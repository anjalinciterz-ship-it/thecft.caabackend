import { Counter, Course, EmailMessage, Entitlement, Notification, Order, Payment, AuditLog, User } from '../models/index.js';
import { env } from '../config/env.js';
import { ApiError } from '../lib/http.js';
import { sendEmail } from './email.js';

const sequence = async (name) => {
  const row = await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return row.seq;
};

export const orderNumber = async () => `MLA-${new Date().getFullYear()}-${String(await sequence('order')).padStart(5, '0')}`;

export function accessUntilFor(course, from = new Date()) {
  if (course.accessPolicy !== 'expiring' || !course.accessMonths) return null;
  return new Date(from.getTime() + course.accessMonths * 30.44 * 24 * 60 * 60 * 1000);
}

export async function createOrder({ user, priced, discountCode, email, idempotencyKey }) {
  if (priced.items.length === 0) throw ApiError.badRequest('cart_empty', 'Choose something to enrol in first.');

  const created = await Order.create({
    orderNumber: await orderNumber(),
    student: user?.id,
    email: email || user?.email,
    items: priced.items,
    currency: priced.currency,
    subtotalMinor: priced.subtotalMinor,
    discountMinor: priced.discountMinor,
    totalMinor: priced.totalMinor,
    discountCode: discountCode || undefined,
    provider: env.stripeConfigured ? 'stripe' : 'mock',
    idempotencyKey: idempotencyKey || undefined
  });
  return created;
}

export async function priceItems(items, discountCode, user) {
  const lines = [];
  for (const item of items) {
    if (item.productKind && item.productKind !== 'course') {
      throw ApiError.badRequest('unknown_product_kind', 'Only courses can be purchased here.');
    }
    const course = await Course.findOne({
      $or: [{ _id: /^[a-f\d]{24}$/i.test(String(item.productId)) ? item.productId : null }, { slug: item.productId }, { legacyId: item.productId }]
    }).catch(() => null);
    if (!course) throw ApiError.notFound('That course is no longer on sale.');
    if (course.availableForPurchase === false || course.publicationStatus !== 'published') {
      throw ApiError.conflict('not_available', 'This course is not open for enrolment yet.');
    }
    if (user) {
      const owned = await Entitlement.findOne({ student: user.id, course: course.id, status: 'active' });
      if (owned) throw ApiError.conflict('already_owned', 'You already have access to this course.');
    }
    lines.push({
      course: course.id,
      title: course.title,
      unitPriceMinor: course.isFree ? 0 : course.priceMinor,
      quantity: 1,
      lineTotalMinor: course.isFree ? 0 : course.priceMinor,
      currency: course.currency
    });
  }

  const currencies = [...new Set(lines.map((l) => l.currency))];
  if (currencies.length > 1) throw ApiError.conflict('mixed_currencies', 'These courses cannot be bought together.');
  const currency = currencies[0] || 'USD';
  const subtotalMinor = lines.reduce((sum, l) => sum + l.lineTotalMinor, 0);
  const discountMinor = discountCode ? await discountFor(discountCode) : 0;

  return {
    currency,
    items: lines,
    subtotalMinor,
    discountMinor,
    totalMinor: Math.max(subtotalMinor - discountMinor, 0)
  };
}

async function discountFor(code) {
  // Discount documents are not modelled yet; any code is refused rather than silently ignored.
  throw new ApiError('invalid_discount_code', 422, `“${code}” is not a valid discount code.`, {
    issues: [{ path: 'discountCode', field: 'discountCode', message: 'Unknown discount code.' }]
  });
}

// A bundle is bought as a single line but opens every offering inside it, so both
// sides of the ledger have to expand it the same way.
export const entitlementCourses = async (course) => {
  const included = (course.bundleIncludes || []).filter(Boolean);
  if (!included.length) return [course];
  return [course, ...(await Course.find({ _id: { $in: included } }))];
};

