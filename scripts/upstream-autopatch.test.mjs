import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sha256 } from "./upstream-agentic-state.mjs";
import { getFindingKey } from "./review-upstream.mjs";
import {
  buildAttemptInput,
  buildCodexExecArgs,
  buildIssueFixInput,
  codexProviderBaseUrl,
  createIssueState,
  executePlan,
  groupConfirmedFindingsByIssue,
  parseIssueMarker,
  parsePrIssueNumber,
  parseStateComment,
  planReconciliation,
  remediateIssue,
  renderFeedbackForReviewBody,
  renderStateComment,
  scrubbedAgentEnv,
  scrubbedCandidateEnv,
  selectEvidenceTolerant,
} from "./upstream-autopatch.mjs";

const FP = "9".repeat(64);
const CYCLE = "8".repeat(64);
const COVERAGE = "7".repeat(64);
const BASE_SHA = "a".repeat(40);

function finding(overrides = {}) {
  return {
    game: "zzz",
    kind: "wrong_time_window",
    severity: "high",
    confidence: "high",
    title: "Event window off by one hour",
    reason: "The API event ends one hour before the raw notice window.",
    raw_title: "「特别频段」活动说明",
    api_title: "特别频段",
    raw_refs: ["raw:zzz:" + "1".repeat(32)],
    api_refs: ["api:zzz:" + "2".repeat(32)],
    start_time: "2026-08-01 10:00",
    end_time: "2026-08-15 03:59",
    ...overrides,
  };
}

function issueMarkerBody(keys, fingerprint = FP) {
  return `<!-- upstream-review-cycle:v2 fingerprint=${fingerprint} cycle=${CYCLE} coverage=${COVERAGE} keys=${keys.join(",")} -->\n\n# Upstream Review Alerts`;
}

function managedIssue({ number, keys, state = null, labels = [], title = "Upstream Review Alerts · x" }) {
  return {
    number,
    title,
    html_url: `https://github.com/example/game-cal/issues/${number}`,
    body: issueMarkerBody(keys),
    labels: labels.map((name) => ({ name })),
    autopatch_state: state,
    autopatch_state_comment_id: state ? 1000 + number : null,
  };
}

function reportFor(findings, issueNumber, { coverage = [] } = {}) {
  const keys = findings.map((entry) => getFindingKey(entry));
  return {
    schema_version: 3,
    generated_at: "2026-08-12T00:00:00.000Z",
    base_sha: BASE_SHA,
    review: { findings },
    issue: {
      action: issueNumber ? "created" : "noop",
      issue_number: issueNumber ?? 0,
      finding_keys: issueNumber ? keys : [],
      coverage,
    },
  };
}

function collectInputFor(findings) {
  const games = new Map();
  for (const entry of findings) {
    if (!games.has(entry.game)) {
      games.set(entry.game, {
        game: entry.game,
        notes: `${entry.game} dataset notes`,
        raw_notices: [],
        api_events: [],
      });
    }
    const dataset = games.get(entry.game);
    for (const ref of entry.raw_refs ?? []) {
      dataset.raw_notices.push({ review_ref: ref, title: entry.raw_title, content: "raw" });
    }
    for (const ref of entry.api_refs ?? []) {
      dataset.api_events.push({ review_ref: ref, title: entry.api_title, content: "api" });
    }
  }
  // Mirrors the real collect-only output: evidence lives under review_datasets.
  return { mode: "collect_only", schema_version: 3, review_datasets: [...games.values()] };
}

const BUDGETS = {
  roundsPerRun: 3,
  lifetimeAttempts: 6,
  issuesPerRun: 2,
  staleMissLimit: 2,
  deadlineMinutes: 100,
};

test("state comment survives a render/parse round trip and trims oversized findings", () => {
  const state = createIssueState(49, 6);
  state.findings = [finding()];
  state.attempts_used = 2;
  state.updated_at = "2026-08-12T00:00:00.000Z";
  const parsed = parseStateComment(renderStateComment(state));
  assert.deepEqual(parsed, state);

  const huge = createIssueState(50, 6);
  huge.findings = Array.from({ length: 12 }, (_, index) =>
    finding({ title: `finding ${index}`, reason: "x".repeat(9000) })
  );
  const rendered = renderStateComment(huge);
  assert.ok(Buffer.byteLength(rendered, "utf8") <= 60_000);
  const reparsed = parseStateComment(rendered);
  assert.equal(reparsed.findings.length, 12);
  assert.ok(reparsed.findings[0].reason.length <= 500);
});

