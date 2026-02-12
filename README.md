# 游戏活动日历

[![Built with Codex](https://img.shields.io/badge/Built%20with%20Codex-1A1A1A?style=for-the-badge)](https://openai.com/codex)

[![部署到 Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cyrahs/game-cal)


这是一个游戏活动日历项目，包含前端 SPA 与 API 聚合代理，当前支持：
- 原神
- 崩坏：星穹铁道
- 绝区零
- 鸣潮
- 尘白禁区
- 明日方舟：终末地

本项目由 Codex 构建与维护。

特别感谢 [jacket-sikaha/game-schedule](https://github.com/jacket-sikaha/game-schedule)

本仓库保留 Node API 以便本地开发，生产部署以 Cloudflare Worker 为主。

## 项目结构

- `apps/web`：React + Vite 单页应用
- `apps/api`：Fastify API（本地开发与自托管可用）
- `apps/worker`：Cloudflare Worker 入口（生产推荐）

## 本地开发

```bash
pnpm install
pnpm dev
```

- Web（Vite）：`http://localhost:5173`（5173 被占用时会自动顺延）
- API（Fastify）：`http://localhost:8787`

开发模式下，前端会通过 `apps/web/vite.config.ts` 将 `/api/*` 代理到 API。

## 部署

### 推荐方式：Cloudflare Worker + D1

当前维护的生产路径是 Worker-first，不再维护 Docker 部署说明。

Worker 配置入口：
- 代码入口：`apps/worker/src/index.ts`
- Wrangler 配置：`wrangler.jsonc`

Worker 负责：
- 提供 `apps/web/dist` 的静态资源（Workers Assets）
- 提供 `/api/*` 接口

首次部署（或手动初始化）：

```bash
pnpm install

# 本地登录；CI 场景可使用 CLOUDFLARE_API_TOKEN
pnpm wrangler whoami

# 创建 D1（如果账户里还没有同名库）
wrangler d1 create game-cal

# 应用迁移（apps/worker/migrations）
wrangler d1 migrations apply game-cal --remote
```

部署：

```bash
pnpm cf:deploy
```

本地 Worker 调试（会先构建前端，再执行 `wrangler dev`）：

```bash
pnpm cf:dev
```

`wrangler.jsonc` 中 D1 的推荐写法（便于一键部署）：

```jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "game-cal",
      "migrations_dir": "apps/worker/migrations"
    }
  ]
}
```

说明：
- 若需要绑定到“已存在”的 D1，可再补充 `database_id`（以及可选的 `preview_database_id`）。
- 对模板/一键部署仓库，不建议写死个人账号的 `database_id`。

### 备选方式：Node API 自托管（不支持同步持久化）

```bash
pnpm build
pnpm --filter @game-cal/api start
```

启动后访问 `http://localhost:8787`（同源提供 API + `apps/web/dist` 静态页面）。

环境变量（见 `.env.example`）：
- `PORT`（默认 `8787`）
- `HOST`（默认 `0.0.0.0`）
- `CACHE_TTL_SECONDS`（默认 `86400`）
- `CORS_ORIGIN`（可选，逗号分隔）
- 可选上游覆盖地址：
  - `GENSHIN_API_URL`
  - `GENSHIN_CONTENT_API_URL`
  - `STARRAIL_API_URL`
  - `STARRAIL_CONTENT_API_URL`
  - `ZZZ_API_URL`
  - `ZZZ_ACTIVITY_API_URL`
  - `ZZZ_CONTENT_API_URL`
  - `SNOWBREAK_ANNOUNCE_API_URL`
  - `WW_NOTICE_API_URL`（默认：鸣潮官方公告 JSON）
  - `ENDFIELD_WEBVIEW_URL`
  - `ENDFIELD_AGGREGATE_API_URL`
  - `ENDFIELD_CODE`

## 状态存储与同步

状态同步主要依赖 Worker + D1 `DB` binding。

前端会把用户偏好（可见游戏、已完成活动、循环活动配置等）先在浏览器端加密，再上传为 D1 中的
`blob`（以 `uuid` 作为键）。服务端仅保存密码盐化哈希，不保存明文密码。

- Worker + D1：`/api/sync/*` 可用
- Worker 无 `DB` binding：`/api/sync/*` 返回 `501`
- Node API 模式：`/api/sync/*` 返回 `501`

`/api/sync/*` 在 Worker + D1 模式下会启用基于 IP 的限流（令牌桶）：
- 默认配额：`120` 次 / `60` 秒
- 写请求加权：`PUT` 和 `POST` 默认消耗 `1` 个令牌（`GET` 消耗 `1` 个）
- D1 级别共享限流（默认 `5` 次 / `60` 秒）：
  - 命中 `PUT /api/sync/:uuid` 且当前 Worker 缓冲无该 `uuid`（会先查 D1）
  - `PUT /api/sync/:uuid?force=1`（立即写 D1）
  - `POST /api/sync/:uuid/rotate`（立即写 D1）
- 超限返回：`429`，并附带 `Retry-After`、`X-RateLimit-*` 响应头
- `PUT /api/sync/:uuid` 默认先写入 Worker 内存缓冲；同一 `uuid` 在连续写入停止 `30s` 后再回写 D1（减少高频本地状态变更造成的 D1 写放大）
- `PUT /api/sync/:uuid?force=1` 与 `POST /api/sync/:uuid/rotate` 会立即写入 D1（用于强制覆盖/密码轮换等场景）

可选环境变量（Worker）：
- `SYNC_RATE_LIMIT_MAX`（默认 `120`）
- `SYNC_RATE_LIMIT_WINDOW_SECONDS`（默认 `60`）
- `SYNC_RATE_LIMIT_WRITE_COST`（默认 `1`）
- `SYNC_D1_RATE_LIMIT_MAX`（默认 `5`）
- `SYNC_D1_RATE_LIMIT_WINDOW_SECONDS`（默认 `60`）

## API 接口

- `GET /api/health`
- `GET /api/games`
- `GET /api/events?game=genshin|starrail|ww|zzz|snowbreak|endfield`
- `GET /api/events/:game`（`genshin|starrail|ww|zzz|snowbreak|endfield`）
- `GET /api/version?game=genshin|starrail|ww|zzz|snowbreak|endfield`
- `GET /api/version/:game`（`genshin|starrail|ww|zzz|snowbreak|endfield`；当前原神 / 星铁 / 鸣潮 / 绝区零 / 尘白禁区返回版本数据，其它游戏返回 `null`）
- `GET /api/sync/:uuid`（仅 Worker + D1；Node 返回 `501`；需 `x-gc-password`）
- `PUT /api/sync/:uuid`（仅 Worker + D1；Node 返回 `501`；需 `x-gc-password`）
- `POST /api/sync/:uuid/rotate`（仅 Worker + D1；Node 返回 `501`；需 `x-gc-password`）

## 缓存策略

- 同一游戏下，`/api/events*` 与 `/api/version*` 共享同一份快照缓存（同一次刷新、同一 TTL）。
- 缓存按 `CACHE_TTL_SECONDS` 过期，按请求触发刷新。
- Worker + D1 时，事件底层缓存仍持久化在 `gc_events_cache`，缺失或过期时会拉取并回写 D1。
- Worker 默认每分钟定时检查一次事件底层缓存；若任一游戏缺失或超过 `CACHE_TTL_SECONDS`，会后台刷新全部游戏，降低冷启动等待。
- Node API 模式使用进程内存缓存。

## 时区说明

`/api/events*` 返回的 `start_time` / `end_time` 为带时区偏移的 ISO-8601 时间，例如：
`2026-02-10T12:00:00+08:00`

这样前端可安全转换为浏览器本地时区显示。
如果上游返回无时区时间（如 `YYYY-MM-DD HH:mm:ss`），抓取器会按对应游戏的默认时区常量处理（当前为 `+08:00`）。

## 循环活动

前端支持按游戏配置循环活动，并可随同步偏好一起保存。
在 `循环活动` 卡片中点击 `设置` 后可配置：
- 活动名称
- 刷新时间（基于当前游戏时区）
- 可选持续天数（`持续天数`，留空则保留连续周期）
- 规则类型（四选一）：
  - 每月几号
  - 每周几
  - 指定开始日期 + 循环天数
  - 自定义 Cron（5 段：分钟 小时 日 月 星期）

首次打开页面时，默认循环活动模板来自：
- `apps/web/src/data/default-recurring-events.json`
