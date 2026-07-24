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
`.github/workflows/upstream-review.yml`，并通过
`.github/workflows/upstream-review-pr-rework.yml` 复用单轮 PR 返工逻辑。它不再
自动定时执行；需要时可在 GitHub Actions 页面从默认分支手动触发；非默认分支不会
运行，以免未合并的 workflow 代码接触 Secrets。

workflow 由相互隔离的审查、修复、复审和合并阶段组成：

- `preflight`：在接触仓库或调用模型前检查五个 Secrets，确认最终 reviewer token
  属于不同于 `github-actions[bot]`、且对仓库有 admin 权限的身份，并验证默认分支会让
  新提交后的旧批准失效。
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
- `review_pr`：在新的只读 runner 中把 PR 的 base、head、单一 parent 和 tree 与已验证
  patch 精确比对，再发起**一个**独立 Codex review 会话；这个 job 没有 GitHub 写
  权限，也拿不到最终 reviewer token。
- `validate_pr_review`：在另一台无 OpenAI Secrets、无 GitHub 写权限的 runner 中重建
  同一 PR snapshot，严格校验 review JSON；只有无 P1/P2 时才能生成 `APPROVE`，
  存在 P1/P2 时只能生成 `REQUEST_CHANGES`。
- `submit_pr_review`：不 checkout 或执行 PR 代码，仅下载经过校验且带 SHA-256 的
  review request，复验分支保护和 PR head 后，用独立身份把 review 绑定到精确
  `commit_id` 提交；若提交期间 head 发生变化，会立即撤销刚创建的 review 并失败。
  PR 在最终结果确定前保持 Draft。
- `rework_round_1` / `rework_round_2` / `rework_round_3`：只有上一轮经过校验并成功
  提交的结果为
  `REQUEST_CHANGES` 时才进入下一轮。每轮由独立的 `repair`、`validate`、`push`、
  `review`、`validate_review` 和 `submit` job 组成；返工 agent 只能修改静态 parser
  白名单，随后在无 Secrets 的新 runner 中复验并运行完整测试，再由只具备
  `contents: write` 的 job 更新原 Draft PR，最后重新执行完整 PR review。
- `finalize_approved_pr`：初审或任一返工轮次成功提交 `APPROVE` 后，集中选择唯一的
  终态 head。这个 job 不 checkout 或执行 PR 代码；它用独立 reviewer token 只读
  复核精确 commit 上的最新批准，再用 job-scoped `GITHUB_TOKEN` 复验 PR 作者、
  base/head、默认分支 tip、分支保护和 squash 配置，将 Draft 转为 Ready，并通过
  带 head SHA 条件的 API 自动 squash merge。Ready 后任一校验或合并失败时会尽力
  恢复为 Draft。

返工轮次在主 workflow DAG 中静态展开，硬上限为 3，不能由 review 文本、PR 内容或
dispatch 输入提高。每轮都会从原始 base 重新生成累计 patch，在原始 base 上创建新的
单亲提交，并用绑定旧 head 的
`--force-with-lease=refs/heads/<branch>:<old-head>` 替换同一个自动分支；因此审查覆盖
原始 base 到最新 head 的完整差异，而不是只看本轮增量。若没有安全的有效补丁、验证
失败、head/base 漂移、复审通过，或第 3 轮仍为 `REQUEST_CHANGES`，自动返工都会停止。
第 3 轮耗尽时 PR 保持 Draft 和 blocked，不会自动 ready 或 merge；任一轮复审通过时
则进入上面的精确 head 自动合并阶段。

每个 matrix job 会先确定性验证完整采集文件，再原位替换为仅含一个
`review_dataset` 的 shard，避免把约 250 KB 聚合文件一次性送进 agent 工具输出。
采集数据、任一 Codex 输出不完整、六个游戏未全部审查、JSON 不符合约束，或
Issue #1 的类型/标题不符时，发布步骤会失败且不修改 Issue。有 findings 时更新或
reopen Issue #1；无 findings 且 Issue 打开时写入干净报告并关闭；已关闭时不操作。
自动修复若越过文件白名单、创建/删除/重命名文件、改变文件模式、只改空白、生成
二进制或超过 512 KB 的初始 patch、测试失败，均不会进入提 PR 阶段；每轮返工的增量
和累计 patch 还分别限制为 128 KiB，且累计 patch 不得丢失上一轮已修改的 parser。
相同 findings 的 open、closed 或 merged PR 都会被 fingerprint 去重；只有返工链路能
以精确旧 head lease 替换刚审查过的自动分支，任何并发或人工 head 变化都会使操作
失败。review 输出不完整、上下文 digest 不一致、PR head 漂移或 reviewer 与 PR
作者身份相同都会 fail closed，不会批准。默认分支未启用 required review，或未配置
“新提交使旧批准失效”时，也会在调用模型前失败。不含人工重新运行 job 的单次初始
完整运行最多调用 8 个 agent；三轮都执行时，最多为 14 个：六个游戏 reviewer、
一个初始 fix agent、一个初始 PR review agent，以及每轮各一个 rework agent 和一个
完整 PR review agent。运行产物和 API 日志会作为 Actions artifacts 保存，并按
round 0/1/2/3 使用不同名称。

需要配置五个 GitHub Actions Secrets：

- `OPENAI_API_KEY`：网关使用的 Bearer API key。
- `OPENAI_BASE_URL`：完整的 Responses POST endpoint。虽然沿用旧变量名，但值必须
  类似 `https://gateway.example/v1/responses`，不能只填
  `https://gateway.example/v1`。
