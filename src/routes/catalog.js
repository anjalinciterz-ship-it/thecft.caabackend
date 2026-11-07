import { Router } from 'express';
import { Course, Entitlement, Lesson, Module } from '../models/index.js';
import { ApiError, asyncHandler, ok, paginated } from '../lib/http.js';
import { isAccessible } from '../lib/access.js';

export const router = Router();

const refFilter = (ref) => {
  const or = [{ slug: String(ref).toLowerCase() }, { legacyId: String(ref) }];
  if (/^[a-f\d]{24}$/i.test(String(ref))) or.push({ _id: ref });
  return { $or: or };
};

async function publishedCounts(courseIds) {
  if (courseIds.length === 0) return { lessons: new Map(), modules: new Map() };
  const lessonRows = await Lesson.aggregate([
    { $match: { course: { $in: courseIds }, publicationStatus: 'published' } },
    { $group: { _id: '$course', count: { $sum: 1 } } }
  ]);
  const moduleRows = await Module.aggregate([
    { $match: { course: { $in: courseIds }, publicationStatus: 'published' } },
    { $group: { _id: '$course', count: { $sum: 1 } } }
  ]);
  return {
    lessons: new Map(lessonRows.map((r) => [String(r._id), r.count])),
    modules: new Map(moduleRows.map((r) => [String(r._id), r.count]))
  };
}

export async function offeringView(course, counts, included = []) {
  return {
    id: course.legacyId || course.slug,
    productId: String(course._id),
    productKind: 'course',
    legacyId: course.legacyId || null,
    slug: course.slug,
    name: course.title,
    short: course.shortDescription,
    description: course.description,
    badge: course.badge,
    level: course.level,
    length: course.lengthLabel,
    categories: course.categories,
    isFree: course.isFree,
    priceMinor: course.priceMinor,
    currency: course.currency,
    accessPolicy: course.accessPolicy,
    availableForPurchase: course.availableForPurchase && course.publicationStatus === 'published',
    publishedLessonCount: counts?.lessons?.get(String(course._id)) ?? 0,
    publishedModuleCount: counts?.modules?.get(String(course._id)) ?? 0,
    includedOfferings: included.map((c) => ({ id: c.legacyId || c.slug, name: c.title })),
    banner: course.banner?.url || null,
    bannerW: course.banner?.width || null,
    bannerH: course.banner?.height || null
  };
}

router.get(
  '/offerings',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 60, 100);
    const courses = await Course.find({ publicationStatus: 'published' }).limit(limit).populate('bundleIncludes');
    const counts = await publishedCounts(courses.map((c) => c._id));
    ok(res, {
      offerings: await Promise.all(courses.map((c) => offeringView(c, counts, c.bundleIncludes || [])))
    });
  })
);

router.get(
  '/offerings/:ref',
  asyncHandler(async (req, res) => {
    const course = await Course.findOne(refFilter(req.params.ref)).populate('bundleIncludes');
    if (!course || course.publicationStatus !== 'published') throw ApiError.notFound('That offering is not available.');
    const counts = await publishedCounts([course._id]);
    ok(res, { offering: await offeringView(course, counts, course.bundleIncludes || []) });
  })
);

const cardView = (course, counts) => ({
  id: course.legacyId || course.slug,
  courseId: String(course._id),
  productId: String(course._id),
  productKind: 'course',
  slug: course.slug,
  title: course.title,
  name: course.title,
  short: course.shortDescription,
  shortDescription: course.shortDescription,
  description: course.description,
  badge: course.badge,
  level: course.level,
  length: course.lengthLabel,
  isFree: course.isFree,
  priceMinor: course.priceMinor,
  currency: course.currency,
  availableForPurchase: course.availableForPurchase && course.publicationStatus === 'published',
  publishedLessonCount: counts?.lessons?.get(String(course._id)) ?? 0,
  coverImage: course.banner?.url || null
});

// The dashboard tiles and the checkout page read these two collections, so they
// share the published filter rather than trusting whatever the client asks for.
const visibleCourses = () => Course.find({ publicationStatus: 'published' }).sort({ createdAt: 1 });

router.get(
  '/courses',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 60, 100);
    const slice = (await visibleCourses()).slice(0, limit);
    const counts = await publishedCounts(slice.map((c) => c._id));
    paginated(res, { courses: slice.map((c) => cardView(c, counts)) }, { total: slice.length, page: 1, pages: 1 });
  })
);

router.get(
  '/programs',
  asyncHandler(async (req, res) => {
    const all = await visibleCourses();
    const byId = new Map(all.map((c) => [String(c._id), c]));
    const bundles = all.filter((course) => (course.bundleIncludes || []).length > 0);
    paginated(
      res,
      {
        programs: bundles.map((course) => ({
          id: course.legacyId || course.slug,
          productId: String(course._id),
          productKind: 'course',
          slug: course.slug,
          title: course.title,
          short: course.shortDescription,
          description: course.description,
          isFree: course.isFree,
          priceMinor: course.priceMinor,
          currency: course.currency,
          courses: (course.bundleIncludes || [])
            .map((ref) => byId.get(String(ref)))
            .filter(Boolean)
            .map((c) => ({ id: c.legacyId || c.slug, slug: c.slug, title: c.title }))
        }))
      },
      { total: bundles.length, page: 1, pages: 1 }
    );
  })
);

router.get(
  '/courses/:ref',
  asyncHandler(async (req, res) => {
    const course = await Course.findOne(refFilter(req.params.ref));
    if (!course || course.publicationStatus !== 'published') throw ApiError.notFound('That course is not available.');
    const entitlement = req.session?.uid
      ? await Entitlement.findOne({ student: req.session.uid, course: course._id })
      : null;
    const accessible = isAccessible(entitlement);
    const [modules, lessons] = await Promise.all([
      Module.find({ course: course._id, publicationStatus: 'published' }).sort({ position: 1 }),
      Lesson.find({ course: course._id, publicationStatus: 'published' }).sort({ position: 1 })
    ]);
    const counts = await publishedCounts([course._id]);
    ok(res, {
      course: { ...cardView(course, counts), courseId: String(course._id) },
      access: accessible ? 'full' : entitlement ? 'revoked' : 'none',
      curriculum: modules.map((module) => ({
        id: String(module._id),
        title: module.title,
        summary: module.summary,
        lessons: lessons
          .filter((lesson) => String(lesson.module) === String(module._id))
          .map((lesson) => ({
            id: String(lesson._id),
            title: lesson.title,
            position: lesson.position,
            durationSeconds: lesson.durationSeconds,
            hasVideo: Boolean(lesson.videoGuid),
            isPreview: lesson.isPreview,
            locked: !accessible && !lesson.isPreview,
            completed: false
          }))
      }))
    });
  })
);

export default router;
