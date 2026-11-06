import { Router } from 'express';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { asyncHandler, ok } from '../lib/http.js';
import { bunnyStatus, listVideos } from '../services/bunny.js';
import { emailStatus } from '../services/email.js';
import { stripeStatus } from '../services/payments/index.js';

export const router = Router();

router.get(
  '/',
  asyncHandler(async (_req, res) => ok(res, { status: 'ok', env: env.NODE_ENV, database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' }))
);

router.get(
  '/integrations',
  asyncHandler(async (_req, res) => {
    const bunny = bunnyStatus();
    let videoCheck = { reachable: false, videos: 0, error: null };
    if (bunny.configured) {
      try {
        const listed = await listVideos({ pageSize: 100 });
        videoCheck = {
          reachable: true,
          videos: listed.total,
          private: listed.items.every((v) => v.isPublic === false),
          mp4FallbackEnabled: listed.items.filter((v) => v.hasMP4Fallback).length,
          unencoded: listed.items.filter((v) => v.status !== 4).map((v) => v.title)
        };
      } catch (err) {
        videoCheck = { reachable: false, videos: 0, error: err.message };
      }
    }
    ok(res, {
      database: { status: mongoose.connection.readyState === 1 ? 'connected' : 'down' },
      google: { status: env.googleConfigured ? 'configured' : 'missing-credentials' },
      payments: { status: stripeStatus().provider, ...stripeStatus() },
      bunny: { ...bunny, ...videoCheck },
      email: { ...emailStatus() }
    });
  })
);

export default router;
