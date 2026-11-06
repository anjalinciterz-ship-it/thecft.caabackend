// End-to-end email-code check: signup, login, reuse, brute force and linking.
// The stack has no mailbox, so the code is taken from the [otp:dev] line the
// service prints in mock mode — the same line a human reads during a local run.
// Run with: node tests/verify-otp.mjs
import mongoose from 'mongoose';
import memory from 'mongodb-memory-server';
import session from 'express-session';
import { useTestEnv } from './helpers/env.js';

const PORT = 5098;
const origin = `http://127.0.0.1:${PORT}`;
const results = [];

class Jar {
  constructor(label) {
    this.label = label;
    this.cookies = new Map();
    this.csrf = null;
  }

  async call(path, { method = 'GET', body, headers = {} } = {}) {
    const cookie = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...(this.csrf && method !== 'GET' ? { 'x-csrf-token': this.csrf } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });
    for (const line of response.headers.getSetCookie?.() || []) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    return { status: response.status, body: payload, data: payload?.data, error: payload?.error };
  }

  async withCsrf() {
    const csrf = await this.call('/api/v1/auth/csrf');
    this.csrf = csrf.data?.csrfToken || null;
    return csrf;
  }
}

// Every code the API emits, in order, so a test can pair a request with its code
// the way a person pairs a terminal line with a browser field.
const emittedCodes = [];
const realLog = console.log;
console.log = (...args) => {
  const line = args.join(' ');
  const match = /\[otp:dev\] code for \S+: (\d{6})/.exec(line);
  if (match) emittedCodes.push(match[1]);
  if (!line.startsWith('[email:mock]') && !line.startsWith('[otp:dev]')) realLog(...args);
};

