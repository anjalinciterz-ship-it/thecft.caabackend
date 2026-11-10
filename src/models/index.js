import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const { Schema, model } = mongoose;
const timestamps = { timestamps: true };
const courseRef = { type: Schema.Types.ObjectId, ref: 'Course', required: true, index: true };
const userRef = { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true };

const splitName = (value = '') => {
  const parts = String(value).trim().split(/\s+/);
  return { firstName: parts.shift() || '', lastName: parts.join(' ') };
};

const userSchema = new Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, trim: true, default: '' },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    passwordHash: { type: String },
    googleId: { type: String, index: true, sparse: true },
    username: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
    avatarUrl: { type: String },
    role: { type: String, enum: ['student', 'admin', 'content_manager'], default: 'student', index: true },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
    emailVerified: { type: Boolean, default: false },
    timeZone: { type: String, default: 'UTC' },
    marketingOptIn: { type: Boolean, default: false },
    termsAcceptedAt: { type: Date },
    notificationPreferences: {
      type: Map,
      of: Boolean,
      default: () => ({ receipts: true, courseUpdates: true, announcements: true })
    },
    lastLoginAt: { type: Date }
  },
  timestamps
);

userSchema.virtual('name')
  .get(function getName() {
    return [this.firstName, this.lastName].filter(Boolean).join(' ');
  })
  .set(function setName(value) {
    const { firstName, lastName } = splitName(value);
    this.firstName = firstName;
    this.lastName = lastName;
  });
userSchema.virtual('hasPassword').get(function hasPassword() {
  return Boolean(this.passwordHash);
});
userSchema.set('toJSON', {
  virtuals: true,
  transform(_doc, ret) {
    delete ret.passwordHash;
    delete ret.googleId;
    delete ret.__v;
    return ret;
  }
});

userSchema.pre('validate', function fillName(next) {
  if (!this.firstName && this.name) {
    const { firstName, lastName } = splitName(this.name);
    this.firstName = firstName;
    this.lastName = this.lastName || lastName;
  }
  next();
});

userSchema.methods.setPassword = async function setPassword(plain) {
  this.passwordHash = await bcrypt.hash(plain, 12);
  return this.save();
};

userSchema.methods.verifyPassword = function verifyPassword(plain) {
  if (!this.passwordHash) return Promise.resolve(false);
  return bcrypt.compare(plain, this.passwordHash);
};

const courseSchema = new Schema(
  {
    legacyId: { type: String, index: true },
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    shortDescription: { type: String, default: '' },
    description: { type: String, default: '' },
    badge: { type: String, default: '' },
    level: { type: String, default: '' },
    lengthLabel: { type: String, default: '' },
    gradient: { type: String, default: '' },
    categories: [{ type: String }],
    isFree: { type: Boolean, default: false },
    priceMinor: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'USD', uppercase: true, length: 3 },
    accessPolicy: { type: String, enum: ['lifetime', 'expiring'], default: 'lifetime' },
    accessMonths: { type: Number, default: 0 },
    availableForPurchase: { type: Boolean, default: true },
    bundleIncludes: [{ type: Schema.Types.ObjectId, ref: 'Course' }],
    publicationStatus: { type: String, enum: ['draft', 'published'], default: 'draft', index: true },
    outcomes: [{ type: String }],
    whoFor: [{ type: String }],
    features: [{ type: String }],
    faqs: [{ q: String, a: String }],
    seo: { title: String, description: String },
    banner: { url: String, width: Number, height: Number },
    bunnyLibraryId: { type: String, default: '' },
    bunnySigningKey: { type: String, default: '' }
  },
  timestamps
);

const moduleSchema = new Schema(
  {
    course: courseRef,
    title: { type: String, required: true, trim: true },
    summary: { type: String, default: '' },
    position: { type: Number, default: 0, min: 0 },
    publicationStatus: { type: String, enum: ['draft', 'published'], default: 'draft' }
  },
  timestamps
);
moduleSchema.index({ course: 1, position: 1 });

