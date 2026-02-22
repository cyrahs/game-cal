import { SimpleTtlCache } from "../../api/src/lib/cache.js";
import type { RuntimeEnv } from "../../api/src/lib/runtimeEnv.js";
import { GAMES, fetchCurrentVersionForGame, fetchEventsForGame } from "../../api/src/games/index.js";
import type { ApiResponse, CalendarEvent, GameId, GameVersionInfo } from "../../api/src/types.js";

interface Env extends RuntimeEnv {
  // Workers Assets binding (see wrangler.jsonc assets.binding).
  ASSETS: Fetcher;

  // Optional D1 binding for sync state.
  // Configure in wrangler.jsonc -> d1_databases: [{ binding: "DB", ... }]
  DB?: D1Database;

  // Optional runtime knobs (match the Node API env vars where possible).
  CACHE_TTL_SECONDS?: string;
  CORS_ORIGIN?: string; // comma-separated allowlist; omit/empty to allow all

  // Sync API rate limit knobs (IP based, Worker in-memory token bucket).
  SYNC_RATE_LIMIT_MAX?: string;
  SYNC_RATE_LIMIT_WINDOW_SECONDS?: string;
  SYNC_RATE_LIMIT_WRITE_COST?: string;
  // Shared per-IP limit for D1-backed sync operations.
  SYNC_D1_RATE_LIMIT_MAX?: string;
  SYNC_D1_RATE_LIMIT_WINDOW_SECONDS?: string;
}

const cache = new SimpleTtlCache();
const DEFAULT_CACHE_TTL_SECONDS = 60 * 60 * 8;
const DEFAULT_SYNC_RATE_LIMIT_MAX = 120;
const DEFAULT_SYNC_RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_SYNC_RATE_LIMIT_WRITE_COST = 1;
const DEFAULT_SYNC_D1_RATE_LIMIT_MAX = 5;
const DEFAULT_SYNC_D1_RATE_LIMIT_WINDOW_SECONDS = 60;
const SYNC_RATE_LIMIT_MAX_TRACKED_IPS = 20_000;

const SYNC_TABLE = "gc_sync_state";
const EVENTS_TABLE = "gc_events_cache";
const SYNC_PBKDF2_ITERATIONS = 100_000;
const SYNC_SALT_BYTES = 16;
const SYNC_HASH_BYTES = 32; // 256-bit
const SYNC_UUID_MIN_LENGTH = 8;
const SYNC_UUID_MAX_LENGTH = 64;
const SYNC_PASSWORD_MAX_LENGTH = 128;
const SYNC_WRITE_IDLE_FLUSH_MS = 5_000;
const SYNC_BUFFER_MAX_ENTRIES = 5_000;
const SYNC_BUFFER_IDLE_EVICT_MS = 10 * 60 * 1000;
const SYNC_BUFFER_SWEEP_INTERVAL_MS = 60 * 1000;
const UPDATED_AT_HEADER = "x-gc-updated-at";

type SyncRateBucket = {
  tokens: number;
  updatedAtMs: number;
};

type SyncRateLimitOutcome = {
  allowed: boolean;
  headers: Headers;
};

const syncRateBuckets = new Map<string, SyncRateBucket>();
let syncRateLastSweepAtMs = 0;
const syncD1RateBuckets = new Map<string, SyncRateBucket>();
let syncD1RateLastSweepAtMs = 0;