- `OPENAI_MODEL`：网关支持的 Codex 模型名。
- `OPENAI_REASONING_EFFORT`：模型支持的推理强度，例如 `low`、`medium`、`high`。
- `UPSTREAM_REVIEW_APPROVAL_TOKEN`：独立 GitHub 身份的 fine-grained PAT，只选择
  本仓库并授予 `Pull requests: Read and write` 与 `Administration: Read`。后者仅
  用于读取分支保护设置。该身份必须不同于 `github-actions[bot]`，并对仓库拥有
  admin 权限；token 只在不 checkout 仓库的 `preflight` 身份检查、初始
  `submit_pr_review`、每轮不 checkout 的 `submit` job，以及最终不 checkout 的
  `finalize_approved_pr` 只读复核步骤中使用，绝不会提供给 Codex、补丁验证或执行
  PR 代码的 job，也不会用于 Ready 或 merge 写操作。

网关需要兼容 Responses API 的流式响应、工具调用和 Structured Outputs，并接受
`Authorization: Bearer <key>`。审查 prompt 和输出 Schema 分别位于
`.github/prompts/upstream-review.md` 与
`.github/schemas/upstream-review-output.schema.json`；修复 agent 使用
`.github/prompts/upstream-review-fix.md` 与
`.github/schemas/upstream-review-fix-output.schema.json`；独立 PR reviewer 使用
`.github/prompts/upstream-review-pr-review.md` 与
`.github/schemas/upstream-review-pr-review-output.schema.json`；返工 agent 使用
`.github/prompts/upstream-review-pr-rework.md` 与
`.github/schemas/upstream-review-pr-rework-output.schema.json`。

自动创建 PR 还需要在仓库 `Settings → Actions → General → Workflow permissions`
中启用 **Allow GitHub Actions to create and approve pull requests**。GitHub 将“创建”
和“批准”合并在同一个仓库级开关里。`open_pr` 使用最小权限的 `GITHUB_TOKEN`
创建 PR；因为 GitHub 禁止 PR 作者自审，最终 review 必须使用上面的独立 token。
`finalize_approved_pr` 则用单独 job 中显式声明的 `pull-requests: write` 将 Draft
转为 Ready，并用 `contents: write` 完成 squash merge，无需新增 merge token。仓库
必须允许 workflow 请求这些写权限，并启用 squash merge。

自动批准还要求默认分支启用保护规则：打开
`Settings → Branches → Branch protection rules`，为 `main` 开启
**Require a pull request before merging**、至少 1 个 required approval，并开启
**Dismiss stale pull request approvals when new commits are pushed**；也可以用
**Require approval of the most recent reviewable push** 提供同等的 fail-closed
保证。workflow 会在开始和最终提交 review 前各复验一次，不满足时不会调用 agent
或提交 review；每一轮返工提交 review 前，以及 Ready/merge 前后也会重新复验。
required checks、未解决会话、ruleset 或其他合并限制仍由 GitHub 最终执行；任何条件
不满足都会让合并 job 失败，而不会绕过保护规则。

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
- `UPSTREAM_REVIEW_HEAD_SHA`（可信 PR head commit）
- `UPSTREAM_REVIEW_PR_NUMBER` / `UPSTREAM_REVIEW_PR_URL`（可信 PR snapshot）
- `UPSTREAM_REVIEW_PR_REVIEW_INPUT_PATH`（PR review 的结构化上下文）
- `UPSTREAM_REVIEW_PR_REVIEW_AGENT_OUTPUT_JSON`（Codex review 的 inline JSON）
- `UPSTREAM_REVIEW_PR_REVIEW_BODY_PATH`（确定性 review Markdown）
- `UPSTREAM_REVIEW_PR_REVIEW_RESULT_PATH`（规范化、可供下一轮验证的 review JSON）
- `UPSTREAM_REVIEW_PR_REVIEW_REQUEST_PATH`（绑定 commit 的 GitHub review request）
- `UPSTREAM_REVIEW_PR_REWORK_ROUND` / `UPSTREAM_REVIEW_PR_REWORK_MAX_ROUNDS`
  （当前返工轮次与固定上限；生产 workflow 的上限固定为 `3`）
- `UPSTREAM_REVIEW_PR_REWORK_INPUT_PATH` / `UPSTREAM_REVIEW_PR_REWORK_AGENT_OUTPUT_PATH`
  （digest-bound 返工请求与 Codex 输出）
- `UPSTREAM_REVIEW_PR_REWORK_METADATA_PATH` /
  `UPSTREAM_REVIEW_PR_REWORK_MANIFEST_PATH` /
  `UPSTREAM_REVIEW_PR_REWORK_PATCH_PATH`（可信返工元数据、返工 manifest 与增量 patch）
- `UPSTREAM_REVIEW_PR_REWORK_FIX_MANIFEST_PATH` /
  `UPSTREAM_REVIEW_PR_REWORK_FIX_PATCH_PATH`（从原始 base 计算的累计 manifest 与 patch）
- `UPSTREAM_REVIEW_SUPPRESSIONS_PATH`（默认 `.github/upstream-review-suppressions.json`）
- `UPSTREAM_REVIEW_ISSUE_NUMBER`（workflow 固定为 `1`）
- `UPSTREAM_REVIEW_ISSUE_TITLE`（workflow 固定为 `Upstream Review Alerts`）
- `UPSTREAM_REVIEW_DRY_RUN=1`（finalize 时只生成报告，不操作 GitHub Issue）

`pnpm review:upstream` / `pnpm review:upstream:collect` 只执行确定性采集，不调用模型；
`pnpm review:upstream:finalize` 校验已有 agent 输出并发布结果；
`prepare-pr-review` / `finalize-pr-review` 对应 PR review 上下文和可信 request
生成；`prepare-pr-rework` / `finalize-pr-rework` / `verify-pr-rework` 对应返工请求、
增量与累计 patch 生成以及隔离复验。生产 workflow 不再调用旧的 Chat Completions
接口。

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