const lessonSchema = new Schema(
  {
    course: courseRef,
    module: { type: Schema.Types.ObjectId, ref: 'Module', required: true, index: true },
    title: { type: String, required: true, trim: true },
    position: { type: Number, default: 0, min: 0 },
    lessonType: { type: String, enum: ['video', 'text'], default: 'video' },
    videoGuid: { type: String, index: true },
    // Set when the file lives in another course's video library, because a course
    // can teach a video it does not own. Access still follows `course`.
    videoSource: { type: Schema.Types.ObjectId, ref: 'Course', default: null },
    durationSeconds: { type: Number, default: 0, min: 0 },
    summary: { type: String, default: '' },
    textContent: { type: String, default: '' },
    isPreview: { type: Boolean, default: false },
    completion: { rule: { type: String, enum: ['manual', 'watched'], default: 'manual' } },
    publicationStatus: { type: String, enum: ['draft', 'published'], default: 'draft' }
  },
  timestamps
);
lessonSchema.index({ module: 1, position: 1 }, { unique: true });

const lessonProgressSchema = new Schema(
  {
    student: userRef,
    lesson: { type: Schema.Types.ObjectId, ref: 'Lesson', required: true, index: true },
    course: courseRef,
    lastPositionSeconds: { type: Number, default: 0 },
    watchedSeconds: { type: Number, default: 0 },
    completed: { type: Boolean, default: false },
    completedAt: { type: Date }
  },
  timestamps
);
lessonProgressSchema.index({ student: 1, lesson: 1 }, { unique: true });

const orderSchema = new Schema(
  {
    orderNumber: { type: String, required: true, unique: true },
    invoiceNumber: { type: String },
    student: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    email: { type: String, lowercase: true, trim: true },
    items: [
      {
        _id: false,
        course: courseRef,
        title: { type: String, required: true },
        unitPriceMinor: { type: Number, required: true, min: 0 },
        quantity: { type: Number, default: 1, min: 1 },
        lineTotalMinor: { type: Number, default: 0, min: 0 },
        currency: { type: String, required: true, uppercase: true }
      }
    ],
    currency: { type: String, required: true, uppercase: true },
    subtotalMinor: { type: Number, required: true, min: 0 },
    discountMinor: { type: Number, default: 0, min: 0 },
    taxMinor: { type: Number, default: 0, min: 0 },
    totalMinor: { type: Number, required: true, min: 0 },
    discountCode: { type: String },
    notes: { type: String, default: '' },
    receiptUrl: { type: String },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'partially_refunded', 'refunded', 'failed', 'cancelled', 'expired'],
      default: 'pending',
      index: true
    },
    fulfillmentStatus: {
      type: String,
      enum: ['unfulfilled', 'fulfilled', 'reversed'],
      default: 'unfulfilled'
    },
    provider: { type: String, enum: ['mock', 'stripe'], default: 'mock' },
    providerSessionId: { type: String, index: true },
    providerChargeId: { type: String },
    checkoutUrl: { type: String },
    idempotencyKey: { type: String, index: true, sparse: true },
    paidAt: { type: Date },
    refundedMinor: { type: Number, default: 0 },
    refundedAt: { type: Date },
    refundReason: { type: String },
    failureReason: { type: String }
  },
  timestamps
);
orderSchema.virtual('refundStatus').get(function refundStatus() {
  const refunded = this.refundedMinor || 0;
  if (refunded <= 0) return this.paymentStatus === 'refunded' ? 'fully_refunded' : 'none';
  return refunded >= this.totalMinor ? 'fully_refunded' : 'partially_refunded';
});
orderSchema.set('toJSON', {
  virtuals: true,
  transform(_doc, ret) {
    delete ret.__v;
    return ret;
  }
});

