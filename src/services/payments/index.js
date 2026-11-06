import Stripe from 'stripe';
import { env } from '../../config/env.js';
import { ApiError } from '../../lib/http.js';

let stripe;
const client = () =>
  stripe ||
  (stripe = new Stripe(env.STRIPE_API_KEY, { apiVersion: '2024-06-20', appInfo: { name: 'cft-backend' } }));

export const providerName = () => (env.stripeConfigured ? 'stripe' : 'mock');

export function assertCheckoutPossible() {
  if (env.stripeConfigured) return;
  if (env.PAYMENT_PROVIDER === 'stripe') {
    throw new ApiError('stripe_not_configured', 503, 'Card payments are not configured on this server.');
  }
}

export async function createCheckout({ order, user }) {
  if (order.totalMinor === 0) return { status: 'paid', url: null, sessionId: `free_${order.id}` };

  if (env.stripeConfigured) {
    const session = await client().checkout.sessions.create(
      {
        mode: 'payment',
        customer_email: user?.email || order.email || undefined,
        client_reference_id: String(order.id),
        line_items: order.items.map((item) => ({
          quantity: 1,
          price_data: {
            currency: item.currency.toLowerCase(),
            unit_amount: item.unitPriceMinor,
            product_data: { name: item.title, description: 'Mind Life Academy online course access' }
          }
        })),
        metadata: { orderId: String(order.id), orderNumber: order.orderNumber },
        success_url: `${env.FRONTEND_URL}/dashboard?checkout=success&order=${order.id}`,
        cancel_url: `${env.FRONTEND_URL}/dashboard?checkout=cancelled&order=${order.id}`,
        allow_promotion_codes: true
      },
      { idempotencyKey: order.idempotencyKey }
    );
    return { status: 'pending', url: session.url, sessionId: session.id };
  }

  // Mock mode mirrors Stripe's shape: the order stays pending until a provider
  // confirmation arrives on /webhooks/mock. The client only ever follows a URL
  // pointing at checkout.stripe.com, so no URL is returned here.
  assertCheckoutPossible();
  return { status: 'pending', url: null, sessionId: `mock_${order.id}` };
}

export async function refund({ order, amountMinor, reason }) {
  if (env.stripeConfigured) {
    if (!order.providerChargeId) throw ApiError.conflict('refund_unavailable', 'No charge to refund yet.');
    const refundRow = await client().refunds.create({ charge: order.providerChargeId, amount: amountMinor });
    return { providerRefundId: refundRow.id, amountMinor: refundRow.amount_remaining === 0 ? order.totalMinor : amountMinor };
  }
  if (!order.providerSessionId?.startsWith('mock_')) {
    throw new ApiError('stripe_not_configured', 503, 'This order was never charged on this server.');
  }
  return { providerRefundId: `mock_re_${order.id}`, amountMinor };
}

export function parseWebhook({ rawBody, signature, provider = 'stripe' }) {
  if (provider === 'mock') {
    let event;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw ApiError.badRequest('invalid_event', 'That payment event could not be read.');
    }
    return { verified: true, synthetic: true, eventId: event.id, type: event.type, object: event.data?.object };
  }
  if (!env.STRIPE_WEBHOOK_SIGNING_KEY) {
    throw new ApiError('stripe_webhook_unconfigured', 503, 'Stripe webhook signing is not configured.');
  }
  try {
    const event = client().webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SIGNING_KEY);
    return { verified: true, eventId: event.id, type: event.type, object: event.data.object };
  } catch (err) {
    return { verified: false, reason: err.message };
  }
}

export const stripeStatus = () => ({
  provider: providerName(),
  live: env.STRIPE_API_KEY.startsWith('sk_live'),
  test: env.STRIPE_API_KEY.startsWith('sk_test'),
  webhookSigningConfigured: Boolean(env.STRIPE_WEBHOOK_SIGNING_KEY),
  publishableConfigured: Boolean(env.STRIPE_PUBLISHABLE_KEY)
});
