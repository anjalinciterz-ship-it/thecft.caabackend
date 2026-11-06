import dns from 'node:dns';
import mongoose from 'mongoose';
import { env } from './config/env.js';

// Some Windows machines resolve DNS through a local stub that answers A records
// but refuses SRV/TXT, which is all a mongodb+srv:// lookup needs. Pinning public
// resolvers keeps Atlas reachable without changing the operator's adapter config.
if (env.DNS_SERVERS) {
  dns.setServers(env.DNS_SERVERS.split(',').map((s) => s.trim()).filter(Boolean));
}

mongoose.set('strictQuery', true);

export async function connectDatabase(uri = env.MONGODB_URI) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 20000,
    maxPoolSize: 10
  });
  return mongoose.connection;
}

export async function disconnectDatabase() {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}