let didInitSyncSchema = false;
let didInitEventsSchema = false;
let eventsRefreshAllPromise: Promise<void> | null = null;

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(hex: string): Uint8Array | null {
  const h = hex.trim();
  if (h.length === 0 || h.length % 2 !== 0) return null;
  if (!/^[0-9a-f]+$/i.test(h)) return null;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function isCacheStale(updatedAtMs: number, ttlMs: number, nowMs: number): boolean {
  return nowMs - updatedAtMs >= ttlMs;
}

function getPasswordHeader(req: Request): string | null {
  const raw = req.headers.get("x-gc-password") ?? req.headers.get("x-game-cal-password");
  const v = (raw ?? "").trim();
  return v ? v : null;
}

function validateSyncPassword(password: string): string | null {
  if (!password.trim()) return "Missing header: x-gc-password";
  if (password.length > SYNC_PASSWORD_MAX_LENGTH) {
    return `Password too long (max ${SYNC_PASSWORD_MAX_LENGTH} chars)`;
  }
  return null;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? String(fallback));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

function parseSyncRateLimitConfig(env: Env): { limit: number; windowMs: number; writeCost: number } {
  const limit = Math.min(parsePositiveInt(env.SYNC_RATE_LIMIT_MAX, DEFAULT_SYNC_RATE_LIMIT_MAX), 10_000);
  const windowSeconds = Math.min(
    parsePositiveInt(env.SYNC_RATE_LIMIT_WINDOW_SECONDS, DEFAULT_SYNC_RATE_LIMIT_WINDOW_SECONDS),
    60 * 60
  );
  const writeCost = Math.min(parsePositiveInt(env.SYNC_RATE_LIMIT_WRITE_COST, DEFAULT_SYNC_RATE_LIMIT_WRITE_COST), limit);
  return {
    limit,
    windowMs: Math.trunc(windowSeconds * 1000),
    writeCost,
  };
}

function parseSyncD1RateLimitConfig(env: Env): { limit: number; windowMs: number } {
  const limit = Math.min(parsePositiveInt(env.SYNC_D1_RATE_LIMIT_MAX, DEFAULT_SYNC_D1_RATE_LIMIT_MAX), 10_000);
  const windowSeconds = Math.min(
    parsePositiveInt(env.SYNC_D1_RATE_LIMIT_WINDOW_SECONDS, DEFAULT_SYNC_D1_RATE_LIMIT_WINDOW_SECONDS),
    60 * 60
  );
  return {
    limit,
    windowMs: Math.trunc(windowSeconds * 1000),
  };
}

function extractClientIp(request: Request): string {
  const cf = (request.headers.get("cf-connecting-ip") ?? "").trim();
  if (cf && cf.length <= 128) return cf.toLowerCase();

  const xff = request.headers.get("x-forwarded-for") ?? "";
  const first = xff.split(",")[0]?.trim() ?? "";
  if (first && first.length <= 128) return first.toLowerCase();

  const real = (request.headers.get("x-real-ip") ?? "").trim();
  if (real && real.length <= 128) return real.toLowerCase();

  return "unknown";
}

function maybeSweepSyncRateBuckets(nowMs: number, windowMs: number): void {
  const staleAfterMs = windowMs * 3;
  const shouldSweepByTime = nowMs - syncRateLastSweepAtMs >= windowMs;
  const shouldSweepBySize = syncRateBuckets.size > SYNC_RATE_LIMIT_MAX_TRACKED_IPS;
  if (!shouldSweepByTime && !shouldSweepBySize) return;
  syncRateLastSweepAtMs = nowMs;

  for (const [ip, bucket] of syncRateBuckets.entries()) {
    if (nowMs - bucket.updatedAtMs > staleAfterMs) {
      syncRateBuckets.delete(ip);
    }
  }

  if (syncRateBuckets.size <= SYNC_RATE_LIMIT_MAX_TRACKED_IPS) return;

  const overflow = syncRateBuckets.size - SYNC_RATE_LIMIT_MAX_TRACKED_IPS;
  const oldest = [...syncRateBuckets.entries()].sort((a, b) => a[1].updatedAtMs - b[1].updatedAtMs);
  for (let i = 0; i < overflow; i++) {
    const ip = oldest[i]?.[0];
    if (ip) syncRateBuckets.delete(ip);
  }
}

function maybeSweepSyncD1RateBuckets(nowMs: number, windowMs: number): void {
  const staleAfterMs = windowMs * 3;
  const shouldSweepByTime = nowMs - syncD1RateLastSweepAtMs >= windowMs;
  const shouldSweepBySize = syncD1RateBuckets.size > SYNC_RATE_LIMIT_MAX_TRACKED_IPS;
  if (!shouldSweepByTime && !shouldSweepBySize) return;
  syncD1RateLastSweepAtMs = nowMs;

  for (const [ip, bucket] of syncD1RateBuckets.entries()) {
    if (nowMs - bucket.updatedAtMs > staleAfterMs) {
      syncD1RateBuckets.delete(ip);
    }
  }

  if (syncD1RateBuckets.size <= SYNC_RATE_LIMIT_MAX_TRACKED_IPS) return;

  const overflow = syncD1RateBuckets.size - SYNC_RATE_LIMIT_MAX_TRACKED_IPS;
  const oldest = [...syncD1RateBuckets.entries()].sort((a, b) => a[1].updatedAtMs - b[1].updatedAtMs);
  for (let i = 0; i < overflow; i++) {
    const ip = oldest[i]?.[0];
    if (ip) syncD1RateBuckets.delete(ip);
  }
}

function toSyncRateHeaders(limit: number, remaining: number, resetAtMs: number, retryAfterSeconds = 0): Headers {
  const headers = new Headers();
  headers.set("x-ratelimit-limit", String(limit));
  headers.set("x-ratelimit-remaining", String(Math.max(0, remaining)));
  headers.set("x-ratelimit-reset", String(Math.ceil(resetAtMs / 1000)));
  if (retryAfterSeconds > 0) {
    headers.set("retry-after", String(retryAfterSeconds));
  }
  return headers;
}

function applyResponseHeaders(res: Response, extra: Headers): Response {
  if ([...extra.keys()].length === 0) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of extra.entries()) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function syncRateLimitedResponse(headers: Headers, action: "sync" | "d1"): Response {
  const msg =
    action === "d1"
      ? "Too many D1-backed sync requests from this IP. Please retry later."
      : "Too many sync requests from this IP. Please retry later.";
  return json({ code: 429, msg, data: null } satisfies ApiResponse<null>, { status: 429, headers });
}

function takeSyncRateLimit(request: Request, env: Env): SyncRateLimitOutcome {
  const { limit, windowMs, writeCost } = parseSyncRateLimitConfig(env);
  const ip = extractClientIp(request);
  const nowMs = Date.now();
  maybeSweepSyncRateBuckets(nowMs, windowMs);

  const methodCost = request.method === "PUT" || request.method === "POST" ? writeCost : 1;
  const refillPerMs = limit / windowMs;
  const existing = syncRateBuckets.get(ip) ?? { tokens: limit, updatedAtMs: nowMs };

  const elapsedMs = Math.max(0, nowMs - existing.updatedAtMs);
  const tokens = Math.min(limit, existing.tokens + elapsedMs * refillPerMs);
  const nextTokens = tokens - methodCost;

  if (nextTokens < 0) {
    const waitMs = Math.abs(nextTokens) / refillPerMs;
    const retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000));
    syncRateBuckets.set(ip, { tokens, updatedAtMs: nowMs });
    return {
      allowed: false,
      headers: toSyncRateHeaders(limit, Math.floor(tokens), nowMs + retryAfterSeconds * 1000, retryAfterSeconds),
    };
  }

  syncRateBuckets.set(ip, { tokens: nextTokens, updatedAtMs: nowMs });
  const secondsUntilFull = Math.max(1, Math.ceil(((limit - nextTokens) / refillPerMs) / 1000));

  return {
    allowed: true,
    headers: toSyncRateHeaders(limit, Math.floor(nextTokens), nowMs + secondsUntilFull * 1000),
  };
}