test("issue marker and PR linkage parse the formats used by existing issues and PRs", () => {
  const keys = ["3".repeat(64), "4".repeat(64)];
  const marker = parseIssueMarker(issueMarkerBody(keys));
  assert.deepEqual(marker.finding_keys, keys);
  assert.equal(marker.finding_fingerprint, FP);
  assert.equal(marker.remediation_cycle, CYCLE);

  assert.equal(parsePrIssueNumber("body\n<!-- upstream-autopatch-pr:issue=54 -->"), 54);
  assert.equal(parsePrIssueNumber("Automated remediation\n\nCloses #49\n\n<!-- upstream-agentic-cycle:abc -->"), 49);
  assert.equal(parsePrIssueNumber("unrelated body"), null);
});

test("confirmed findings are grouped by covering issue including today's new issue", () => {
  const coveredFinding = finding({ title: "covered" });
  const newFinding = finding({ game: "genshin", title: "new" });
  const report = reportFor([coveredFinding, newFinding], 60, {
    coverage: [{ finding_key: getFindingKey(coveredFinding), issue_number: 49 }],
  });
  report.issue.finding_keys = [getFindingKey(newFinding)];
  const grouped = groupConfirmedFindingsByIssue(report);
  assert.deepEqual([...grouped.get(49).values()], [coveredFinding]);
  assert.deepEqual([...grouped.get(60).values()], [newFinding]);
});

test("reconfirmed issues are queued for remediation with refreshed findings", () => {
  const entry = finding();
  const key = getFindingKey(entry);
  const issue = managedIssue({ number: 49, keys: [key] });
  const report = reportFor([entry], 0, {
    coverage: [{ finding_key: key, issue_number: 49 }],
  });
  const { actions } = planReconciliation({ issues: [issue], pulls: [], report, budgets: BUDGETS });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, "remediate");
  assert.equal(actions[0].issue_number, 49);
  assert.deepEqual(actions[0].state.findings, [entry]);
  assert.equal(actions[0].state.consecutive_misses, 0);
});

test("issues not re-confirmed today wait, then close as stale after the miss limit", () => {
  const key = getFindingKey(finding());
  const emptyReport = reportFor([], 0);

  const fresh = managedIssue({ number: 48, keys: [key] });
  const first = planReconciliation({ issues: [fresh], pulls: [], report: emptyReport, budgets: BUDGETS });
  assert.equal(first.actions[0].type, "wait");
  assert.equal(first.actions[0].state.consecutive_misses, 1);

  const missedState = { ...createIssueState(48, 6), consecutive_misses: 1 };
  const missed = managedIssue({ number: 48, keys: [key], state: missedState });
  const pull = {
    number: 54,
    body: "Closes #48",
    head: { ref: "codex/upstream-review-x", sha: "b".repeat(40) },
  };
  const second = planReconciliation({ issues: [missed], pulls: [pull], report: emptyReport, budgets: BUDGETS });
  const stale = second.actions.find((action) => action.type === "close_stale");
  assert.ok(stale);
  assert.equal(stale.pr_number, 54);
  assert.equal(stale.misses, 2);
});

test("paused, blocked, and exhausted issues never enter remediation", () => {
  const entry = finding();
  const key = getFindingKey(entry);
  const report = reportFor([entry], 0, { coverage: [{ finding_key: key, issue_number: 48 }] });

  const paused = managedIssue({ number: 48, keys: [key], labels: ["autopatch:paused"] });
  assert.equal(
    planReconciliation({ issues: [paused], pulls: [], report, budgets: BUDGETS }).actions[0].type,
    "skip"
  );

  const blockedState = { ...createIssueState(48, 6), status: "blocked", blocked_reason: "x" };
  const blocked = managedIssue({ number: 48, keys: [key], state: blockedState });
  assert.equal(
    planReconciliation({ issues: [blocked], pulls: [], report, budgets: BUDGETS }).actions[0].type,
    "skip"
  );

  const exhaustedState = { ...createIssueState(48, 6), attempts_used: 6 };
  const exhausted = managedIssue({ number: 48, keys: [key], state: exhaustedState });
  const action = planReconciliation({ issues: [exhausted], pulls: [], report, budgets: BUDGETS }).actions[0];
  assert.equal(action.type, "block");
  assert.equal(action.reason, "code_attempt_budget_exhausted");
});

