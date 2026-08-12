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
- `GET /api/summary`（一次返回全部游戏的 events + version + 更新时间；单个游戏拉取失败时以 `ok: false` 逐游戏标记，前端首页/导航使用该端点）
- `GET /api/events?game=genshin|starrail|ww|zzz|snowbreak|endfield`
- `GET /api/events/:game`（`genshin|starrail|ww|zzz|snowbreak|endfield`）
- `GET /api/version?game=genshin|starrail|ww|zzz|snowbreak|endfield`
- `GET /api/version/:game`（`genshin|starrail|ww|zzz|snowbreak|endfield`；当前原神 / 星铁 / 鸣潮 / 绝区零 / 尘白禁区 / 终末地返回版本数据，其它游戏返回 `null`）
- `GET /api/upstream/zzz/snapshot`（固定目标的绝区零官方原始快照 relay；Node API 与 Worker 均不接受任意目标 URL，初始巡检用 Node 进程缓存把 raw 证据和 parser 输入绑定到同一快照）
- `GET /api/sync/:uuid`（仅 Worker + D1；Node 返回 `501`；需 `x-gc-password`）
- `PUT /api/sync/:uuid`（仅 Worker + D1；Node 返回 `501`；需 `x-gc-password`）
- `POST /api/sync/:uuid/rotate`（仅 Worker + D1；Node 返回 `501`；需 `x-gc-password`）

## 上游巡检

仓库内置了一条可手动触发的 Codex agentic workflow：
`.github/workflows/upstream-review.yml`，并通过
`.github/workflows/upstream-review-pr-rework.yml` 复用单轮 PR 返工逻辑。它不再
自动定时执行；需要时可在 GitHub Actions 页面从默认分支手动触发；非默认分支不会
运行，以免未合并的 workflow 代码接触 Secrets。

workflow 由相互隔离的发现、确认、修复、复审、终态重放和合并阶段组成：

- `preflight`：调用模型前检查五个 Secrets，确认 reviewer token 属于不同于
  `github-actions[bot]`、且对仓库有 admin 权限的身份，并验证默认分支保护会让新
  commit 上的旧批准失效。
- `collect` / `review`：采集六个游戏的原始公告和当前 `/api/events/:game` 输出，
  过滤已过期项及 reviewer-input suppression；随后按可信采集结果生成 matrix，在
  隔离 runner 中发起逐游戏只读 Responses agent 会话。正常运行仍为六游戏；若恰好
  一个游戏的 raw upstream 出现可分类的连接、超时、限流或 5xx 故障，本轮标记为
  `degraded` 并跳过该游戏，不把网络故障生成 finding。两个游戏不可用、raw 响应
  结构异常，或 raw 已成功但本地 API 失败时仍 fail closed。每个会话只看到对应游戏
  的紧凑 shard，单游戏最多返回 8 条候选 finding。
- `confirmation_plan` / `confirm`：初审 finding 只视为候选。可信脚本为有候选的
  游戏生成 digest-bound 输入；候选在这个可信 plan 阶段再次应用 suppression，再由
  新的只读 Codex 会话独立确认。没有候选的游戏不调用确认模型。只有初审和确认结果
  都不为 `low`、且确认 verdict 为 `confirmed` 的 finding 才进入发布，
  `rejected` / `ambiguous` / 低置信度结果只保留在审计 artifact 中。
- `publish`：把确认结果与已应用 suppression 的冻结 plan 严格绑定，然后从所有 Open
  托管 Issue 的 coverage 并集中扣除已覆盖 finding。若新集合完全被包含，则保留旧
  Issue、不新建 Issue；其中若本轮集合与单个 current-identity Issue 完全一致，就复用
  该 cycle，并分页检查全部历史 PR；仅当不存在关联 PR 时，才把它视为曾在提 PR 前
  中断的 orphan 并恢复修复。已有 Open、merged 或 closed-unmerged PR 时都不会重复
  修复。子集、超集、多个 Issue 的并集或旧 identity coverage 仍只视为已跟踪，不自动
  猜测恢复。若只有部分重叠，则只为不重叠的补集新建一个 Issue。这个 job 不接触
  OpenAI Secrets，后续 fix input、fingerprint、分支和 PR 也只绑定被创建或精确复用的
  scope。
