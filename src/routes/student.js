import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { AuditLog, Course, Entitlement, Lesson, LessonProgress, Module, Notification, Order, User } from '../models/index.js';
import { ApiError, asyncHandler, ok, paginated } from '../lib/http.js';
import { validate } from '../lib/validate.js';
import { clientIp, requireSignIn } from '../lib/security.js';
import { accessStateFor, isAccessible } from '../lib/access.js';

export const router = Router();

const findCourse = (ref) => {
  const or = [{ slug: String(ref).toLowerCase() }, { legacyId: String(ref) }];
  if (/^[a-f\d]{24}$/i.test(String(ref))) or.push({ _id: ref });
  return Course.findOne({ $or: or });
};

async function libraryFor(studentId) {
  const entitlements = await Entitlement.find({ student: studentId }).populate('course');
  const rows = [];
  for (const entitlement of entitlements) {
    if (!entitlement.course) continue;
    // A bundle is taught through the courses inside it, so its tile counts and
    // scores those lessons too rather than reporting an empty course.
    const sourceIds = [entitlement.course._id, ...(entitlement.course.bundleIncludes || [])];
    const lessons = await Lesson.find({ course: { $in: sourceIds }, publicationStatus: 'published' }).select('_id videoGuid');
    const ids = lessons.map((l) => l._id);
    const progress = ids.length
      ? await LessonProgress.find({ student: studentId, lesson: { $in: ids }, completed: true }).select('lesson')
      : [];
    rows.push({
      id: entitlement.course.legacyId || entitlement.course.slug,
      courseId: String(entitlement.course._id),
      slug: entitlement.course.slug,
      title: entitlement.course.title,
      shortDescription: entitlement.course.shortDescription,
      badge: entitlement.course.badge,
      // The dashboard's Continue Learning card needs artwork and a lesson
      // count; the banner is the only image a course carries, and the totals
      // are aliased because the tiles read lessonsTotal/lessonsCompleted.
      coverImage: entitlement.course.banner?.url || null,
      lengthLabel: entitlement.course.lengthLabel || '',
      level: entitlement.course.level || '',
      lessonsTotal: ids.length,
      lessonsCompleted: progress.length,
      hasVideo: lessons.some((l) => Boolean(l.videoGuid)),
      priceMinor: entitlement.course.priceMinor,
      currency: entitlement.course.currency,
      isFree: entitlement.course.isFree,
      access: accessStateFor(entitlement),
      accessActive: isAccessible(entitlement),
      lessonCount: ids.length,
      completedCount: progress.length,
      percent: ids.length ? Math.round((progress.length / ids.length) * 100) : 0
    });
  }
  return rows;
}

router.get(
  '/student/courses',
  requireSignIn,
  asyncHandler(async (req, res) => {
    const courses = await libraryFor(req.user.id);
    paginated(res, { courses }, { total: courses.length, page: 1, pages: 1 });
  })
);

