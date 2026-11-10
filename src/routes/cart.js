import { Router } from 'express';
import { z } from 'zod';
import { Course, Lesson, Order } from '../models/index.js';
import { ApiError, asyncHandler, ok, paginated } from '../lib/http.js';
import { validate } from '../lib/validate.js';
import { requireSignIn } from '../lib/security.js';
import { createCheckout } from '../services/payments/index.js';
import { createOrder, fulfilOrder, priceItems } from '../services/orders.js';

export const router = Router();

const cartSchema = z.object({
  items: z
    .array(
      z.object({
        productKind: z.string().optional(),
        productId: z.string().min(1),
        quantity: z.number().int().min(1).max(1).default(1)
      })
    )
    .min(1, 'Choose at least one course.')
    .max(10),
  discountCode: z.string().max(40).optional()
});

const orderSummary = (order) => ({
  id: String(order._id),
  orderNumber: order.orderNumber,
  paymentStatus: order.paymentStatus,
  fulfillmentStatus: order.fulfillmentStatus,
  checkoutUrl: order.checkoutUrl || null,
  totalMinor: order.totalMinor,
  currency: order.currency,
  createdAt: order.createdAt,
  paidAt: order.paidAt,
  items: order.items.map((i) => ({ title: i.title, unitPriceMinor: i.unitPriceMinor, currency: i.currency }))
});

// Charging for a course with nothing published in it is the one mistake a buyer
// can never forgive, so the quote is checked against real lessons before money moves.
async function assertDeliverable(lines) {
  for (const line of lines) {
    if (line.unitPriceMinor === 0) continue;
    const course = await Course.findById(line.course);
    // A bundle carries no lessons of its own, it sells the ones inside the
    // offerings it names, so each of those has to be deliverable instead.
    const sources = course?.bundleIncludes?.length
      ? course.bundleIncludes
      : [course?._id];
    if (!sources[0]) {
      throw ApiError.conflict('not_deliverable', `${line.title} has no published lessons yet, so it cannot be sold.`);
    }
    for (const source of sources) {
      const lessons = await Lesson.countDocuments({ course: source, publicationStatus: 'published' });
      if (lessons === 0) {
        throw ApiError.conflict('not_deliverable', `${line.title} has no published lessons yet, so it cannot be sold.`);
      }
    }
  }
}

router.post(
  '/cart/price',
  asyncHandler(async (req, res) => {
    const payload = validate(cartSchema, req.body);
    ok(res, await priceItems(payload.items, payload.discountCode, req.user || null));
  })
);

router.post(
  '/cart/checkout',
  requireSignIn,
  asyncHandler(async (req, res) => {
    const payload = validate(cartSchema, req.body);
    const idempotencyKey = req.get('Idempotency-Key') || null;
    if (!req.user.email) {
      throw new ApiError('email_required', 422, 'Add and verify an email before enrolling.', {
        issues: [{ path: 'email', field: 'email', message: 'A verified email is required for receipts and access.' }]
      });
    }

    if (idempotencyKey) {
      const existing = await Order.findOne({ idempotencyKey, student: req.user.id });
      if (existing) {
        if (existing.paymentStatus === 'pending' && !existing.checkoutUrl) {
          const restarted = await createCheckout({ order: existing, user: req.user });
          if (restarted.url) {
            existing.checkoutUrl = restarted.url;
            existing.providerSessionId = restarted.sessionId;
            await existing.save();
          } else if (restarted.status === 'paid') {
            await fulfilOrder({ order: existing, actor: req.user });
          }
        }
        return ok(res, {
          checkoutUrl: existing.checkoutUrl || null,
          status: existing.paymentStatus === 'paid' ? 'paid' : existing.paymentStatus,
          order: orderSummary(existing)
        });
      }
    }

    const priced = await priceItems(payload.items, payload.discountCode, req.user);
    await assertDeliverable(priced.items);

    const order = await createOrder({
      user: req.user,
      priced,
      discountCode: payload.discountCode,
      email: req.user.email,
      idempotencyKey
    });

    const started = await createCheckout({ order, user: req.user });
    order.checkoutUrl = started.url || undefined;
    order.providerSessionId = started.sessionId;
    await order.save();

    if (started.status === 'paid') {
      await fulfilOrder({ order, actor: req.user });
      return ok(res, { checkoutUrl: null, status: 'paid', order: orderSummary(order) });
    }

    ok(res, { checkoutUrl: started.url, status: 'pending', order: orderSummary(order) });
  })
);

router.get(
  '/orders',
  requireSignIn,
  asyncHandler(async (req, res) => {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const filter = { student: req.user.id };
    const [rows, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      Order.countDocuments(filter)
    ]);
    paginated(res, { orders: rows.map(orderSummary) }, { total, page, pages: Math.ceil(total / limit) || 1 });
  })
);

router.get(
  '/orders/:id',
  requireSignIn,
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id);
    if (!order || String(order.student) !== String(req.user.id)) throw ApiError.notFound('Order not found.');
    ok(res, { order: orderSummary(order) });
  })
);

export default router;