- `repair` / `validate_patch`：仅在待修 scope 非空，且按分支或
  issue/fingerprint/cycle marker 都找不到关联 Open PR 时发起一个 workspace-write
  fix agent。它没有 GitHub 写权限，只能修改目标游戏
  parser 和 agent-owned 回归测试；可信脚本重新导出并校验 base SHA、路径、patch
  与 SHA-256。新 runner 在无 Secrets、无写权限环境中应用补丁，使用
  `pnpm install --frozen-lockfile` 按已提交的 lockfile 安装依赖，再运行
  `pnpm test:upstream-review`、`pnpm test:game-parsers`、`pnpm typecheck` 和
  `pnpm build`。
- `open_pr`：只接收已验证补丁，复验默认分支 tip 和所有 digest 后创建 Draft PR。
  初始 fix agent 声明全部修复时正文使用 `Closes #N`，否则使用 `Refs #N`；这只
  决定 PR 文案，不再作为 identity-v3 Issue 的最终关闭依据。此 job 不执行修改后的
  parser。
- `review_pr` / `validate_pr_review` / `submit_pr_review`：把 PR 的 base、单一
  parent、tree、head 与已验证 patch 精确绑定，交给独立只读 Codex review；可信
  runner 将无 P1/P2 映射为 `APPROVE`，否则映射为 `REQUEST_CHANGES`，最后由独立
  GitHub 身份把 review 提交到精确 `commit_id`。提交期间 head 漂移会撤销刚创建的
  review 并失败。
- `rework_round_1` / `rework_round_2` / `rework_round_3`：仅在上一轮
  `REQUEST_CHANGES` 时运行。每轮均重新执行 repair、无 Secrets 验证、受 lease
  约束的 push 和完整 PR review；最多三轮，耗尽后 PR 保持 Draft，留给人工处理。

批准后的路径拆成四个信任边界明确的 job：

1. `resolve_approved_snapshot` 只选择唯一获批 stage，核对 reviewer、分支保护、
   PR 身份、精确 head 和累计 patch artifact；不 checkout 或执行获批代码。
2. `collect_approved_runtime_input` 使用两个彼此独立、无 Secrets、无写 token 的
   locked-down Docker 容器执行精确获批 head。第一个一次性测试容器从只读 bind
   mount 复制代码到临时文件系统，以 `pnpm install --frozen-lockfile` 安装依赖并同时
   运行 trusted 与 agent-owned parser 回归测试，随后销毁；第二个全新 runtime 容器
   再以 frozen lockfile 安装依赖、启动 API，并冻结只含本次 finding 目标的 runtime
   replay。测试和 API 不共享可写工作树。绝区零先由可信 base checkout 上的独立
   snapshot server 从 Worker 固定白名单 relay 冻结一次完整 raw bundle；host raw
   collector 和 approved-head runtime 容器只读同一份 canonical bytes。最终比较的
   仍是 exact approved-head 本地 parser 输出，而不是生产 `/api/events/zzz`。该服务
   不执行 approved-head 代码，既避免上游在两次请求间切换产生边界假阳性，也防止
   可修 parser 同时改写原始证据。
3. `verify_approved_runtime_input` checkout 可信默认分支代码，先把冻结输入与
   base/head/累计 manifest/patch digest 重新绑定，再用只读 Codex verifier 对比
   原始已确认证据和获批 head 的实际 API 输出；它拥有 OpenAI Secret，但不会执行
   或 checkout PR 代码。
4. `finalize_approved_pr` 仍从可信默认分支运行，重新验证 exact-head replay、
   reviewer、PR 正文、base/head、分支保护和 merge 配置后，才把 Draft 转为 Ready
   并用带 head SHA 条件的 API squash merge；它不会执行获批代码。