const paymentSchema = new Schema(
  {
    order: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    student: userRef,
    provider: { type: String, enum: ['mock', 'stripe'], default: 'mock' },
    status: {
      type: String,
      enum: ['pending', 'succeeded', 'failed', 'partially_refunded', 'refunded', 'cancelled'],
      default: 'pending',
      index: true
    },
    amountMinor: { type: Number, required: true, min: 0 },
    amountRefundedMinor: { type: Number, default: 0, min: 0 },
    currency: { type: String, required: true, uppercase: true },
    cardBrand: { type: String },
    cardLast4: { type: String },
    stripePaymentIntentId: { type: String, index: true, sparse: true },
    receiptUrl: { type: String },
    failureMessage: { type: String },
    paidAt: { type: Date }
  },
  timestamps
);

const refundSchema = new Schema(
  {
    order: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    provider: { type: String, enum: ['mock', 'stripe'], default: 'mock' },
    providerRefundId: { type: String },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    idempotencyKey: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: ['pending', 'succeeded', 'failed', 'cancelled'],
      default: 'pending',
      index: true
    },
    amountMinor: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true, uppercase: true },
    reason: { type: String, required: true },
    note: { type: String, required: true },
    entitlementAction: { type: String, enum: ['none', 'revoked', 'retained'], default: 'none' },
    entitlementsRevoked: { type: Number, default: 0 },
    failureMessage: { type: String },
    processedAt: { type: Date }
  },
  timestamps
);

const entitlementSchema = new Schema(
  {
    student: userRef,
    course: courseRef,
    order: { type: Schema.Types.ObjectId, ref: 'Order' },
    source: { type: String, enum: ['purchase', 'admin_grant', 'import'], default: 'purchase' },
    status: { type: String, enum: ['active', 'revoked', 'expired'], default: 'active', index: true },
    accessUntil: { type: Date },
    grantedAt: { type: Date, default: () => new Date() },
    revokedAt: { type: Date },
    revokedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    revokeReason: { type: String }
  },
  timestamps
);
entitlementSchema.index({ student: 1, course: 1 }, { unique: true });

const playbackSessionSchema = new Schema(
  {
    student: userRef,
    course: courseRef,
    lesson: { type: Schema.Types.ObjectId, ref: 'Lesson', required: true, index: true },
    token: { type: String, required: true, unique: true },
    videoGuid: { type: String, required: true },
    startedAt: { type: Date, default: () => new Date() },
    expiresAt: { type: Date, required: true, index: true },
    lastHeartbeatAt: { type: Date },
    endedAt: { type: Date },
    endedReason: { type: String },
    positionSeconds: { type: Number, default: 0 },
    watchedSeconds: { type: Number, default: 0 },
    ip: { type: String },
    userAgent: { type: String }
  },
  timestamps
);
playbackSessionSchema.index({ student: 1, endedAt: 1, expiresAt: 1 });

const webhookEventSchema = new Schema(
  {
    provider: { type: String, required: true, index: true },
    eventId: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    payload: { type: Schema.Types.Mixed },
    order: { type: Schema.Types.ObjectId, ref: 'Order' },
    status: {
      type: String,
      enum: ['received', 'processed', 'ignored', 'failed'],
      default: 'received',
      index: true
    },
    error: { type: String },
    processedAt: { type: Date }
  },
  timestamps
);

const emailMessageSchema = new Schema(
  {
    template: { type: String, required: true, index: true },
    to: { type: String, required: true, lowercase: true },
    from: { type: String },
    subject: { type: String, required: true },
    html: { type: String },
    text: { type: String },
    provider: { type: String, default: 'mock' },
    providerId: { type: String },
    status: { type: String, enum: ['queued', 'sent', 'skipped', 'failed'], default: 'queued', index: true },
    order: { type: Schema.Types.ObjectId, ref: 'Order' },
    student: { type: Schema.Types.ObjectId, ref: 'User' },
    error: { type: String },
    sentAt: { type: Date }
  },
  timestamps
);

const auditLogSchema = new Schema(
  {
    actor: { type: Schema.Types.ObjectId, ref: 'User' },
    actorEmail: { type: String },
    action: { type: String, required: true, index: true },
    targetKind: { type: String },
    targetId: { type: String },
    summary: { type: String, default: '' },
    meta: { type: Schema.Types.Mixed },
    ip: { type: String }
  },
  timestamps
);

