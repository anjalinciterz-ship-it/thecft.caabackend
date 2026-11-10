import { Router } from 'express';
import { LiveClassRegistration } from '../models/index.js';
import { ApiError, asyncHandler, ok, paginated } from '../lib/http.js';
import { requireSignIn } from '../lib/security.js';
import { findOccurrence, pastOccurrences, upcomingOccurrences } from '../services/liveClasses.js';

export const router = Router();

// No meeting host is configured for the call yet, so registering holds a place
// in the room rather than producing a link; the join route stays a stub.
const shape = (item, isRegistered) => ({ ...item, isRegistered, canJoin: false });

router.get(
  '/student/live-classes',
  requireSignIn,
  asyncHandler(async (req, res) => {
    const scope = req.query.scope === 'past' ? 'past' : 'upcoming';
    const exclude = String(req.query.excludeSeries || '').split(',').filter(Boolean);
    const only = String(req.query.series || '').split(',').filter(Boolean);
    const occurrences = (scope === 'past' ? pastOccurrences() : upcomingOccurrences())
      .filter((item) => !exclude.includes(item.series))
      .filter((item) => !only.length || only.includes(item.series));
    const registered = new Set(
      (await LiveClassRegistration.find({
        student: req.user.id,
        status: 'registered',
        occurrence: { $in: occurrences.map((item) => item.id) }
      }).lean()).map((row) => row.occurrence)
    );
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const rows = occurrences
      .slice((page - 1) * limit, page * limit)
      .map((item) => shape(item, registered.has(item.id)));
    paginated(res, { liveClasses: rows }, { total: occurrences.length, page, pages: Math.ceil(occurrences.length / limit) || 1 });
  })
);

const resolveOccurrence = (id) => {
  const occurrence = findOccurrence(id);
  if (!occurrence) throw ApiError.notFound('That class date is not on the schedule.');
  return occurrence;
};

router.post(
  '/student/live-classes/:id/register',
  requireSignIn,
  asyncHandler(async (req, res) => {
    const occurrence = resolveOccurrence(req.params.id);
    if (!occurrence.registrationOpen) throw ApiError.forbidden('This class has already taken place.');
    await LiveClassRegistration.findOneAndUpdate(
      { student: req.user.id, occurrence: occurrence.id },
      { $set: { status: 'registered', series: occurrence.series, startAt: new Date(occurrence.startAt), cancelledAt: null } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    ok(res, { liveClass: shape(occurrence, true) });
  })
);

router.delete(
  '/student/live-classes/:id/register',
  requireSignIn,
  asyncHandler(async (req, res) => {
    const occurrence = resolveOccurrence(req.params.id);
    await LiveClassRegistration.updateOne(
      { student: req.user.id, occurrence: occurrence.id, status: 'registered' },
      { $set: { status: 'cancelled', cancelledAt: new Date() } }
    );
    ok(res, { liveClass: shape(occurrence, false) });
  })
);

export default router;