test("orphan pull requests are closed and extra remediations deferred by the run cap", () => {
  const entries = [
    finding({ game: "zzz", title: "a" }),
    finding({ game: "genshin", title: "b" }),
    finding({ game: "ww", title: "c" }),
  ];
  const keys = entries.map((item) => getFindingKey(item));
  const issues = [
    managedIssue({ number: 41, keys: [keys[0]] }),
    managedIssue({ number: 42, keys: [keys[1]] }),
    managedIssue({ number: 43, keys: [keys[2]] }),
  ];
  const report = reportFor(entries, 0, {
    coverage: keys.map((key, index) => ({ finding_key: key, issue_number: 41 + index })),
  });
  const orphan = { number: 90, body: "no link", head: { ref: "codex/orphan", sha: "c".repeat(40) } };
  const { actions } = planReconciliation({ issues, pulls: [orphan], report, budgets: BUDGETS });
  assert.equal(actions.filter((action) => action.type === "close_orphan_pr").length, 1);
  assert.equal(actions.filter((action) => action.type === "remediate").length, 2);
  const deferred = actions.find((action) => action.type === "defer");
  assert.equal(deferred.issue_number, 43);
});

test("issue fix input binds today's evidence and passes the strict fix-input policy", () => {
  const entry = finding();
  const state = { ...createIssueState(49, 6), findings: [entry] };
  const { fixInput, evidenceWarnings } = buildIssueFixInput({
    repository: "example/game-cal",
    issueNumber: 49,
    issueUrl: "https://github.com/example/game-cal/issues/49",
    marker: parseIssueMarker(issueMarkerBody([getFindingKey(entry)])),
    state,
    baseSha: BASE_SHA,
    collectInput: collectInputFor([entry]),
    generatedAt: "2026-08-12T00:00:00.000Z",
  });
  assert.equal(evidenceWarnings.length, 0);
  assert.equal(fixInput.mode, "agentic_fix");
  assert.deepEqual(fixInput.target_games, ["zzz"]);
  assert.deepEqual(fixInput.allowed_files, [
    "apps/api/src/games/zzz.ts",
    "apps/api/src/games/parser-regressions.agent.test.ts",
  ]);
  assert.equal(fixInput.findings[0].finding_id, "finding-001");
  assert.equal(fixInput.evidence[0].matching_raw_notices.length, 1);
});

test("evidence selection falls back to title matching when stored refs disappeared", () => {
  const items = [
    { review_ref: "raw:zzz:new", title: "「特别频段」活动说明" },
    { review_ref: "raw:zzz:other", title: "unrelated notice" },
  ];
  const byRef = selectEvidenceTolerant(items, ["raw:zzz:new"], []);
  assert.equal(byRef.selected.length, 1);
  assert.equal(byRef.missingRefs.length, 0);

  const byTitle = selectEvidenceTolerant(items, ["raw:zzz:stale"], ["「特别频段」活动说明"]);
  assert.equal(byTitle.selected.length, 1);
  assert.equal(byTitle.selected[0].review_ref, "raw:zzz:new");
  assert.deepEqual(byTitle.missingRefs, ["raw:zzz:stale"]);
});

test("attempt input binds cross-run feedback to the stable issue cycle", () => {
  const entry = finding();
  const state = { ...createIssueState(49, 6), findings: [entry] };
  const { fixInput } = buildIssueFixInput({
    repository: "example/game-cal",
    issueNumber: 49,
    issueUrl: "https://github.com/example/game-cal/issues/49",
    marker: parseIssueMarker(issueMarkerBody([getFindingKey(entry)])),
    state,
    baseSha: BASE_SHA,
    collectInput: collectInputFor([entry]),
    generatedAt: "2026-08-12T00:00:00.000Z",
  });
  const first = buildAttemptInput({
    repository: "example/game-cal",
    fixInput,
    attempt: 0,
    maxAttempts: 6,
    baseSha: BASE_SHA,
    feedback: null,
  });
  assert.equal(first.cycle.start_sha, BASE_SHA);

  const feedback = {
    cycle_id: first.cycle.cycle_id,
    attempt: 0,
    retryable: true,
    source: "review",
    classification: "review_changes",
    gate: "independent-review",
    diagnostics: [{ id: "review-1", expected: "-", actual: "-", message: "still wrong" }],
    fingerprint: sha256("feedback"),
  };
  const second = buildAttemptInput({
    repository: "example/game-cal",
    fixInput,
    attempt: 1,
    maxAttempts: 6,
    baseSha: BASE_SHA,
    feedback,
  });
  assert.equal(second.cycle.cycle_id, first.cycle.cycle_id);
  assert.throws(
    () =>
      buildAttemptInput({
        repository: "example/game-cal",
        fixInput,
        attempt: 2,
        maxAttempts: 6,
        baseSha: BASE_SHA,
        feedback,
      }),
    /wrong attempt/
  );
});

