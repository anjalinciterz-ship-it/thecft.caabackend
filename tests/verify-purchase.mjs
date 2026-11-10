// End-to-end purchase + DRM check against an isolated in-memory replica set.
// Run with: node tests/verify-purchase.mjs
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import memory from 'mongodb-memory-server';
import session from 'express-session';
import { useTestEnv } from './helpers/env.js';
import { paymentEvent } from './helpers/payment-simulator.js';

const PORT = 5099;
const origin = `http://127.0.0.1:${PORT}`;
const results = [];
const record = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const assert = (name, condition, detail = '') => record(name, Boolean(condition), detail);

class Jar {
  constructor(label) {
    this.label = label;
    this.cookies = new Map();
    this.csrf = null;
  }

  async call(path, { method = 'GET', body, headers = {}, raw } = {}) {
    const cookie = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(body && !raw ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...(this.csrf && method !== 'GET' ? { 'x-csrf-token': this.csrf } : {}),
        ...headers
      },
      body: raw ? body : body ? JSON.stringify(body) : undefined
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

const mongo = await memory.MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
useTestEnv({
  MONGODB_URI: mongo.getUri('cft_verify'),
  BACKEND_URL: origin,
  BUNNY_LIBRARY_ID: '788236',
  BUNNY_API_KEY: '',
  VIDEO_MAX_CONCURRENT_SESSIONS: '1'
});
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all(Object.values(mongoose.models).map((model) => model.init()));

// Imported only after the test environment is written, so the API config never sees .env.
const { seedCatalog } = await import('../scripts/seed.js');

const { createApp } = await import('../src/app.js');
const app = createApp({ sessionStore: new session.MemoryStore() });
const server = await new Promise((resolve, reject) => {
  const listening = app.listen(PORT, '127.0.0.1', () => resolve(listening));
  listening.once('error', reject);
});

const { Course, Entitlement, EmailMessage, Lesson, Order, User, WebhookEvent, PlaybackSession } = await import('../src/models/index.js');

try {
  await seedCatalog();

  // The two refusal paths depend on flags and lesson counts, not on any real
  // offering, so they get their own fixtures instead of borrowing a catalogue
  // course that stops being a valid example the moment its lessons are published.
  await Course.create([
    { legacyId: 'hidden-fixture', title: 'Not Open Yet', slug: 'not-open-yet', priceMinor: 19900, currency: 'USD', availableForPurchase: false, publicationStatus: 'published' },
    { legacyId: 'empty-fixture', title: 'Nothing Published', slug: 'nothing-published', priceMinor: 19900, currency: 'USD', availableForPurchase: true, publicationStatus: 'published' },
  ]);

  const health = await new Jar('health').call('/api/v1/health/integrations');
  assert('health reports integrations', health.status === 200 && health.data?.database?.status === 'connected', JSON.stringify(health.data?.payments));
  const root = await new Jar('health').call('/health');
  assert('the bare health route answers', root.data?.status === 'ok', root.data?.database);

  const catalog = await new Jar('anon').call('/api/v1/courses?limit=60');
  const accelerator = catalog.data?.courses?.find((c) => c.slug === '10-part-consciousness-accelerator');
  assert('catalog lists the accelerator', Boolean(accelerator), `${catalog.data?.courses?.length || 0} courses, price ${accelerator?.priceMinor} ${accelerator?.currency}`);
  const locked = catalog.data?.courses?.find((c) => c.slug === 'not-open-yet');
  assert('courses closed for enrolment report themselves as closed', locked && locked.availableForPurchase === false, locked?.title);

  const email = `student.${randomUUID().slice(0, 8)}@verify.test`;
  const password = 'Verify-Password-123!';
  const student = new User({ name: 'Verify Student', email, role: 'student', emailVerified: true });
  await student.setPassword(password);
  await student.save();

  const jar = new Jar('student');
  await jar.withCsrf();
  const login = await jar.call('/api/v1/auth/login', { method: 'POST', body: { identifier: email, password } });
  assert('password sign-in opens a session', login.status === 200 && login.data?.user?.email === email, `csrf ${Boolean(jar.csrf)}`);
  const me = await jar.call('/api/v1/auth/me');
  assert('session is readable', me.data?.authenticated === true);

  const priced = await jar.call('/api/v1/cart/price', {
    method: 'POST',
    body: { items: [{ productKind: 'course', productId: accelerator.slug }] }
  });
  assert('server prices the cart', priced.data?.totalMinor === 19900 && priced.data?.currency === 'USD', JSON.stringify(priced.data?.items?.[0] || {}));

  const closed = await jar.call('/api/v1/cart/checkout', {
    method: 'POST',
    headers: { 'Idempotency-Key': `verify-${randomUUID()}` },
    body: { items: [{ productKind: 'course', productId: 'not-open-yet' }] }
  });
  assert('a course closed for enrolment cannot be bought', closed.status === 409 && closed.error?.code === 'not_available', closed.error?.code);

  const empty = await jar.call('/api/v1/cart/checkout', {
    method: 'POST',
    headers: { 'Idempotency-Key': `verify-${randomUUID()}` },
    body: { items: [{ productKind: 'course', productId: 'nothing-published' }] }
  });
  assert('a course with no published lessons cannot be bought', empty.status === 409 && empty.error?.code === 'not_deliverable', empty.error?.code);

  const checkoutKey = `verify-${randomUUID()}`;
  const checkout = await jar.call('/api/v1/cart/checkout', {
    method: 'POST',
    headers: { 'Idempotency-Key': checkoutKey },
    body: { items: [{ productKind: 'course', productId: accelerator.slug }] }
  });
  const orderId = checkout.data?.order?.id;
  assert('checkout creates a pending order', checkout.data?.status === 'pending' && checkout.data?.checkoutUrl === null && Boolean(orderId), `order ${orderId}`);

  const replay = await jar.call('/api/v1/cart/checkout', {
    method: 'POST',
    headers: { 'Idempotency-Key': checkoutKey },
    body: { items: [{ productKind: 'course', productId: accelerator.slug }] }
  });
  assert('the same idempotency key replays one order', replay.data?.order?.id === orderId, replay.data?.order?.orderNumber);

  const earlyLibrary = await jar.call('/api/v1/student/courses?limit=60');
  assert('a pending order grants no access', (earlyLibrary.data?.courses || []).length === 0);

  const event = paymentEvent(orderId, 'success');
  const hook = await new Jar('hook').call('/api/v1/webhooks/mock', { method: 'POST', body: event });
  assert('provider webhook fulfils the order', hook.status === 200 && hook.data?.processed === true, JSON.stringify(hook.data || hook.error));

  const dupe = await new Jar('hook').call('/api/v1/webhooks/mock', { method: 'POST', body: event });
  assert('a replayed webhook event is ignored', dupe.data?.reason === 'duplicate_event' || dupe.data?.ignored === true, JSON.stringify(dupe.data));
  assert('webhook ledger keeps one row per event', (await WebhookEvent.countDocuments({ eventId: event.id })) === 1);

  const order = await Order.findById(orderId);
  assert('order is paid and fulfilled', order?.paymentStatus === 'paid' && order?.fulfillmentStatus === 'fulfilled', `${order?.orderNumber} ${order?.totalMinor} ${order?.currency}`);

  const mails = await EmailMessage.find({ order: orderId }).sort({ createdAt: 1 });
  const templates = mails.map((m) => m.template);
  assert('student receipt is queued', templates.includes('order_paid'), mails.find((m) => m.template === 'order_paid')?.to);
  assert('admin is notified of the sale', templates.includes('purchase_admin_notice'), mails.find((m) => m.template === 'purchase_admin_notice')?.to);

  const library = await jar.call('/api/v1/student/courses?limit=60');
  const enrolled = library.data?.courses?.find((c) => c.slug === accelerator.slug);
  assert('entitlement opens the course in the library', Boolean(enrolled) && enrolled.access === 'full', `${enrolled?.lessonCount} lessons`);

  const detail = await jar.call(`/api/v1/student/courses/${accelerator.slug}`);
  const firstVideo = (detail.data?.curriculum || []).flatMap((m) => m.lessons).find((l) => l.hasVideo && !l.isPreview);
  assert('curriculum publishes every accelerator lesson', (detail.data?.curriculum || []).flatMap((m) => m.lessons).length === 11, `${(detail.data?.curriculum || []).length} modules`);

  const outsider = new Jar('outsider');
  await outsider.withCsrf();
  const anonEmail = `preview.${randomUUID().slice(0, 8)}@verify.test`;
  const outsiderUser = new User({ name: 'Preview Watcher', email: anonEmail, role: 'student', emailVerified: true });
  await outsiderUser.setPassword(password);
  await outsiderUser.save();
  await outsider.call('/api/v1/auth/login', { method: 'POST', body: { identifier: anonEmail, password } });
  const refused = await outsider.call(`/api/v1/video/lessons/${firstVideo.id}/playback`, { method: 'POST', body: {} });
  assert('a non-owner is refused the paid lesson', refused.status === 403, refused.error?.code);

  const preview = (detail.data?.curriculum || []).flatMap((m) => m.lessons).find((l) => l.isPreview);
  const previewPlay = await outsider.call(`/api/v1/video/lessons/${preview.id}/playback`, { method: 'POST', body: {} });
  assert('the intro lesson plays as a preview', previewPlay.data?.playback?.playbackType === 'iframe', JSON.stringify(previewPlay.error || {}));
  await outsider.call(`/api/v1/video/playback/${previewPlay.data.playback.sessionId}`, { method: 'DELETE' });

  const anonymous = new Jar('anon');
  await anonymous.withCsrf();
  const anonPlay = await anonymous.call(`/api/v1/video/lessons/${preview.id}/playback`, { method: 'POST', body: {} });
  assert('playback always needs a session', anonPlay.status === 401, anonPlay.error?.code);

  const play = await jar.call(`/api/v1/video/lessons/${firstVideo.id}/playback`, { method: 'POST', body: {} });
  const issued = play.data?.playback || {};
  let playerUrl = null;
  try {
    playerUrl = new URL(issued.playbackUrl);
  } catch {
    playerUrl = null;
  }
  // Each course lives in its own Bunny library, so the embed has to name that
  // library rather than whatever the server falls back to.
  const courseLibrary = (await Course.findOne({ slug: '10-part-consciousness-accelerator' }))?.bunnyLibraryId;
  assert('playback uses the PlayerJS iframe the client accepts',
    issued.playbackType === 'iframe'
      && playerUrl?.origin === 'https://player.mediadelivery.net'
      && Boolean(courseLibrary)
      && new RegExp(`^/embed/${courseLibrary}/[a-f\\d-]{36}/?$`, 'i').test(playerUrl?.pathname || ''),
    issued.playbackUrl);
  assert('playback expires and heartbeats', Boolean(issued.expiresAt) && Number(issued.heartbeatSeconds) > 0, `ttl ${issued.expiresAt}`);
  assert('watermark carries name, email and session id',
    issued.watermark?.enabled === true
      && issued.watermark.text.includes('Verify Student')
      && issued.watermark.text.includes(email)
      && issued.watermark.moveSeconds > 0,
    issued.watermark?.text);

  const second = await jar.call(`/api/v1/video/lessons/${firstVideo.id}/playback`, { method: 'POST', body: {} });
  assert('a new player takes the slot instead of being locked out', second.status === 200 && Boolean(second.data?.playback?.sessionId), JSON.stringify(second.error || {}));
  const holder = second.data?.playback || issued;

  const displaced = await jar.call(`/api/v1/video/playback/${issued.sessionId}/heartbeat`, { method: 'POST', body: {} });
  assert('the displaced tab is told within one heartbeat', displaced.status === 410, JSON.stringify(displaced.error || {}));

  const heart = await jar.call(`/api/v1/video/playback/${holder.sessionId}/heartbeat`, { method: 'POST', body: { positionSeconds: 40 } });
  assert('heartbeat keeps the session alive', heart.status === 200, JSON.stringify(heart.data || heart.error));

  const saved = await jar.call(`/api/v1/student/lessons/${firstVideo.id}/progress`, { method: 'POST', body: { sessionId: holder.sessionId, positionSeconds: 55, watchedDeltaSeconds: 50 } });
  assert('resume position is stored', saved.data?.lastPositionSeconds === 55, JSON.stringify(saved.data));

  const done = await jar.call(`/api/v1/student/lessons/${firstVideo.id}/complete`, { method: 'POST', body: {} });
  assert('lesson completion is stored', done.data?.completed === true);

  const stop = await jar.call(`/api/v1/video/playback/${holder.sessionId}`, { method: 'DELETE' });
  assert('closing the player releases the slot', stop.status === 200 || stop.status === 204, JSON.stringify(stop.data || stop.error));
  assert('the released session is marked ended', (await PlaybackSession.countDocuments({ token: holder.sessionId, endedAt: { $ne: null } })) === 1);

  const again = await jar.call(`/api/v1/video/lessons/${firstVideo.id}/playback`, { method: 'POST', body: {} });
  assert('a released slot allows a new viewer', again.status === 200 && Boolean(again.data?.playback?.sessionId));
  await jar.call(`/api/v1/video/playback/${again.data.playback.sessionId}`, { method: 'DELETE' });

  const openBefore = await PlaybackSession.countDocuments({ student: student.id, endedAt: null });
  const signedOut = await jar.call('/api/v1/auth/logout', { method: 'POST', body: {} });
  assert('signing out releases the video slot', signedOut.status === 204 && (await PlaybackSession.countDocuments({ student: student.id, endedAt: null })) === 0, `${signedOut.status} from ${openBefore}`);
  await jar.withCsrf();
  await jar.call('/api/v1/auth/login', { method: 'POST', body: { identifier: email, password } });

  const repurchase = await jar.call('/api/v1/cart/checkout', {
    method: 'POST',
    headers: { 'Idempotency-Key': `verify-${randomUUID()}` },
    body: { items: [{ productKind: 'course', productId: accelerator.slug }] }
  });
  assert('an owned course is not sold twice', repurchase.status === 409 && repurchase.error?.code === 'already_owned', repurchase.error?.code);

  const adminEmail = `admin.${randomUUID().slice(0, 8)}@verify.test`;
  const admin = new User({ name: 'Verify Admin', email: adminEmail, role: 'admin', emailVerified: true });
  await admin.setPassword(password);
  await admin.save();
  const staff = new Jar('admin');
  await staff.withCsrf();
  await staff.call('/api/v1/auth/login', { method: 'POST', body: { identifier: adminEmail, password } });

  const studentRead = await jar.call('/api/v1/admin/orders?page=1&limit=25');
  assert('orders are staff-only', studentRead.status === 403 || studentRead.status === 401, studentRead.error?.code);

  const list = await staff.call('/api/v1/admin/orders?page=1&limit=25');
  const row = list.data?.orders?.find((o) => o.id === String(orderId));
  assert('admin sees the paid order', row?.paymentStatus === 'paid' && Boolean(row?.student?.name), `${row?.orderNumber} · ${row?.student?.name}`);

  const search = await staff.call(`/api/v1/admin/orders?search=${encodeURIComponent(email)}&page=1&limit=25`);
  assert('admin can search orders by student', search.data?.orders?.some((o) => o.id === String(orderId)) === true, `${search.data?.orders?.length} hit(s)`);

  const record1 = await staff.call(`/api/v1/admin/orders/${orderId}`);
  const snapshot = record1.data?.order || {};
  assert('order detail exposes payment and refund history',
    Boolean(snapshot.order) && Boolean(snapshot.detail) && snapshot.payments?.[0]?.status === 'succeeded' && Array.isArray(snapshot.refunds),
    `refunded ${snapshot.detail?.refundedMinor} of ${snapshot.order?.totalMinor}`);

  const tooMuch = await staff.call(`/api/v1/admin/orders/${orderId}/refund`, {
    method: 'POST',
    headers: { 'Idempotency-Key': `verify-refund-${randomUUID()}` },
    body: { reason: 'requested_by_customer', note: 'More than the balance', amountMinor: 99999 }
  });
  assert('an over-balance refund is rejected', tooMuch.status === 400 && tooMuch.error?.code === 'bad_request', tooMuch.error?.message);

  const refundKey = `verify-refund-${randomUUID()}`;
  const refundBody = { reason: 'policy', note: 'Refund policy check in verification' };
  const refund1 = await staff.call(`/api/v1/admin/orders/${orderId}/refund`, { method: 'POST', headers: { 'Idempotency-Key': refundKey }, body: refundBody });
  assert('admin refunds the order in full', refund1.data?.refund?.status === 'succeeded' && refund1.data?.refund?.amountMinor === 19900, JSON.stringify(refund1.data?.refund || refund1.error));
  assert('a full refund revokes access', refund1.data?.refund?.entitlementAction === 'revoked' && refund1.data?.refund?.entitlementsRevoked === 1, `revoked ${refund1.data?.refund?.entitlementsRevoked}`);

  const refund2 = await staff.call(`/api/v1/admin/orders/${orderId}/refund`, { method: 'POST', headers: { 'Idempotency-Key': refundKey }, body: refundBody });
  assert('replaying the refund key does not pay twice', refund2.data?.refund?.id === refund1.data?.refund?.id && refund2.data?.replayed === true, refund2.data?.refund?.status);

  const afterRefund = await Order.findById(orderId);
  assert('the order is marked refunded', afterRefund?.paymentStatus === 'refunded' && afterRefund?.fulfillmentStatus === 'reversed', `refundedMinor ${afterRefund?.refundedMinor}`);
  const entitlement = await Entitlement.findOne({ student: student._id, course: (await Course.findOne({ slug: accelerator.slug }))._id });
  assert('the entitlement row is revoked, not deleted', entitlement?.status === 'revoked' && Boolean(entitlement?.revokedAt));

  const lockedLibrary = await jar.call('/api/v1/student/courses?limit=60');
  const revokedRow = lockedLibrary.data?.courses?.find((c) => c.slug === accelerator.slug);
  assert('a refunded course shows revoked, not open', revokedRow?.access === 'revoked', revokedRow?.access);
  const blockedPlay = await jar.call(`/api/v1/video/lessons/${firstVideo.id}/playback`, { method: 'POST', body: {} });
  assert('a refunded student loses playback', blockedPlay.status === 403, blockedPlay.error?.code);

  const previewStill = await outsider.call(`/api/v1/video/lessons/${preview.id}/playback`, { method: 'POST', body: {} });
  assert('the free preview stays open', previewStill.status === 200, previewStill.error?.code);
  await outsider.call(`/api/v1/video/playback/${previewStill.data.playback.sessionId}`, { method: 'DELETE' });

  const csrfless = await fetch(`${origin}/api/v1/cart/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: [...jar.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ') },
    body: JSON.stringify({ items: [{ productKind: 'course', productId: accelerator.slug }] })
  });
  assert('a mutation without the CSRF token is refused', csrfless.status === 403, (await csrfless.json())?.error?.code);

  const anonCourse = await new Jar('anon').call(`/api/v1/courses/${accelerator.slug}`);
  const publicLessons = (anonCourse.data?.curriculum || []).flatMap((m) => m.lessons);
  assert('public course page hides locked lessons',
    anonCourse.data?.access === 'none'
      && publicLessons.filter((l) => l.isPreview).every((l) => l.locked === false)
      && publicLessons.filter((l) => !l.isPreview).every((l) => l.locked === true),
    `${publicLessons.filter((l) => l.locked).length}/${publicLessons.length} locked`);

  const missing = await new Jar('anon').call('/api/v1/not-a-route');
  assert('unknown routes answer with the error envelope', missing.status === 404 && missing.error?.code === 'not_found');
} catch (err) {
  record('verification crashed', false, err.stack || err.message);
} finally {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await mongo.stop();
  process.exit(failed.length ? 1 : 0);
}
