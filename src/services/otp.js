import { randomInt } from 'node:crypto';
import { ApiError } from '../lib/http.js';
import { hashToken } from '../lib/security.js';
import { OtpChallenge } from '../models/index.js';
import { sendEmail } from './email.js';

export const OTP_TTL_SECONDS = 600;
export const OTP_RESEND_SECONDS = 45;
export const OTP_MAX_ATTEMPTS = 5;

const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

// Codes are short-lived and single-use, so a peppered digest salted with the
// destination is enough — and it keeps verification constant time.
const hashFor = (destination, code) => hashToken(`${destination}|${code}`);

export function maskDestination(value) {
  const text = String(value);
  const at = text.indexOf('@');
  if (at <= 0) return text.length > 4 ? `${text.slice(0, 2)}${'*'.repeat(text.length - 4)}${text.slice(-2)}` : '*'.repeat(text.length);
  const [name, domain] = [text.slice(0, at), text.slice(at + 1)];
  return `${name[0]}${'*'.repeat(Math.max(1, name.length - 1))}@${domain}`;
}

/** Issues a code and answers with everything the client may show — never the code itself. */
export async function issueOtp({ channel, destination, purpose, profile }) {
  const open = await OtpChallenge.findOne({ channel, destination, purpose, consumedAt: null, expiresAt: { $gt: new Date() } });
  if (open && open.resendAt > new Date()) {
    throw ApiError.tooManyRequests(`A code was just sent. Try again in ${Math.ceil((open.resendAt - Date.now()) / 1000)}s.`);
  }

  const code = newCode();
  const now = new Date();
  const challenge = await OtpChallenge.create({
    channel,
    destination,
    purpose,
    codeHash: hashFor(destination, code),
    profile,
    expiresAt: new Date(now.getTime() + OTP_TTL_SECONDS * 1000),
    resendAt: new Date(now.getTime() + OTP_RESEND_SECONDS * 1000)
  });

  const mail = await sendEmail({ template: 'otp_code', to: destination, otp: { code, channel, purpose, minutes: Math.round(OTP_TTL_SECONDS / 60) } });

  // Without a live email provider the code would be unreachable, so it is logged
  // for local runs only. A configured provider never sees it leave the process.
  if (mail.status === 'skipped') console.log(`[otp:dev] code for ${destination}: ${code}`);
  if (mail.status === 'failed') {
    // A code nobody received is not a challenge worth keeping, and the client may
    // never claim one was sent when the mail did not leave.
    await OtpChallenge.deleteOne({ _id: challenge._id });
    console.error(`[otp:delivery] ${destination}: ${mail.error}`);
    throw ApiError.badRequest('otp_delivery_failed', 'The verification email could not be delivered. Check the address, or sign in another way.');
  }

  return { challenge, code };
}

/** Returns the challenge when the code is right; throws the client-facing failure otherwise. */
export async function redeemOtp({ challengeId, code, destinationHint }) {
  const challenge = await OtpChallenge.findById(challengeId);
  if (!challenge) throw ApiError.badRequest('invalid_code', 'That code is not valid. Request a new one and try again.');
  if (challenge.expiresAt <= new Date()) {
    throw ApiError.badRequest('code_expired', 'This code has expired. Request a new one.');
  }
  if (challenge.consumedAt) throw ApiError.badRequest('code_used', 'That code was already used. Request a new one.');
  if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
    throw ApiError.tooManyRequests('Too many attempts with this code. Request a new one.');
  }

  if (hashFor(challenge.destination, code) !== challenge.codeHash) {
    challenge.attempts += 1;
    await challenge.save();
    throw ApiError.badRequest('invalid_code', 'That code is not valid. Request a new one and try again.');
  }

  challenge.consumedAt = new Date();
  await challenge.save();
  if (destinationHint && destinationHint !== challenge.destination) {
    throw ApiError.badRequest('code_mismatch', 'That code belongs to a different address.');
  }
  return challenge;
}
