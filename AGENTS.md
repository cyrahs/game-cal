# AGENTS.md

This repository is a small pnpm-workspace monorepo:

- `apps/web`: React + Vite single-page app (SPA)
- `apps/api`: Fastify server that proxies/scrapes upstream game schedule data

In development the web app proxies `/api/*` to the API to avoid CORS issues.
In production the API can serve the built SPA from `apps/web/dist` so UI + API share one origin.

## Quick Start (Local Dev)

Prereqs:
- Node.js 20.x recommended (Docker uses `node:20-alpine`)
- pnpm via Corepack (repo pins `pnpm@9.9.0`)

Commands:
- Install deps: `pnpm install`
- Run web + api (parallel): `pnpm dev`
- Typecheck all packages: `pnpm typecheck`
- Build all packages: `pnpm build`

Useful per-package commands:
- API only (watch): `pnpm --filter @game-cal/api dev`
- Web only (Vite): `pnpm --filter @game-cal/web dev`
- Build + run prod server from source:
  - `pnpm build`
  - `pnpm --filter @game-cal/api start`

Default dev URLs:
- Web (Vite): `http://localhost:5173`
- API (Fastify): `http://localhost:8787`

## Production / Docker

- Docker image builds web + api, then runs the API which serves the SPA if present.
- `docker compose up -d --build` builds locally.
- CI builds/pushes multi-arch images to GHCR via `.github/workflows/docker-build.yml`.

Container defaults:
- `PORT=8787`
- `HOST=0.0.0.0`

## API Endpoints

Implemented in `apps/api/src/index.ts`:
- `GET /api/health`
- `GET /api/games`
- `GET /api/events?game=genshin|starrail|ww|zzz|snowbreak|endfield`
- `GET /api/events/:game` (`genshin|starrail|ww|zzz|snowbreak|endfield`)
- `GET /api/version?game=genshin|starrail|ww|zzz|snowbreak|endfield`
- `GET /api/version/:game` (`genshin|starrail|ww|zzz|snowbreak|endfield`; `genshin`/`starrail`/`ww`/`zzz`/`snowbreak` return non-null data)
- `GET /api/sync/:uuid` (always `501` in Node API; supported in Worker + D1 binding)
- `PUT /api/sync/:uuid` (always `501` in Node API; supported in Worker + D1 binding)
- `POST /api/sync/:uuid/rotate` (always `501` in Node API; supported in Worker + D1 binding)

## Environment Variables

Primary configuration knobs:
- `PORT` (default `8787`)
- `HOST` (default `0.0.0.0`)
- `CACHE_TTL_SECONDS` (default `28800`)
- `CORS_ORIGIN` (optional; comma-separated list; omit/empty to allow all)

Cloudflare D1 note:
- Node API does not use D1.
- `/api/sync/*` is backed by D1 only in Worker mode via `DB` binding.

Upstream override URLs (optional):
- `GENSHIN_API_URL`
- `GENSHIN_CONTENT_API_URL`
- `STARRAIL_API_URL`
- `STARRAIL_CONTENT_API_URL`
- `ZZZ_API_URL`
- `ZZZ_ACTIVITY_API_URL`
- `ZZZ_CONTENT_API_URL`
- Wuthering Waves official notice JSON:
  - `WW_NOTICE_API_URL`

Notes:
- The API imports `dotenv/config`, so `.env` is loaded from the process working directory.
  - When run via pnpm scripts, cwd is typically `apps/api/`.
  - In Docker, the app runs from `/app` and expects env to come from container env vars.
- Examples live in `.env.example` (repo root) and `apps/api/.env.example` (API-focused).

## Code Map (Where To Change Things)

Backend (`apps/api`):
- Server + routing + static SPA serving: `apps/api/src/index.ts`
- Game list + dispatch to per-game fetchers: `apps/api/src/games/index.ts`
- Fetchers:
  - `apps/api/src/games/genshin.ts`
  - `apps/api/src/games/starrail.ts`
  - `apps/api/src/games/ww.ts`
  - `apps/api/src/games/zzz.ts`
- Shared utilities:
  - Fetch with timeout + UA: `apps/api/src/lib/fetch.ts`
  - In-memory TTL cache + in-flight dedupe: `apps/api/src/lib/cache.ts`
- Types:
  - `apps/api/src/types.ts`

Frontend (`apps/web`):
- Dev proxy to API: `apps/web/vite.config.ts`
- API client wrapper: `apps/web/src/api/client.ts`
- API types (duplicated from API package): `apps/web/src/api/types.ts`
- Fetching + small in-memory cache: `apps/web/src/hooks/useEvents.ts`
- UI entrypoints:
  - Router/app shell: `apps/web/src/App.tsx`
  - Game page: `apps/web/src/pages/GamePage.tsx`

## Making Changes Safely

When updating the API contract:
- Keep `ApiResponse<T>` shape stable unless you also update the web client.
- Update both `apps/api/src/types.ts` and `apps/web/src/api/types.ts` (they are separate).

When adding a new game:
- Add the new id to both `GameId` unions:
  - `apps/api/src/types.ts`
  - `apps/web/src/api/types.ts`
- Add to `GAMES` and `fetchEventsForGame()` in `apps/api/src/games/index.ts`.
- Implement a new fetcher under `apps/api/src/games/`.
- Update the UI to expose/route to the new game.
- Update docs (`README.md`) and examples if new env vars are required.

Caching behavior:
- Node API caches upstream event lists in-memory for `CACHE_TTL_SECONDS` and sends a `Cache-Control` header.
- Worker API uses D1-backed `gc_events_cache` when `DB` binding exists; otherwise it falls back to in-memory cache.
- Web hook (`useEvents`) also caches results for ~60s in-memory.

Upstream-fetch hygiene:
- Keep timeouts conservative (see `fetchJson()` default ~12s).
- Avoid aggressive polling; prefer caching instead.
- Preserve the existing User-Agent header behavior unless there is a good reason.

## Verification Checklist

No automated test suite is currently configured. Before opening a PR, prefer:
- `pnpm typecheck`
- `pnpm build`
- Manual smoke checks:
  - `curl http://localhost:8787/api/health`
  - `curl http://localhost:8787/api/games`
  - `curl 'http://localhost:8787/api/events?game=genshin'`
  - Open `http://localhost:5173` and confirm events render

## Repo Hygiene

- Use `pnpm` (not npm/yarn). Keep `pnpm-lock.yaml` consistent.
- Do not commit secrets or local `.env` files.
- Prefer small, focused diffs; update docs when behavior changes.
