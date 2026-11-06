import { env } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './db.js';
import { createApp } from './app.js';

const main = async () => {
  await connectDatabase();
  const app = createApp();
  const server = app.listen(env.PORT, '0.0.0.0', () => {
    console.log(`[cft-api] listening on :${env.PORT} (${env.NODE_ENV}) payments=${env.PAYMENT_PROVIDER} email=${env.EMAIL_PROVIDER}`);
  });

  const shutdown = (signal) => {
    console.log(`[cft-api] ${signal} received, closing connections`);
    server.close(async () => {
      await disconnectDatabase().catch(() => null);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => console.error('[cft-api] unhandled rejection', reason));
};

main().catch((err) => {
  console.error('[cft-api] failed to start', err);
  process.exit(1);
});