export async function fulfilOrder({ order, event = null, actor = null }) {
  if (order.paymentStatus === 'paid' && order.fulfillmentStatus === 'fulfilled') {
    return { order, fulfilled: false, alreadyFulfilled: true };
  }

  const courses = [];
  for (const item of order.items) {
    const course = await Course.findById(item.course);
    if (!course) continue;
    courses.push(course);
    if (!order.student) continue;
    for (const granted of await entitlementCourses(course)) {
      await Entitlement.findOneAndUpdate(
        { student: order.student, course: granted.id },
        {
          $set: {
            status: 'active',
            source: 'purchase',
            order: order.id,
            accessUntil: accessUntilFor(granted, order.paidAt || new Date())
          },
          $setOnInsert: { grantedAt: new Date() }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }
  }

  order.paymentStatus = 'paid';
  order.fulfillmentStatus = 'fulfilled';
  order.paidAt = order.paidAt || new Date();
  if (event?.id) order.providerSessionId = event.id;
  await order.save();

  await Payment.findOneAndUpdate(
    { order: order.id },
    {
      $set: {
        status: 'succeeded',
        amountMinor: order.totalMinor,
        currency: order.currency,
        provider: order.provider,
        student: order.student,
        paidAt: order.paidAt,
        stripePaymentIntentId: order.providerChargeId || undefined
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  if (order.student && courses.length) {
    const student = await User.findById(order.student);
    if (student) {
      await sendEmail({
        template: 'order_paid',
        to: student.email,
        student,
        order,
        courses,
        orderRef: order.id,
        studentRef: student.id
      });
      if (env.ADMIN_NOTIFY_EMAIL) {
        await sendEmail({
          template: 'purchase_admin_notice',
          to: env.ADMIN_NOTIFY_EMAIL,
          student,
          order,
          courses,
          orderRef: order.id,
          studentRef: student.id
        });
      }
      await Notification.create({
        recipient: student.id,
        type: 'order',
        title: `${courses[0].title} is open`,
        body: 'Your payment is confirmed. Start the first lesson whenever you are ready.',
        link: `/dashboard/courses/${courses[0].slug}`
      });
    }
  }

  await AuditLog.create({
    actor: actor?.id,
    actorEmail: actor?.email || order.email,
    action: 'order.fulfilled',
    targetKind: 'order',
    targetId: String(order.id),
    summary: `${order.orderNumber} paid ${(order.totalMinor / 100).toFixed(2)} ${order.currency}`,
    meta: { provider: order.provider, sessionId: order.providerSessionId }
  });

  return { order, fulfilled: true, courses };
}

export async function markOrderUnpaid(order, { reason, actor }) {
  order.paymentStatus = 'cancelled';
  order.failureReason = reason;
  await order.save();
  await AuditLog.create({
    actor: actor?.id,
    actorEmail: actor?.email,
    action: 'order.cancelled',
    targetKind: 'order',
    targetId: String(order.id),
    summary: reason
  });
  return order;
}

export async function applyRefund(order, { amountMinor, reason, actor, revokeAccess = true }) {
  const refunded = Math.min(order.totalMinor, (order.refundedMinor || 0) + amountMinor);
  const fullyRefunded = refunded >= order.totalMinor;
  order.refundedMinor = refunded;
  order.refundedAt = new Date();
  order.refundReason = reason;
  order.paymentStatus = fullyRefunded ? 'refunded' : 'partially_refunded';
  if (fullyRefunded) order.fulfillmentStatus = 'reversed';
  await order.save();

  let revokedCount = 0;
  if (revokeAccess && order.student) {
    for (const item of order.items) {
      const course = await Course.findById(item.course);
      const targets = course ? await entitlementCourses(course) : [{ id: item.course }];
      for (const target of targets) {
        // Scoped to this order so a separately bought course cannot be revoked
        // when the bundle that also contained it is refunded.
        const result = await Entitlement.updateOne(
          { student: order.student, course: target.id, order: order.id, status: 'active' },
          { $set: { status: 'revoked', revokedAt: new Date(), revokedBy: actor?.id, revokeReason: reason } }
        );
        revokedCount += result.modifiedCount || 0;
      }
    }
  }

  await Payment.findOneAndUpdate(
    { order: order.id, status: { $in: ['succeeded', 'partially_refunded'] } },
    {
      $set: {
        amountRefundedMinor: refunded,
        status: fullyRefunded ? 'refunded' : 'partially_refunded'
      }
    }
  ).catch(() => null);

  await AuditLog.create({
    actor: actor?.id,
    actorEmail: actor?.email,
    action: 'order.refunded',
    targetKind: 'order',
    targetId: String(order.id),
    summary: `Refunded ${(amountMinor / 100).toFixed(2)} ${order.currency}: ${reason}`,
    meta: { reason, amountMinor, revokeAccess, entitlementsRevoked: revokedCount }
  });
  return { order, refundedMinor: refunded, fullyRefunded, entitlementsRevoked: revokedCount };
}

export const reverseFulfillment = (order, { amountMinor, reason, actor }) =>
  applyRefund(order, { amountMinor, reason, actor, revokeAccess: true });

export const emailLedgerFor = async (orderId) => EmailMessage.find({ order: orderId }).sort({ createdAt: 1 });