const notificationSchema = new Schema(
  {
    recipient: userRef,
    type: { type: String, enum: ['system', 'order', 'course', 'message'], default: 'system' },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    link: { type: String },
    readAt: { type: Date }
  },
  timestamps
);

const otpChallengeSchema = new Schema(
  {
    destination: { type: String, required: true, lowercase: true },
    channel: { type: String, enum: ['email'], default: 'email' },
    purpose: { type: String, required: true },
    codeHash: { type: String, required: true },
    profile: { type: Schema.Types.Mixed },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    resendAt: { type: Date, required: true },
    consumedAt: { type: Date }
  },
  timestamps
);

// The email carries the opaque token itself, so the digest is what gets looked
// up on redemption — a leaked table never yields a usable link.
const magicLinkChallengeSchema = new Schema(
  {
    destination: { type: String, required: true, lowercase: true, trim: true },
    tokenHash: { type: String, required: true, unique: true },
    purpose: { type: String, required: true, default: 'login' },
    expiresAt: { type: Date, required: true, index: true },
    resendAt: { type: Date, required: true },
    consumedAt: { type: Date },
    consumedIp: { type: String }
  },
  timestamps
);
magicLinkChallengeSchema.index({ destination: 1, expiresAt: 1 });

const articleSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    title: { type: String, required: true, trim: true },
    excerpt: { type: String, default: '' },
    body: { type: String, default: '' },
    tags: [{ type: String }],
    coverImage: { type: String },
    authorName: { type: String, default: '' },
    publicationStatus: { type: String, enum: ['draft', 'published', 'archived'], default: 'draft', index: true },
    publishedAt: { type: Date }
  },
  timestamps
);

const counterSchema = new Schema({ _id: String, seq: { type: Number, default: 0 } });
const contactMessageSchema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, lowercase: true },
    phone: { type: String },
    topic: { type: String, default: '' },
    message: { type: String, default: '' },
    source: { type: String, default: 'site' },
    status: { type: String, enum: ['new', 'replied', 'closed', 'spam'], default: 'new', index: true },
    internalNote: { type: String, default: '' },
    idempotencyKey: { type: String, index: true, sparse: true },
    repliedAt: { type: Date }
  },
  timestamps
);

// The recurring Wisdom Call dates are derived from a rule, so the only thing
// worth storing about a class is that a member put their name against one.
const liveClassRegistrationSchema = new Schema(
  {
    student: userRef,
    occurrence: { type: String, required: true },
    series: { type: String, required: true },
    startAt: { type: Date, required: true },
    status: { type: String, enum: ['registered', 'cancelled'], default: 'registered' },
    cancelledAt: { type: Date }
  },
  timestamps
);
liveClassRegistrationSchema.index({ student: 1, occurrence: 1 }, { unique: true });

export const User = model('User', userSchema);
export const Course = model('Course', courseSchema);
export const Module = model('Module', moduleSchema);
export const Lesson = model('Lesson', lessonSchema);
export const LessonProgress = model('LessonProgress', lessonProgressSchema);
export const Order = model('Order', orderSchema);
export const Payment = model('Payment', paymentSchema);
export const Refund = model('Refund', refundSchema);
export const Entitlement = model('Entitlement', entitlementSchema);
export const PlaybackSession = model('PlaybackSession', playbackSessionSchema);
export const WebhookEvent = model('WebhookEvent', webhookEventSchema);
export const EmailMessage = model('EmailMessage', emailMessageSchema);
export const AuditLog = model('AuditLog', auditLogSchema);
export const Notification = model('Notification', notificationSchema);
export const OtpChallenge = model('OtpChallenge', otpChallengeSchema);
export const MagicLinkChallenge = model('MagicLinkChallenge', magicLinkChallengeSchema);
export const Counter = model('Counter', counterSchema);
export const ContactMessage = model('ContactMessage', contactMessageSchema);
export const Article = model('Article', articleSchema);
export const LiveClassRegistration = model('LiveClassRegistration', liveClassRegistrationSchema);