`finalize_remediation_issue` 仅在 GitHub 确认 merge 后运行，并再次核对原始和终态
artifact、PR/merge 身份及 exact verifier 结果。对 identity-v3 cycle，exact verifier
是关闭 Issue 的权威依据：只有它确认每条原始 finding 在终态 head 已解决，PR 才能
merge，随后 Issue 关闭为 completed；即使初始 fix agent 曾返回 `not_fixed`、PR 正文
使用 `Refs #N`，也不会把已经由终态重放证明解决的 Issue 留在 Open。验证未解决、
artifact 漂移或 merge 失败时不会合并，Issue 保持 Open。

批准后的 continuation gate 显式使用 job-level `always()`，同时逐项要求上游 job
为 `success`，避免正常跳过的 rework 分支把 runtime 验证与 merge 链路一并跳过。
`assert_approved_pr_finalized` 在自动 PR 已获批后始终核对 runtime collection、终态
验证、squash merge 和 Issue 收尾；任一环节未完成都会让 workflow 明确失败，不能以
绿色状态留下 Draft PR。

终态 replay 会为每个目标游戏冻结一份共享的 `patched_api_snapshots`，同一游戏的所有
finding 都从这份获批 head API 快照判断，而不是各自依赖可能为空的局部候选列表。每份
快照最多保存 60 条 event；若 API 报告的总数更多，快照标记为 `truncated`。需要用完整
列表证明“不再存在”或“只剩一条”的 API-only finding（包括
`non_event_included`、`duplicate_event`，以及没有 raw evidence 的 `other`）在快照
截断时一律 fail closed，不能被判为 resolved，也不会进入自动合并。

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
采集数据、任一 Codex 输出不完整、确认未覆盖全部候选、可用游戏未全部初审、可信
`collection` 覆盖元数据不完整或 JSON 不符合约束时都会 fail closed。降级运行会把
未审查游戏明确保存在 artifact 和 job summary 中，且不会为网络故障创建或更新
Issue。

采集 schema v3 为每条证据同时生成两个引用：

- `review_ref` 绑定本次采集中的精确 evidence snapshot，用于阻止 agent 引用不存在或
  已被替换的证据。
- `identity_ref` 表示跨运行稳定的主体身份。raw evidence 优先使用 `ann_id`、
  `activity_id`、`article_id`、`notice_id`、`cid`、`id`、`url` 或 `linkUrl` 等稳定
  来源 ID，缺失时才回退到规范化标题。Star Rail 会复用 `ann_id`，因此它的 raw
  主体键使用 `ann_id` 加规范化标题和类型来消歧，但仍排除易变的时间窗；API evidence
  使用规范化标题。

identity-v3 finding key 由 `game`、`kind` 和排序去重后的 `subject_refs`
确定性生成；时间窗、说明、严重度及其它模型文案不参与身份计算。集合 fingerprint
由排序去重后的 v3 finding 身份确定，Issue marker 中的 coverage digest 也会从 key
集合重算。这样同一个稳定主体引用的时间窗或模型说明变化不会改变 finding 身份，
同一 finding 被模型重复输出也会先去重；Star Rail raw 标题和 API 标题本身属于上述
主体消歧规则。

所有 Open 托管 Issue 的 coverage 必须互不重叠；Closed Issue 不参与覆盖，也永不
reopen。相同问题在历史 Issue 关闭后再次出现时会新建 regression Issue。旧
identity-v1 Open coverage 只在逐条 legacy key 能全部精确匹配时兼容；若仍有无法
匹配的 legacy coverage 与新 finding 并存，workflow 会 fail closed。更早、没有
逐条 key 的 v1 marker 只能用完整 fingerprint 精确覆盖整个剩余集合，绝不猜测部分
重叠。只有本轮 v3 finding key 集与单个 Open current-identity marker 的 key 集、
fingerprint 和 coverage digest 全部精确相等时，才会复用原 Issue/cycle；repair
前会按 managed marker 和 canonical branch 对全部 PR 状态做分类，并在开始 fix agent
及创建 PR 前各复核一次。只有关联 PR 数为零时才恢复；Open PR 继续原流程，merged PR
等待关单恢复，closed-unmerged PR 留给人工决定，不会自动另开重复 PR。

