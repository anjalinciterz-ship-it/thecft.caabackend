import { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env.js';
import { ApiError } from '../lib/http.js';
import { User } from '../models/index.js';

let client;
const oauth = () => client || (client = new OAuth2Client(env.GOOGLE_CLIENT_ID));

export async function signInWithGoogle(credential) {
  if (!env.googleConfigured) throw new ApiError('google_not_configured', 503, 'Google sign-in is not configured.');

  let payload;
  try {
    const ticket = await oauth().verifyIdToken({ idToken: credential, audience: env.GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch {
    throw ApiError.badRequest('invalid_credential', 'Google did not vouch for that sign-in.');
  }
  if (!payload?.email) throw ApiError.badRequest('invalid_credential', 'Google returned no email address.');

  const email = payload.email.toLowerCase();
  const user = await User.findOne({ email });

  if (user) {
    if (user.status !== 'active') throw ApiError.forbidden('This account is suspended.');
    if (!user.googleId) user.googleId = payload.sub;
    if (!user.emailVerified && payload.email_verified) user.emailVerified = true;
    if (!user.avatarUrl && payload.picture) user.avatarUrl = payload.picture;
    user.lastLoginAt = new Date();
    await user.save();
    return { user, created: false };
  }

  const created = await User.create({
    firstName: payload.given_name || email.split('@')[0],
    lastName: payload.family_name || '',
    email,
    googleId: payload.sub,
    avatarUrl: payload.picture || '',
    emailVerified: Boolean(payload.email_verified),
    lastLoginAt: new Date()
  });
  return { user: created, created: true };
}