test("the codex subprocess environment never contains GitHub credentials", () => {
  const env = scrubbedAgentEnv({
    PATH: "/usr/bin",
    HOME: "/home/runner",
    OPENAI_API_KEY: "sk-x",
    OPENAI_BASE_URL: "https://example.test/v1",
    GITHUB_TOKEN: "ghs_secret",
    GH_TOKEN: "ghs_secret",
    UPSTREAM_REVIEW_APPROVAL_TOKEN: "ghp_secret",
    OPENAI_MODEL: "model",
  });
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.UPSTREAM_REVIEW_APPROVAL_TOKEN, undefined);
  assert.equal(env.OPENAI_MODEL, undefined);
  assert.equal(env.OPENAI_API_KEY, "sk-x");
});

test("codex talks to the configured gateway as an explicit provider with bearer auth", () => {
  assert.equal(
    codexProviderBaseUrl("https://gateway.example/v1/responses"),
    "https://gateway.example/v1"
  );
  assert.equal(codexProviderBaseUrl("https://gateway.example/v1/"), "https://gateway.example/v1");
  assert.throws(() => codexProviderBaseUrl(""), /absolute URL/);

  const args = buildCodexExecArgs({
    sandbox: "read-only",
    schemaPath: "schema.json",
    outputPath: "out.json",
    model: "gpt-x",
    effort: "high",
    baseUrl: "https://gateway.example/v1/responses",
    prompt: "prompt",
  });
  assert.ok(args.includes('model_provider="autopatch"'));
  assert.ok(args.includes('model_providers.autopatch.base_url="https://gateway.example/v1"'));
  assert.ok(args.includes('model_providers.autopatch.env_key="OPENAI_API_KEY"'));
  assert.ok(args.includes('model_providers.autopatch.wire_api="responses"'));
  assert.equal(args.at(-1), "prompt");
});

test("candidate code (gates, runtime API) never sees GitHub or model credentials", () => {
  const env = scrubbedCandidateEnv({
    PATH: "/usr/bin",
    HOME: "/home/runner",
    ZZZ_SNAPSHOT_API_URL: "https://example.test/snapshot",
    GITHUB_TOKEN: "ghs_secret",
    UPSTREAM_REVIEW_APPROVAL_TOKEN: "ghp_secret",
    OPENAI_API_KEY: "sk-x",
    OPENAI_BASE_URL: "https://example.test/v1",
  });
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.UPSTREAM_REVIEW_APPROVAL_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.OPENAI_BASE_URL, undefined);
  assert.equal(env.ZZZ_SNAPSHOT_API_URL, "https://example.test/snapshot");
});

// ---------------------------------------------------------------------------
// Remediation loop with fully faked side effects.
// ---------------------------------------------------------------------------