function takeSyncD1RateLimit(request: Request, env: Env): SyncRateLimitOutcome {
  const { limit, windowMs } = parseSyncD1RateLimitConfig(env);
  const ip = extractClientIp(request);
  const nowMs = Date.now();
  maybeSweepSyncD1RateBuckets(nowMs, windowMs);

  const refillPerMs = limit / windowMs;
  const existing = syncD1RateBuckets.get(ip) ?? { tokens: limit, updatedAtMs: nowMs };

  const elapsedMs = Math.max(0, nowMs - existing.updatedAtMs);
  const tokens = Math.min(limit, existing.tokens + elapsedMs * refillPerMs);
  const nextTokens = tokens - 1;

  if (nextTokens < 0) {
    const waitMs = Math.abs(nextTokens) / refillPerMs;
    const retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000));
    syncD1RateBuckets.set(ip, { tokens, updatedAtMs: nowMs });
    return {
      allowed: false,
      headers: toSyncRateHeaders(limit, Math.floor(tokens), nowMs + retryAfterSeconds * 1000, retryAfterSeconds),
    };
  }

  syncD1RateBuckets.set(ip, { tokens: nextTokens, updatedAtMs: nowMs });
  const secondsUntilFull = Math.max(1, Math.ceil(((limit - nextTokens) / refillPerMs) / 1000));

  return {
    allowed: true,
    headers: toSyncRateHeaders(limit, Math.floor(nextTokens), nowMs + secondsUntilFull * 1000),
  };
}

function validateSyncUuidKey(uuid: string): string | null {
  // Keep this fairly permissive (it's also part of the URL path), but avoid abuse.
  const v = uuid.trim();
  if (v.length < SYNC_UUID_MIN_LENGTH) return `UUID too short (min ${SYNC_UUID_MIN_LENGTH} chars)`;
  if (v.length > SYNC_UUID_MAX_LENGTH) return `UUID too long (max ${SYNC_UUID_MAX_LENGTH} chars)`;
  if (!/^[0-9a-z-]+$/i.test(v)) return "Invalid uuid";
  return null;
}

async function pbkdf2Hash(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: SYNC_PBKDF2_ITERATIONS },
    keyMaterial,
    SYNC_HASH_BYTES * 8
  );
  return new Uint8Array(bits);
}

async function ensureSyncSchema(env: Env): Promise<boolean> {
  if (!env.DB) return false;
  if (didInitSyncSchema) return true;
  // Idempotent init to reduce "oops forgot migrations" footguns.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ${SYNC_TABLE} (
      uuid TEXT PRIMARY KEY,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      blob TEXT NOT NULL,
      client_updated_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_gc_sync_state_updated_at ON ${SYNC_TABLE}(updated_at)`
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_gc_sync_state_client_updated_at ON ${SYNC_TABLE}(client_updated_at)`
  ).run();
  didInitSyncSchema = true;
  return true;
}

type SyncRow = {
  uuid: string;
  password_salt: string;
  password_hash: string;
  blob: string;
  client_updated_at: number;
  created_at: number;
  updated_at: number;
};

type SyncBufferEntry = {
  row: SyncRow;
  dirty: boolean;
  flushAfterMs: number;
  version: number;
  lastAccessAtMs: number;
};

type EventCacheRow = {
  game: GameId;
  payload: string;
  updated_at: number | string;
};

type EventCacheUpdatedAtRow = {
  updated_at: number | string;
};

const syncBuffer = new Map<string, SyncBufferEntry>();
let syncBufferLastSweepAtMs = 0;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readSyncRow(env: Env, uuid: string): Promise<SyncRow | null> {
  if (!env.DB) return null;
  const row = (await env.DB.prepare(
    `SELECT uuid, password_salt, password_hash, blob, client_updated_at, created_at, updated_at FROM ${SYNC_TABLE} WHERE uuid = ?`
  )
    .bind(uuid)
    .first()) as SyncRow | null;
  return row;
}

function maybeSweepSyncBuffer(nowMs: number): void {
  const shouldSweepByTime = nowMs - syncBufferLastSweepAtMs >= SYNC_BUFFER_SWEEP_INTERVAL_MS;
  const shouldSweepBySize = syncBuffer.size > SYNC_BUFFER_MAX_ENTRIES;
  if (!shouldSweepByTime && !shouldSweepBySize) return;
  syncBufferLastSweepAtMs = nowMs;

  for (const [uuid, entry] of syncBuffer.entries()) {
    if (entry.dirty) continue;
    if (nowMs - entry.lastAccessAtMs > SYNC_BUFFER_IDLE_EVICT_MS) {
      syncBuffer.delete(uuid);
    }
  }

  if (syncBuffer.size <= SYNC_BUFFER_MAX_ENTRIES) return;
  const removable = [...syncBuffer.entries()]
    .filter(([, entry]) => !entry.dirty)
    .sort((a, b) => a[1].lastAccessAtMs - b[1].lastAccessAtMs);
  const overflow = syncBuffer.size - SYNC_BUFFER_MAX_ENTRIES;
  for (let i = 0; i < overflow; i++) {
    const uuid = removable[i]?.[0];
    if (!uuid) break;
    syncBuffer.delete(uuid);
  }
}

