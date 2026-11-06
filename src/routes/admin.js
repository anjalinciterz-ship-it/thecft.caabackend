import { Router } from 'express';
import { z } from 'zod';
import { AuditLog, Entitlement, Order, Payment, Refund, User } from '../models/index.js';
import { ApiError, asyncHandler, ok, paginated } from '../lib/http.js';
import { validate } from '../lib/validate.js';
import { clientIp, requireRoles } from '../lib/security.js';
import { applyRefund } from '../services/orders.js';
import { refund as refundThroughProvider } from '../services/payments/index.js';

export const router = Router();

const STAFF = requireRoles('admin', 'content_manager');
const idFilter = (ref) => (/^[a-f\d]{24}$/i.test(String(ref)) ? { _id: ref } : { orderNumber: String(ref) });

const orderView = (order, student) => ({
  id: String(order._id),
  orderNumber: order.orderNumber,
  email: order.email,
  student: student ? { id: String(student._id), name: student.name, email: student.email } : {},
  items: order.items.map((item) => ({
    title: item.title,
    quantity: item.quantity || 1,
    unitPriceMinor: item.unitPriceMinor,
    lineTotalMinor: item.lineTotalMinor ?? item.unitPriceMinor
  })),
  currency: order.currency,
  totalMinor: order.totalMinor,
  paymentStatus: order.paymentStatus,
  fulfillmentStatus: order.fulfillmentStatus,
  refundStatus: order.refundStatus,
  provider: order.provider,
  createdAt: order.createdAt,
  paidAt: order.paidAt
});

async function orderRecord(order) {
  const [student, payments, refunds, entitlements] = await Promise.all([
    order.student ? User.findById(order.student) : Promise.resolve(null),
    Payment.find({ order: order._id }).sort({ createdAt: 1 }),
    Refund.find({ order: order._id }).sort({ createdAt: 1 }),
    Entitlement.find({ order: order._id }).populate('course', 'title slug')
  ]);
  return {
    order: orderView(order, student),
    detail: {
      invoiceNumber: order.invoiceNumber || null,
      failureReason: order.failureReason || null,
      notes: order.notes || '',
      receiptUrl: order.receiptUrl || null,
      subtotalMinor: order.subtotalMinor,
      discountMinor: order.discountMinor,
      discountCode: order.discountCode || null,
      taxMinor: order.taxMinor,
      refundedMinor: order.refundedMinor,
      provider: order.provider,
      providerSessionId: order.providerSessionId || null
    },
    payments: payments.map((payment) => ({
      id: String(payment._id),
      status: payment.status,
      amountMinor: payment.amountMinor,
      amountRefundedMinor: payment.amountRefundedMinor,
      currency: payment.currency,
      cardBrand: payment.cardBrand || null,
      cardLast4: payment.cardLast4 || null,
      paidAt: payment.paidAt,
      createdAt: payment.createdAt,
      failureMessage: payment.failureMessage || null,
      stripePaymentIntentId: payment.stripePaymentIntentId || null,
      receiptUrl: payment.receiptUrl || null
    })),
    refunds: refunds.map((refund) => ({
      id: String(refund._id),
      status: refund.status,
      amountMinor: refund.amountMinor,
      currency: refund.currency,
      reason: refund.reason,
      entitlementAction: refund.entitlementAction,
      entitlementsRevoked: refund.entitlementsRevoked,
      processedAt: refund.processedAt,
      requestedBy: refund.requestedBy ? String(refund.requestedBy) : null
    })),
    entitlements: entitlements.map((entry) => ({
      id: String(entry._id),
      product: entry.course ? { id: String(entry.course._id), title: entry.course.title, slug: entry.course.slug } : null,
      productKind: 'course',
      status: entry.status,
      revokedAt: entry.revokedAt
    }))
  };
}

router.get(
  '/admin/orders',
  STAFF,
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    const status = String(req.query.status || '');
    const search = String(req.query.search || '').trim().slice(0, 120);
    const filter = {};
    if (status) filter.paymentStatus = status;
    if (search) {
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const students = await User.find({
        $or: [
          { email: { $regex: safe, $options: 'i' } },
          { firstName: { $regex: safe, $options: 'i' } },
          { lastName: { $regex: safe, $options: 'i' } }
        ]
      }).select('_id');
      filter.$or = [
        { orderNumber: { $regex: safe, $options: 'i' } },
        { email: { $regex: safe, $options: 'i' } },
        ...(students.length ? [{ student: { $in: students.map((s) => s._id) } }] : [])
      ];
    }
    const [rows, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      Order.countDocuments(filter)
    ]);
    const byId = new Map();
    for (const order of rows) {
      if (order.student) byId.set(String(order.student), await User.findById(order.student));
    }
    paginated(
      res,
      { orders: rows.map((order) => orderView(order, byId.get(String(order.student)))) },
      { total, page, pages: Math.max(1, Math.ceil(total / limit)) }
    );
  })
);

router.get(
  '/admin/orders/:id',
  STAFF,
  asyncHandler(async (req, res) => {
    const order = await Order.findOne(idFilter(req.params.id));
    if (!order) throw ApiError.notFound('That order was not found.');
    ok(res, { order: await orderRecord(order) });
  })
);

const refundSchema = z.object({
  reason: z.enum(['requested_by_customer', 'duplicate', 'fraudulent', 'policy', 'other']),
  note: z.string().trim().min(3).max(1000),
  amountMinor: z.number().int().positive().optional()
});

const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{8,128}$/;

