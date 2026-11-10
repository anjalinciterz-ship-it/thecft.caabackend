import 'dotenv/config';
import { z } from 'zod';

// The default has to stay the string form: zod applies it before the transform,
// so a boolean default fails the enum check when the variable is absent.
const bool = (def = 'false') => z.enum(['true', 'false']).default(def).transform((v) => v === 'true');

const minLen = (n) =>
  z.string().trim().refine((v) => v.length >= n, { message: `must be at least ${n} characters` });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(5000),
  FRONTEND_URL: z.string().url().default('http://127.0.0.1:5180'),
  BACKEND_URL: z.string().url().default('http://127.0.0.1:5000'),
  CORS_ALLOWED_ORIGINS: z.string().default('http://127.0.0.1:5180'),
  SESSION_SIGNING_KEY: minLen(32),
  SESSION_COOKIE_SECURE: bool(process.env.NODE_ENV === 'production' ? 'true' : 'false'),
  DNS_SERVERS: z.string().default(''),
  MONGODB_URI: minLen(1),

  AUTH_GOOGLE_ENABLED: bool('false'),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SIGNIN_KEY: minLen(1),

  AUTH_PASSWORD_ENABLED: bool('false'),
  AUTH_OTP_EMAIL_ENABLED: bool('false'),
  AUTH_MAGIC_LINK_ENABLED: bool('false'),
  OTP_HASH_PEPPER: z.string().default('dev-only-otp-pepper'),

  BUNNY_API_KEY: z.string().default(''),
  BUNNY_LIBRARY_ID: z.string().default(''),
  BUNNY_STREAM_API_HOST: z.string().default('https://video.bunnycdn.com'),
  BUNNY_EMBED_HOST: z.string().default('https://player.mediadelivery.net'),
  BUNNY_SIGNING_KEY: z.string().default(''),
  VIDEO_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).default(1800),
  VIDEO_HEARTBEAT_SECONDS: z.coerce.number().int().min(10).default(45),
  VIDEO_MAX_CONCURRENT_SESSIONS: z.coerce.number().int().min(1).default(1),
  WATERMARK_OPACITY: z.coerce.number().min(0.05).max(1).default(0.32),
  WATERMARK_MOVE_SECONDS: z.coerce.number().int().min(3).default(7),

  WISDOM_CALL_TIMEZONE: z.string().default('America/Denver'),
  WISDOM_CALL_HOUR: z.coerce.number().int().min(0).max(23).default(19),
  WISDOM_CALL_MINUTE: z.coerce.number().int().min(0).max(59).default(0),

  PAYMENT_PROVIDER: z.enum(['mock', 'stripe']).default('mock'),
  PAYMENT_MOCK_ENABLED: bool('true'),
  STRIPE_API_KEY: z.string().default(''),
  STRIPE_PUBLISHABLE_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SIGNING_KEY: z.string().default(''),

  EMAIL_PROVIDER: z.enum(['mock', 'resend']).default('mock'),
  RESEND_API_KEY: z.string().default(''),
  EMAIL_FROM: z.string().default('Mind Life Academy <onboarding@resend.dev>'),
  ADMIN_NOTIFY_EMAIL: z.string().default('')
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const raw = parsed.data;

export const env = {
  ...raw,
  SESSION_SECRET: raw.SESSION_SIGNING_KEY,
  GOOGLE_CLIENT_SECRET: raw.GOOGLE_CLIENT_SIGNIN_KEY,
  BUNNY_TOKEN_KEY: raw.BUNNY_SIGNING_KEY,
  STRIPE_SECRET_KEY: raw.STRIPE_API_KEY,
  STRIPE_WEBHOOK_SECRET: raw.STRIPE_WEBHOOK_SIGNING_KEY,
  isProd: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  // A browser sends the Origin without a trailing slash, so a pasted value like
  // https://site.netlify.app/ would otherwise reject every real request.
  allowedOrigins: raw.CORS_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean),
  googleConfigured: raw.AUTH_GOOGLE_ENABLED && !!raw.GOOGLE_CLIENT_ID && !!raw.GOOGLE_CLIENT_SIGNIN_KEY,
  bunnyConfigured: !!raw.BUNNY_API_KEY && !!raw.BUNNY_LIBRARY_ID,
  bunnyTokensConfigured: !!raw.BUNNY_SIGNING_KEY,
  stripeConfigured: raw.PAYMENT_PROVIDER === 'stripe' && !!raw.STRIPE_API_KEY,
  resendConfigured: raw.EMAIL_PROVIDER === 'resend' && !!raw.RESEND_API_KEY
};