function getNextSyncUpdatedAt(existing: SyncRow | null): number {
  const now = Date.now();
  if (!existing) return now;
  return Math.max(now, Math.trunc(existing.updated_at) + 1);
}

function markSyncRowDirty(row: SyncRow): SyncBufferEntry {
  const now = Date.now();
  const entry = syncBuffer.get(row.uuid);
  if (entry) {
    entry.row = row;
    entry.dirty = true;
    entry.flushAfterMs = now + SYNC_WRITE_IDLE_FLUSH_MS;
    entry.version += 1;
    entry.lastAccessAtMs = now;
    return entry;
  }

  const created: SyncBufferEntry = {
    row,
    dirty: true,
    flushAfterMs: now + SYNC_WRITE_IDLE_FLUSH_MS,
    version: 1,
    lastAccessAtMs: now,
  };
  syncBuffer.set(row.uuid, created);
  maybeSweepSyncBuffer(now);
  return created;
}

function rememberSyncRow(row: SyncRow): SyncRow {
  const now = Date.now();
  const entry = syncBuffer.get(row.uuid);
  if (entry) {
    entry.lastAccessAtMs = now;
    // Never overwrite dirty buffered writes with a DB snapshot.
    if (!entry.dirty) {
      entry.row = row;
    }
    return entry.row;
  }

  syncBuffer.set(row.uuid, {
    row,
    dirty: false,
    flushAfterMs: 0,
    version: 0,
    lastAccessAtMs: now,
  });
  maybeSweepSyncBuffer(now);
  return row;
}

async function readSyncRowWithBuffer(env: Env, uuid: string): Promise<SyncRow | null> {
  const cached = syncBuffer.get(uuid);
  if (cached) {
    cached.lastAccessAtMs = Date.now();
    return cached.row;
  }

  const row = await readSyncRow(env, uuid);
  if (!row) return null;
  return rememberSyncRow(row);
}

async function writeSyncRowToD1(env: Env, row: SyncRow): Promise<void> {
  if (!env.DB) return;
  await env.DB.prepare(
    `INSERT INTO ${SYNC_TABLE} (uuid, password_salt, password_hash, blob, client_updated_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uuid) DO UPDATE SET
       password_salt = excluded.password_salt,
       password_hash = excluded.password_hash,
       blob = excluded.blob,
       client_updated_at = excluded.client_updated_at,
       updated_at = excluded.updated_at
     WHERE excluded.updated_at >= ${SYNC_TABLE}.updated_at`
  )
    .bind(
      row.uuid,
      row.password_salt,
      row.password_hash,
      row.blob,
      Math.trunc(row.client_updated_at),
      Math.trunc(row.created_at),
      Math.trunc(row.updated_at)
    )
    .run();
}

async function flushSyncRowToD1(
  env: Env,
  uuid: string,
  opts?: { expectedVersion?: number; onlyIfDue?: boolean }
): Promise<boolean> {
  const entry = syncBuffer.get(uuid);
  if (!entry || !entry.dirty) return false;
  if (opts?.expectedVersion != null && opts.expectedVersion !== entry.version) return false;
  if (opts?.onlyIfDue && Date.now() < entry.flushAfterMs) return false;

  const version = entry.version;
  const snapshot = { ...entry.row };
  await writeSyncRowToD1(env, snapshot);

  const latest = syncBuffer.get(uuid);
  if (latest && latest.version === version) {
    latest.dirty = false;
    latest.flushAfterMs = 0;
    latest.lastAccessAtMs = Date.now();
  }
  return true;
}

async function flushDueSyncRowsToD1(env: Env): Promise<number> {
  if (!env.DB || syncBuffer.size === 0) return 0;
  if (!(await ensureSyncSchema(env))) return 0;

  const now = Date.now();
  const due = [...syncBuffer.entries()]
    .filter(([, entry]) => entry.dirty && entry.flushAfterMs <= now)
    .map(([uuid, entry]) => ({ uuid, version: entry.version }));
  if (due.length === 0) return 0;

  let flushed = 0;
  for (const item of due) {
    try {
      if (await flushSyncRowToD1(env, item.uuid, { expectedVersion: item.version, onlyIfDue: true })) {
        flushed += 1;
      }
    } catch (err) {
      console.error("Failed to flush buffered sync row to D1", { uuid: item.uuid, err });
    }
  }
  maybeSweepSyncBuffer(Date.now());
  return flushed;
}

function scheduleSyncRowFlush(env: Env, ctx: ExecutionContext, uuid: string, version: number): void {
  ctx.waitUntil(
    (async () => {
      await sleepMs(SYNC_WRITE_IDLE_FLUSH_MS);
      try {
        await flushSyncRowToD1(env, uuid, { expectedVersion: version, onlyIfDue: true });
      } catch (err) {
        console.error("Delayed sync flush failed", { uuid, err });
      }
    })()
  );
}

async function flushSyncRowImmediately(env: Env, uuid: string, expectedVersion: number): Promise<void> {
  const flushedExpected = await flushSyncRowToD1(env, uuid, { expectedVersion });
  if (!flushedExpected) {
    await flushSyncRowToD1(env, uuid);
  }
}

async function verifyRowPassword(row: SyncRow, password: string): Promise<boolean> {
  const salt = hexToBytes(row.password_salt);
  const expected = hexToBytes(row.password_hash);
  if (!salt || !expected) return false;
  const actual = await pbkdf2Hash(password, salt);
  return timingSafeEqual(actual, expected);
}

