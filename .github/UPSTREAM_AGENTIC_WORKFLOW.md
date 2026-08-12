# Upstream Autopatch

`upstream-autopatch.yml` replaces the v2 review workflow with a reconciling daily
loop. Discovery and confirmation are unchanged; everything after them is driven by
`scripts/upstream-autopatch.mjs` inside one `remediate` job, and all remediation
state lives on the managed Issue and its draft PR instead of run-scoped artifacts.
An interrupted run therefore resumes on the next schedule; it never strands an open
Issue or PR.

## Reconcile pass

Every run, before any repair, the driver:

- queues open managed Issues whose findings were re-confirmed today (oldest first,
  capped by `AUTOPATCH_ISSUES_PER_RUN`), refreshing their tracked findings;
- counts a miss for Issues whose findings did not reproduce, closing them as
  `not_planned` (and closing their PR, deleting the branch) after
  `AUTOPATCH_STALE_MISS_LIMIT` consecutive misses;
- closes orphan `codex/*` PRs that no longer map to an open managed Issue;
- re-arms auto-merge for a previously approved and validated head whose merge was
  interrupted;
- skips Issues labeled `autopatch:paused` (manual hold) or `autopatch:blocked`
  (budget exhausted / no progress; remove the label to resume).

## Attempt loop

Each queued Issue gets up to `AUTOPATCH_ROUNDS_PER_RUN` rounds in this run and
`AUTOPATCH_LIFETIME_ATTEMPTS` code attempts across its lifetime (persisted in a
driver-maintained state comment on the Issue). One round is:

1. **repair** — Codex CLI (`workspace-write` sandbox, no network, no GitHub
   credentials in its environment) edits only the allowed parser paths plus the
   agent-owned regression test; the trusted policy check rejects escapes,
   untracked files, renames, mode changes, and patches over 512 KiB.
2. **validate** — dependencies are reinstalled from the committed lockfile, then
   `pnpm test:upstream-review`, `pnpm test:game-parsers`, `pnpm typecheck`, and
   `pnpm build` run. Failures become structured feedback for the next round;
   nothing unvalidated is ever pushed.
3. **publish** — the validated candidate is committed as a single-parent commit on
   the run base, force-pushed to the Issue's `codex/*` branch, and the
   `upstream-agentic/validate` status is posted on the exact head. The draft PR is
   created or updated.
4. **review** — a read-only Codex session reviews the cumulative diff. Blocking
   findings are submitted to the PR as a `REQUEST_CHANGES` review **with the
   concrete findings in the body** from the independent reviewer identity, then
   feed the next round.
5. **runtime replay** — after review approval the API is started from the exact
   candidate and every original finding is replayed against fresh output;
   unresolved findings also become `REQUEST_CHANGES` feedback.
6. **approve + merge** — the independent identity approves the exact commit, the
   PR is marked ready, native squash auto-merge is enabled, and the Issue closes on
   merge.

Validation failures, review changes, and runtime failures each consume one code
attempt. Infrastructure failures (model transport, GitHub API, runner issues)
never consume the code budget: they are reported as an Issue comment and retried
on the next scheduled run; repeated infrastructure failures eventually mark the
Issue `autopatch:blocked`. A repeated candidate tree blocks immediately as
no-progress.

The workflow run itself only fails on real defects in the pipeline. "Needs a
human" is expressed through the `autopatch:blocked` label and Issue comments, not
through a permanently red schedule.

## Trust boundaries

- The `remediate` job holds GitHub write tokens, but every Codex subprocess runs
  with a scrubbed environment (only `OPENAI_API_KEY` / `OPENAI_BASE_URL` plus
  basic system variables), a Landlock sandbox, and no network; sudo is removed
  from the runner before any agent runs.
- Trusted gates rerun after dependencies are wiped and reinstalled from the
  committed lockfile, so an agent cannot poison `node_modules` to fake a pass.
- Reviews and approvals come from `UPSTREAM_REVIEW_APPROVAL_TOKEN`, an identity
  distinct from the PR author (`github-actions[bot]`), always bound to the exact
  `commit_id`. The token is never in the environment of a model subprocess.
- `upstream-agentic-pr-gate.yml` provides the same required
  `upstream-agentic/validate` context for ordinary human PRs into `main`.

## Required secrets

- `OPENAI_API_KEY`, `OPENAI_BASE_URL` (full Responses endpoint), `OPENAI_MODEL`,
  `OPENAI_REASONING_EFFORT`
- `UPSTREAM_REVIEW_APPROVAL_TOKEN` — fine-grained PAT of an independent identity
  with repository role `write`/`maintain`/`admin`; permissions: Pull requests
  (read/write), Administration (read), Commit statuses (read), Contents (read),
  Metadata (read).

## Repository settings

Enable "Allow GitHub Actions to create and approve pull requests", squash merge,
and pull-request auto-merge. Default branch protection should require the
`upstream-agentic/validate` status; drift is surfaced as a preflight warning
rather than failing the run, because merges still require the driver-posted
status and the exact-head independent approval before auto-merge is armed.
