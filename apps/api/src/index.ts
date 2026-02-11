import "dotenv/config";
import cors from "@fastify/cors";
import staticPlugin from "@fastify/static";
import Fastify from "fastify";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SimpleTtlCache } from "./lib/cache.js";
import type { RuntimeEnv } from "./lib/runtimeEnv.js";
import { GAMES, fetchEventsForGame } from "./games/index.js";
import type { ApiResponse, GameId } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const server = Fastify({ logger: true });

const cache = new SimpleTtlCache();
const DEFAULT_CACHE_TTL_SECONDS = 60 * 60 * 24;

function parseCacheTtlMs(): number {
  const raw = process.env.CACHE_TTL_SECONDS;
  const n = Number(raw ?? String(DEFAULT_CACHE_TTL_SECONDS));
  const seconds = Number.isFinite(n) && n > 0 ? n : DEFAULT_CACHE_TTL_SECONDS;
  return Math.trunc(seconds * 1000);
}

const cacheTtlMs = parseCacheTtlMs();
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
});

server.get("/api/health", async () => ({ ok: true }));

server.get("/api/games", async (): Promise<ApiResponse<typeof GAMES>> => {
  return { code: 200, data: GAMES };
});

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

server.get<{
  Params: { game: string };
}>("/api/events/:game", async (req, reply): Promise<ApiResponse<any>> => {
  const game = req.params.game;
  if (!isGameId(game)) {
    reply.code(400);
    return { code: 400, msg: `Unsupported game: ${game}`, data: [] };
  }

  const data = await cache.getOrSet(`events:${game}`, cacheTtlMs, () =>
    fetchEventsForGame(game, process.env as unknown as RuntimeEnv)
  );

  reply.header("Cache-Control", `public, max-age=${Math.floor(cacheTtlMs / 1000)}`);
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

  const data = await cache.getOrSet(`events:${game}`, cacheTtlMs, () =>
    fetchEventsForGame(game, process.env as unknown as RuntimeEnv)
  );

  reply.header("Cache-Control", `public, max-age=${Math.floor(cacheTtlMs / 1000)}`);
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
