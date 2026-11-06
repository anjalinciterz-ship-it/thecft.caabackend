import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import session from 'express-session';
import mongoStore from 'connect-mongo';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import { ApiError, sendFailure } from './lib/http.js';
import { attachUser } from './middleware/loadUser.js';
import { csrfGuard } from './lib/security.js';
import authRouter from './routes/auth.js';
import catalogRouter from './routes/catalog.js';
import cartRouter from './routes/cart.js';
import studentRouter from './routes/student.js';
import videoRouter from './routes/video.js';
import adminRouter from './routes/admin.js';
import stubRouter from './routes/stubs.js';
import contactRouter from './routes/contact.js';
import healthRouter from './routes/health.js';
import webhooksRouter from './routes/webhooks.js';

const COOKIE_NAME = 'cft.sid';

const corsOptions = () => ({
  origin(origin, callback) {
    // Same-origin and tooling requests arrive without an Origin header.
    if (!origin || env.allowedOrigins.includes(origin)) return callback(null, true);
    callback(new ApiError('cors_origin_denied', 403, `Origin ${origin} is not allowed.`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key', 'Authorization'],
  exposedHeaders: ['X-CSRF-Token']
});

const sessionMiddleware = (sessionStore) =>
  session({
    name: COOKIE_NAME,
    // A supplied store is used verbatim by the e2e suite; production sessions live in Mongo.
    store: sessionStore || mongoStore.create({ client: mongoose.connection.getClient(), collectionName: 'sessions', ttl: 60 * 60 * 24 * 30 }),
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: env.SESSION_COOKIE_SECURE,
      sameSite: env.SESSION_COOKIE_SECURE ? 'none' : 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 30,
      path: '/'
    }
  });

export function createApp({ sessionStore } = {}) {
  const app = express();
  // Render and Netlify both terminate TLS in front of the app, so req.ip and
  // req.secure have to reflect the forwarded request, not the load balancer.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(compression());
  app.use(cors(corsOptions()));
  app.options('*', cors(corsOptions()));

  // Payment providers sign raw bytes, so these routes are mounted before any body parser.
  app.use('/api/v1/webhooks', webhooksRouter);

  app.use(express.json({ limit: '200kb' }));
  app.use(express.urlencoded({ extended: true, limit: '200kb' }));
  app.use(cookieParser(env.SESSION_SECRET));
  app.use(sessionMiddleware(sessionStore));
  app.use(attachUser);

  app.get('/', (_req, res) => res.json({ data: { service: 'cft-backend', status: 'ok' } }));
  app.use('/health', healthRouter);
  app.use('/api/v1/health', healthRouter);

  const api = express.Router();
  api.use(csrfGuard);
  api.use('/auth', rateLimit({ windowMs: 60_000, limit: 40, standardHeaders: true, legacyHeaders: false }), authRouter);
  api.use('/contact', rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false }), contactRouter);
  api.use(
    rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false, skip: (req) => req.method === 'GET' }),
    catalogRouter,
    cartRouter,
    studentRouter,
    videoRouter,
    adminRouter,
    stubRouter
  );
  app.use('/api/v1', api);

  app.use((req, _res, next) => next(new ApiError('not_found', 404, `No route for ${req.method} ${req.path}`)));
  app.use((err, req, res, next) => {
    if (err?.message === 'failure' || err?.code === 'EBADCSRFTOKEN') {
      return sendFailure(res, new ApiError('session_invalid', 401, 'Your session expired. Sign in again.'));
    }
    sendFailure(res, err);
  });

  return app;
}

export default createApp;
