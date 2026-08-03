import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReviewInput,
  buildRuntimeInput,
  prepareAttempt,
  renderPrBody,
  validateAgentOutput,
  validateFixInput,
} from "./upstream-agentic-artifact.mjs";

function fixInput(overrides = {}) {
  return {
    schema_version: 3,
    mode: "agentic_fix",
    source_report: {
      issue_number: 26,
      issue_url: "https://github.com/example/game-cal/issues/26",
      remediation_cycle: "c".repeat(64),
      base_sha: "a".repeat(40),
    },
    finding_fingerprint: "b".repeat(64),
    fix_branch: "codex/upstream-agentic-test",
    target_games: ["zzz"],
    allowed_files: [
      "apps/api/src/games/zzz.ts",
      "apps/api/src/games/parser-regressions.agent.test.ts",
    ],
    required_test_files: ["apps/api/src/games/parser-regressions.agent.test.ts"],
    findings: [{ finding_id: "finding-001", game: "zzz", reason: "wrong time" }],
    evidence: [{ game: "zzz", matching_raw_notices: [] }],
    ...overrides,
  };
}

test("attempt input binds findings, feedback, budget, and exact start SHA", async () => {
  const initial = await prepareAttempt({
    fixInput: fixInput(),
    repository: "example/game-cal",
    attempt: 0,
    maxAttempts: 4,
    startSha: "a".repeat(40),
  });
  assert.equal(initial.input.mode, "upstream_remediation_attempt");
  assert.equal(initial.input.feedback, null);
  assert.equal(initial.input.cycle.max_attempts, 4);
  assert.match(initial.input.context_sha256, /^[a-f0-9]{64}$/);

  const feedback = {
    schema_version: 1,
    cycle_id: initial.cycle.cycle_id,
    attempt: 0,
    head_sha: null,
    source: "validate",
    classification: "code",
    retryable: true,
    gate: "trusted-validation",
    diagnostics: [],
    fingerprint: "d".repeat(64),
  };
  const revision = await prepareAttempt({
    fixInput: fixInput(),
    repository: "example/game-cal",
    attempt: 1,
    maxAttempts: 4,
    startSha: "e".repeat(40),
    feedback,
  });
  assert.equal(revision.input.feedback.fingerprint, "d".repeat(64));
  assert.equal(revision.input.cycle.start_sha, "e".repeat(40));
});

test("revision attempts reject absent, stale, or non-retryable feedback", async () => {
  await assert.rejects(
    prepareAttempt({
      fixInput: fixInput(),
      repository: "example/game-cal",
      attempt: 1,
      maxAttempts: 4,
      startSha: "a".repeat(40),
    }),
    /requires feedback/
  );
});

test("automatic repair paths are restricted to mapped parsers and the agent test", () => {
  assert.doesNotThrow(() => validateFixInput(fixInput()));
  for (const file of [
    ".github/workflows/unsafe.yml",
    "scripts/review-upstream.mjs",
    "package.json",
    "apps/api/src/games/parser-regressions.trusted.test.ts",
  ]) {
    assert.throws(() => validateFixInput(fixInput({ allowed_files: [file] })), /disallowed/);
  }
});

test("agent output must exactly describe an allowed nonempty diff", () => {
  const input = {
    allowed_files: ["apps/api/src/games/zzz.ts"],
  };
  assert.deepEqual(
    validateAgentOutput(
      { complete: true, errors: [], summary: "fixed", changed_files: ["apps/api/src/games/zzz.ts"] },
      input
    ).changed_files,
    ["apps/api/src/games/zzz.ts"]
  );
  assert.throws(
    () =>
      validateAgentOutput(
        { complete: true, errors: [], summary: "unsafe", changed_files: [".github/workflows/unsafe.yml"] },
        input
      ),
    /disallowed/
  );
});

test("review input and PR body bind the exact cycle and head", () => {
  const input = fixInput();
  const review = buildReviewInput({
    fixInput: input,
    repository: "example/game-cal",
    prNumber: 27,
    headSha: "d".repeat(40),
    manifest: {
      cycle_id: "e".repeat(64),
      attempt: 1,
      base_sha: "a".repeat(40),
      result_tree: "f".repeat(40),
      changed_files: ["apps/api/src/games/zzz.ts"],
    },
  });
  assert.equal(review.head_sha, "d".repeat(40));
  assert.equal(review.pr_number, 27);
  assert.match(review.context_sha256, /^[a-f0-9]{64}$/);
  const body = renderPrBody({ fixInput: input, cycleId: "e".repeat(64), maxAttempts: 4 });
  assert.match(body, /Closes #26/);
  assert.match(body, /upstream-agentic-cycle:/);
});

test("runtime input freezes exact-head candidate API results", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "http://127.0.0.1:8787/api/events?game=zzz");
    return new Response(JSON.stringify({ data: [{ title: "event", start_time: "2026-01-01" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const input = await buildRuntimeInput({
      fixInput: fixInput(),
      cycleId: "e".repeat(64),
      attempt: 1,
      headSha: "d".repeat(40),
      apiBaseUrl: "http://127.0.0.1:8787",
    });
    assert.equal(input.mode, "upstream_remediation_runtime");
    assert.equal(input.candidate_datasets[0].game, "zzz");
    assert.equal(input.candidate_datasets[0].events[0].title, "event");
    assert.match(input.context_sha256, /^[a-f0-9]{64}$/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
