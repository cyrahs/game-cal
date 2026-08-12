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

当前维护的生产路径是 Worker-first，仓库不再包含 Docker 部署配置。

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
  - `ZZZ_SNAPSHOT_API_URL`（可选完整原始快照；设置后优先于下面三条独立地址）
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
- `GET /api/upstream/zzz/snapshot`（固定目标的绝区零官方原始快照 relay；Node API 与 Worker 均不接受任意目标 URL，初始巡检用 Node 进程缓存把 raw 证据和 parser 输入绑定到同一快照）
- `GET /api/sync/:uuid`（仅 Worker + D1；Node 返回 `501`；需 `x-gc-password`）
- `PUT /api/sync/:uuid`（仅 Worker + D1；Node 返回 `501`；需 `x-gc-password`）
- `POST /api/sync/:uuid/rotate`（仅 Worker + D1；Node 返回 `501`；需 `x-gc-password`）

## 上游巡检与自动修复（Upstream Autopatch）

仓库内置一条每日定时的 agentic workflow：`.github/workflows/upstream-autopatch.yml`
（也可在 Actions 页面手动触发并调整本轮预算）。它把「发现 → 确认 → Issue 留痕 →
修复 → PR → 独立复审 → 终态重放 → 自动合并」组织成一个**以 GitHub Issue/PR 为持久
状态**的调和循环（reconcile loop）：任何一次运行中断、基础设施故障或预算耗尽都不会
丢失状态，下一次定时运行会从 Issue/PR 上记录的状态继续，而不是重新开始或永久搁浅。

### 每日流程

1. `preflight`：校验五个 Secrets 与独立 reviewer 身份（必须不同于
   `github-actions[bot]`，仓库角色至少 `write`）。分支保护漂移只产生 warning，
   不再让整轮失败。
2. `collect` / `discover` / `confirmation_plan` / `confirm`：与旧版一致的两阶段
   发现管线——冻结六游戏证据快照，逐游戏只读初审，再由独立只读会话确认候选。
3. `sync_findings`：按 finding fingerprint 同步托管 Issue（去重、为新 finding 建
   Issue），写出本轮报告 artifact。
4. `remediate`：单个 job 运行 `scripts/upstream-autopatch.mjs`，完成全部调和与
   修复工作（见下）。

### 调和与修复（`scripts/upstream-autopatch.mjs`）

driver 首先读取所有 Open 托管 Issue（识别 body 中的 `upstream-review-cycle:v2`
marker）与所有 `codex/*` 自动 PR，然后逐一决策：

- **今日再确认的 Issue**：进入修复队列（每轮运行最多 `AUTOPATCH_ISSUES_PER_RUN`
  个，默认 2）。历史遗留的 Open Issue 只要 finding 再次被确认，就会带着已有
  PR/预算继续修复——不会再出现“被旧 Issue 覆盖就永远没人修”的死区。
- **今日未再确认的 Issue**：记一次 miss；连续 `AUTOPATCH_STALE_MISS_LIMIT`
  （默认 2）次未复现后自动关闭（`not_planned`），并关闭关联 PR、删除分支。
- **孤儿 PR**（无对应 Open Issue 的 `codex/*` PR）：评论后自动关闭。
- **已批准但未合并的 PR**：直接重新武装 auto-merge（恢复中断的收尾）。
- 打了 `autopatch:paused` 标签的 Issue 一律跳过；打了 `autopatch:blocked` 的
  等待人工处理，移除标签即可恢复自动修复。

对每个进入队列的 Issue，driver 在**同一个 job 内**执行有限轮次的修复循环
（每轮 = 一次 code attempt）：

1. **repair**：以 `workspace-write` 沙箱、无网络、无任何 GitHub 凭据的 Codex CLI
   会话生成候选补丁（白名单仍限目标 parser + agent-owned 回归测试，≤512 KiB，
   不得创建/删除/改名/改模式）。
2. **validate**：清理并重装依赖后运行 `pnpm test:upstream-review`、
   `pnpm test:game-parsers`、`pnpm typecheck`、`pnpm build`；失败则生成结构化
   feedback 进入下一轮，不发布任何未通过验证的提交。
3. **publish**：验证通过才把候选以单亲提交 force-push 到 `codex/*` 分支并
   创建/更新 Draft PR，同时在精确 head 上发布 `upstream-agentic/validate` status。
4. **review**：只读 Codex 独立复审累计 diff；`REQUEST_CHANGES` 会由独立 reviewer
   身份**连同具体 findings** 提交到 PR 上留痕，然后进入下一轮修复。
