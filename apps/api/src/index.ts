import "dotenv/config";
import cors from "@fastify/cors";
import staticPlugin from "@fastify/static";
import Fastify from "fastify";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SimpleTtlCache } from "./lib/cache.js";
import type { RuntimeEnv } from "./lib/runtimeEnv.js";
import {
  classifyZzzSnapshotRelayError,
  getZzzSnapshotBundle,
  ZZZ_SNAPSHOT_CACHE_TTL_MS,
  type ZzzSnapshotBundle,
} from "./lib/zzzSnapshot.js";
import { GAMES, fetchCurrentVersionForGame, fetchEventsForGame } from "./games/index.js";
import type { ApiResponse, GameId, GameSummaryEntry, GamesSummary } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const server = Fastify({ logger: true });

const cache = new SimpleTtlCache();
const DEFAULT_CACHE_TTL_SECONDS = 60 * 60 * 8;
const UPDATED_AT_HEADER = "x-gc-updated-at";

function parseCacheTtlMs(): number {
  const raw = process.env.CACHE_TTL_SECONDS;
  const n = Number(raw ?? String(DEFAULT_CACHE_TTL_SECONDS));
  const seconds = Number.isFinite(n) && n > 0 ? n : DEFAULT_CACHE_TTL_SECONDS;
  return Math.trunc(seconds * 1000);
}

const cacheTtlMs = parseCacheTtlMs();
// Browser-side max-age stays short; the server-side cache above owns freshness.
const CLIENT_CACHE_MAX_AGE_SECONDS = 60;
const SYNC_DISABLED_MSG = "Sync is only available in Worker mode with D1 binding";

function syncUnavailable(reply: { code: (code: number) => unknown }): ApiResponse<null> {
  reply.code(501);
  return { code: 501, msg: SYNC_DISABLED_MSG, data: null };
}

await server.register(cors, {
  origin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean)
    : true,
  allowedHeaders: ["accept", "authorization", "content-type", "origin", "x-requested-with", "x-gc-password"],
  exposedHeaders: [UPDATED_AT_HEADER],
});

server.get("/api/health", async () => ({ ok: true }));

server.get("/api/games", async (): Promise<ApiResponse<typeof GAMES>> => {
  return { code: 200, data: GAMES };
});

server.all<{
  Querystring: Record<string, unknown>;
}>(
  "/api/upstream/zzz/snapshot",
  { config: { cors: false } },
  async (req, reply): Promise<ZzzSnapshotBundle | ApiResponse<null>> => {
    if (req.method !== "GET") {
      reply.code(405);
      reply.header("Allow", "GET");
      reply.header("Cache-Control", "no-store");
      return { code: 405, msg: "Method not allowed", data: null };
    }
    if (Object.keys(req.query).length > 0) {
      reply.code(400);
      reply.header("Cache-Control", "no-store");
      return {
        code: 400,
        msg: "Query parameters are not supported",
        data: null,
      };
    }

    try {
      const snapshot = await getZzzSnapshotBundle(
        process.env as unknown as RuntimeEnv
      );
      reply.header(
        "Cache-Control",
        `public, max-age=${Math.floor(ZZZ_SNAPSHOT_CACHE_TTL_MS / 1000)}`
      );
      return snapshot;
    } catch (error) {
      const status = classifyZzzSnapshotRelayError(error);
      req.log.error(
        {
          error_name: error instanceof Error ? error.name : "UnknownError",
        },
        "ZZZ snapshot relay fetch failed"
      );
      reply.code(status);
      reply.header("Cache-Control", "no-store");
      return {
        code: status,
        msg: "ZZZ upstream snapshot unavailable",
        data: null,
      };
    }
  }
);

server.get<{ Params: { uuid: string } }>("/api/sync/:uuid", async (_req, reply): Promise<ApiResponse<null>> => {
  return syncUnavailable(reply);
});

server.put<{
  Params: { uuid: string };
  Querystring: { force?: string };
  Body: { blob?: unknown; clientUpdatedAt?: unknown };
}>("/api/sync/:uuid", async (_req, reply): Promise<ApiResponse<null>> => {
  return syncUnavailable(reply);
});

server.post<{
  Params: { uuid: string };
  Body: { newPassword?: unknown; blob?: unknown; clientUpdatedAt?: unknown };
}>("/api/sync/:uuid/rotate", async (_req, reply): Promise<ApiResponse<null>> => {
  return syncUnavailable(reply);
});

function isGameId(x: unknown): x is GameId {
  return typeof x === "string" && GAMES.some((g) => g.id === x);
}

type GameSnapshotData = {
  events: Awaited<ReturnType<typeof fetchEventsForGame>>;
  version: Awaited<ReturnType<typeof fetchCurrentVersionForGame>>;
  updatedAtMs: number;
};

