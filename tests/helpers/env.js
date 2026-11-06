const base = {
  NODE_ENV: 'test',
  PORT: '5051',
  FRONTEND_URL: 'http://127.0.0.1:5174',
  BACKEND_URL: 'http://127.0.0.1:5051',
  CORS_ALLOWED_ORIGINS: 'http://127.0.0.1:5174',
  SESSION_SIGNING_KEY: 'test-session-signing-key-0123456789-abcdefghijklmnop',
  SESSION_COOKIE_SECURE: 'false',
  DNS_SERVERS: '',
  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SIGNIN_KEY: 'test-google-secret',
  AUTH_GOOGLE_ENABLED: 'false',
  AUTH_PASSWORD_ENABLED: 'true',
  AUTH_OTP_EMAIL_ENABLED: 'false',
  AUTH_OTP_SMS_ENABLED: 'false',
  OTP_HASH_PEPPER: 'test-otp-pepper',
  BUNNY_API_KEY: '',
  BUNNY_LIBRARY_ID: '',
  BUNNY_SIGNING_KEY: '',
  PAYMENT_PROVIDER: 'mock',
  PAYMENT_MOCK_ENABLED: 'true',
  STRIPE_API_KEY: '',
  STRIPE_PUBLISHABLE_KEY: '',
  STRIPE_WEBHOOK_SIGNING_KEY: '',
  EMAIL_PROVIDER: 'mock',
  RESEND_API_KEY: '',
  ADMIN_NOTIFY_EMAIL: 'notify@example.test'
};

// The suite needs password sign-in and a mock provider no matter what .env says,
// so the test values are written into the environment before the API is imported.
export function useTestEnv(overrides = {}) {
  const config = { ...base, ...overrides };
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  return config;
}

export default useTestEnv;
