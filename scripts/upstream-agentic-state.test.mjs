import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalJson,
  classifyReview,
  classifyRuntime,
  classifyValidation,
  createCycle,
  createFeedback,
  sha256,
  terminalAttempt,
  transition,
} from "./upstream-agentic-state.mjs";

function cycle(overrides = {}) {
  return createCycle({
    repository: "example/game-cal",
    baseSha: "a".repeat(40),
    findingFingerprint: "b".repeat(64),
    remediationCycle: "c".repeat(64),
    issueNumber: 26,
    fixBranch: "codex/upstream-agentic-test",
    maxCodeAttempts: 4,
    ...overrides,
  });
}

test("canonical JSON and hashes are independent of object insertion order", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}\n');
  assert.equal(sha256({ b: 2, a: 1 }), sha256({ a: 1, b: 2 }));
});

test("validate failure feeds the same bounded repair loop", () => {
  let state = cycle();
  state = transition(state, {
    type: "candidate_generated",
    payload: { treeSha: "1".repeat(40) },
  });
  const result = classifyValidation({
    cycleId: state.cycle_id,
    attempt: 0,
    maxAttempts: 4,
    gates: {
      safeguards: { executed: true, outcome: "success" },
      parsers: {
        executed: true,
        outcome: "failure",
        message: "expected 06:00, received 07:00",
      },
      typecheck: { executed: true, outcome: "success" },
      build: { executed: true, outcome: "success" },
    },
  });
  assert.equal(result.disposition, "retry");
  assert.equal(result.feedback.source, "validate");
  state = transition(state, {
    type: "repairable_failure",
    payload: { feedback: result.feedback },
  });
  assert.equal(state.disposition, "retry");
});

test("review changes use the same code budget", () => {
  const result = classifyReview({
    cycleId: "d".repeat(64),
    attempt: 1,
    headSha: "e".repeat(40),
    maxAttempts: 4,
    review: {
      complete: true,
      errors: [],
      context_sha256: "f".repeat(64),
      verdict: "request_changes",
      summary: "one blocking problem",
      findings: [
        {
          severity: "P2",
          path: "apps/api/src/games/zzz.ts",
          line: 10,
          title: "Wrong offset",
          body: "The computed end remains one hour late.",
        },
      ],
    },
  });
  assert.equal(result.disposition, "retry");
  assert.equal(result.feedback.classification, "review_changes");
});

test("review evidence is bound to the trusted context and changed paths", () => {
  const review = {
    complete: true,
    errors: [],
    context_sha256: "f".repeat(64),
    verdict: "request_changes",
    summary: "blocking",
    findings: [
      {
        severity: "P2",
        path: "apps/api/src/games/zzz.ts",
        line: 1,
        title: "problem",
        body: "problem",
      },
    ],
  };
  assert.throws(
    () =>
      classifyReview({
        cycleId: "d".repeat(64),
        attempt: 0,
        headSha: "e".repeat(40),
        maxAttempts: 4,
        review,
        expectedContextSha256: "0".repeat(64),
        allowedFiles: ["apps/api/src/games/zzz.ts"],
      }),
    /context digest does not match/
  );
  assert.throws(
    () =>
      classifyReview({
        cycleId: "d".repeat(64),
        attempt: 0,
        headSha: "e".repeat(40),
        maxAttempts: 4,
        review,
        expectedContextSha256: "f".repeat(64),
        allowedFiles: ["apps/api/src/games/starrail.ts"],
      }),
    /outside the candidate diff/
  );
});

test("the last configured attempt fails closed", () => {
  const validation = classifyValidation({
    cycleId: "1".repeat(64),
    attempt: 3,
    maxAttempts: 4,
    gates: { parsers: { executed: true, outcome: "failure" } },
  });
  assert.equal(validation.disposition, "blocked");
  assert.equal(validation.feedback.retryable, false);
  assert.equal(validation.feedback.classification, "budget_exhausted");
});