async function ensureEventsSchema(env: Env): Promise<boolean> {
  if (!env.DB) return false;
  if (didInitEventsSchema) return true;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (
      game TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_gc_events_cache_updated_at ON ${EVENTS_TABLE}(updated_at)`
  ).run();
  didInitEventsSchema = true;
  return true;
}

async function readEventCacheRow(env: Env, game: GameId): Promise<EventCacheRow | null> {
  if (!env.DB) return null;
  return (await env.DB.prepare(`SELECT game, payload, updated_at FROM ${EVENTS_TABLE} WHERE game = ?`)
    .bind(game)
    .first()) as EventCacheRow | null;
}

async function readEventCacheUpdatedAt(env: Env, game: GameId): Promise<number | null> {
  if (!env.DB) return null;
  const row = (await env.DB.prepare(`SELECT updated_at FROM ${EVENTS_TABLE} WHERE game = ?`)
    .bind(game)
    .first()) as EventCacheUpdatedAtRow | null;
  if (!row) return null;
  const updatedAt = Number(row.updated_at);
  return Number.isFinite(updatedAt) ? updatedAt : Number.NaN;
}

async function writeEventCacheRow(env: Env, game: GameId, payload: string, updatedAt: number): Promise<void> {
  if (!env.DB) return;
  await env.DB.prepare(
    `INSERT INTO ${EVENTS_TABLE} (game, payload, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(game) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
  )
    .bind(game, payload, Math.trunc(updatedAt))
    .run();
}

function decodeEventPayload(payload: string): CalendarEvent[] | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return Array.isArray(parsed) ? (parsed as CalendarEvent[]) : null;
  } catch {
    return null;
  }
}

type EventsWithUpdatedAt = {
  events: CalendarEvent[];
  updatedAtMs: number;
};

async function refreshGameEventsToD1(env: Env, game: GameId): Promise<EventsWithUpdatedAt> {
  const events = await fetchEventsForGame(game, env);
  const updatedAtMs = Date.now();
  await writeEventCacheRow(env, game, JSON.stringify(events), updatedAtMs);
  return { events, updatedAtMs };
}

async function refreshAllGamesToD1(env: Env): Promise<void> {
  const tasks = GAMES.map(async ({ id }) => {
    await refreshGameEventsToD1(env, id);
  });
  const results = await Promise.allSettled(tasks);
  for (const [idx, r] of results.entries()) {
    if (r.status === "rejected") {
      const game = GAMES[idx]?.id;
      console.error("Failed to refresh D1 event cache", { game, err: r.reason });
    }
  }
}

function triggerRefreshAllGames(env: Env): Promise<void> {
  const existing = eventsRefreshAllPromise;
  if (existing) return existing;
  const p = refreshAllGamesToD1(env).finally(() => {
    eventsRefreshAllPromise = null;
  });
  eventsRefreshAllPromise = p;
  return p;
}

async function shouldRefreshAllGames(env: Env, ttlMs: number): Promise<boolean> {
  const nowMs = Date.now();
  const checks = await Promise.all(
    GAMES.map(async ({ id }) => {
      const updatedAt = await readEventCacheUpdatedAt(env, id);
      return { id, updatedAt };
    })
  );

  for (const { updatedAt } of checks) {
    if (updatedAt === null || !Number.isFinite(updatedAt) || isCacheStale(updatedAt, ttlMs, nowMs)) {
      return true;
    }
  }
  return false;
}

async function refreshAllGamesToD1IfNeeded(env: Env): Promise<boolean> {
  if (!env.DB) return false;
  if (!(await ensureEventsSchema(env))) return false;

  const ttlMs = parseCacheTtlMs(env);
  if (!(await shouldRefreshAllGames(env, ttlMs))) return false;

  await triggerRefreshAllGames(env);
  return true;
}

async function getEventsForGameWithCache(env: Env, game: GameId): Promise<EventsWithUpdatedAt> {
  const cacheTtlMs = parseCacheTtlMs(env);
  const memoryFallback = async () =>
    await cache.getOrSet(`events:${game}`, cacheTtlMs, async () => {
      const events = await fetchEventsForGame(game, env);
      return { events, updatedAtMs: Date.now() };
    });

  if (!env.DB) return await memoryFallback();

  return await cache.getOrSet(`events:d1:${game}`, cacheTtlMs, async () => {
    try {
      if (!(await ensureEventsSchema(env))) {
        return await memoryFallback();
      }

      const row = await readEventCacheRow(env, game);

      if (!row) {
        await triggerRefreshAllGames(env);
        const refreshed = await readEventCacheRow(env, game);
        const parsed = refreshed ? decodeEventPayload(refreshed.payload) : null;
        const updatedAt = refreshed ? Number(refreshed.updated_at) : Number.NaN;
        if (parsed && Number.isFinite(updatedAt) && updatedAt > 0) return { events: parsed, updatedAtMs: updatedAt };
        return await refreshGameEventsToD1(env, game);
      }

      const parsed = decodeEventPayload(row.payload);
      const updatedAt = Number(row.updated_at);
      if (!parsed || !Number.isFinite(updatedAt) || updatedAt <= 0 || isCacheStale(updatedAt, cacheTtlMs, Date.now())) {
        await triggerRefreshAllGames(env);
        const refreshed = await readEventCacheRow(env, game);
        const refreshedParsed = refreshed ? decodeEventPayload(refreshed.payload) : null;
        const refreshedUpdatedAt = refreshed ? Number(refreshed.updated_at) : Number.NaN;
        if (refreshedParsed && Number.isFinite(refreshedUpdatedAt) && refreshedUpdatedAt > 0) {
          return { events: refreshedParsed, updatedAtMs: refreshedUpdatedAt };
        }
        return await refreshGameEventsToD1(env, game);
      }

      return { events: parsed, updatedAtMs: updatedAt };
    } catch (err) {
      console.error("D1 event cache failed, fallback to in-memory cache", { game, err });
      return await memoryFallback();
    }
  });
}

