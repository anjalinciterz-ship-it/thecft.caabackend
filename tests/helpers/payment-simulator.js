import { randomUUID } from 'node:crypto';

const apiOrigin = () => process.env.BACKEND_URL || 'http://127.0.0.1:5051';

const types = {
  success: 'checkout.session.completed',
  paid: 'checkout.session.completed',
  expired: 'checkout.session.expired',
  failed: 'checkout.failed'
};

// Stands in for the provider: it builds the same event shape Stripe would send and
// posts it to the mock webhook, so fulfilment is exercised through the real door.
export function paymentEvent(orderId, outcome = 'success') {
  const type = types[outcome] || types.success;
  return {
    id: `mock_evt_${randomUUID()}`,
    type,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `mock_cs_${orderId}`,
        object: 'checkout.session',
        payment_status: type === 'checkout.session.completed' ? 'paid' : 'unpaid',
        payment_intent: type === 'checkout.session.completed' ? `mock_pi_${orderId}` : null,
        amount_total: 0,
        currency: 'cad',
        metadata: { orderId: String(orderId) },
        client_reference_id: String(orderId)
      }
    }
  };
}

export async function deliver(event) {
  const response = await fetch(`${apiOrigin()}/api/v1/webhooks/mock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Mock webhook rejected (${response.status}): ${body?.error?.message || 'unknown'}`);
  return body.data;
}

export default { paymentEvent, deliver };