let passCount = 0;
const assert = (name, condition, detail = '') => {
  const pass = Boolean(condition);
  if (pass) passCount += 1;
  results.push({ name, pass, detail });
  realLog(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const mongo = await memory.MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
useTestEnv({
  MONGODB_URI: mongo.getUri('cft_otp'),
  BACKEND_URL: origin,
  AUTH_OTP_EMAIL_ENABLED: 'true'
});
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(mongoose.models).map((model) => model.init()));

const { createApp } = await import('../src/app.js');
const app = createApp({ sessionStore: new session.MemoryStore() });
const server = await new Promise((resolve) => {
  const listening = app.listen(PORT, '127.0.0.1', () => resolve(listening));
});

const studentEmail = `otp.student+${Date.now()}@verify.test`;
const freshJar = async () => {
  const jar = new Jar();
  await jar.withCsrf();
  return jar;
};
const nextCode = () => emittedCodes[emittedCodes.length - 1];

try {
  const { User, EmailMessage, OtpChallenge } = await import('../src/models/index.js');

  const status = await (await freshJar()).call('/api/v1/auth/status');
  assert('status advertises email codes', status.data?.otp?.email?.enabled === true);

  const anonymous = new Jar();
  await anonymous.withCsrf();
  const noTerms = await anonymous.call('/api/v1/auth/otp/request', {
    method: 'POST',
    body: { channel: 'email', destination: studentEmail, purpose: 'signup', firstName: 'Opt' }
  });
  assert('signup without the terms box is refused', noTerms.error?.code === 'terms_required', noTerms.error?.message);

  const badEmail = await anonymous.call('/api/v1/auth/otp/request', {
    method: 'POST',
    body: { channel: 'email', destination: 'not-an-email', purpose: 'signup', termsAccepted: true }
  });
  assert('a malformed address is refused', badEmail.error?.code === 'invalid_email', badEmail.error?.message);

  const missing = await anonymous.call('/api/v1/auth/otp/request', {
    method: 'POST',
    body: { channel: 'email', destination: `nobody+${Date.now()}@verify.test`, purpose: 'login' }
  });
  assert('login for an unknown address says so', missing.error?.code === 'account_not_found', missing.error?.message);

  const issued = await anonymous.call('/api/v1/auth/otp/request', {
    method: 'POST',
    body: {
      channel: 'email',
      destination: studentEmail,
      purpose: 'signup',
      firstName: 'Opt',
      lastName: 'Student',
      termsAccepted: true,
      marketingConsent: true,
      timeZone: 'Asia/Kolkata'
    }
  });
  assert('signup code is issued', issued.status === 200 && issued.data?.challengeId, JSON.stringify(issued.data || issued.error));
  assert('the response masks the address', issued.data?.maskedDestination?.includes('*'), issued.data?.maskedDestination);
  assert('the response never contains the code', !JSON.stringify(issued.data).includes(nextCode()));
  assert('expiry and resend windows are absolute', Number.isFinite(Date.parse(issued.data?.expiresAt)) && Number.isFinite(Date.parse(issued.data?.resendAt)));

  const throttled = await anonymous.call('/api/v1/auth/otp/request', {
    method: 'POST',
    body: { channel: 'email', destination: studentEmail, purpose: 'signup', termsAccepted: true }
  });
  assert('an immediate second code is throttled', throttled.status === 429, throttled.error?.message);

  const wrong = await anonymous.call('/api/v1/auth/otp/verify', {
    method: 'POST',
    body: { challengeId: issued.data.challengeId, code: '000001' }
  });
  assert('a wrong code is refused', wrong.error?.code === 'invalid_code', wrong.error?.message);

  const verified = await anonymous.call('/api/v1/auth/otp/verify', {
    method: 'POST',
    body: { challengeId: issued.data.challengeId, code: nextCode() }
  });
  assert('the right code creates the account', verified.data?.created === true, JSON.stringify(verified.data?.user || verified.error));
  assert('the new account is signed in', verified.data?.user?.email === studentEmail);
  assert('the new account is a student', verified.data?.user?.role === 'student' && verified.data?.user?.emailVerified === true);

  const me = await anonymous.call('/api/v1/auth/me');
  assert('the session survives to the next request', me.data?.authenticated === true && me.data?.user?.email === studentEmail);

  const created = await User.findOne({ email: studentEmail });
  assert('terms acceptance is timestamped', created?.termsAcceptedAt instanceof Date);
  assert('marketing consent is stored', created?.marketingOptIn === true);
  assert('the signup timezone is captured', created?.timeZone === 'Asia/Kolkata');
  assert('a code-only account has no password', !created?.passwordHash);

  const replay = await (await freshJar()).call('/api/v1/auth/otp/verify', {
    method: 'POST',
    body: { challengeId: issued.data.challengeId, code: nextCode() }
  });
  assert('a code cannot be used twice', replay.error?.code === 'code_used', replay.error?.message);

  const duplicate = await anonymous.call('/api/v1/auth/otp/request', {
    method: 'POST',
    body: { channel: 'email', destination: studentEmail, purpose: 'signup', termsAccepted: true }
  });
  assert('a second account on the same address is refused', duplicate.error?.code === 'account_exists', duplicate.error?.message);

  const login = await anonymous.call('/api/v1/auth/otp/request', {
    method: 'POST',
    body: { channel: 'email', destination: studentEmail, purpose: 'login' }
  });
  assert('an existing account can request a login code', login.status === 200, JSON.stringify(login.error || {}));
  const loginBack = await anonymous.call('/api/v1/auth/otp/verify', {
    method: 'POST',
    body: { challengeId: login.data.challengeId, code: nextCode() }
  });
  assert('the login code signs the account back in', loginBack.data?.user?.email === studentEmail && loginBack.data?.created === false);

  const fiveCodes = await (async () => {
    const other = `brute+${Date.now()}@verify.test`;
    await User.create({
      name: 'Brute Test',
      email: other,
      role: 'student',
      emailVerified: false,
      status: 'active'
    });
    const jar = await freshJar();
    const request = await jar.call('/api/v1/auth/otp/request', {
      method: 'POST',
      body: { channel: 'email', destination: other, purpose: 'login' }
    });
    let last = null;
    for (let i = 0; i < 7; i += 1) {
      last = await jar.call('/api/v1/auth/otp/verify', {
        method: 'POST',
        body: { challengeId: request.data.challengeId, code: '123456' }
      });
    }
    return last;
  })();
  assert('repeated wrong codes are locked out', fiveCodes.status === 429, fiveCodes.error?.message);

  const challengeCount = await OtpChallenge.countDocuments({ destination: studentEmail });
  assert('every issued challenge is recorded', challengeCount >= 2, `${challengeCount} rows`);

  const stored = await EmailMessage.findOne({ template: 'otp_code', to: studentEmail }).sort({ createdAt: -1 });
  const noDigits = !/\d{6}/.test(`${stored?.html || ''}${stored?.text || ''}`);
  assert('the mailed code is redacted from the log', stored?.html === '' && noDigits, stored?.text);

  const linkJar = await freshJar();
  const link = await linkJar.call('/api/v1/auth/otp/request', {
    method: 'POST',
    body: { channel: 'email', destination: `link+${Date.now()}@verify.test`, purpose: 'link' }
  });
  assert('linking a method needs a session', link.status === 401, link.error?.code);

  const sms = await (await freshJar()).call('/api/v1/auth/otp/request', {
    method: 'POST',
    body: { channel: 'sms', destination: '+14165550111', purpose: 'login' }
  });
  assert('mobile codes explain that they are off', sms.status === 400 && sms.error?.code === 'auth_method_disabled', sms.error?.message);

  const password = await (await freshJar()).call('/api/v1/auth/login', {
    method: 'POST',
    body: { identifier: studentEmail, password: 'anything-long-enough' }
  });
  assert('a code-only account cannot password-login', password.error?.code === 'invalid_credentials', password.error?.message);

  const failed = results.filter((r) => !r.pass).length;
  realLog(`\n${passCount}/${results.length} checks passed`);
  if (failed) process.exitCode = 1;
} finally {
  console.log = realLog;
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await mongo.stop();
}
