import { Router, raw } from 'express';
import { env } from '../config/env.js';
import { ApiError, asyncHandler, ok } from '../lib/http.js';
import { WebhookEvent, Order, AuditLog } from '../models/index.js';
import { parseWebhook } from '../services/payments/index.js';
import { fulfilOrder, reverseFulfillment } from '../services/orders.js';

export const router = Router();

async function record({ provider, eventId, type, payload }) {
  const existing = await WebhookEvent.findOne({ eventId });
  if (existing) return { duplicate: true, row: existing };
  const row = await WebhookEvent.create({ provider, eventId, type, payload, status: 'received' });
  return { duplicate: false, row };
}

async function orderForSession(object) {
  const orderId = object?.metadata?.orderId || object?.client_reference_id;
  if (orderId) {
    const byMeta = await Order.findById(orderId);
    if (byMeta) return byMeta;
  }
  if (object?.id) return Order.findOne({ providerSessionId: object.id });
  return null;
}

export async function handlePaymentEvent({ provider, eventId, type, object, rawPayload }) {
  const { duplicate, row } = await record({ provider, eventId, type, payload: rawPayload });
  if (duplicate) return { ignored: true, reason: 'duplicate_event' };

  try {
    const order = await orderForSession(object);
    if (!order) throw ApiError.notFound('No order matches that payment session.');
    row.order = order._id;

    if (type === 'checkout.session.completed' || type === 'checkout.session.paid') {
      if (object.payment_intent) order.providerChargeId = String(object.payment_intent);
      order.providerSessionId = object.id || order.providerSessionId;
      await order.save();
      await fulfilOrder({ order });
    } else if (type === 'charge.refunded') {
      await reverseFulfillment(order, {
        amountMinor: object.amount_refunded ?? order.totalMinor,
        reason: object.refunds?.data?.[0]?.reason || 'provider_refund',
        actor: null
      });
    } else if (type === 'checkout.session.expired') {
      if (order.paymentStatus === 'pending') {
        order.paymentStatus = 'cancelled';
        order.failureReason = 'checkout_expired';
        await order.save();
      }
    }

    row.status = 'processed';
    row.processedAt = new Date();
    await row.save();
    return { processed: true, orderId: String(order._id) };
  } catch (err) {
    row.status = 'failed';
    row.error = err.message;
    await row.save();
    throw err;
  }
}

router.post(
  '/stripe',
  raw({ type: 'application/json' }),
  asyncHandler(async (req, res) => {
    const event = parseWebhook({ rawBody: req.body, signature: req.get('stripe-signature'), provider: 'stripe' });
    if (!event.verified) {
      await AuditLog.create({ action: 'webhook.rejected', targetKind: 'stripe', summary: event.reason, ip: req.ip });
      throw ApiError.badRequest('webhook_signature_invalid', 'That webhook signature does not match.');
    }
    const result = await handlePaymentEvent({
      provider: 'stripe',
      eventId: event.eventId,
      type: event.type,
      object: event.object,
      rawPayload: event.object
    });
    ok(res, result);
  })
);

// Only mounted when mock payments are allowed; the e2e suite fulfils through this door.
if (env.PAYMENT_MOCK_ENABLED) {
  router.post(
    '/mock',
    // Raw body everywhere: this router is mounted before the global JSON parser so
    // Stripe signature verification sees the exact bytes Stripe signed.
    raw({ type: '*/*', limit: '1mb' }),
    asyncHandler(async (req, res) => {
      const event = parseWebhook({ rawBody: req.body, provider: 'mock' });
      const result = await handlePaymentEvent({
        provider: 'mock',
        eventId: event.eventId,
        type: event.type,
        object: event.object,
        rawPayload: event.object
      });
      ok(res, result);
    })
  );
}

export default router;