test("runtime replay failures return to the same bounded loop", () => {
  const runtimeInput = {
    context_sha256: "8".repeat(64),
    findings: [{ finding_id: "finding-001" }],
  };
  const retry = classifyRuntime({
    cycleId: "7".repeat(64),
    attempt: 1,
    headSha: "6".repeat(40),
    maxAttempts: 4,
    runtimeInput,
    runtime: {
      complete: true,
      errors: [],
      context_sha256: runtimeInput.context_sha256,
      verdict: "unresolved",
      summary: "still wrong",
      outcomes: [{ finding_id: "finding-001", status: "unresolved", reason: "still one hour late" }],
    },
  });
  assert.equal(retry.disposition, "retry");
  assert.equal(retry.feedback.source, "runtime");

  const approved = classifyRuntime({
    cycleId: "7".repeat(64),
    attempt: 2,
    headSha: "5".repeat(40),
    maxAttempts: 4,
    runtimeInput,
    runtime: {
      complete: true,
      errors: [],
      context_sha256: runtimeInput.context_sha256,
      verdict: "resolved",
      summary: "fixed",
      outcomes: [{ finding_id: "finding-001", status: "resolved", reason: "matches evidence" }],
    },
  });
  assert.equal(approved.disposition, "approved");
});

test("a skipped validation gate cannot produce a green decision", () => {
  const result = classifyValidation({
    cycleId: "2".repeat(64),
    attempt: 0,
    maxAttempts: 4,
    gates: {
      safeguards: { executed: true, outcome: "success" },
      parsers: { executed: false, outcome: "skipped" },
    },
  });
  assert.equal(result.disposition, "retry");
  assert.equal(result.feedback.diagnostics[0].actual, "not_executed");
});

test("repeated trees and repeated feedback stop oscillating agents", () => {
  let state = cycle();
  state = transition(state, {
    type: "candidate_generated",
    payload: { treeSha: "3".repeat(40) },
  });
  const feedback = createFeedback({
    cycleId: state.cycle_id,
    attempt: 0,
    source: "validate",
    classification: "code",
    retryable: true,
    gate: "parsers",
    diagnostics: [{ id: "test", actual: "failed", expected: "passed", message: "same failure" }],
  });
  state = transition(state, { type: "repairable_failure", payload: { feedback } });
  state = transition(state, {
    type: "candidate_generated",
    payload: { treeSha: "4".repeat(40) },
  });
  state = transition(state, { type: "repairable_failure", payload: { feedback } });
  assert.equal(state.disposition, "blocked");
  assert.equal(state.terminal_reason, "no_progress_feedback_repeated");

  let repeatedTree = cycle();
  repeatedTree = transition(repeatedTree, {
    type: "candidate_generated",
    payload: { treeSha: "5".repeat(40) },
  });
  repeatedTree.disposition = "retry";
  repeatedTree = transition(repeatedTree, {
    type: "candidate_generated",
    payload: { treeSha: "5".repeat(40) },
  });
  assert.equal(repeatedTree.disposition, "blocked");
  assert.equal(repeatedTree.terminal_reason, "no_progress_tree_repeated");
});

test("merge is impossible before exact-head approval", () => {
  const state = cycle();
  assert.throws(
    () => transition(state, { type: "merged", payload: { headSha: "6".repeat(40) } }),
    /unapproved cycle cannot merge/
  );
});

test("terminal resolver rejects skipped-as-success chains", () => {
  assert.throws(
    () => terminalAttempt([{ result: "success", disposition: "retry" }, { result: "skipped" }]),
    /without an explicit terminal result/
  );
  assert.deepEqual(
    terminalAttempt([
      { result: "success", disposition: "retry", attempt: 0 },
      { result: "success", disposition: "approved", attempt: 1 },
      { result: "skipped" },
    ]),
    { result: "success", disposition: "approved", attempt: 1 }
  );
});
