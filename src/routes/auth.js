import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { ApiError, asyncHandler, noContent, ok } from '../lib/http.js';
import { validate } from '../lib/validate.js';
import { csrfGuard, issueCsrfToken, requireSignIn, assertNotTooManyAttempts, recordFailedAttempt, clearAttempts, clientIp } from '../lib/security.js';
import { signInWithGoogle } from '../services/google.js';
import { issueOtp, redeemOtp, maskDestination, OTP_MAX_ATTEMPTS } from '../services/otp.js';
import { issueMagicLink, redeemMagicLink, MAGIC_LINK_TTL_SECONDS } from '../services/magicLink.js';
import { PlaybackSession, User } from '../models/index.js';

export const router = Router();

const methodDisabled = (alternative) =>
  new ApiError('auth_method_disabled', 400, `That sign-in method is not switched on. Use ${alternative} instead.`);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

const accountNotFound = () =>
  new ApiError('account_not_found', 404, 'We could not find an account for that email address.');

// Session fixation is answered by a brand new session id; the CSRF token itself
// carries no authority, so keeping it means the client never has to re-fetch one
// after signing in.
const startSession = (req, user) =>
  new Promise((resolve, reject) => {
    const carriedToken = req.session?.csrfToken || null;
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.uid = String(user.id);
      if (carriedToken) req.session.csrfToken = carriedToken;
      req.session.ip = req.ip;
      return resolve();
    });
  });

router.get('/csrf', asyncHandler(async (req, res) => ok(res, { csrfToken: issueCsrfToken(req) })));

router.get(
  '/status',
  asyncHandler(async (_req, res) =>
    ok(res, {
      otp: {
        email: { enabled: env.AUTH_OTP_EMAIL_ENABLED }
      },
      magicLink: { enabled: env.AUTH_MAGIC_LINK_ENABLED, minutes: Math.round(MAGIC_LINK_TTL_SECONDS / 60) },
      password: { enabled: env.AUTH_PASSWORD_ENABLED },
      google: { configured: env.googleConfigured, clientId: env.GOOGLE_CLIENT_ID || null }
    })
  )
);

router.get(
  '/me',
  asyncHandler(async (req, res) => {
    if (!req.session?.uid || !req.user) return ok(res, { authenticated: false });
    ok(res, { authenticated: true, user: req.user.toJSON() });
  })
);

router.post(
  '/google',
  csrfGuard,
  asyncHandler(async (req, res) => {
    const { credential } = validate(z.object({ credential: z.string().min(30) }), req.body);
    const { user, created } = await signInWithGoogle(credential);
    await startSession(req, user);
    ok(res, { user: user.toJSON(), created });
  })
);

router.post(
  '/login',
  csrfGuard,
  asyncHandler(async (req, res) => {
    if (!env.AUTH_PASSWORD_ENABLED) throw methodDisabled('Google');
    const { identifier, password } = validate(
      z.object({ identifier: z.string().min(3), password: z.string().min(8) }),
      req.body
    );
    const user = await User.findOne({ email: identifier.toLowerCase() });
    if (!user || !(await user.verifyPassword(password))) {
      throw ApiError.badRequest('invalid_credentials', 'That email and password do not match.');
    }
    if (user.status !== 'active') throw ApiError.forbidden('This account is suspended.');
    user.lastLoginAt = new Date();
    await user.save();
    await startSession(req, user);
    ok(res, { user: user.toJSON() });
  })
);

const otpRequestSchema = z.object({
  destination: z.string().trim().toLowerCase().min(3).max(254),
  purpose: z.enum(['login', 'signup', 'link']).default('login'),
  firstName: z.string().trim().max(60).optional(),
  lastName: z.string().trim().max(60).optional(),
  termsAccepted: z.coerce.boolean().optional(),
  marketingConsent: z.coerce.boolean().optional(),
  timeZone: z.string().max(64).optional()
});

router.post(
  '/otp/request',
  csrfGuard,
  asyncHandler(async (req, res) => {
    const body = validate(otpRequestSchema, req.body);

    if (!env.AUTH_OTP_EMAIL_ENABLED) throw methodDisabled('your password');
    if (!EMAIL_PATTERN.test(body.destination)) throw ApiError.badRequest('invalid_email', 'Enter a valid email address.');

    const existing = await User.findOne({ email: body.destination });
    if (body.purpose === 'signup') {
      if (existing) throw ApiError.conflict('account_exists', 'An account already uses this email. Log in instead.');
      if (!body.termsAccepted) throw ApiError.badRequest('terms_required', 'Please accept the Terms and Privacy Policy first.');
    }
    if (body.purpose === 'login') {
      if (!existing) throw accountNotFound();
      if (existing.status !== 'active') throw ApiError.forbidden('This account is suspended.');
    }
    if (body.purpose === 'link') {
      if (!req.session?.uid) throw ApiError.unauthorized();
      if (existing && String(existing._id) !== String(req.session.uid)) {
        throw ApiError.conflict('account_exists', 'Another account already uses this email address.');
      }
    }

    const { challenge } = await issueOtp({
      channel: 'email',
      destination: body.destination,
      purpose: body.purpose,
      profile: {
        firstName: body.firstName || '',
        lastName: body.lastName || '',
        marketingConsent: Boolean(body.marketingConsent),
        timeZone: body.timeZone || 'UTC'
      }
    });

    ok(res, {
      challengeId: String(challenge._id),
      channel: challenge.channel,
      purpose: challenge.purpose,
      maskedDestination: maskDestination(challenge.destination),
      expiresAt: challenge.expiresAt.toISOString(),
      resendAt: challenge.resendAt.toISOString()
    });
  })
);