router.get(
  '/student/courses/:ref',
  requireSignIn,
  asyncHandler(async (req, res) => {
    const course = await findCourse(req.params.ref);
    if (!course) throw ApiError.notFound('Course not found.');
    const entitlement = await Entitlement.findOne({ student: req.user.id, course: course._id });
    const accessible = isAccessible(entitlement);

    // A bundle carries no lessons of its own, it is the list of teachings inside it,
    // so its page shows those in the order the bundle names them.
    const sources = [course];
    if (course.bundleIncludes?.length) {
      const byId = new Map((await Course.find({ _id: { $in: course.bundleIncludes } })).map((c) => [String(c._id), c]));
      for (const id of course.bundleIncludes) {
        const included = byId.get(String(id));
        if (included) sources.push(included);
      }
    }
    const courseIds = sources.map((c) => c._id);
    const [modules, lessons, entitlements] = await Promise.all([
      Module.find({ course: { $in: courseIds }, publicationStatus: 'published' }).sort({ position: 1 }),
      Lesson.find({ course: { $in: courseIds }, publicationStatus: 'published' }).sort({ position: 1 }),
      Entitlement.find({ student: req.user.id, course: { $in: courseIds } })
    ]);
    const progressRows = await LessonProgress.find({ student: req.user.id, lesson: { $in: lessons.map((l) => l._id) } });
    const progressByLesson = new Map(progressRows.map((p) => [String(p.lesson), p]));
    // Playback is granted on the teaching's own course, never on the bundle, so the
    // lock follows that row and the list cannot offer a video the player then refuses.
    const openCourses = new Set(entitlements.filter((e) => isAccessible(e)).map((e) => String(e.course)));

    const curriculum = [];
    for (const source of sources) {
      for (const module of modules.filter((m) => String(m.course) === String(source._id))) {
        curriculum.push({
          id: String(module._id),
          title: module.title,
          summary: module.summary,
          courseTitle: sources.length > 1 ? source.title : '',
          lessons: lessons
            .filter((lesson) => String(lesson.module) === String(module._id))
            .map((lesson) => {
              const row = progressByLesson.get(String(lesson._id));
              const canPlay = openCourses.has(String(lesson.course));
              return {
                id: String(lesson._id),
                title: lesson.title,
                position: lesson.position,
                durationSeconds: lesson.durationSeconds,
                hasVideo: Boolean(lesson.videoGuid),
                isPreview: lesson.isPreview,
                locked: !canPlay && !lesson.isPreview,
                completed: Boolean(row?.completed),
                lastPositionSeconds: row?.lastPositionSeconds || 0,
                courseTitle: sources.length > 1 ? source.title : '',
                courseSlug: sources.length > 1 ? source.slug : ''
              };
            })
        });
      }
    }

    ok(res, {
      course: {
        id: course.legacyId || course.slug,
        courseId: String(course._id),
        slug: course.slug,
        title: course.title,
        shortDescription: course.shortDescription,
        description: course.description,
        badge: course.badge,
        lengthLabel: course.lengthLabel,
        priceMinor: course.priceMinor,
        currency: course.currency,
        isFree: course.isFree
      },
      access: accessible ? 'full' : entitlement ? 'revoked' : 'none',
      curriculum
    });
  })
);

async function loadLessonForStudent(lessonId, studentId) {
  const lesson = await Lesson.findById(lessonId).populate('course');
  if (!lesson || lesson.publicationStatus !== 'published') throw ApiError.notFound('Lesson not found.');
  const entitlement = await Entitlement.findOne({ student: studentId, course: lesson.course._id });
  if (!isAccessible(entitlement) && !lesson.isPreview) throw ApiError.forbidden('This lesson belongs to a course you do not have.');
  return { lesson, entitlement };
}

router.get(
  '/student/lessons/:id',
  requireSignIn,
  asyncHandler(async (req, res) => {
    const { lesson, entitlement } = await loadLessonForStudent(req.params.id, req.user.id);
    const progress = await LessonProgress.findOne({ student: req.user.id, lesson: lesson._id });
    const status = progress?.completed ? 'completed' : progress?.watchedSeconds > 30 ? 'in_progress' : 'not_started';
    ok(res, {
      lesson: {
        id: String(lesson._id),
        lessonId: String(lesson._id),
        courseId: String(lesson.course._id),
        courseSlug: lesson.course.slug,
        title: lesson.title,
        description: lesson.summary || '',
        lessonType: lesson.lessonType,
        textContent: lesson.textContent,
        durationSeconds: lesson.durationSeconds,
        hasVideo: Boolean(lesson.videoGuid),
        isPreview: lesson.isPreview,
        access: isAccessible(entitlement) ? 'full' : 'preview'
      },
      progress: {
        status,
        lastPositionSeconds: progress?.lastPositionSeconds || 0,
        watchedSeconds: progress?.watchedSeconds || 0,
        completed: Boolean(progress?.completed),
        updatedAt: progress?.updatedAt || null
      }
    });
  })
);