async function makeLoopHarness({ reviewVerdicts, gatesOutcomes, runtimeDispositions, trees }) {
  const entry = finding();
  const workspace = await mkdtemp(path.join(os.tmpdir(), "autopatch-test-"));
  const state = { ...createIssueState(49, 6), findings: [entry] };
  const item = {
    type: "remediate",
    issue_number: 49,
    issue_url: "https://github.com/example/game-cal/issues/49",
    marker: parseIssueMarker(issueMarkerBody([getFindingKey(entry)])),
    pull: null,
    state,
  };
  const calls = { reviews: [], published: [], automerge: 0 };
  let round = 0;
  const deps = {
    git: async () => "",
    refreshBase: async () => BASE_SHA,
    runCodexAgent: async ({ promptPath, outputPath, cwd }) => {
      if (promptPath.includes("repair")) {
        return { complete: true, errors: [], summary: "patch", changed_files: ["apps/api/src/games/zzz.ts"] };
      }
      const reviewInput = JSON.parse(
        await readFile(path.join(cwd, "artifacts/upstream-agentic-review-input.json"), "utf8")
      );
      const verdict = reviewVerdicts[calls.reviews.filter((r) => r.kind === "agent").length] ?? "approve";
      calls.reviews.push({ kind: "agent", verdict });
      return {
        complete: true,
        errors: [],
        context_sha256: reviewInput.context_sha256,
        verdict,
        summary: "review",
        findings:
          verdict === "approve"
            ? []
            : [
                {
                  severity: "P2",
                  path: "apps/api/src/games/zzz.ts",
                  line: 3,
                  title: "still wrong",
                  body: "end time still off",
                },
              ],
      };
    },
    createCandidate: async ({ attemptInput }) => {
      const tree = trees[round] ?? sha256(`tree-${round}`).slice(0, 40);
      round += 1;
      return {
        schema_version: 1,
        cycle_id: attemptInput.cycle.cycle_id,
        attempt: attemptInput.cycle.attempt,
        base_sha: attemptInput.cycle.base_sha,
        start_sha: attemptInput.cycle.start_sha,
        result_tree: tree,
        context_sha256: attemptInput.context_sha256,
        changed_files: ["apps/api/src/games/zzz.ts"],
        incremental_files: ["apps/api/src/games/zzz.ts"],
        incremental_patch_sha256: sha256("p"),
        cumulative_patch_sha256: sha256("p"),
        agent_output_sha256: sha256("o"),
      };
    },
    runTrustedGates: async () => {
      const outcome = gatesOutcomes.shift() ?? "success";
      return {
        safeguards: { executed: true, outcome: "success", message: "" },
        parsers: { executed: true, outcome, message: outcome === "success" ? "" : "parser broke" },
        typecheck: { executed: true, outcome: "success", message: "" },
        build: { executed: true, outcome: "success", message: "" },
      };
    },
    publishCandidate: async ({ manifest, attempt }) => {
      const headSha = sha256(`head-${attempt}`).slice(0, 40);
      calls.published.push({ attempt, tree: manifest.result_tree, headSha });
      return { headSha, prNumber: 77, prUrl: "https://github.com/example/game-cal/pull/77" };
    },
    submitIndependentReview: async ({ event, body }) => {
      calls.reviews.push({ kind: "submitted", event, body });
    },
    armAutoMergeAndWait: async () => {
      calls.automerge += 1;
      return { merged: true };
    },
    verifyRuntime: async ({ attemptInput, headSha, state: loopState }) => {
      const disposition = runtimeDispositions.shift() ?? "approved";
      if (disposition === "approved") return { disposition: "approved", feedback: null };
      return {
        disposition,
        feedback: {
          cycle_id: attemptInput.cycle.cycle_id,
          attempt: attemptInput.cycle.attempt,
          head_sha: headSha,
          source: "runtime",
          classification: "code",
          retryable: true,
          gate: "exact-head-runtime",
          diagnostics: [{ id: "finding-001", expected: "resolved", actual: "unresolved", message: "still off" }],
          fingerprint: sha256(`runtime-${attemptInput.cycle.attempt}`),
        },
      };
    },
    pushUrl: "https://example.invalid/repo.git",
    defaultBranch: "main",
    runUrl: "https://github.com/example/game-cal/actions/runs/1",
  };
  const context = {
    client: {
      repository: "example/game-cal",
      request: async (pathname, options = {}) => {
        calls.github ??= [];
        calls.github.push({ pathname, method: options.method ?? "GET", body: options.body });
        if (/\/issues\/\d+$/.test(pathname) && (options.method ?? "GET") === "GET") {
          return { state: "open" };
        }
        return {};
      },
    },
    reviewClient: { request: async () => ({ login: "reviewer" }) },
    budgets: BUDGETS,
    baseSha: BASE_SHA,
    collectInput: collectInputFor([entry]),
    report: reportFor([entry], 0, {
      coverage: [{ finding_key: getFindingKey(entry), issue_number: 49 }],
    }),
    workspace,
    runUrl: deps.runUrl,
    deadlineAt: Date.now() + 60 * 60 * 1000,
    deps,
  };
  return { item, context, deps, calls, state };
}