async function getGameSnapshotData(game: GameId): Promise<GameSnapshotData> {
  return await cache.getOrSet(`snapshot:${game}`, cacheTtlMs, async () => {
    const runtimeEnv = process.env as unknown as RuntimeEnv;
    const [events, version] = await Promise.all([
      fetchEventsForGame(game, runtimeEnv),
      fetchCurrentVersionForGame(game, runtimeEnv),
    ]);
    return { events, version, updatedAtMs: Date.now() };
  });
}

server.get("/api/summary", async (_req, reply): Promise<ApiResponse<GamesSummary>> => {
  const games = await Promise.all(
    GAMES.map(async ({ id }): Promise<GameSummaryEntry> => {
      try {
        const snapshot = await getGameSnapshotData(id);
        return {
          game: id,
          ok: true,
          events: snapshot.events,
          version: snapshot.version,
          updatedAtMs: snapshot.updatedAtMs,
        };
      } catch (err) {
        server.log.error({ game: id, err }, "Summary snapshot failed");
        return { game: id, ok: false, error: "Upstream fetch failed" };
      }
    })
  );

  reply.header("Cache-Control", `public, max-age=${CLIENT_CACHE_MAX_AGE_SECONDS}`);
  return { code: 200, data: { games } };
});

server.get<{
  Params: { game: string };
}>("/api/events/:game", async (req, reply): Promise<ApiResponse<any>> => {
  const game = req.params.game;
  if (!isGameId(game)) {
    reply.code(400);
    return { code: 400, msg: `Unsupported game: ${game}`, data: [] };
  }

  const snapshot = await getGameSnapshotData(game);
  const data = snapshot.events;

  reply.header("Cache-Control", `public, max-age=${CLIENT_CACHE_MAX_AGE_SECONDS}`);
  reply.header(UPDATED_AT_HEADER, String(snapshot.updatedAtMs));
  return { code: 200, data };
});

server.get<{
  Querystring: { game?: string };
}>("/api/events", async (req, reply): Promise<ApiResponse<any>> => {
  const game = req.query.game;
  if (!game) {
    reply.code(400);
    return { code: 400, msg: "Missing query param: game", data: [] };
  }
  if (!isGameId(game)) {
    reply.code(400);
    return { code: 400, msg: `Unsupported game: ${game}`, data: [] };
  }

  const snapshot = await getGameSnapshotData(game);
  const data = snapshot.events;

  reply.header("Cache-Control", `public, max-age=${CLIENT_CACHE_MAX_AGE_SECONDS}`);
  reply.header(UPDATED_AT_HEADER, String(snapshot.updatedAtMs));
  return { code: 200, data };
});

server.get<{
  Params: { game: string };
}>("/api/version/:game", async (req, reply): Promise<ApiResponse<any>> => {
  const game = req.params.game;
  if (!isGameId(game)) {
    reply.code(400);
    return { code: 400, msg: `Unsupported game: ${game}`, data: null };
  }

  const snapshot = await getGameSnapshotData(game);
  const data = snapshot.version;

  reply.header("Cache-Control", `public, max-age=${CLIENT_CACHE_MAX_AGE_SECONDS}`);
  reply.header(UPDATED_AT_HEADER, String(snapshot.updatedAtMs));
  return { code: 200, data };
});

server.get<{
  Querystring: { game?: string };
}>("/api/version", async (req, reply): Promise<ApiResponse<any>> => {
  const game = req.query.game;
  if (!game) {
    reply.code(400);
    return { code: 400, msg: "Missing query param: game", data: null };
  }
  if (!isGameId(game)) {
    reply.code(400);
    return { code: 400, msg: `Unsupported game: ${game}`, data: null };
  }

  const snapshot = await getGameSnapshotData(game);
  const data = snapshot.version;

  reply.header("Cache-Control", `public, max-age=${CLIENT_CACHE_MAX_AGE_SECONDS}`);
  reply.header(UPDATED_AT_HEADER, String(snapshot.updatedAtMs));
  return { code: 200, data };
});

// Optional: serve built SPA from apps/web/dist (same origin -> no CORS in prod).
const webDist = path.resolve(__dirname, "../../web/dist");
if (fs.existsSync(webDist)) {
  await server.register(staticPlugin, {
    root: webDist,
    prefix: "/",
  });

  server.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api")) {
      reply.code(404).send({ code: 404, msg: "Not found", data: null });
      return;
    }
    reply.type("text/html").sendFile("index.html");
  });
}

const port = Number(process.env.PORT ?? "8787");
const host = process.env.HOST ?? "0.0.0.0";

await server.listen({ port, host });
