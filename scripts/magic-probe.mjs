// Proves the magic-link loop on a stack whose console we can actually read:
// create an account with an email code, ask for a sign-in link, take that link
// out of [magic:dev], redeem it, and confirm the session belongs to the right
// person and that the link cannot be used twice.
import { readFileSync } from 'node:fs';

const API = process.env.CFT_API || 'http://127.0.0.1:5008/api/v1';
const EMAIL = `magic.probe.${Date.now()}@verify.test`;
const LOG = process.argv[2];

const jar = new Map();
const cookies = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
const call = async (path, body, token) => {
  const res = await fetch(`${API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      ...(cookies() ? { cookie: cookies() } : {}),
      ...(token ? { 'x-csrf-token': token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const raw of res.headers.getSetCookie?.() || []) {
    const [pair] = raw.split(';');
    const [k, v] = pair.split('=');
    jar.set(k.trim(), v);
  }
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const lastLine = (needle) =>
  readFileSync(LOG, 'utf8').split('\n').reverse().find((l) => l.includes(needle));

const csrf = (await call('/auth/csrf')).json.data.csrfToken;

const asked = await call('/auth/otp/request', {
  channel: 'email',
  destination: EMAIL,
  purpose: 'signup',
  firstName: 'Magic',
  lastName: 'Probe',
  termsAccepted: true,
}, csrf);
const code = /code for \S+: (\d+)/.exec(lastLine('[otp:dev]') || '')?.[1];
const made = await call('/auth/otp/verify', {
  challengeId: asked.json.data.challengeId,
  code,
}, csrf);
console.log(`account created -> ${made.status} ${made.json?.data?.user?.email || JSON.stringify(made.json).slice(0, 120)}`);

const requested = await call('/auth/magic/request', { email: EMAIL }, csrf);
console.log(`magic/request -> ${requested.status} ${JSON.stringify(requested.json.data || requested.json.error || {}).slice(0, 160)}`);

const url = (lastLine('[magic:dev]') || '').split(': ').pop().trim();
const token = new URL(url).searchParams.get('token');
console.log(`the link the console printed: ${url.replace(token, `${token.slice(0, 10)}…`)}`);

// Signing out first proves the link alone is enough to get a session back. The
// logout also throws the session away, so the CSRF token has to be re-issued
// against the fresh anonymous session before the verify call will be accepted.
await call('/auth/logout', {}, csrf);
const fresh = (await call('/auth/csrf')).json.data.csrfToken;
const verified = await call('/auth/magic/verify', { token }, fresh);
console.log(`magic/verify -> ${verified.status} signed in as ${verified.json?.data?.user?.email}`);
console.log(`auth/me -> ${(await call('/auth/me')).json?.data?.user?.email || 'no session'}`);
const reused = await call('/auth/magic/verify', { token }, fresh);
console.log(`using the same link twice -> ${reused.status} ${JSON.stringify(reused.json.error || {}).slice(0, 120)}`);