const progressSchema = z.object({
  sessionId: z.string().min(6).optional(),
  positionSeconds: z.coerce.number().min(0).default(0),
  watchedDeltaSeconds: z.coerce.number().min(0).max(3600).default(0)
});

router.post(
  '/student/lessons/:id/progress',
  requireSignIn,
  asyncHandler(async (req, res) => {
    const { lesson } = await loadLessonForStudent(req.params.id, req.user.id);
    const payload = validate(progressSchema, req.body);
    const row = await LessonProgress.findOneAndUpdate(
      { student: req.user.id, lesson: lesson._id },
      {
        $set: { course: lesson.course._id, lastPositionSeconds: Math.max(payload.positionSeconds, 0) },
        $inc: { watchedSeconds: payload.watchedDeltaSeconds }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    ok(res, {
      lastPositionSeconds: row.lastPositionSeconds,
      watchedSeconds: row.watchedSeconds,
      watchedPercent: lesson.durationSeconds ? Math.min(100, Math.round((row.watchedSeconds / lesson.durationSeconds) * 100)) : 0,
      completed: row.completed,
      updatedAt: row.updatedAt
    });
  })
);

router.post(
  '/student/lessons/:id/complete',
  requireSignIn,
  asyncHandler(async (req, res) => {
    const { lesson } = await loadLessonForStudent(req.params.id, req.user.id);
    const row = await LessonProgress.findOneAndUpdate(
      { student: req.user.id, lesson: lesson._id },
      { $set: { completed: true, completedAt: new Date(), course: lesson.course._id } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    ok(res, { completed: row.completed, completedAt: row.completedAt });
  })
);

router.get(
  '/student/dashboard',
  requireSignIn,
  asyncHandler(async (req, res) => {
    const library = await libraryFor(req.user.id);
    const inProgress = library
      .filter((row) => row.accessActive && row.percent > 0 && row.percent < 100)
      .sort((a, b) => b.percent - a.percent);
    const recentOrders = await Order.find({ student: req.user.id }).sort({ createdAt: -1 }).limit(5);
    const nextLesson = inProgress[0]
      ? await LessonProgress.findOne({ student: req.user.id, completed: false }).sort({ updatedAt: -1 }).populate('lesson')
      : null;
    ok(res, {
      continueLearning: inProgress.map((row) => ({
        slug: row.slug,
        title: row.title,
        percent: row.percent,
        shortDescription: row.shortDescription,
        lastLessonTitle: nextLesson?.lesson?.title || 'Start the first lesson'
      })),
      upcomingBookings: [],
      upcomingLiveClasses: [],
      recentOrders: recentOrders.map((order) => ({
        id: String(order._id),
        orderNumber: order.orderNumber,
        totalMinor: order.totalMinor,
        currency: order.currency,
        createdAt: order.createdAt,
        paymentStatus: order.paymentStatus,
        items: order.items.map((i) => ({ title: i.title }))
      }))
    });
  })
);

router.get(
  '/student/notifications',
  requireSignIn,
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const filter = { recipient: req.user.id };
    const [rows, total, unread] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      Notification.countDocuments(filter),
      Notification.countDocuments({ ...filter, readAt: null })
    ]);
    paginated(
      res,
      {
        notifications: rows.map((n) => ({ id: String(n._id), type: n.type, title: n.title, body: n.body, link: n.link, read: Boolean(n.readAt), createdAt: n.createdAt })),
        unread
      },
      { total, page, pages: Math.max(1, Math.ceil(total / limit)) }
    );
  })
);

router.post(
  '/student/notifications',
  requireSignIn,
  asyncHandler(async (req, res) => {
    await Notification.updateMany({ recipient: req.user.id, readAt: null }, { $set: { readAt: new Date() } });
    ok(res, { read: true });
  })
);

router.post(
  '/student/notifications/read-all',
  requireSignIn,
  asyncHandler(async (req, res) => {
    await Notification.updateMany({ recipient: req.user.id, readAt: null }, { $set: { readAt: new Date() } });
    ok(res, { read: true });
  })
);

