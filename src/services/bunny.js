import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from '../lib/http.js';

const api = (path, options = {}) =>
  fetch(`${env.BUNNY_STREAM_API_HOST}${path}`, {
    ...options,
    headers: { AccessKey: env.BUNNY_API_KEY, ...(options.headers || {}) }
  });

export const bunnyStatus = () => ({
  configured: env.bunnyConfigured,
  libraryId: env.BUNNY_LIBRARY_ID,
  embedHost: env.BUNNY_EMBED_HOST,
  tokenSigning: env.bunnyTokensConfigured ? 'enabled' : 'referrer-allowlist-only'
});

export async function listVideos({ page = 1, pageSize = 100 } = {}) {
  if (!env.bunnyConfigured) throw ApiError.unavailable('Bunny Stream is not configured.');
  const res = await api(`/library/${env.BUNNY_LIBRARY_ID}/videos?page=${page}&pageSize=${pageSize}`);
  if (!res.ok) throw ApiError.unavailable(`Bunny Stream lookup failed (${res.status}).`);
  const body = await res.json();
  return {
    total: body.totalItems ?? 0,
    items: (body.items || []).map((v) => ({
      guid: v.guid,
      title: v.title,
      lengthSeconds: v.length || 0,
      width: v.width,
      height: v.height,
      isPublic: v.isPublic,
      hasMP4Fallback: v.hasMP4Fallback,
      availableResolutions: v.availableResolutions,
      status: v.status,
      encodeProgress: v.encodeProgress
    }))
  };
}

export async function describeVideo(guid) {
  const res = await api(`/library/${env.BUNNY_LIBRARY_ID}/videos/${encodeURIComponent(guid)}`);
  if (res.status === 404) throw ApiError.notFound('That video no longer exists in the library.');
  if (!res.ok) throw ApiError.unavailable(`Bunny Stream lookup failed (${res.status}).`);
  return res.json();
}

// Bunny's "embedded view token" scheme: hex(sha256(tokenKey + videoGuid + expires)).
// PlayerJS reads its own query string, so the token parameters have to survive
// alongside the player options rather than replacing them.
const PLAYER_OPTIONS = 'autoplay=false&mute=false&loop=false&controls=true&preload=false&playbackRate=false&quality_selector=1&contextmenu=false';

export function buildPlaybackUrl(videoGuid, { libraryId = env.BUNNY_LIBRARY_ID, signingKey = env.BUNNY_TOKEN_KEY, ttlSeconds = env.VIDEO_SESSION_TTL_SECONDS } = {}) {
  const path = `/embed/${libraryId}/${videoGuid}`;
  const base = `${env.BUNNY_EMBED_HOST}${path}?${PLAYER_OPTIONS}`;
  if (!signingKey) return { url: base, signed: false, expiresAt: null };
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const token = crypto.createHash('sha256').update(`${signingKey}${videoGuid}${expires}`).digest('hex');
  return { url: `${base}&token=${token}&expires=${expires}`, signed: true, expiresAt: new Date(expires * 1000) };
}

export function watermarkText({ email, name, sessionId }) {
  const who = name ? `${name} · ${email}` : email;
  return `${who} · ${sessionId.slice(-6).toUpperCase()}`;
}
