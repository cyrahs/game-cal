import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CODE_ATTEMPT_DEFAULT = 4;
const CODE_ATTEMPT_MAX = 4;
const INFRA_RETRY_DEFAULT = 3;

const DISPOSITIONS = new Set([
  "repair",
  "validate",
  "publish",
  "review",
  "approved",
  "retry",
  "blocked",
  "merged",
  "no_findings",
]);

const RETRYABLE_SOURCES = new Set(["validate", "ci", "review", "runtime"]);
const FAILURE_CLASSES = new Set([
  "code",
  "review_changes",
  "infrastructure",
  "stale_base",
  "no_progress",
  "policy_violation",
  "budget_exhausted",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, expected, label) {
  assert(isObject(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(
    JSON.stringify(actual) === JSON.stringify(wanted),
    `${label} has unexpected fields: ${actual.join(", ")}`
  );
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

function sha256(value) {
  const bytes = typeof value === "string" ? value : canonicalJson(value);
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeText(value, maximum = 2000) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maximum);
}

function normalizeAttemptBudget(value = CODE_ATTEMPT_DEFAULT) {
  const parsed = Number(value);
  assert(Number.isInteger(parsed), "max_code_attempts must be an integer");
  assert(parsed >= 1 && parsed <= CODE_ATTEMPT_MAX, "max_code_attempts must be between 1 and 4");
  return parsed;
}

function createCycle({
  repository,
  baseSha,
  findingFingerprint,
  remediationCycle,
  issueNumber,
  fixBranch,
  maxCodeAttempts = CODE_ATTEMPT_DEFAULT,
  maxInfraRetries = INFRA_RETRY_DEFAULT,
}) {
  assert(/^[^/\s]+\/[^/\s]+$/.test(repository), "invalid repository");
  assert(/^[a-f0-9]{40}$/.test(baseSha), "invalid base SHA");
  assert(/^[a-f0-9]{64}$/.test(findingFingerprint), "invalid finding fingerprint");
  assert(/^[a-f0-9]{64}$/.test(remediationCycle), "invalid remediation cycle");
  assert(Number.isInteger(issueNumber) && issueNumber > 0, "invalid Issue number");
  assert(/^codex\/[A-Za-z0-9._/-]+$/.test(fixBranch), "invalid fix branch");
  const codeBudget = normalizeAttemptBudget(maxCodeAttempts);
  const infraBudget = Number(maxInfraRetries);
  assert(Number.isInteger(infraBudget) && infraBudget >= 0 && infraBudget <= 5, "invalid infra retry budget");

  const cycleId = sha256({
    repository,
    base_sha: baseSha,
    finding_fingerprint: findingFingerprint,
    remediation_cycle: remediationCycle,
  });

  return {
    schema_version: 1,
    cycle_id: cycleId,
    sequence: 0,
    disposition: "repair",
    repository,
    base_sha: baseSha,
    finding_fingerprint: findingFingerprint,
    remediation_cycle: remediationCycle,
    issue_number: issueNumber,
    pr_number: null,
    fix_branch: fixBranch,
    head_sha: null,
    attempt: 0,
    budgets: {
      max_code_attempts: codeBudget,
      code_attempts_used: 0,
      max_infra_retries: infraBudget,
      infra_retries_used: 0,
      max_base_restarts: 1,
      base_restarts_used: 0,
    },
    tree_history: [],
    feedback_fingerprints: [],
    previous_state_sha256: null,
    terminal_reason: null,
  };
}

function validateCycle(state) {
  assertExactKeys(
    state,
    [
      "schema_version",
      "cycle_id",
      "sequence",
      "disposition",
      "repository",
      "base_sha",
      "finding_fingerprint",
      "remediation_cycle",
      "issue_number",
      "pr_number",
      "fix_branch",
      "head_sha",
      "attempt",
      "budgets",
      "tree_history",
      "feedback_fingerprints",
      "previous_state_sha256",
      "terminal_reason",
    ],
    "cycle state"
  );
  assert(state.schema_version === 1, "unsupported cycle schema");
  assert(/^[a-f0-9]{64}$/.test(state.cycle_id), "invalid cycle id");
  assert(Number.isInteger(state.sequence) && state.sequence >= 0, "invalid cycle sequence");
  assert(DISPOSITIONS.has(state.disposition), "invalid disposition");
  assert(/^[a-f0-9]{40}$/.test(state.base_sha), "invalid cycle base SHA");
  assert(Array.isArray(state.tree_history), "invalid tree history");
  assert(Array.isArray(state.feedback_fingerprints), "invalid feedback history");
  normalizeAttemptBudget(state.budgets.max_code_attempts);
  return state;
}

function feedbackFingerprint({ source, classification, gate, diagnostics }) {
  return sha256({
    source,
    classification,
    gate,
    diagnostics: diagnostics.map((item) => ({
      id: item.id,
      expected: item.expected,
      actual: item.actual,
      message: item.message,
    })),
  });
}

function createFeedback({
  cycleId,
  attempt,
  headSha = null,
  source,
  classification,
  retryable,
  gate,
  diagnostics = [],
}) {
  assert(/^[a-f0-9]{64}$/.test(cycleId), "invalid feedback cycle id");
  assert(Number.isInteger(attempt) && attempt >= 0, "invalid feedback attempt");
  assert(RETRYABLE_SOURCES.has(source), "invalid feedback source");
  assert(FAILURE_CLASSES.has(classification), "invalid feedback classification");
  assert(typeof retryable === "boolean", "invalid retryable flag");
  assert(typeof gate === "string" && gate.length > 0 && gate.length <= 100, "invalid feedback gate");
  assert(Array.isArray(diagnostics) && diagnostics.length <= 20, "invalid diagnostics");

  const normalizedDiagnostics = diagnostics.map((item, index) => ({
    id: normalizeText(item?.id || `diagnostic-${index + 1}`, 120),
    expected: normalizeText(item?.expected, 500),
    actual: normalizeText(item?.actual, 500),
    message: normalizeText(item?.message, 2000),
  }));
  const fingerprint = feedbackFingerprint({
    source,
    classification,
    gate,
    diagnostics: normalizedDiagnostics,
  });

  return {
    schema_version: 1,
    cycle_id: cycleId,
    attempt,
    head_sha: headSha,
    source,
    classification,
    retryable,
    gate,
    diagnostics: normalizedDiagnostics,
    fingerprint,
  };
}

function transition(state, event) {
  validateCycle(state);
  assertExactKeys(event, ["type", "payload"], "transition event");
  assert(typeof event.type === "string", "invalid event type");
  assert(isObject(event.payload), "invalid event payload");

  const previousDigest = sha256(state);
  const next = structuredClone(state);
  next.sequence += 1;
  next.previous_state_sha256 = previousDigest;

  switch (event.type) {
    case "candidate_generated": {
      assert(state.disposition === "repair" || state.disposition === "retry", "candidate cannot be generated now");
      const { treeSha } = event.payload;
      assert(/^[a-f0-9]{40}$/.test(treeSha), "invalid candidate tree");
      if (state.tree_history.includes(treeSha)) {
        next.disposition = "blocked";
        next.terminal_reason = "no_progress_tree_repeated";
        return next;
      }
      next.tree_history.push(treeSha);
      next.budgets.code_attempts_used += 1;
      next.attempt = next.budgets.code_attempts_used - 1;
      next.disposition = "validate";
      return next;
    }
    case "validation_passed":
      assert(state.disposition === "validate", "validation cannot pass now");
      next.disposition = "publish";
      return next;
    case "candidate_published": {
      assert(state.disposition === "publish", "candidate cannot be published now");
      const { headSha, prNumber } = event.payload;
      assert(/^[a-f0-9]{40}$/.test(headSha), "invalid published head");
      assert(Number.isInteger(prNumber) && prNumber > 0, "invalid PR number");
      next.head_sha = headSha;
      next.pr_number = prNumber;
      next.disposition = "review";
      return next;
    }
    case "approval_ready":
      assert(state.disposition === "review", "approval cannot be recorded now");
      assert(event.payload.headSha === state.head_sha, "approval is not for the current head");
      next.disposition = "approved";
      return next;
    case "repairable_failure": {
      assert(
        state.disposition === "validate" || state.disposition === "review",
        "repairable failure cannot be recorded now"
      );
      const feedback = event.payload.feedback;
      assert(feedback?.cycle_id === state.cycle_id, "feedback belongs to another cycle");
      assert(feedback?.retryable === true, "failure is not retryable");
      if (state.feedback_fingerprints.at(-1) === feedback.fingerprint) {
        next.disposition = "blocked";
        next.terminal_reason = "no_progress_feedback_repeated";
        return next;
      }
      next.feedback_fingerprints.push(feedback.fingerprint);
      if (next.budgets.code_attempts_used >= next.budgets.max_code_attempts) {
        next.disposition = "blocked";
        next.terminal_reason = "code_attempt_budget_exhausted";
      } else {
        next.disposition = "retry";
      }
      return next;
    }
    case "infrastructure_failure":
      next.budgets.infra_retries_used += 1;
      if (next.budgets.infra_retries_used > next.budgets.max_infra_retries) {
        next.disposition = "blocked";
        next.terminal_reason = "infrastructure_retry_budget_exhausted";
      }
      return next;
    case "policy_violation":
      next.disposition = "blocked";
      next.terminal_reason = normalizeText(event.payload.reason || "policy_violation", 200);
      return next;
    case "merged":
      assert(state.disposition === "approved", "unapproved cycle cannot merge");
      assert(event.payload.headSha === state.head_sha, "merged head does not match approved head");
      next.disposition = "merged";
      next.terminal_reason = "merged_exact_head";
      return next;
    default:
      throw new Error(`unsupported transition: ${event.type}`);
  }
}

function classifyValidation({ cycleId, attempt, headSha = null, gates, maxAttempts }) {
  assert(isObject(gates) && Object.keys(gates).length > 0, "validation gates are required");
  const failed = Object.entries(gates)
    .filter(([, value]) => value?.executed !== true || value?.outcome !== "success")
    .map(([id, value]) => ({
      id,
      expected: "success",
      actual: value?.executed === true ? normalizeText(value.outcome, 100) : "not_executed",
      message: normalizeText(value?.message || `${id} did not pass`),
    }));
  if (failed.length === 0) {
    return { disposition: "review", feedback: null };
  }
  const budget = normalizeAttemptBudget(maxAttempts);
  const retryable = attempt + 1 < budget;
  return {
    disposition: retryable ? "retry" : "blocked",
    feedback: createFeedback({
      cycleId,
      attempt,
      headSha,
      source: "validate",
      classification: retryable ? "code" : "budget_exhausted",
      retryable,
      gate: "trusted-validation",
      diagnostics: failed,
    }),
  };
}

function classifyReview({
  cycleId,
  attempt,
  headSha,
  review,
  maxAttempts,
  expectedContextSha256 = null,
  allowedFiles = null,
}) {
  assert(isObject(review), "review result is required");
  assert(review.complete === true, "review is incomplete");
  assert(review.context_sha256 && /^[a-f0-9]{64}$/.test(review.context_sha256), "invalid review context digest");
  if (expectedContextSha256 !== null) {
    assert(review.context_sha256 === expectedContextSha256, "review context digest does not match");
  }
  assert(review.verdict === "approve" || review.verdict === "request_changes", "invalid review verdict");
  assert(Array.isArray(review.findings), "review findings must be an array");
  if (allowedFiles !== null) {
    assert(Array.isArray(allowedFiles), "allowed review files must be an array");
    assert(
      review.findings.every((item) => allowedFiles.includes(item.path)),
      "review finding points outside the candidate diff"
    );
  }
  const blocking = review.findings.filter((item) => item.severity === "P1" || item.severity === "P2");
  if (review.verdict === "approve") {
    assert(blocking.length === 0, "approval contains blocking findings");
    return { disposition: "approved", feedback: null };
  }
  assert(blocking.length > 0, "request_changes requires a blocking finding");
  const budget = normalizeAttemptBudget(maxAttempts);
  const retryable = attempt + 1 < budget;
  return {
    disposition: retryable ? "retry" : "blocked",
    feedback: createFeedback({
      cycleId,
      attempt,
      headSha,
      source: "review",
      classification: retryable ? "review_changes" : "budget_exhausted",
      retryable,
      gate: "independent-review",
      diagnostics: blocking.map((item, index) => ({
        id: `review-${index + 1}`,
        expected: "no blocking finding",
        actual: `${item.severity} ${normalizeText(item.path, 300)}:${item.line}`,
        message: `${normalizeText(item.title, 300)} — ${normalizeText(item.body, 1500)}`,
      })),
    }),
  };
}

function classifyRuntime({ cycleId, attempt, headSha, runtime, runtimeInput, maxAttempts }) {
  assert(isObject(runtime), "runtime result is required");
  assert(isObject(runtimeInput), "runtime input is required");
  assert(runtime.complete === true, "runtime verification is incomplete");
  assert(runtime.context_sha256 === runtimeInput.context_sha256, "runtime context digest does not match");
  assert(runtime.verdict === "resolved" || runtime.verdict === "unresolved", "invalid runtime verdict");
  assert(Array.isArray(runtime.outcomes), "runtime outcomes must be an array");
  const expectedIds = runtimeInput.findings.map((item) => item.finding_id);
  const actualIds = runtime.outcomes.map((item) => item.finding_id);
  assert(JSON.stringify(actualIds) === JSON.stringify(expectedIds), "runtime outcomes do not cover findings exactly");
  const unresolved = runtime.outcomes.filter((item) => item.status !== "resolved");
  if (runtime.verdict === "resolved") {
    assert(unresolved.length === 0, "resolved runtime verdict contains unresolved outcomes");
    return { disposition: "approved", feedback: null };
  }
  assert(unresolved.length > 0, "unresolved runtime verdict has no unresolved outcome");
  const budget = normalizeAttemptBudget(maxAttempts);
  const retryable = attempt + 1 < budget;
  return {
    disposition: retryable ? "retry" : "blocked",
    feedback: createFeedback({
      cycleId,
      attempt,
      headSha,
      source: "runtime",
      classification: retryable ? "code" : "budget_exhausted",
      retryable,
      gate: "exact-head-runtime",
      diagnostics: unresolved.map((item) => ({
        id: item.finding_id,
        expected: "resolved",
        actual: item.status,
        message: item.reason,
      })),
    }),
  };
}

function terminalAttempt(attempts) {
  assert(Array.isArray(attempts) && attempts.length > 0, "attempt results are required");
  const actual = attempts.filter((item) => item && item.result !== "skipped");
  assert(actual.length > 0, "no attempt executed");
  const approved = actual.filter((item) => item.disposition === "approved");
  assert(approved.length <= 1, "multiple attempts claim approval");
  if (approved.length === 1) return approved[0];
  const latest = actual.at(-1);
  assert(latest.disposition === "blocked", "attempt chain ended without an explicit terminal result");
  return latest;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, canonicalJson(value), "utf8");
}

async function appendOutputs(values) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join("");
  await writeFile(outputPath, lines, { encoding: "utf8", flag: "a" });
}

async function cli() {
  const command = process.argv[2];
  if (command === "classify-validation") {
    const gates = await readJson(process.env.AGENTIC_GATES_PATH);
    const result = classifyValidation({
      cycleId: process.env.AGENTIC_CYCLE_ID,
      attempt: Number(process.env.AGENTIC_ATTEMPT),
      headSha: process.env.AGENTIC_HEAD_SHA || null,
      gates,
      maxAttempts: Number(process.env.AGENTIC_MAX_ATTEMPTS || CODE_ATTEMPT_DEFAULT),
    });
    if (result.feedback) await writeJson(process.env.AGENTIC_FEEDBACK_PATH, result.feedback);
    await writeJson(process.env.AGENTIC_DECISION_PATH, {
      schema_version: 1,
      disposition: result.disposition,
      feedback_sha256: result.feedback ? sha256(result.feedback) : null,
    });
    await appendOutputs({ disposition: result.disposition });
    return;
  }
  if (command === "classify-review") {
    const review = await readJson(process.env.AGENTIC_REVIEW_PATH);
    const reviewInput = process.env.AGENTIC_REVIEW_INPUT_PATH
      ? await readJson(process.env.AGENTIC_REVIEW_INPUT_PATH)
      : null;
    const result = classifyReview({
      cycleId: process.env.AGENTIC_CYCLE_ID,
      attempt: Number(process.env.AGENTIC_ATTEMPT),
      headSha: process.env.AGENTIC_HEAD_SHA,
      review,
      maxAttempts: Number(process.env.AGENTIC_MAX_ATTEMPTS || CODE_ATTEMPT_DEFAULT),
      expectedContextSha256: reviewInput?.context_sha256 ?? null,
      allowedFiles: reviewInput?.changed_files ?? null,
    });
    if (result.feedback) await writeJson(process.env.AGENTIC_FEEDBACK_PATH, result.feedback);
    await writeJson(process.env.AGENTIC_DECISION_PATH, {
      schema_version: 1,
      disposition: result.disposition,
      feedback_sha256: result.feedback ? sha256(result.feedback) : null,
    });
    await appendOutputs({ disposition: result.disposition });
    return;
  }
  if (command === "classify-runtime") {
    const runtime = await readJson(process.env.AGENTIC_RUNTIME_PATH);
    const runtimeInput = await readJson(process.env.AGENTIC_RUNTIME_INPUT_PATH);
    const result = classifyRuntime({
      cycleId: process.env.AGENTIC_CYCLE_ID,
      attempt: Number(process.env.AGENTIC_ATTEMPT),
      headSha: process.env.AGENTIC_HEAD_SHA,
      runtime,
      runtimeInput,
      maxAttempts: Number(process.env.AGENTIC_MAX_ATTEMPTS || CODE_ATTEMPT_DEFAULT),
    });
    if (result.feedback) await writeJson(process.env.AGENTIC_FEEDBACK_PATH, result.feedback);
    await writeJson(process.env.AGENTIC_DECISION_PATH, {
      schema_version: 1,
      disposition: result.disposition,
      feedback_sha256: result.feedback ? sha256(result.feedback) : null,
    });
    await appendOutputs({ disposition: result.disposition });
    return;
  }
  throw new Error(`Unknown upstream-agentic-state command: ${command || "<empty>"}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  cli().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  canonicalJson,
  classifyReview,
  classifyRuntime,
  classifyValidation,
  createCycle,
  createFeedback,
  sha256,
  terminalAttempt,
  transition,
  validateCycle,
};
