import { Router } from 'express';
import { Article } from '../models/index.js';
import { ApiError, asyncHandler, ok, paginated } from '../lib/http.js';
import { requireSignIn } from '../lib/security.js';

// Bookings, community and certificates are not built yet. Reads answer with an
// empty collection so the dashboard renders its own empty state; writes answer
// 501 instead of pretending the record was stored.
export const notBuilt = (feature) => () => {
  throw new ApiError('feature_not_available', 501, `${feature} is not available yet. Ask the team to switch it on.`);
};

export const router = Router();

const emptyPage = (res, key) => paginated(res, { [key]: [] }, { total: 0, page: 1, pages: 1 });

router.get('/session-types', asyncHandler(async (_req, res) => emptyPage(res, 'sessionTypes')));
router.get('/availability/slots', asyncHandler(async (_req, res) => emptyPage(res, 'slots')));
router.post('/bookings', notBuilt('One-to-one bookings'));
router.get('/bookings', asyncHandler(async (_req, res) => emptyPage(res, 'bookings')));
router.post('/bookings/:id/confirm', notBuilt('One-to-one bookings'));
router.post('/bookings/:id/cancel', notBuilt('One-to-one bookings'));
router.get('/bookings/:id/join', notBuilt('One-to-one bookings'));

// The member-facing classes come from routes/liveClasses.js and the recurring
// schedule. The public feed stays empty until the website's own countdown is
// pointed at those dates, so no public page changes yet.
router.get('/live-classes', asyncHandler(async (_req, res) => emptyPage(res, 'liveClasses')));
router.get('/student/live-classes/:id/join', notBuilt('Live classes'));
router.get('/student/bookings', asyncHandler(async (_req, res) => emptyPage(res, 'bookings')));

router.get('/student/wishlist', requireSignIn, asyncHandler(async (_req, res) => emptyPage(res, 'items')));
router.post('/student/wishlist', requireSignIn, notBuilt('The wishlist'));
router.delete('/student/wishlist/:id', requireSignIn, notBuilt('The wishlist'));

router.get('/student/certificates', requireSignIn, asyncHandler(async (_req, res) => emptyPage(res, 'certificates')));

router.get('/community/posts', requireSignIn, asyncHandler(async (_req, res) => emptyPage(res, 'posts')));
router.post('/community/posts', requireSignIn, notBuilt('The community'));
router.get('/community/posts/:id/comments', requireSignIn, asyncHandler(async (_req, res) => emptyPage(res, 'comments')));
router.post('/community/posts/:id/comments', requireSignIn, notBuilt('The community'));
router.post('/community/likes', requireSignIn, notBuilt('The community'));

// The public blog is still the static bundle shipped with the frontend, so the
// CMS-shaped feed stays empty until articles move into the database.
router.get('/articles', asyncHandler(async (_req, res) => {
  const total = await Article.countDocuments({ publicationStatus: 'published' });
  paginated(res, { articles: [] }, { total, page: 1, pages: 1 });
}));
router.get('/articles/:slug', asyncHandler(async (_req, res) => {
  const article = await Article.findOne({ slug: req.params.slug, publicationStatus: 'published' });
  if (!article) throw ApiError.notFound('That article is not published.');
  ok(res, { article });
}));

router.get('/pages/settings', asyncHandler(async (_req, res) => ok(res, { settings: {} })));
router.get('/pages/:key', asyncHandler(async (_req, res) => ok(res, { page: { key: req.params.key, blocks: [] } })));

export default router;
