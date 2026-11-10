import { Router } from 'express';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

  // The newest request wins. Refusing instead leaves an account locked out by a tab
  // that was closed, crashed or simply forgotten, and the viewer has no way to find
  // the tab that holds the slot. The displaced player finds out on its next heartbeat.
  const displaced = live.slice(Math.max(0, env.VIDEO_MAX_CONCURRENT_SESSIONS - 1));
  if (displaced.length) {
    await PlaybackSession.updateMany(
      { _id: { $in: displaced.map((s) => s._id) } },
      { $set: { endedAt: now, endedReason: 'displaced' } }
    );
  }

  // A tab that stopped heartbeating is already gone, even if its expiry is still
  // ahead, so it is closed here rather than left accumulating as a ghost.
  await PlaybackSession.updateMany(
    {
      student: studentId,
      endedAt: null,
      $or: [{ expiresAt: { $lte: now } }, { lastHeartbeatAt: { $lte: new Date(now.getTime() - liveWindowMs) } }]
    },
    { $set: { endedAt: now, endedReason: 'expired' } }
  );
}

router.post(
  '/video/lessons/:lessonId/playback',
  requireSignIn,
  asyncHandler(async (req, res) => {
    // Embedding only needs the library id; the API key is for management calls.
    if (!env.BUNNY_LIBRARY_ID) throw ApiError.unavailable('The video library is not configured yet.');

    const lesson = await Lesson.findById(req.params.lessonId).populate('course videoSource');
    if (!lesson || lesson.publicationStatus !== 'published') throw ApiError.notFound('Lesson not found.');
    if (!lesson.videoGuid) throw ApiError.badRequest('no_video', 'This lesson has no video attached yet.');

    const entitlement = await Entitlement.findOne({ student: req.user.id, course: lesson.course._id });
    if (!isAccessible(entitlement) && !lesson.isPreview) {
      throw ApiError.forbidden('Enrol in this course to watch it.');
    }

    const now = new Date();
    await claimSlot(req.user.id, now);

    // A borrowed video sits in whichever library actually holds the file, which is
    // not always the library of the course the member bought.
    const libraryOwner = lesson.videoSource || lesson.course;
    const playback = buildPlaybackUrl(lesson.videoGuid, {
      libraryId: libraryOwner.bunnyLibraryId || env.BUNNY_LIBRARY_ID,
      signingKey: libraryOwner.bunnySigningKey || env.BUNNY_TOKEN_KEY
    });
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

const CAPTIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../captions');

// English captions are authored per video as captions/<guid>.json ([{start,end,text}]).
// Bunny's player.js bridge exposes no caption method, so the client renders these
// as a synced overlay; the endpoint keeps paid transcripts behind the same
// entitlement check as playback.
router.get(
  '/video/lessons/:lessonId/captions',
  requireSignIn,
  asyncHandler(async (req, res) => {
    const lesson = await Lesson.findById(req.params.lessonId).populate('course');
    if (!lesson || lesson.publicationStatus !== 'published') throw ApiError.notFound('Lesson not found.');
    const guid = String(lesson.videoGuid || '');
    if (!/^[a-f\d-]{36}$/i.test(guid)) throw ApiError.notFound('English captions are not available for this lesson yet.');
    const entitlement = await Entitlement.findOne({ student: req.user.id, course: lesson.course._id });
    if (!isAccessible(entitlement) && !lesson.isPreview) throw ApiError.forbidden('Enrol in this course to view captions.');
    let cues;
    try {
      cues = JSON.parse(await fs.readFile(path.join(CAPTIONS_DIR, `${guid}.json`), 'utf8'));
    } catch {
      throw ApiError.notFound('English captions are not available for this lesson yet.');
    }
    if (!Array.isArray(cues)) throw ApiError.notFound('English captions are not available for this lesson yet.');
    ok(res, { language: 'en', cues });
  })
);

router.post(
  '/video/playback/:sessionId/heartbeat',
  requireSignIn,
  asyncHandler(async (req, res) => {
    const payload = validate(heartbeatSchema, req.body);
    const session = await PlaybackSession.findOne({ token: req.params.sessionId, student: req.user.id });
    if (!session) throw ApiError.notFound('That viewing session no longer exists.');
    const now = new Date();
    if (session.endedAt || session.expiresAt <= now) {
      throw new ApiError(
        'playback_expired',
        410,
        session.endedReason === 'displaced'
          ? 'This lesson is now playing in another tab or device, so this one stopped.'
          : 'This viewing session has ended.'
      );
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