type GameSnapshotData = {
  events: CalendarEvent[];
  eventsUpdatedAtMs: number;
  version: GameVersionInfo | null;
};

async function getGameSnapshotWithCache(env: Env, game: GameId): Promise<GameSnapshotData> {
  const cacheTtlMs = parseCacheTtlMs(env);
  return await cache.getOrSet(`snapshot:${game}`, cacheTtlMs, async () => {
    const [eventsRes, version] = await Promise.all([
      getEventsForGameWithCache(env, game),
      fetchCurrentVersionForGame(game, env),
    ]);
    return { events: eventsRes.events, eventsUpdatedAtMs: eventsRes.updatedAtMs, version };
  });
}

async function handleSyncApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!(await ensureSyncSchema(env))) {
    return json({ code: 501, msg: "Sync store not configured (missing D1 binding)", data: null }, { status: 501 });
  }

  const url = new URL(request.url);
  const rotateMatch = /^\/api\/sync\/([^/]+)\/rotate$/.exec(url.pathname);
  const mainMatch = /^\/api\/sync\/([^/]+)$/.exec(url.pathname);

  const uuidRaw = decodeURIComponent((rotateMatch?.[1] ?? mainMatch?.[1] ?? "").trim());
  const uuidError = validateSyncUuidKey(uuidRaw);
  if (!uuidRaw || uuidError) {
    return json({ code: 400, msg: uuidError ?? "Invalid uuid", data: null }, { status: 400 });
  }

  const password = getPasswordHeader(request);
  if (!password) {
    return json({ code: 400, msg: "Missing header: x-gc-password", data: null }, { status: 400 });
  }
  const passwordError = validateSyncPassword(password);
  if (passwordError) {
    return json({ code: 400, msg: passwordError, data: null }, { status: 400 });
  }

  if (rotateMatch) {
    if (request.method !== "POST") {
      return json({ code: 405, msg: "Method not allowed", data: null }, { status: 405 });
    }
    const d1Decision = takeSyncD1RateLimit(request, env);
    if (!d1Decision.allowed) {
      return syncRateLimitedResponse(d1Decision.headers, "d1");
    }
    const respondRotate = (res: Response): Response => applyResponseHeaders(res, d1Decision.headers);

    const row = await readSyncRowWithBuffer(env, uuidRaw);
    if (!row) return respondRotate(json({ code: 404, msg: "Not found", data: null }, { status: 404 }));
    if (!(await verifyRowPassword(row, password))) {
      return respondRotate(json({ code: 403, msg: "Invalid password", data: null }, { status: 403 }));
    }

    let body: any = null;
    try {
      body = await request.json();
    } catch {
      body = null;
    }
    const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
    const blob = typeof body?.blob === "string" ? body.blob : "";
    const clientUpdatedAt = typeof body?.clientUpdatedAt === "number" ? body.clientUpdatedAt : NaN;

    if (!newPassword.trim()) {
      return respondRotate(json({ code: 400, msg: "Missing body.newPassword", data: null }, { status: 400 }));
    }
    if (newPassword.length > SYNC_PASSWORD_MAX_LENGTH) {
      return respondRotate(
        json({ code: 400, msg: `newPassword too long (max ${SYNC_PASSWORD_MAX_LENGTH} chars)`, data: null }, { status: 400 })
      );
    }
    if (!blob) {
      return respondRotate(json({ code: 400, msg: "Missing body.blob", data: null }, { status: 400 }));
    }
    if (!Number.isFinite(clientUpdatedAt) || clientUpdatedAt <= 0) {
      return respondRotate(json({ code: 400, msg: "Invalid body.clientUpdatedAt", data: null }, { status: 400 }));
    }
    if (blob.length > 900_000) {
      return respondRotate(json({ code: 413, msg: "Blob too large", data: null }, { status: 413 }));
    }

    const salt = crypto.getRandomValues(new Uint8Array(SYNC_SALT_BYTES));
    const hash = await pbkdf2Hash(newPassword, salt);
    const nextRow: SyncRow = {
      ...row,
      password_salt: bytesToHex(salt),
      password_hash: bytesToHex(hash),
      blob,
      client_updated_at: Math.trunc(clientUpdatedAt),
      updated_at: getNextSyncUpdatedAt(row),
    };
    const staged = markSyncRowDirty(nextRow);
    await flushSyncRowImmediately(env, uuidRaw, staged.version);

    return respondRotate(json({ code: 200, data: { uuid: uuidRaw, clientUpdatedAt } }, { status: 200 }));
  }

  if (!mainMatch) {
    return json({ code: 404, msg: "Not found", data: null }, { status: 404 });
  }

  if (request.method === "GET") {
    // Pull must read from D1 as source of truth, then refresh worker memory cache.
    const pending = syncBuffer.get(uuidRaw);
    if (pending?.dirty) {
      await flushSyncRowImmediately(env, uuidRaw, pending.version);
    }

    const row = await readSyncRow(env, uuidRaw);
    if (!row) return json({ code: 404, msg: "Not found", data: null }, { status: 404 });
    rememberSyncRow(row);
    if (!(await verifyRowPassword(row, password))) {
      return json({ code: 403, msg: "Invalid password", data: null }, { status: 403 });
    }
    return json(
      { code: 200, data: { uuid: row.uuid, blob: row.blob, clientUpdatedAt: row.client_updated_at } },
      { status: 200 }
    );
  }

  if (request.method === "PUT") {
    let body: any = null;
    try {
      body = await request.json();
    } catch {
      body = null;
    }

    const blob = typeof body?.blob === "string" ? body.blob : "";
    const clientUpdatedAt = typeof body?.clientUpdatedAt === "number" ? body.clientUpdatedAt : NaN;
    const force = url.searchParams.get("force") === "1";

    if (!blob) {
      return json({ code: 400, msg: "Missing body.blob", data: null }, { status: 400 });
    }
    if (!Number.isFinite(clientUpdatedAt) || clientUpdatedAt <= 0) {
      return json({ code: 400, msg: "Invalid body.clientUpdatedAt", data: null }, { status: 400 });
    }
    if (blob.length > 900_000) {
      return json({ code: 413, msg: "Blob too large", data: null }, { status: 413 });
    }

    const hasBufferedRow = syncBuffer.has(uuidRaw);
    const needsD1Guard = force || !hasBufferedRow;
    const d1Decision = needsD1Guard ? takeSyncD1RateLimit(request, env) : null;
    if (d1Decision && !d1Decision.allowed) {
      return syncRateLimitedResponse(d1Decision.headers, "d1");
    }
    const respondPut = (res: Response): Response => (d1Decision ? applyResponseHeaders(res, d1Decision.headers) : res);

    const existing = await readSyncRowWithBuffer(env, uuidRaw);
    if (!existing) {
      const salt = crypto.getRandomValues(new Uint8Array(SYNC_SALT_BYTES));
      const hash = await pbkdf2Hash(password, salt);
      const now = Date.now();
      const nextRow: SyncRow = {
        uuid: uuidRaw,
        password_salt: bytesToHex(salt),
        password_hash: bytesToHex(hash),
        blob,
        client_updated_at: Math.trunc(clientUpdatedAt),
        created_at: now,
        updated_at: now,
      };
      const staged = markSyncRowDirty(nextRow);
      if (force) {
        await flushSyncRowImmediately(env, uuidRaw, staged.version);
      } else {
        scheduleSyncRowFlush(env, ctx, uuidRaw, staged.version);
      }

      return respondPut(json({ code: 201, data: { uuid: uuidRaw, clientUpdatedAt } }, { status: 201 }));
    }

    if (!(await verifyRowPassword(existing, password))) {
      return respondPut(json({ code: 403, msg: "Invalid password", data: null }, { status: 403 }));
    }

    if (!force && Math.trunc(clientUpdatedAt) < Math.trunc(existing.client_updated_at)) {
      return respondPut(
        json(
          {
            code: 409,
            msg: "Conflict: server has a newer version",
            data: { uuid: existing.uuid, blob: existing.blob, clientUpdatedAt: existing.client_updated_at },
          },
          { status: 409 }
        )
      );
    }

    const nextRow: SyncRow = {
      ...existing,
      blob,
      client_updated_at: Math.trunc(clientUpdatedAt),
      updated_at: getNextSyncUpdatedAt(existing),
    };
    const staged = markSyncRowDirty(nextRow);
    if (force) {
      await flushSyncRowImmediately(env, uuidRaw, staged.version);
    } else {
      scheduleSyncRowFlush(env, ctx, uuidRaw, staged.version);
    }

    return respondPut(json({ code: 200, data: { uuid: uuidRaw, clientUpdatedAt } }, { status: 200 }));
  }

  return json({ code: 405, msg: "Method not allowed", data: null }, { status: 405 });
}