5. **runtime replay**：复审通过后，在精确 head 启动 API 并对照原始证据重放验证
   每条 finding；未解决同样以 `REQUEST_CHANGES` 留痕并进入下一轮。
6. **approve + merge**：全部通过后由独立身份提交精确 commit 的 `APPROVE`，
   转正 PR 并启用原生 squash auto-merge；合并后关闭 Issue、删除分支。

### 预算与状态

- 每轮运行每个 Issue 最多 `AUTOPATCH_ROUNDS_PER_RUN`（默认 3）轮修复。
- 每个 Issue 终身最多 `AUTOPATCH_LIFETIME_ATTEMPTS`（默认 6）次 code attempt，
  跨运行累计；耗尽后打 `autopatch:blocked` 标签并评论说明，交给人工。
- 基础设施故障（模型超时、网络、GitHub API 异常）**不消耗** code 预算，只在
  Issue 上留言并等待下一次运行重试；连续多次基础设施故障也会转为 blocked。
- 候选 tree 重复（模型原地打转）会立即 blocked，避免烧预算。
- 每个 Issue 的机器可读状态（已用预算、miss 计数、最近 feedback、关联 PR）保存在
  driver 维护的一条 Issue 评论中；每次实际修复也会追加一条人类可读的运行小结。

### 留痕位置

- Issue：发现详情、每次运行小结、状态评论、blocked/stale 原因。
- PR：每个通过验证的候选是一个提交；每轮拒绝是一条带具体 findings 的
  `REQUEST_CHANGES` review；最终批准是精确 commit 的 `APPROVE`。
- workflow 只有在自身出错时才是红色；“修不好等人工”通过 Issue 标签与评论表达，
  而不是让每日运行常红。

### Secrets 与仓库设置

需要五个 Actions Secrets：`OPENAI_API_KEY`、`OPENAI_BASE_URL`（完整 Responses
endpoint）、`OPENAI_MODEL`、`OPENAI_REASONING_EFFORT`、
`UPSTREAM_REVIEW_APPROVAL_TOKEN`（独立身份的 fine-grained PAT：Pull requests
Read/Write + Administration Read；只用于身份校验与提交 review，绝不进入模型
子进程环境）。

仓库需启用 **Allow GitHub Actions to create and approve pull requests**、squash
merge 与 auto-merge；默认分支保护建议 required status
`upstream-agentic/validate`（`.github/workflows/upstream-agentic-pr-gate.yml` 为
人工 PR 提供同名 required check）。

### 巡检脚本环境变量（确定性采集/确认阶段）

- `UPSTREAM_REVIEW_API_BASE_URL`（默认 `http://127.0.0.1:8787`）
- `UPSTREAM_REVIEW_MAX_ITEMS`（默认 `60`）
- `UPSTREAM_REVIEW_INPUT_PATH`（采集模式写出的 JSON）
- `UPSTREAM_REVIEW_GAME` / `UPSTREAM_REVIEW_GAME_INPUT_PATH`（extract-game 模式）
- `UPSTREAM_REVIEW_AGENT_OUTPUT_DIR`（初审 Codex JSON 目录）
- `UPSTREAM_REVIEW_REPORT_PATH`（finalize 模式写出的完整 JSON 报告）
- `UPSTREAM_REVIEW_CONFIRMATION_PLAN_PATH` /
  `UPSTREAM_REVIEW_CONFIRMATION_INPUT_DIR` /
  `UPSTREAM_REVIEW_CONFIRMATION_OUTPUT_DIR`（候选确认 plan、分游戏输入和 agent 输出）
- `UPSTREAM_REVIEW_SUPPRESSIONS_PATH`（默认 `.github/upstream-review-suppressions.json`）
- `UPSTREAM_REVIEW_DRY_RUN=1`（finalize 时只生成报告，不操作 GitHub Issue）

### driver 环境变量（remediate 阶段）

- `AUTOPATCH_ROUNDS_PER_RUN` / `AUTOPATCH_ISSUES_PER_RUN` /
  `AUTOPATCH_LIFETIME_ATTEMPTS` / `AUTOPATCH_STALE_MISS_LIMIT` /
  `AUTOPATCH_DEADLINE_MINUTES`（预算，见上）
- `AUTOPATCH_REPORT_PATH` / `AUTOPATCH_COLLECT_INPUT_PATH`（本轮报告与冻结证据）
- `AUTOPATCH_DEFAULT_BRANCH`（PR base，默认 `main`）
- `AUTOPATCH_CODEX_BIN`（Codex CLI 路径，默认 `codex`；workflow 固定安装
  `@openai/codex@0.145.0`）

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
