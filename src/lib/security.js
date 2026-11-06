import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from './http.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const digest = (...parts) => crypto.createHash('sha256').update(parts.join('|')).digest('hex');

export const hashToken = (token) => digest('cft-otp', env.OTP_HASH_PEPPER, token);

export const randomId = (bytes = 24) => crypto.randomBytes(bytes).toString('hex');

export const signState = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', env.SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
};

export const verifyState = (token) => {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', env.SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(signature || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
};

export const loginAttempts = new Map();

export function assertNotTooManyAttempts(key, { max = 5, windowMs = 15 * 60 * 1000 } = {}) {
  const entry = loginAttempts.get(key);
  if (entry && entry.first + windowMs < Date.now()) loginAttempts.delete(key);
  const current = loginAttempts.get(key);
  if (current && current.count >= max) {
    throw ApiError.tooManyRequests('Too many attempts. Wait a few minutes and try again.');
  }
}

export function recordFailedAttempt(key, { windowMs = 15 * 60 * 1000 } = {}) {
  const current = loginAttempts.get(key);
  if (!current || current.first + windowMs < Date.now()) {
    loginAttempts.set(key, { first: Date.now(), count: 1 });
    return;
  }
  current.count += 1;
}

export function clearAttempts(key) {
  loginAttempts.delete(key);
}

export function requireSignIn(req, _res, next) {
  if (!req.session?.uid) return next(ApiError.unauthorized());
  next();
}

export function requireRoles(...roles) {
  return (req, _res, next) => {
    if (!req.session?.uid) return next(ApiError.unauthorized());
    if (!req.user || !roles.includes(req.user.role)) return next(ApiError.forbidden());
    next();
  };
}

export function csrfGuard(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const supplied = req.get('x-csrf-token') || req.body?._csrf;
  const expected = req.session?.csrfToken;
  if (!expected || typeof supplied !== 'string') {
    return next(new ApiError('csrf_missing', 403, 'Your session needs a security refresh.'));
  }
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return next(new ApiError('csrf_mismatch', 403, 'Your session needs a security refresh.'));
  }
  next();
}

export function issueCsrfToken(req) {
  if (!req.session) return null;
  if (!req.session.csrfToken) req.session.csrfToken = randomId(20);
  return req.session.csrfToken;
}

export const clientIp = (req) => (req.ips && req.ips[0]) || req.ip || req.socket?.remoteAddress || '';

export { digest };