function parseCacheTtlMs(env: Env): number {
  const raw = env.CACHE_TTL_SECONDS;
  const n = Number(raw ?? String(DEFAULT_CACHE_TTL_SECONDS));
  const seconds = Number.isFinite(n) && n > 0 ? n : DEFAULT_CACHE_TTL_SECONDS;
  return Math.trunc(seconds * 1000);
}

function parseCorsAllowlist(env: Env): string[] | null {
  const raw = (env.CORS_ORIGIN ?? "").trim();
  if (!raw) return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function ensureExposeHeader(h: Headers, name: string): void {
  const existing = h.get("access-control-expose-headers");
  if (!existing) {
    h.set("access-control-expose-headers", name);
    return;
  }
  const parts = existing
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (parts.includes(name.toLowerCase())) return;
  h.set("access-control-expose-headers", `${existing}, ${name}`);
}

function withCors(req: Request, env: Env, res: Response): Response {
  const allowlist = parseCorsAllowlist(env);
  if (!allowlist) {
    // allow all
    const h = new Headers(res.headers);
    h.set("access-control-allow-origin", "*");
    h.append("vary", "origin");
    ensureExposeHeader(h, UPDATED_AT_HEADER);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }

  const origin = req.headers.get("origin") ?? "";
  if (!origin || !allowlist.includes(origin)) return res;

  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", origin);
  h.append("vary", "origin");
  ensureExposeHeader(h, UPDATED_AT_HEADER);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

function corsPreflight(req: Request, env: Env): Response {
  const allowlist = parseCorsAllowlist(env);
  const origin = req.headers.get("origin") ?? "";

  // If allowlist is set, only allow matching origins.
  if (allowlist && (!origin || !allowlist.includes(origin))) {
    return new Response(null, { status: 204 });
  }

  const reqHeaders = req.headers.get("access-control-request-headers") ?? "content-type";

  const headers = new Headers();
  headers.set("access-control-allow-methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
  headers.set("access-control-allow-headers", reqHeaders);
  headers.set("access-control-max-age", "86400");

  if (allowlist) {
    headers.set("access-control-allow-origin", origin);
    headers.append("vary", "origin");
  } else {
    headers.set("access-control-allow-origin", "*");
    headers.append("vary", "origin");
  }

  return new Response(null, { status: 204, headers });
}

function isGameId(x: unknown): x is GameId {
  return typeof x === "string" && GAMES.some((g) => g.id === x);
}

async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return corsPreflight(request, env);
  }

  if (url.pathname.startsWith("/api/sync/")) {
    if (env.DB) {
      ctx.waitUntil(
        flushDueSyncRowsToD1(env).catch((err) => {
          console.error("Background flush for buffered sync rows failed", { err });
        })
      );
      const decision = takeSyncRateLimit(request, env);
      if (!decision.allowed) {
        return syncRateLimitedResponse(decision.headers, "sync");
      }
      const res = await handleSyncApi(request, env, ctx);
      if (res.headers.has("x-ratelimit-limit")) {
        return res;
      }
      return applyResponseHeaders(res, decision.headers);
    }
    return handleSyncApi(request, env, ctx);
  }

  if (request.method !== "GET") {
    return json({ code: 405, msg: "Method not allowed", data: null } satisfies ApiResponse<null>, {
      status: 405,
    });
  }

  if (url.pathname === "/api/health") {
    return json({ ok: true });
  }

  if (url.pathname === "/api/games") {
    return json({ code: 200, data: GAMES } satisfies ApiResponse<typeof GAMES>);
  }

  if (url.pathname === "/api/version") {
    const game = url.searchParams.get("game");
    if (!game) {
      return json({ code: 400, msg: "Missing query param: game", data: null } satisfies ApiResponse<null>, {
        status: 400,
      });
    }
    if (!isGameId(game)) {
      return json({ code: 400, msg: `Unsupported game: ${game}`, data: null } satisfies ApiResponse<null>, {
        status: 400,
      });
    }

    const cacheTtlMs = parseCacheTtlMs(env);
    const snapshot = await getGameSnapshotWithCache(env, game);
    const data = snapshot.version;

    return json({ code: 200, data } satisfies ApiResponse<typeof data>, {
      headers: { "cache-control": `public, max-age=${Math.floor(cacheTtlMs / 1000)}` },
    });
  }

  if (url.pathname === "/api/events") {
    const game = url.searchParams.get("game");
    if (!game) {
      return json({ code: 400, msg: "Missing query param: game", data: [] } satisfies ApiResponse<[]>, {
        status: 400,
      });
    }
    if (!isGameId(game)) {
      return json({ code: 400, msg: `Unsupported game: ${game}`, data: [] } satisfies ApiResponse<[]>, {
        status: 400,
      });
    }

    const cacheTtlMs = parseCacheTtlMs(env);
    const snapshot = await getGameSnapshotWithCache(env, game);
    const data = snapshot.events;

    return json({ code: 200, data } satisfies ApiResponse<typeof data>, {
      headers: {
        "cache-control": `public, max-age=${Math.floor(cacheTtlMs / 1000)}`,
        [UPDATED_AT_HEADER]: String(snapshot.eventsUpdatedAtMs),
      },
    });
  }

  const versionMatch = /^\/api\/version\/([^/]+)$/.exec(url.pathname);
  if (versionMatch) {
    const game = versionMatch[1]!;
    if (!isGameId(game)) {
      return json({ code: 400, msg: `Unsupported game: ${game}`, data: null } satisfies ApiResponse<null>, {
        status: 400,
      });
    }

    const cacheTtlMs = parseCacheTtlMs(env);
    const snapshot = await getGameSnapshotWithCache(env, game);
    const data = snapshot.version;

    return json({ code: 200, data } satisfies ApiResponse<typeof data>, {
      headers: { "cache-control": `public, max-age=${Math.floor(cacheTtlMs / 1000)}` },
    });
  }

  const m = /^\/api\/events\/([^/]+)$/.exec(url.pathname);
  if (m) {
    const game = m[1]!;
    if (!isGameId(game)) {
      return json({ code: 400, msg: `Unsupported game: ${game}`, data: [] } satisfies ApiResponse<[]>, {
        status: 400,
      });
    }

    const cacheTtlMs = parseCacheTtlMs(env);
    const snapshot = await getGameSnapshotWithCache(env, game);
    const data = snapshot.events;

    return json({ code: 200, data } satisfies ApiResponse<typeof data>, {
      headers: {
        "cache-control": `public, max-age=${Math.floor(cacheTtlMs / 1000)}`,
        [UPDATED_AT_HEADER]: String(snapshot.eventsUpdatedAtMs),
      },
    });
  }

  return json({ code: 404, msg: "Not found", data: null } satisfies ApiResponse<null>, {
    status: 404,
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api")) {
      const res = await handleApi(request, env, ctx);
      return withCors(request, env, res);
    }

    // Static SPA assets (built from apps/web). See wrangler.jsonc "assets".
    return env.ASSETS.fetch(request);
  },
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await flushDueSyncRowsToD1(env);
    } catch (err) {
      console.error("Scheduled flush for buffered sync rows failed", { err });
    }

    try {
      await refreshAllGamesToD1IfNeeded(env);
    } catch (err) {
      console.error("Scheduled refresh for D1 event cache failed", { err });
    }
  },
};