router.post(
  '/student/notifications/:id/read',
  requireSignIn,
  asyncHandler(async (req, res) => {
    const row = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient: req.user.id },
      { $set: { readAt: new Date() } },
      { new: true }
    ).catch(() => null);
    if (!row) throw ApiError.notFound('That notification was not found.');
    ok(res, { id: String(row._id), read: true });
  })
);

router.get(
  '/users/me',
  requireSignIn,
  asyncHandler(async (req, res) => ok(res, { user: req.user.toJSON() }))
);

const profileSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  firstName: z.string().trim().min(1).max(60).optional(),
  lastName: z.string().trim().max(60).optional(),
  username: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{2,29}$/i, 'Use 3–30 characters, starting with a letter.')
    .optional(),
  timeZone: z.string().max(60).optional(),
  marketingOptIn: z.boolean().optional()
});

router.patch(
  '/users/me',
  requireSignIn,
  asyncHandler(async (req, res) => {
    const patch = validate(profileSchema, req.body);
    if (patch.name) {
      const parts = patch.name.split(/\s+/);
      patch.firstName = parts.shift();
      patch.lastName = parts.join(' ');
    }
    const { name, ...rest } = patch;
    if ('username' in rest && !rest.username) rest.username = undefined;
    Object.assign(req.user, rest);
    try {
      await req.user.save();
    } catch (err) {
      if (err?.code === 11000 && err.keyPattern?.username) {
        throw ApiError.conflict('username_taken', 'That username is already in use.');
      }
      throw err;
    }
    ok(res, { user: req.user.toJSON() });
  })
);

const passwordSchema = z.object({
  currentPassword: z.string().max(200).optional(),
  newPassword: z
    .string()
    .min(10, 'Use at least 10 characters.')
    .max(200)
    .refine((v) => /[A-Za-z]/.test(v) && /[0-9]/.test(v), { message: 'Include at least one letter and one number.' })
});

router.post(
  '/users/me/password',
  requireSignIn,
  asyncHandler(async (req, res) => {
    const payload = validate(passwordSchema, req.body);
    if (req.user.passwordHash) {
      if (!payload.currentPassword || !(await req.user.verifyPassword(payload.currentPassword))) {
        throw ApiError.badRequest('current_password_incorrect', 'Your current password does not match.');
      }
    } else if (env.AUTH_OTP_EMAIL_ENABLED) {
      // First password is a new sign-in method, so it needs a fresh verification from an existing one.
      throw ApiError.badRequest(
        'verification_required',
        'Verify your email address before setting a password.'
      );
    }
    await req.user.setPassword(payload.newPassword);
    await AuditLog.create({
      actor: req.user.id,
      actorEmail: req.user.email,
      action: 'user.password_set',
      targetKind: 'user',
      targetId: String(req.user.id),
      summary: req.user.passwordHash ? 'Password updated' : 'Password created',
      ip: clientIp(req)
    });
    ok(res, { user: req.user.toJSON(), hasPassword: true });
  })
);

const preferencesSchema = z.object({
  receipts: z.boolean().optional(),
  courseUpdates: z.boolean().optional(),
  announcements: z.boolean().optional(),
  marketing: z.boolean().optional()
});

router.patch(
  '/users/me/notification-preferences',
  requireSignIn,
  asyncHandler(async (req, res) => {
    const patch = validate(preferencesSchema, req.body);
    const next = { ...(req.user.notificationPreferences?.toObject?.() || {}), ...patch };
    req.user.notificationPreferences = next;
    await req.user.save();
    ok(res, { preferences: next });
  })
);

router.get(
  '/student/search',
  requireSignIn,
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return ok(res, { results: [] });
    const library = (await libraryFor(req.user.id)).filter((row) =>
      `${row.title} ${row.shortDescription}`.toLowerCase().includes(q.toLowerCase())
    );
    paginated(res, { results: library, courses: library }, { total: library.length, page: 1, pages: 1 });
  })
);

export default router;