router.post(
  '/admin/orders/:id/refund',
  requireRoles('admin'),
  asyncHandler(async (req, res) => {
    const key = req.get('Idempotency-Key') || '';
    if (!IDEMPOTENCY_KEY.test(key)) {
      throw ApiError.badRequest('idempotency_key_required', 'This refund needs a stable request key. Try again.');
    }
    const payload = validate(refundSchema, req.body);
    const order = await Order.findOne(idFilter(req.params.id));
    if (!order) throw ApiError.notFound('That order was not found.');

    // A retry of the same request never moves money twice, even after the first
    // attempt answered with an error the client could not read.
    const replay = await Refund.findOne({ idempotencyKey: key });
    if (replay) {
      if (String(replay.order) !== String(order._id)) {
        throw ApiError.conflict('idempotency_conflict', 'That request key belongs to a different order.');
      }
      ok(res, { refund: refundView(replay), order: await orderRecord(order), replayed: true });
      return;
    }

    if (!['paid', 'partially_refunded'].includes(order.paymentStatus)) {
      throw ApiError.conflict('not_refundable', 'Only a paid order can be refunded.');
    }
    const payment = await Payment.findOne({ order: order._id, status: { $in: ['succeeded', 'partially_refunded'] } });
    if (!payment) throw ApiError.conflict('no_successful_payment', 'No successful charge backs this order.');

    const reserved = await Refund.aggregate([
      { $match: { order: order._id, status: 'pending' } },
      { $group: { _id: null, total: { $sum: '$amountMinor' } } }
    ]);
    const remaining = Math.max(0, order.totalMinor - (order.refundedMinor || 0) - (reserved[0]?.total || 0));
    const amountMinor = payload.amountMinor ?? remaining;
    if (amountMinor <= 0 || amountMinor > remaining) {
      throw ApiError.badRequest(
        'bad_request',
        `Only ${remaining} minor units are unreserved on this order.`,
        { issues: [{ path: 'amountMinor', field: 'amountMinor', message: 'Amount exceeds the refundable balance.' }] }
      );
    }

    const request = await Refund.create({
      order: order._id,
      provider: order.provider,
      requestedBy: req.user.id,
      idempotencyKey: key,
      status: 'pending',
      amountMinor,
      currency: order.currency,
      reason: payload.reason,
      note: payload.note
    });

    try {
      const result = await refundThroughProvider({ order, amountMinor, reason: payload.reason });
      const fullyRefunded = amountMinor >= remaining;
      const applied = await applyRefund(order, {
        amountMinor,
        reason: `${payload.reason}: ${payload.note}`,
        actor: req.user,
        revokeAccess: fullyRefunded
      });
      request.status = 'succeeded';
      request.providerRefundId = result.providerRefundId;
      request.entitlementAction = fullyRefunded ? 'revoked' : 'retained';
      request.entitlementsRevoked = applied.entitlementsRevoked;
      request.processedAt = new Date();
      await request.save();
    } catch (err) {
      request.status = 'failed';
      request.failureMessage = err.message;
      request.processedAt = new Date();
      await request.save();
      throw err;
    }

    ok(res, { refund: refundView(request), order: await orderRecord(order) });
  })
);

const refundView = (refund) => ({
  id: String(refund._id),
  status: refund.status,
  amountMinor: refund.amountMinor,
  currency: refund.currency,
  reason: refund.reason,
  entitlementAction: refund.entitlementAction,
  entitlementsRevoked: refund.entitlementsRevoked,
  processedAt: refund.processedAt,
  failureMessage: refund.failureMessage || null
});

router.get(
  '/admin/entitlements',
  STAFF,
  asyncHandler(async (req, res) => {
    const search = String(req.query.search || '').trim().slice(0, 120);
    const filter = {};
    if (search) {
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const students = await User.find({ email: { $regex: safe, $options: 'i' } }).select('_id');
      if (!students.length) return paginated(res, { entitlements: [] }, { total: 0, page: 1, pages: 1 });
      filter.student = { $in: students.map((s) => s._id) };
    }
    if (req.query.status) filter.status = req.query.status;
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    const [rows, total] = await Promise.all([
      Entitlement.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('course', 'title slug').populate('student', 'name email firstName lastName'),
      Entitlement.countDocuments(filter)
    ]);
    paginated(
      res,
      {
        entitlements: rows.map((entry) => ({
          id: String(entry._id),
          status: entry.status,
          source: entry.source,
          grantedAt: entry.grantedAt,
          accessUntil: entry.accessUntil,
          course: entry.course ? { id: String(entry.course._id), title: entry.course.title, slug: entry.course.slug } : null,
          student: entry.student ? { id: String(entry.student._id), name: entry.student.name, email: entry.student.email } : null
        }))
      },
      { total, page, pages: Math.max(1, Math.ceil(total / limit)) }
    );
  })
);

const revokeSchema = z.object({ reason: z.string().trim().min(3).max(500) });

router.post(
  '/admin/entitlements/:id/revoke',
  requireRoles('admin'),
  asyncHandler(async (req, res) => {
    const payload = validate(revokeSchema, req.body);
    const entry = await Entitlement.findById(req.params.id);
    if (!entry) throw ApiError.notFound('That entitlement was not found.');
    entry.status = 'revoked';
    entry.revokedAt = new Date();
    entry.revokedBy = req.user.id;
    entry.revokeReason = payload.reason;
    await entry.save();
    await AuditLog.create({
      actor: req.user.id,
      actorEmail: req.user.email,
      action: 'entitlement.revoked',
      targetKind: 'entitlement',
      targetId: String(entry._id),
      summary: payload.reason,
      ip: clientIp(req)
    });
    ok(res, { entitlement: { id: String(entry._id), status: entry.status, revokedAt: entry.revokedAt } });
  })
);

export default router;
