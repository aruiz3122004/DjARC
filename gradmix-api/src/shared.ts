export interface RoomPermissions {
  canSkip: boolean;
  canPause: boolean;
  canAdd: boolean;
  canRemove: boolean;
}

export interface RoomParticipant {
  id: string;
  name: string;
  isHost: boolean;
  joinedAt: number;
  lastSeenAt?: number;
  deviceId?: string;
  permissions: RoomPermissions;
}

export interface RoomQueuePreviewItem {
  id: string;
  title: string;
  artist: string;
  duration: number;
}

export interface RoomTrackMeta {
  id: string;
  title: string;
  artist: string;
  duration: number;
  addedById: string;
  addedByName: string;
  addedAt: number;
  mimeType: string;
  fileName: string;
  /** El audio sigue disponible en R2 para que el host lo descargue una vez. */
  hasAudioRelay: boolean;
}

export interface RoomDoc {
  code: string;
  passwordHash: string;
  passwordSalt: string;
  passwordIterations: number;
  hostId: string;
  inviteToken: string;
  createdAt: number;
  expiresAt: number;
  maxDurationHours: number;
  participants: RoomParticipant[];
  tracks: RoomTrackMeta[];
  playbackQueue?: RoomQueuePreviewItem[];
  nowPlayingTitle: string | null;
  nowPlayingArtist?: string | null;
  nowPlayingTrackKey?: string | null;
  nowAudioTrackKey?: string | null;
  nowPlayingAudioMime?: string | null;
  hasLiveAudio?: boolean;
  basePositionSec?: number;
  playbackSyncedAtMs?: number;
  isPlaying: boolean;
}

export interface BundleTrackMeta {
  title: string;
  artist: string;
  fileName: string;
  duration: number;
  bpm: number | null;
  block: string;
  mimeType: string;
  byteLength: number;
}

export interface BundleRecord {
  id: string;
  playlistName: string;
  block: string;
  createdAt: number;
  expiresAt: number;
  tracks: BundleTrackMeta[];
}

export interface Env {
  ROOMS: DurableObjectNamespace;
  BUNDLES: DurableObjectNamespace;
  AUDIO: R2Bucket;
  ALLOWED_ORIGINS: string;
}

export const MAX_ROOM_HOURS = 10;
export const GUEST_INACTIVITY_MS = 10_000;
export const MAX_UPLOAD_BYTES = 35 * 1024 * 1024;
export const BUNDLE_TTL_MS = 24 * 3600 * 1000;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(extraHeaders as Record<string, string> | undefined),
    },
  });
}

export function generateCode(length = 6): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
  }
  return out;
}

export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 16);
}

export function randomToken(bytes = 12): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64Url(buf);
}

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const buffer = new ArrayBuffer(clean.length / 2);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function randomSalt(): string {
  const salt = new Uint8Array(12);
  crypto.getRandomValues(salt);
  return bytesToHex(salt);
}

/**
 * El plan gratuito de Workers limita el CPU por petición, así que usamos PBKDF2
 * con 12 000 iteraciones: suficiente para salas efímeras de fiesta.
 */
export const PASSWORD_ITERATIONS = 12_000;

export async function hashPassword(
  password: string,
  saltHex: string,
  iterations = PASSWORD_ITERATIONS
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: hexToBytes(saltHex),
      iterations,
      hash: 'SHA-256',
    },
    key,
    256
  );
  return base64Url(new Uint8Array(bits));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function verifyPassword(
  password: string,
  saltHex: string,
  expectedHash: string,
  iterations: number
): Promise<boolean> {
  if (!expectedHash) return false;
  const actual = await hashPassword(password, saltHex, iterations);
  return constantTimeEqual(actual, expectedHash);
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  return constantTimeEqual(a, b);
}

export function resolveCors(request: Request, allowed: string): HeadersInit | null {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const list = allowed
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const isAllowed =
    list.includes(origin) ||
    /^https:\/\/gradmix-[a-z0-9-]+-aruiz3122004s-projects\.vercel\.app$/.test(origin);
  if (!isAllowed) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Idempotency-Key, Range, X-Host-Id, X-Track-Key, X-Participant-Id, X-Track-Filename, X-Track-Title, X-Track-Artist, X-Track-Duration',
    'Access-Control-Expose-Headers': 'Content-Type, Content-Length, Content-Range, Accept-Ranges',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export async function readJson<T>(request: Request): Promise<T> {
  const raw = await request.text();
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error('JSON inválido.');
  }
}