test("a clean round publishes, approves, runs runtime replay, merges, and closes the issue", async () => {
  const harness = await makeLoopHarness({
    reviewVerdicts: ["approve"],
    gatesOutcomes: [],
    runtimeDispositions: ["approved"],
    trees: [],
  });
  const result = await remediateIssue(harness);
  assert.equal(result.outcome, "merged");
  assert.equal(harness.state.status, "resolved");
  assert.equal(harness.state.attempts_used, 1);
  assert.equal(harness.calls.automerge, 1);
  const submitted = harness.calls.reviews.filter((entry) => entry.kind === "submitted");
  assert.deepEqual(submitted.map((entry) => entry.event), ["APPROVE"]);
  // GitHub's `Closes #N` keyword did not fire for API merges, so the driver
  // must close the Issue itself.
  const closed = harness.calls.github.find(
    (call) => call.method === "PATCH" && call.pathname === "/repos/example/game-cal/issues/49"
  );
  assert.ok(closed, "remediated issue must be closed explicitly");
  assert.equal(closed.body.state, "closed");
  assert.equal(closed.body.state_reason, "completed");
});

test("each issue rebases onto the current default-branch tip before repairing", async () => {
  const harness = await makeLoopHarness({
    reviewVerdicts: ["approve"],
    gatesOutcomes: [],
    runtimeDispositions: ["approved"],
    trees: [],
  });
  // Simulates an earlier issue in the same run having merged: protected
  // branches require up-to-date PRs, so a stale run-wide base would leave this
  // PR permanently BEHIND.
  const advanced = "f".repeat(40);
  harness.deps.refreshBase = async () => advanced;
  const result = await remediateIssue(harness);
  assert.equal(result.outcome, "merged");
  assert.equal(harness.item.fixInput.source_report.base_sha, advanced);
  assert.ok(
    result.roundLog.some((line) => line.includes("rebased onto")),
    "a base change must be recorded on the issue trail"
  );
});

test("gate failures consume budget without publishing, then a fixed round merges", async () => {
  const harness = await makeLoopHarness({
    reviewVerdicts: ["approve"],
    gatesOutcomes: ["failure"],
    runtimeDispositions: ["approved"],
    trees: [],
  });
  const result = await remediateIssue(harness);
  assert.equal(result.outcome, "merged");
  assert.equal(harness.state.attempts_used, 2);
  assert.equal(harness.calls.published.length, 1);
});

test("request-changes reviews leave a PR trail and feed the next round", async () => {
  const harness = await makeLoopHarness({
    reviewVerdicts: ["request_changes", "approve"],
    gatesOutcomes: [],
    runtimeDispositions: ["approved"],
    trees: [],
  });
  const result = await remediateIssue(harness);
  assert.equal(result.outcome, "merged");
  const submitted = harness.calls.reviews.filter((entry) => entry.kind === "submitted");
  assert.deepEqual(submitted.map((entry) => entry.event), ["REQUEST_CHANGES", "APPROVE"]);
  assert.match(submitted[0].body, /still wrong/);
});

test("the per-run round budget pauses the loop with resumable feedback", async () => {
  const harness = await makeLoopHarness({
    reviewVerdicts: ["request_changes", "request_changes", "request_changes"],
    gatesOutcomes: [],
    runtimeDispositions: [],
    trees: [],
  });
  const result = await remediateIssue(harness);
  assert.equal(result.outcome, "paused:round_budget");
  assert.equal(harness.state.attempts_used, 3);
  assert.ok(harness.state.last_feedback);
  assert.equal(harness.state.last_feedback.attempt, 2);
});

test("a repeated candidate tree blocks the issue as no-progress", async () => {
  const tree = "d".repeat(40);
  const harness = await makeLoopHarness({
    reviewVerdicts: ["request_changes"],
    gatesOutcomes: [],
    runtimeDispositions: [],
    trees: [tree, tree],
  });
  const result = await remediateIssue(harness);
  assert.equal(result.outcome, "blocked:no_progress_tree_repeated");
  assert.equal(harness.state.status, "blocked");
});

test("an unresolved runtime replay requests changes instead of merging", async () => {
  const harness = await makeLoopHarness({
    reviewVerdicts: ["approve", "approve"],
    gatesOutcomes: [],
    runtimeDispositions: ["retry", "approved"],
    trees: [],
  });
  const result = await remediateIssue(harness);
  assert.equal(result.outcome, "merged");
  const submitted = harness.calls.reviews.filter((entry) => entry.kind === "submitted");
  assert.deepEqual(submitted.map((entry) => entry.event), ["REQUEST_CHANGES", "APPROVE"]);
  assert.match(submitted[0].body, /runtime/);
});

