# 游戏活动日历

[![Demo](https://img.shields.io/badge/Demo-gamecal.nv5.me-blue)](https://gamecal.nv5.me)
[![Deploy to Cloudflare](https://img.shields.io/badge/Deploy_to_Cloudflare-F38020?&logo=cloudflare&logoColor=white)](https://deploy.workers.cloudflare.com/?url=https://github.com/cyrahs/game-cal)
[![Built with Codex](https://img.shields.io/badge/Built_with_Codex-1A1A1A)](https://openai.com/codex)


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
- `CACHE_TTL_SECONDS`（默认 `28800`）
- `CACHE_REFRESH_MARGIN_SECONDS`（Worker 可选；默认 `1800`，表示距离 TTL 到期前 30 分钟开始预刷新 D1 缓存）
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
- `PUT /api/sync/:uuid` 默认先写入 Worker 内存缓冲；同一 `uuid` 在连续写入停止 `5s` 后再回写 D1（减少高频本地状态变更造成的 D1 写放大）
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
- `GET /api/version/:game`（`genshin|starrail|ww|zzz|snowbreak|endfield`；当前原神 / 星铁 / 鸣潮 / 绝区零 / 尘白禁区 / 终末地返回版本数据，其它游戏返回 `null`）
- `GET /api/sync/:uuid`（仅 Worker + D1；Node 返回 `501`；需 `x-gc-password`）
- `PUT /api/sync/:uuid`（仅 Worker + D1；Node 返回 `501`；需 `x-gc-password`）
- `POST /api/sync/:uuid/rotate`（仅 Worker + D1；Node 返回 `501`；需 `x-gc-password`）

## 上游巡检

仓库内置了一条可手动触发的 Codex agentic workflow：
`.github/workflows/upstream-review.yml`。它不再自动定时执行；需要时可在
GitHub Actions 页面从默认分支手动触发；非默认分支不会运行，以免未合并的
workflow 代码接触 Secrets。

Workflow 分成六个相互隔离的阶段：

- `collect`：启动本地 Node API，抓取六个游戏的原始公告与当前
  `/api/events/:game` 输出，过滤已过期项和 reviewer-input suppression。
- `review`：用六游戏 matrix 在相互隔离的 runner 中分别发起 Responses agent
  会话。每个 Codex 只读仓库和对应游戏的紧凑 JSON shard，没有 Issue 写权限；
  单个 shard 最多返回 8 条 findings，六份合计不超过 48 条。
- `publish`：在第三个 runner 中严格校验结构化结果、再次应用 suppression，再由
  确定性脚本维护固定的 Issue #1 `Upstream Review Alerts`。这个 job 不接触
  OpenAI Secrets，并生成只含已确认 findings、匹配证据和静态 parser 白名单的紧凑
  修复请求。
- `repair`：仅在存在 findings 且没有相同 finding fingerprint 的历史 PR 时，再发起
  **一个** workspace-write Codex 会话。它没有 GitHub 写权限，只能修改受影响游戏
  对应的 `apps/api/src/games/<game>.ts`；补丁、base SHA、路径和 SHA-256 会由可信
  脚本重新导出并校验。
- `validate_patch`：在全新、无 Secrets、无 GitHub 写权限的 runner 中复验 artifact，
  应用补丁并运行 `pnpm test:upstream-review`、`pnpm typecheck` 和 `pnpm build`。
- `open_pr`：只接收上一步验证过的补丁，再次核对 base SHA、digest、路径和默认分支
  tip，然后用固定 commit/PR 文案非强制推送 fingerprint 分支并创建 Draft PR。这个
  job 不安装依赖，也不执行被修改的 parser 代码。

每个 matrix job 会先确定性验证完整采集文件，再原位替换为仅含一个
`review_dataset` 的 shard，避免把约 250 KB 聚合文件一次性送进 agent 工具输出。
采集数据、任一 Codex 输出不完整、六个游戏未全部审查、JSON 不符合约束，或
Issue #1 的类型/标题不符时，发布步骤会失败且不修改 Issue。有 findings 时更新或
reopen Issue #1；无 findings 且 Issue 打开时写入干净报告并关闭；已关闭时不操作。
自动修复若越过文件白名单、创建/删除/重命名文件、改变文件模式、只改空白、生成
二进制或超过 512 KB 的 patch、测试失败，均不会进入提 PR 阶段。相同 findings 的
open、closed 或 merged PR 都会被 fingerprint 去重，workflow 不会 force-push 覆盖
人工修改。运行产物和 API 日志会作为 Actions artifacts 保存。

需要配置四个 GitHub Actions Secrets：

- `OPENAI_API_KEY`：网关使用的 Bearer API key。
- `OPENAI_BASE_URL`：完整的 Responses POST endpoint。虽然沿用旧变量名，但值必须
  类似 `https://gateway.example/v1/responses`，不能只填
  `https://gateway.example/v1`。
- `OPENAI_MODEL`：网关支持的 Codex 模型名。
- `OPENAI_REASONING_EFFORT`：模型支持的推理强度，例如 `low`、`medium`、`high`。

网关需要兼容 Responses API 的流式响应、工具调用和 Structured Outputs，并接受
`Authorization: Bearer <key>`。审查 prompt 和输出 Schema 分别位于
`.github/prompts/upstream-review.md` 与
`.github/schemas/upstream-review-output.schema.json`；修复 agent 使用
`.github/prompts/upstream-review-fix.md` 与
`.github/schemas/upstream-review-fix-output.schema.json`。

自动创建 PR 还需要在仓库 `Settings → Actions → General → Workflow permissions`
中启用 **Allow GitHub Actions to create and approve pull requests**。GitHub 将“创建”
和“批准”合并在同一个仓库级开关里；本 workflow 只在 `open_pr` job 申请
`contents: write` / `pull-requests: write`，不会批准 PR。未启用时，前面的审查、
Issue 和补丁验证仍可运行，但最终创建 PR 会被 GitHub 拒绝。

可选环境变量：

- `UPSTREAM_REVIEW_API_BASE_URL`（默认 `http://127.0.0.1:8787`）
- `UPSTREAM_REVIEW_MAX_ITEMS`（默认 `60`）
- `UPSTREAM_REVIEW_INPUT_PATH`（采集模式写出的 JSON）
- `UPSTREAM_REVIEW_GAME`（extract-game 模式提取的游戏 ID）
- `UPSTREAM_REVIEW_GAME_INPUT_PATH`（可选的单游戏 shard 输出路径；默认原位替换输入）
- `UPSTREAM_REVIEW_AGENT_OUTPUT_DIR`（finalize 模式读取六份 Codex JSON 的目录）
- `UPSTREAM_REVIEW_AGENT_OUTPUT_PATH`（兼容旧版单文件 Codex JSON）
- `UPSTREAM_REVIEW_REPORT_PATH`（finalize 模式写出的完整 JSON 报告）
- `UPSTREAM_REVIEW_FIX_INPUT_PATH`（prepare/finalize-fix 使用的紧凑修复请求）
- `UPSTREAM_REVIEW_FIX_AGENT_OUTPUT_PATH`（Codex 修复结果）
- `UPSTREAM_REVIEW_FIX_METADATA_PATH`（可信校验后的修复元数据）
- `UPSTREAM_REVIEW_FIX_MANIFEST_PATH`（包含 base SHA、路径、patch digest 的 manifest）
- `UPSTREAM_REVIEW_FIX_PATCH_PATH`（候选或已验证 patch）
- `UPSTREAM_REVIEW_SUPPRESSIONS_PATH`（默认 `.github/upstream-review-suppressions.json`）
- `UPSTREAM_REVIEW_ISSUE_NUMBER`（workflow 固定为 `1`）
- `UPSTREAM_REVIEW_ISSUE_TITLE`（workflow 固定为 `Upstream Review Alerts`）
- `UPSTREAM_REVIEW_DRY_RUN=1`（finalize 时只生成报告，不操作 GitHub Issue）

`pnpm review:upstream` / `pnpm review:upstream:collect` 只执行确定性采集，不调用模型；
`pnpm review:upstream:finalize` 校验已有 agent 输出并发布结果。生产 workflow 不再调用
旧的 Chat Completions 接口。

Suppression 配置文件默认是 `.github/upstream-review-suppressions.json`，用于屏蔽已确认合理、但模型仍可能重复上报的 finding。对于 `kind: "non_event_included"`（或未填写 `kind`）的规则，对应 API event 也会在送审前从 reviewer 输入中排除；对于 `kind: "missing_event"` 的规则，对应 raw notice 会在送审前从 reviewer 输入中排除。

匹配字段支持精确标题和模式匹配：
- 精确匹配：`title` / `api_title` / `raw_title`
- 包含匹配：`title_contains` / `api_title_contains` / `raw_title_contains`
- 正则匹配：`title_regex` / `api_title_regex` / `raw_title_regex`

精确匹配字段 `title` / `api_title` / `raw_title` 会按历史兼容行为匹配 finding 的任意标题候选；`api_title_contains` / `raw_title_contains` 和 `api_title_regex` / `raw_title_regex` 只匹配对应来源。每个匹配字段都可以写字符串或字符串数组。

示例：

```json
{
  "suppressions": [
    {
      "game": "starrail",
      "kind": "non_event_included",
      "title": "「联动跃迁」说明",
      "reason": "联动跃迁说明属于预期保留项，不需要重复告警。"
    },
    {
      "game": "genshin",
      "kind": "missing_event",
      "raw_title_regex": "^「[^」]*纪行」活动说明$",
      "reason": "纪行 / battle pass 说明不属于日历收录范围。"
    },
    {
      "game": "starrail",
      "kind": "missing_event",
      "raw_title_contains": "绘画征集",
      "reason": "社区绘画征集不属于日历收录范围。"
    }
  ]
}
```

## 缓存策略

- 同一游戏下，`/api/events*` 与 `/api/version*` 共享同一份快照缓存（同一次刷新、同一 TTL）。
- 请求侧仍然按 `CACHE_TTL_SECONDS` 判定缓存是否过期；若缺失或已过期，现有回源兜底逻辑会继续生效。
- Worker + D1 时，事件与版本底层缓存分别持久化在 `gc_events_cache` 与 `gc_versions_cache`；版本 `null` 也是有效缓存值。
- Worker 在新部署 revision 首次生效时，会基于 `version_metadata` 自动清空 D1 中的事件/版本持久化缓存，避免旧部署写入的缓存跨版本残留。
- Worker 默认每分钟定时检查一次事件与版本底层缓存；只会后台刷新缺失、时间戳无效，或进入 `CACHE_TTL_SECONDS - CACHE_REFRESH_MARGIN_SECONDS` 预刷新窗口的那些游戏。
- Worker + D1 下，每个游戏的事件缓存与版本缓存各自维护独立的 `updated_at`；单个游戏刷新失败不会触发其他游戏一起重刷。
- `CACHE_REFRESH_MARGIN_SECONDS` 默认 `1800` 秒；若配置值大于等于 TTL，会自动钳制为小于 TTL 的安全值。
- Node API 模式使用进程内存缓存。

## 时区说明

`/api/events*` 返回的明确 `start_time` / `end_time` 为带时区偏移的 ISO-8601 时间，例如：
`2026-02-10T12:00:00+08:00`

这样前端可安全转换为浏览器本地时区显示。
如果上游返回无时区时间（如 `YYYY-MM-DD HH:mm:ss`），抓取器会按对应游戏的默认时区常量处理（当前为 `+08:00`）。

若上游公告只有相对截止条件，事件会返回 `end_time: null`、`end_time_kind: "relative"` 和
`end_time_text`。前端会将这类事件显示为右端截断的时间轴条，并在详情中展示原始相对截止描述。

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