router.post(
  '/otp/verify',
  csrfGuard,
  asyncHandler(async (req, res) => {
    const { challengeId, code } = validate(
      z.object({ challengeId: z.string().regex(/^[a-f\d]{24}$/i), code: z.string().regex(/^\d{6}$/) }),
      req.body
    );

    const guardKey = `otp:${challengeId}`;
    assertNotTooManyAttempts(guardKey, { max: OTP_MAX_ATTEMPTS });

    let challenge;
    try {
      challenge = await redeemOtp({ challengeId, code });
    } catch (error) {
      if (error.code === 'invalid_code') recordFailedAttempt(guardKey);
      throw error;
    }
    clearAttempts(guardKey);

    let user;
    let created = false;

    if (challenge.purpose === 'link') {
      if (!req.session?.uid) throw ApiError.unauthorized();
      user = await User.findById(req.session.uid);
      if (!user) throw ApiError.unauthorized();
      user.email = challenge.destination;
      user.emailVerified = true;
      await user.save();
    } else if (challenge.purpose === 'signup') {
      const profile = challenge.profile || {};
      user = new User({
        firstName: profile.firstName || 'Friend',
        lastName: profile.lastName || '',
        email: challenge.destination,
        emailVerified: true,
        termsAcceptedAt: new Date(),
        marketingOptIn: Boolean(profile.marketingConsent),
        timeZone: profile.timeZone || 'UTC',
        role: 'student'
      });
      try {
        await user.save();
        created = true;
      } catch (failure) {
        if (failure?.code === 11000) throw ApiError.conflict('account_exists', 'An account already uses this email. Log in instead.');
        throw failure;
      }
    } else {
      user = await User.findOne({ email: challenge.destination });
      if (!user) throw accountNotFound();
      if (user.status !== 'active') throw ApiError.forbidden('This account is suspended.');
      user.emailVerified = true;
      user.lastLoginAt = new Date();
      await user.save();
    }

    await startSession(req, user);
    ok(res, { user: user.toJSON(), created, verified: true });
  })
);

router.post(
  '/magic/request',
  csrfGuard,
  asyncHandler(async (req, res) => {
    if (!env.AUTH_MAGIC_LINK_ENABLED) throw methodDisabled('an email code');
    const { email } = validate(
      z.object({ email: z.string().trim().toLowerCase().min(3).max(254) }),
      req.body
    );
    if (!EMAIL_PATTERN.test(email)) throw ApiError.badRequest('invalid_email', 'Enter a valid email address.');

    const existing = await User.findOne({ email });
    if (!existing) throw accountNotFound();
    if (existing.status !== 'active') throw ApiError.forbidden('This account is suspended.');

    const { challenge, maskedDestination } = await issueMagicLink({ destination: email });
    ok(res, {
      channel: 'email',
      maskedDestination,
      expiresAt: challenge.expiresAt.toISOString(),
      resendAt: challenge.resendAt.toISOString()
    });
  })
);

// The link lands on the site as a page, and that page posts the token here. A
// GET would be simpler, but mail clients and scanners prefetch links in emails,
// which would burn a single-use link before its reader ever saw it.
router.post(
  '/magic/verify',
  csrfGuard,
  asyncHandler(async (req, res) => {
    if (!env.AUTH_MAGIC_LINK_ENABLED) throw methodDisabled('an email code');
    const { token } = validate(z.object({ token: z.string().min(20).max(512) }), req.body);

    const challenge = await redeemMagicLink({ token, ip: clientIp(req) });
    const user = await User.findOne({ email: challenge.destination });
    if (!user) throw accountNotFound();
    if (user.status !== 'active') throw ApiError.forbidden('This account is suspended.');

    // Opening a link that was delivered to the address proves it, so a magic-link
    // sign-in verifies the email exactly as a code does.
    user.emailVerified = true;
    user.lastLoginAt = new Date();
    await user.save();
    await startSession(req, user);
    ok(res, { user: user.toJSON(), verified: true });
  })
);

router.post(
  '/password/forgot',
  csrfGuard,
  asyncHandler(async () => {
    throw ApiError.unavailable('Password resets are not configured on this server yet.');
  })
);

router.post(
  '/password/reset',
  csrfGuard,
  asyncHandler(async () => {
    throw ApiError.unavailable('Password resets are not configured on this server yet.');
  })
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    if (!req.session) return noContent(res);
    const uid = req.session.uid;
    await new Promise((resolve) => req.session.destroy(() => resolve()));
    res.clearCookie('cft.sid');
    // A signed-out account must not keep holding a video slot, otherwise the next
    // sign-in inherits a session nobody can reach.
    if (uid) {
      await PlaybackSession.updateMany(
        { student: uid, endedAt: null },
        { $set: { endedAt: new Date(), endedReason: 'signed_out' } }
      );
    }
    noContent(res);
  })
);

router.get(
  '/sessions',
  requireSignIn,
  asyncHandler(async (req, res) =>
    ok(res, { current: { ip: req.ip, startedAt: req.session.updatedAt || req.session.createdAt } })
  )
);

export default router;