自动修复的 v3 白名单只包含目标 parser 和
`apps/api/src/games/parser-regressions.agent.test.ts`；只要修改 parser，就必须同步
增加或更新这个 agent-owned 确定性回归测试。
`apps/api/src/games/parser-regressions.trusted.test.ts` 是仓库维护的不可变核心测试，
`apps/api/src/lib/zzzSnapshot.ts` 与 `scripts/serve-zzz-snapshot.mjs` 也是可信边界，
永远不会进入 agent allowlist。`pnpm test:game-parsers` 会同时运行两类 parser 测试。若 agent
越过白名单、遗漏所需测试、创建/删除/重命名文件、改变文件模式、只改空白、生成
二进制、超过 patch 上限或测试失败，补丁都不会进入提 PR 阶段；返工累计 patch 还
不得丢失前一轮已验证修改。

自动分支采用
`codex/upstream-review-<fingerprint16>-i<issue-number>-b<base-sha12>`：同一
base 上已有当前 cycle 的 Open PR 时停止重复创建；默认分支因部分修复合并或其他提交
而前进后会进入新的 attempt。Closed 或 merged PR 不会阻止新的 regression cycle。
同一 base 上遗留的 Open Draft PR 由人工继续或关闭后再重跑，不会自动覆盖。只有
返工链路
能以精确旧 head lease 替换刚审查过的自动分支，任何并发或人工 head 变化都会使操作
失败。自动修复无补丁、验证失败、返工耗尽或合并失败时，对应 Issue 保持 Open 供人工
跟进。review 输出不完整、上下文 digest 不一致、PR head 漂移或 reviewer 与 PR
作者身份相同都会 fail closed，不会批准。默认分支未启用 required review，或未配置
“新提交使旧批准失效”时，也会在调用模型前失败。不含人工重新运行 job 的单次初始
运行按实际分支计费：

- 完整干净运行固定 6 次；单游戏网络降级且其余游戏干净时为 5 次。
- 出现候选、但确认后没有可发布 finding 时，为 `本轮可用游戏数 + 有候选的游戏数`，
  完整采集时最多 12 次；
  确认按游戏而不是按 finding 调用。
- 成功到达对应阶段时，初始 fix、初始 PR review 和终态 verifier 各增加 1 次；每次
  实际执行的返工再增加 1 次 rework 和 1 次完整 PR review。无有效 patch、没有获批
  head 或中途验证失败时，后续调用不会发生。只有六个游戏都有候选、初始修复与复审
  均执行、三轮返工及其三轮复审全部执行，并最终到达 verifier 时，才达到
  `6 + 6 + 1 + 1 + 3 + 3 + 1 = 21` 次的上限。

运行产物和 API 日志会作为 Actions artifacts 保存，并按 round 0/1/2/3 使用不同名称。

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
  admin 权限；token 只用于不执行 PR 代码的身份/保护校验、精确 commit review 提交、
  `resolve_approved_snapshot` 和 merge 前的 reviewer 复核，绝不会提供给 Codex、
  补丁验证或执行获批代码的容器，也不会用于 Ready 或 merge 写操作。

网关需要兼容 Responses API 的流式响应、工具调用和 Structured Outputs，并接受
`Authorization: Bearer <key>`。各 agent 的 prompt / Structured Output Schema 为：

- 初审：`.github/prompts/upstream-review.md` /
  `.github/schemas/upstream-review-output.schema.json`
- 候选确认：`.github/prompts/upstream-review-confirm.md` /
  `.github/schemas/upstream-review-confirm-output.schema.json`
- 初始修复：`.github/prompts/upstream-review-fix.md` /
  `.github/schemas/upstream-review-fix-output.schema.json`
- PR 复审：`.github/prompts/upstream-review-pr-review.md` /
  `.github/schemas/upstream-review-pr-review-output.schema.json`
- PR 返工：`.github/prompts/upstream-review-pr-rework.md` /
  `.github/schemas/upstream-review-pr-rework-output.schema.json`
- 终态验证：`.github/prompts/upstream-remediation-verify.md` /
  `.github/schemas/upstream-remediation-verify-output.schema.json`

