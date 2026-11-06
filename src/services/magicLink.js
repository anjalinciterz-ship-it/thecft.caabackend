import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from '../lib/http.js';
import { hashToken } from '../lib/security.js';
import { MagicLinkChallenge } from '../models/index.js';
import { maskDestination } from './otp.js';
import { sendEmail } from './email.js';

export const MAGIC_LINK_TTL_SECONDS = 600;
export const MAGIC_LINK_RESEND_SECONDS = 45;

// 256 bits, so a link is never guessed — which is why there is no attempt
// counter here. What it does protect against is a link that outlives its moment.
const newToken = () => crypto.randomBytes(32).toString('base64url');

const hashFor = (token) => hashToken(`magic|${token}`);

/** The only place the raw token is turned into a URL, so the mail and the dev log agree. */
export const magicLinkUrl = (token) =>
  `${String(env.FRONTEND_URL).replace(/\/+$/, '')}/magic-link?token=${encodeURIComponent(token)}`;

/**
 * Emails a one-click sign-in link. The caller has already confirmed the account
 * exists and is active; the token itself never appears in a response body.
 */
export async function issueMagicLink({ destination }) {
  const open = await MagicLinkChallenge.findOne({ destination, consumedAt: null, expiresAt: { $gt: new Date() } })
    .sort({ createdAt: -1 });
  if (open?.resendAt > new Date()) {
    throw ApiError.tooManyRequests(`A sign-in link was just sent. Try again in ${Math.ceil((open.resendAt - Date.now()) / 1000)}s.`);
  }

  // Last link wins: anything still outstanding for this address stops working
  // the moment a newer one is sent, so an old mail cannot sign in later.
  await MagicLinkChallenge.updateMany({ destination, consumedAt: null }, { consumedAt: new Date() });

  const token = newToken();
  const url = magicLinkUrl(token);
  const now = new Date();
  const challenge = await MagicLinkChallenge.create({
    destination,
    tokenHash: hashFor(token),
    expiresAt: new Date(now.getTime() + MAGIC_LINK_TTL_SECONDS * 1000),
    resendAt: new Date(now.getTime() + MAGIC_LINK_RESEND_SECONDS * 1000)
  });

  await sendEmail({
    template: 'magic_link',
    to: destination,
    magic: { url, minutes: Math.round(MAGIC_LINK_TTL_SECONDS / 60) }
  });

  // Without a live email provider the link would be unreachable, so it is logged
  // for local runs only. A configured provider never sees it leave the process.
  if (env.EMAIL_PROVIDER !== 'resend' || !env.RESEND_API_KEY) {
    console.log(`[magic:dev] sign-in link for ${destination}: ${url}`);
  }

  return { challenge, maskedDestination: maskDestination(destination) };
}

/** Returns the challenge when the token is right; throws the client-facing failure otherwise. */
export async function redeemMagicLink({ token, ip }) {
  const challenge = await MagicLinkChallenge.findOne({ tokenHash: hashFor(String(token)) });
  if (!challenge) throw ApiError.badRequest('invalid_link', 'That sign-in link is not valid. Request a new one.');
  if (challenge.expiresAt <= new Date()) {
    throw ApiError.badRequest('link_expired', 'This sign-in link has expired. Request a new one.');
  }
  if (challenge.consumedAt) {
    throw ApiError.badRequest('link_used', 'That sign-in link was already used. Request a new one.');
  }

  challenge.consumedAt = new Date();
  challenge.consumedIp = ip || '';
  await challenge.save();
  return challenge;
}