// ---------------------------------------------------------------------------
// Plan execution with a recording GitHub client.
// ---------------------------------------------------------------------------

function recordingClient() {
  const calls = [];
  return {
    calls,
    repository: "example/game-cal",
    request: async (pathname, options = {}) => {
      calls.push({ pathname, method: options.method ?? "GET", body: options.body });
      if (pathname.endsWith("/comments") && options.method === "POST") return { id: 555 };
      return {};
    },
    graphql: async () => ({}),
  };
}

test("executePlan closes orphan PRs, persists waiting state, and records blocks", async () => {
  const entry = finding();
  const key = getFindingKey(entry);
  const issue = managedIssue({ number: 48, keys: [key] });
  const client = recordingClient();
  const context = {
    client,
    reviewClient: recordingClient(),
    issuesByNumber: new Map([[48, issue]]),
    runUrl: "https://github.com/example/game-cal/actions/runs/1",
    deps: {},
  };
  const waitState = { ...createIssueState(48, 6), consecutive_misses: 1 };
  const blockState = { ...createIssueState(48, 6), attempts_used: 6 };
  const summary = await executePlan({
    plan: {
      warnings: [],
      actions: [
        { type: "close_orphan_pr", pr_number: 90, branch: "codex/orphan", reason: "no linked remediation issue" },
        { type: "wait", issue_number: 48, reason: "not re-confirmed", state: waitState },
        { type: "block", issue_number: 48, reason: "code_attempt_budget_exhausted", state: blockState },
      ],
    },
    context,
    deps: context.deps,
  });
  const paths = client.calls.map((call) => `${call.method} ${call.pathname}`);
  assert.ok(paths.includes("PATCH /repos/example/game-cal/pulls/90"));
  assert.ok(paths.some((entry) => entry.startsWith("POST /repos/example/game-cal/issues/48/labels")));
  assert.ok(summary.some((line) => line.includes("blocked")));
  assert.equal(blockState.status, "blocked");
});

test("infrastructure failures during remediation are contained and reported on the issue", async () => {
  const entry = finding();
  const key = getFindingKey(entry);
  const issue = managedIssue({ number: 49, keys: [key] });
  const client = recordingClient();
  const state = { ...createIssueState(49, 6), findings: [entry] };
  const context = {
    client,
    reviewClient: recordingClient(),
    issuesByNumber: new Map([[49, issue]]),
    runUrl: "https://github.com/example/game-cal/actions/runs/1",
    budgets: BUDGETS,
    baseSha: BASE_SHA,
    collectInput: collectInputFor([entry]),
    report: reportFor([entry], 0, { coverage: [{ finding_key: key, issue_number: 49 }] }),
    workspace: await mkdtemp(path.join(os.tmpdir(), "autopatch-test-")),
    deadlineAt: Date.now() + 60 * 60 * 1000,
  };
  const deps = {
    git: async () => {
      throw new Error("network unreachable");
    },
  };
  context.deps = deps;
  const summary = await executePlan({
    plan: {
      warnings: [],
      actions: [
        {
          type: "remediate",
          issue_number: 49,
          issue_url: issue.html_url,
          marker: parseIssueMarker(issue.body),
          pull: null,
          state,
        },
      ],
    },
    context,
    deps,
  });
  assert.equal(state.infra_failures, 1);
  assert.equal(state.attempts_used, 0);
  assert.ok(summary.some((line) => line.includes("infrastructure failure")));
  const commentCall = client.calls.find(
    (call) => call.pathname === "/repos/example/game-cal/issues/49/comments" && call.method === "POST"
  );
  assert.match(commentCall.body.body, /attempt aborted \(infrastructure\)/);
});

test("feedback rendering shows the concrete diagnostics on the PR review", () => {
  const body = renderFeedbackForReviewBody({
    source: "validate",
    classification: "code",
    attempt: 1,
    diagnostics: [
      { id: "parsers", expected: "success", actual: "failure", message: "zzz window off by one hour" },
    ],
  });
  assert.match(body, /attempt 2/);
  assert.match(body, /parsers/);
  assert.match(body, /off by one hour/);
});