自动创建 PR 还需要在仓库 `Settings → Actions → General → Workflow permissions`
中启用 **Allow GitHub Actions to create and approve pull requests**。GitHub 将“创建”
和“批准”合并在同一个仓库级开关里。`open_pr` 使用最小权限的 `GITHUB_TOKEN`
创建 PR；因为 GitHub 禁止 PR 作者自审，最终 review 必须使用上面的独立 token。
`finalize_approved_pr` 则用单独 job 中显式声明的 `pull-requests: write` 将 Draft
转为 Ready，并用 `contents: write` 完成 squash merge，无需新增 merge token。仓库
必须允许 workflow 请求这些写权限，并启用 squash merge。最终合并前由独立 reviewer
token 通过 GraphQL 的 `squashMergeAllowed` 读取 merge 配置，避免 REST 仓库响应在
受限 token 下省略 `allow_squash_merge`；`GITHUB_TOKEN` 只执行 Ready 和 merge 写操作，
独立 reviewer token 无需获得 Contents 权限。

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
- `UPSTREAM_REVIEW_AGENT_OUTPUT_DIR`（finalize 模式读取本轮 review matrix 对应的 Codex JSON 目录）
- `UPSTREAM_REVIEW_AGENT_OUTPUT_PATH`（兼容旧版单文件 Codex JSON）
- `UPSTREAM_REVIEW_REPORT_PATH`（finalize 模式写出的完整 JSON 报告）
- `UPSTREAM_REVIEW_CONFIRMATION_PLAN_PATH` /
  `UPSTREAM_REVIEW_CONFIRMATION_INPUT_DIR` /
  `UPSTREAM_REVIEW_CONFIRMATION_OUTPUT_DIR`（候选确认 plan、分游戏输入和 agent 输出）
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
- `UPSTREAM_REVIEW_APPROVED_FIX_INPUT_PATH` /
  `UPSTREAM_REVIEW_APPROVED_FIX_MANIFEST_PATH` /
  `UPSTREAM_REVIEW_APPROVED_FIX_PATCH_PATH`（终态获批 head 对应的累计修复 artifact）
- `UPSTREAM_REVIEW_REMEDIATION_VERIFY_INPUT_PATH` /
  `UPSTREAM_REVIEW_REMEDIATION_VERIFY_AGENT_OUTPUT_PATH` /
  `UPSTREAM_REVIEW_REMEDIATION_VERIFY_RESULT_PATH`（终态 runtime replay、verifier 输出与
  规范化结果）
- `UPSTREAM_REVIEW_SUPPRESSIONS_PATH`（默认 `.github/upstream-review-suppressions.json`）
- `UPSTREAM_REVIEW_ISSUE_NUMBER` / `UPSTREAM_REVIEW_ISSUE_URL` /
  `UPSTREAM_REVIEW_FINDING_FINGERPRINT` / `UPSTREAM_REVIEW_REMEDIATION_CYCLE`
  （合并后 Issue 收尾使用的可信 cycle 身份）
- `UPSTREAM_REVIEW_PR_BODY_SHA256` / `UPSTREAM_REVIEW_MERGE_SHA` /
  `UPSTREAM_REVIEW_APPROVED_STAGE`（合并后收尾使用的可信 PR 正文、merge commit 与
  获批轮次）
- `UPSTREAM_REVIEW_ALL_FINDINGS_ADDRESSED`（仅供旧 schema 收尾兼容；identity-v3
  以 exact verifier 结果为准）
- `UPSTREAM_REVIEW_DRY_RUN=1`（finalize 时只生成报告，不操作 GitHub Issue）

`pnpm review:upstream` / `pnpm review:upstream:collect` 只执行确定性采集，不调用模型；
`--prepare-confirmation` / `--finalize-confirmation` 生成并收口候选确认；
`prepare-pr-review` / `finalize-pr-review` 对应 PR review 上下文和可信 request
生成；`prepare-pr-rework` / `finalize-pr-rework` / `verify-pr-rework` 对应返工请求、
增量与累计 patch 生成以及隔离复验；`--prepare-remediation-verification`、
`--validate-remediation-verification-input` 和
`--finalize-remediation-verification` 对应终态重放的冻结、可信校验和收口。生产
workflow 不再调用旧的 Chat Completions 接口。

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
