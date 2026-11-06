import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { ApiError, asyncHandler, noContent, ok } from '../lib/http.js';
import { validate } from '../lib/validate.js';
import { randomId, requireSignIn, clientIp } from '../lib/security.js';
import { isAccessible } from '../lib/access.js';
import { Entitlement, Lesson, PlaybackSession } from '../models/index.js';
import { buildPlaybackUrl, watermarkText } from '../services/bunny.js';

export const router = Router();

const liveWindowMs = Math.max(env.VIDEO_HEARTBEAT_SECONDS * 2500, 60000);

async function claimSlot(studentId, now) {
  const live = await PlaybackSession.find({
    student: studentId,
    endedAt: null,
    expiresAt: { $gt: now },
    lastHeartbeatAt: { $gt: new Date(now.getTime() - liveWindowMs) }
  }).sort({ lastHeartbeatAt: -1 });

  if (live.length >= env.VIDEO_MAX_CONCURRENT_SESSIONS) {
    throw ApiError.conflict(
      'already_watching',
      'This account is already playing a lesson on another device. Finish that one, or sign out there, and try again.'
    );
  }

  if (live.length) {
    await PlaybackSession.updateMany(
      { _id: { $in: live.map((s) => s._id) } },
      { $set: { endedAt: now, endedReason: 'displaced' } }
    );
  } else {
    // Anything that simply timed out is closed so the account never accumulates ghosts.
    await PlaybackSession.updateMany(
      { student: studentId, endedAt: null, expiresAt: { $lte: now } },
      { $set: { endedAt: now, endedReason: 'expired' } }
    );
  }
}

router.post(
  '/video/lessons/:lessonId/playback',
  requireSignIn,
  asyncHandler(async (req, res) => {
    // Embedding only needs the library id; the API key is for management calls.
    if (!env.BUNNY_LIBRARY_ID) throw ApiError.unavailable('The video library is not configured yet.');

    const lesson = await Lesson.findById(req.params.lessonId).populate('course');
    if (!lesson || lesson.publicationStatus !== 'published') throw ApiError.notFound('Lesson not found.');
    if (!lesson.videoGuid) throw ApiError.badRequest('no_video', 'This lesson has no video attached yet.');

    const entitlement = await Entitlement.findOne({ student: req.user.id, course: lesson.course._id });
    if (!isAccessible(entitlement) && !lesson.isPreview) {
      throw ApiError.forbidden('Enrol in this course to watch it.');
    }

    const now = new Date();
    await claimSlot(req.user.id, now);

    const playback = buildPlaybackUrl(lesson.videoGuid);
    const expiresAt = new Date(now.getTime() + env.VIDEO_SESSION_TTL_SECONDS * 1000);
    const token = randomId(18);

    await PlaybackSession.create({
      student: req.user.id,
      course: lesson.course._id,
      lesson: lesson._id,
      token,
      videoGuid: lesson.videoGuid,
      expiresAt,
      lastHeartbeatAt: now,
      ip: clientIp(req),
      userAgent: String(req.get('user-agent') || '').slice(0, 300)
    });

    ok(res, {
      playback: {
        sessionId: token,
        lesson: { id: String(lesson._id), title: lesson.title },
        playbackUrl: playback.url,
        playbackType: 'iframe',
        expiresAt: expiresAt.toISOString(),
        heartbeatSeconds: env.VIDEO_HEARTBEAT_SECONDS,
        watermark: {
          enabled: true,
          text: watermarkText({ email: req.user.email, name: req.user.name, sessionId: token }),
          opacity: env.WATERMARK_OPACITY,
          moveSeconds: env.WATERMARK_MOVE_SECONDS
        },
        drm: { active: playback.signed, referrerLockOnly: !playback.signed }
      }
    });
  })
);

const heartbeatSchema = z.object({
  positionSeconds: z.coerce.number().min(0).optional(),
  watchedDeltaSeconds: z.coerce.number().min(0).max(600).optional()
});

router.post(
  '/video/playback/:sessionId/heartbeat',
  requireSignIn,
  asyncHandler(async (req, res) => {
    const payload = validate(heartbeatSchema, req.body);
    const session = await PlaybackSession.findOne({ token: req.params.sessionId, student: req.user.id });
    if (!session) throw ApiError.notFound('That viewing session no longer exists.');
    const now = new Date();
    if (session.endedAt || session.expiresAt <= now) {
      throw new ApiError('playback_expired', 410, 'This viewing session has ended.');
    }
    session.lastHeartbeatAt = now;
    if (typeof payload.positionSeconds === 'number') session.positionSeconds = payload.positionSeconds;
    if (payload.watchedDeltaSeconds) session.watchedSeconds += payload.watchedDeltaSeconds;
    await session.save();
    ok(res, { session: { sessionId: session.token, expiresAt: session.expiresAt, watchedSeconds: session.watchedSeconds } });
  })
);

router.delete(
  '/video/playback/:sessionId',
  requireSignIn,
  asyncHandler(async (req, res) => {
    await PlaybackSession.updateOne(
      { token: req.params.sessionId, student: req.user.id, endedAt: null },
      { $set: { endedAt: new Date(), endedReason: 'client_closed' } }
    );
    noContent(res);
  })
);

export default router;
