import { execFile, spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  canonicalJson,
  classifyReview,
  classifyRuntime,
  classifyValidation,
  sha256,
} from "./upstream-agentic-state.mjs";
import {
  buildReviewInput,
  buildRuntimeInput,
  createCandidate,
  validateFixInput,
} from "./upstream-agentic-artifact.mjs";
import { getFindingFingerprint, getFindingKey } from "./review-upstream.mjs";

const execFileAsync = promisify(execFile);

const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const DEFAULT_GAMES = ["genshin", "starrail", "ww", "zzz", "snowbreak", "endfield"];
const GAME_SOURCE_FILES = {
  genshin: "apps/api/src/games/genshin.ts",
  starrail: "apps/api/src/games/starrail.ts",
  ww: "apps/api/src/games/ww.ts",
  zzz: "apps/api/src/games/zzz.ts",
  snowbreak: "apps/api/src/games/snowbreak.ts",
  endfield: "apps/api/src/games/endfield.ts",
};
const AGENT_TEST_FILE = "apps/api/src/games/parser-regressions.agent.test.ts";

const STATE_COMMENT_MARKER = "<!-- upstream-autopatch-state:v1 -->";
const STATE_BLOCK_START = "<!-- upstream-autopatch-state-json\n";
const STATE_BLOCK_END = "\n-->";
const PR_MARKER_PATTERN = /<!-- upstream-autopatch-pr:issue=([1-9]\d*) -->/;
const LEGACY_PR_CLOSES_PATTERN = /(?:^|\n)Closes #([1-9]\d*)\b/;
const ISSUE_MARKER_PATTERN =
  /<!-- upstream-review-cycle:v2 fingerprint=([a-f0-9]{64}) cycle=([a-f0-9]{64}) coverage=([a-f0-9]{64}) keys=([a-f0-9,]+) -->/;

const BLOCKED_LABEL = "autopatch:blocked";
const PAUSED_LABEL = "autopatch:paused";

const DEFAULT_ROUNDS_PER_RUN = 3;
const DEFAULT_LIFETIME_ATTEMPTS = 6;
const DEFAULT_ISSUES_PER_RUN = 2;
const DEFAULT_STALE_MISS_LIMIT = 2;
const DEFAULT_DEADLINE_MINUTES = 100;
const MAX_INFRA_FAILURES = 4;
const MAX_STATE_COMMENT_BYTES = 60_000;
const MERGE_POLL_SECONDS = 150;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value, maximum = 2000) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maximum);
}

function parseBudget(value, fallback, minimum, maximum) {
  const parsed = Number(String(value ?? "").trim() || fallback);
  assert(
    Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum,
    `budget must be an integer in [${minimum}, ${maximum}]: ${value}`
  );
  return parsed;
}

class InfrastructureError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "InfrastructureError";
    this.infrastructure = true;
  }
}

// ---------------------------------------------------------------------------
// Persistent per-issue state, stored as one bot-maintained issue comment.
// ---------------------------------------------------------------------------

function createIssueState(issueNumber, maxAttempts) {
  return {
    schema_version: 1,
    issue_number: issueNumber,
    attempts_used: 0,
    max_attempts: maxAttempts,
    consecutive_misses: 0,
    infra_failures: 0,
    tree_history: [],
    last_feedback: null,
    pr_number: null,
    fix_branch: null,
    status: "active",
    blocked_reason: null,
    findings: [],
    updated_at: null,
  };
}

function validateIssueState(state) {
  assert(isObject(state), "issue state must be an object");
  assert(state.schema_version === 1, "unsupported issue state schema");
  assert(Number.isInteger(state.issue_number) && state.issue_number > 0, "invalid state issue number");
  assert(Number.isInteger(state.attempts_used) && state.attempts_used >= 0, "invalid attempts_used");
  assert(Number.isInteger(state.max_attempts) && state.max_attempts >= 1, "invalid max_attempts");
  assert(Number.isInteger(state.consecutive_misses) && state.consecutive_misses >= 0, "invalid consecutive_misses");
  assert(Number.isInteger(state.infra_failures) && state.infra_failures >= 0, "invalid infra_failures");
  assert(Array.isArray(state.tree_history), "invalid tree_history");
  assert(["active", "blocked", "resolved"].includes(state.status), "invalid state status");
  assert(Array.isArray(state.findings), "invalid state findings");
  return state;
}

function renderStateComment(state) {
  validateIssueState(state);
  let payload = state;
  let body = buildStateCommentBody(payload);
  if (Buffer.byteLength(body, "utf8") > MAX_STATE_COMMENT_BYTES) {
    payload = {
      ...state,
      findings: state.findings.map((finding) => ({
        ...finding,
        reason: normalizeText(finding.reason, 500),
      })),
    };
    body = buildStateCommentBody(payload);
  }
  if (Buffer.byteLength(body, "utf8") > MAX_STATE_COMMENT_BYTES) {
    payload = { ...payload, last_feedback: null };
    body = buildStateCommentBody(payload);
  }
  assert(
    Buffer.byteLength(body, "utf8") <= MAX_STATE_COMMENT_BYTES,
    "issue state comment exceeds the size limit"
  );
  return body;
}

function buildStateCommentBody(state) {
  const summary = [
    `| attempts | ${state.attempts_used}/${state.max_attempts} |`,
    `| status | ${state.status}${state.blocked_reason ? ` (${state.blocked_reason})` : ""} |`,
    `| findings tracked | ${state.findings.length} |`,
    `| consecutive misses | ${state.consecutive_misses} |`,
    `| pull request | ${state.pr_number ? `#${state.pr_number}` : "none"} |`,
    `| updated | ${state.updated_at ?? "never"} |`,
  ].join("\n");
  return [
    STATE_COMMENT_MARKER,
    `${STATE_BLOCK_START}${canonicalJson(state).trimEnd()}${STATE_BLOCK_END}`,
    "",
    "### Autopatch state",
    "",
    "This comment is maintained by the upstream autopatch workflow. Do not edit.",
    `Remove the \`${BLOCKED_LABEL}\` label to grant a fresh attempt budget; add`,
    `\`${PAUSED_LABEL}\` to stop automatic remediation for this issue.`,
    "",
    "| field | value |",
    "| --- | --- |",
    summary,
  ].join("\n");
}

function parseStateComment(body) {
  const text = String(body ?? "");
  if (!text.includes(STATE_COMMENT_MARKER)) return null;
  const start = text.indexOf(STATE_BLOCK_START);
  const end = text.indexOf(STATE_BLOCK_END, start);
  if (start < 0 || end < 0) return null;
  try {
    return validateIssueState(
      JSON.parse(text.slice(start + STATE_BLOCK_START.length, end))
    );
  } catch {
    return null;
  }
}

function parseIssueMarker(body) {
  const match = ISSUE_MARKER_PATTERN.exec(String(body ?? ""));
  if (!match) return null;
  const keys = match[4].split(",").filter(Boolean);
  if (keys.length === 0 || keys.some((key) => !SHA64.test(key))) return null;
  return {
    finding_fingerprint: match[1],
    remediation_cycle: match[2],
    coverage_fingerprint: match[3],
    finding_keys: keys,
  };
}

function parsePrIssueNumber(body) {
  const text = String(body ?? "");
  const marker = PR_MARKER_PATTERN.exec(text);
  if (marker) return Number(marker[1]);
  const closes = LEGACY_PR_CLOSES_PATTERN.exec(text);
  if (closes) return Number(closes[1]);
  return null;
}

// ---------------------------------------------------------------------------
// Reconciliation planning (pure).
// ---------------------------------------------------------------------------

function groupConfirmedFindingsByIssue(report) {
  const byKey = new Map();
  for (const finding of report?.review?.findings ?? []) {
    byKey.set(getFindingKey(finding), finding);
  }
  const byIssue = new Map();
  const record = (issueNumber, findingKey) => {
    const finding = byKey.get(findingKey);
    if (!finding) return;
    if (!byIssue.has(issueNumber)) byIssue.set(issueNumber, new Map());
    byIssue.get(issueNumber).set(findingKey, finding);
  };
  for (const entry of report?.issue?.coverage ?? []) {
    record(entry.issue_number, entry.finding_key);
  }
  const ownIssueNumber = report?.issue?.issue_number;
  if (Number.isInteger(ownIssueNumber) && ownIssueNumber > 0) {
    for (const findingKey of report?.issue?.finding_keys ?? []) {
      record(ownIssueNumber, findingKey);
    }
  }
  return byIssue;
}

function planReconciliation({ issues, pulls, report, budgets, warnings = [] }) {
  const actions = [];
  const managed = [];
  for (const issue of issues) {
    const marker = parseIssueMarker(issue.body);
    if (!marker) {
      if (issue.title?.startsWith("Upstream Review Alerts")) {
        warnings.push(`issue #${issue.number} looks managed but has no parsable marker; skipping`);
      }
      continue;
    }
    managed.push({ issue, marker });
  }

  const managedIssueNumbers = new Set(managed.map((entry) => entry.issue.number));
  const pullsByIssue = new Map();
  for (const pull of pulls) {
    if (!pull.head?.ref?.startsWith("codex/")) continue;
    const issueNumber = parsePrIssueNumber(pull.body);
    if (issueNumber == null || !managedIssueNumbers.has(issueNumber)) {
      actions.push({
        type: "close_orphan_pr",
        pr_number: pull.number,
        branch: pull.head.ref,
        reason:
          issueNumber == null
            ? "no linked remediation issue"
            : `linked issue #${issueNumber} is not an open managed issue`,
      });
      continue;
    }
    const existing = pullsByIssue.get(issueNumber) ?? [];
    existing.push(pull);
    pullsByIssue.set(issueNumber, existing);
  }
  for (const [issueNumber, linked] of pullsByIssue) {
    const sorted = [...linked].sort((a, b) => b.number - a.number);
    for (const extra of sorted.slice(1)) {
      actions.push({
        type: "close_orphan_pr",
        pr_number: extra.number,
        branch: extra.head.ref,
        reason: `superseded by PR #${sorted[0].number} for issue #${issueNumber}`,
      });
    }
    pullsByIssue.set(issueNumber, sorted[0]);
  }

  const confirmedByIssue = groupConfirmedFindingsByIssue(report);
  const remediations = [];
  for (const { issue, marker } of managed) {
    const labels = new Set((issue.labels ?? []).map((label) => label.name ?? label));
    const previous = issue.autopatch_state ?? null;
    const state = previous
      ? structuredClone(previous)
      : createIssueState(issue.number, budgets.lifetimeAttempts);
    const pull = pullsByIssue.get(issue.number) ?? null;
    if (pull) {
      state.pr_number = pull.number;
      state.fix_branch = pull.head.ref;
    }

    const scopeKeys = new Set(marker.finding_keys);
    const confirmed = confirmedByIssue.get(issue.number) ?? new Map();
    const confirmedInScope = [...confirmed.entries()].filter(([key]) => scopeKeys.has(key));
    const reconfirmedToday = confirmedInScope.length > 0;
    if (reconfirmedToday) {
      state.consecutive_misses = 0;
      state.findings = confirmedInScope
        .map(([, finding]) => finding)
        .sort((a, b) => {
          const left = `${a.game} ${a.title ?? ""}`;
          const right = `${b.game} ${b.title ?? ""}`;
          return left < right ? -1 : left > right ? 1 : 0;
        });
    } else {
      state.consecutive_misses += 1;
    }

    if (labels.has(PAUSED_LABEL)) {
      actions.push({ type: "skip", issue_number: issue.number, reason: "paused by label", state });
      continue;
    }
    if (labels.has(BLOCKED_LABEL) || state.status === "blocked") {
      actions.push({
        type: "skip",
        issue_number: issue.number,
        reason: `blocked (${state.blocked_reason ?? "label"})`,
        state,
      });
      continue;
    }
    if (!reconfirmedToday && state.consecutive_misses >= budgets.staleMissLimit) {
      actions.push({
        type: "close_stale",
        issue_number: issue.number,
        pr_number: pull?.number ?? null,
        branch: pull?.head?.ref ?? null,
        misses: state.consecutive_misses,
        state,
      });
      continue;
    }
    if (!reconfirmedToday) {
      actions.push({
        type: "wait",
        issue_number: issue.number,
        reason: `findings not re-confirmed today (miss ${state.consecutive_misses}/${budgets.staleMissLimit})`,
        state,
      });
      continue;
    }
    if (state.attempts_used >= state.max_attempts) {
      actions.push({
        type: "block",
        issue_number: issue.number,
        reason: "code_attempt_budget_exhausted",
        state,
      });
      continue;
    }
    remediations.push({
      type: "remediate",
      issue_number: issue.number,
      issue_url: issue.html_url,
      marker,
      pull,
      state,
    });
  }

  remediations.sort((a, b) => a.issue_number - b.issue_number);
  for (const [index, item] of remediations.entries()) {
    if (index < budgets.issuesPerRun) {
      actions.push(item);
    } else {
      actions.push({
        type: "defer",
        issue_number: item.issue_number,
        reason: `run cap of ${budgets.issuesPerRun} issue(s) reached`,
        state: item.state,
      });
    }
  }
  return { actions, warnings };
}

// ---------------------------------------------------------------------------
// Per-issue fix input, built from persistent state + today's confirmations.
// ---------------------------------------------------------------------------

function assignFindingIds(findings) {
  return findings.map((finding, index) => ({
    finding_id: `finding-${String(index + 1).padStart(3, "0")}`,
    ...finding,
  }));
}

function normalizeIdentityText(value) {
  return normalizeText(value, 400).toLowerCase().replace(/\s+/g, " ");
}

function selectEvidenceTolerant(items, refs, titles) {
  const availableByRef = new Map(items.map((item) => [item.review_ref, item]));
  const selected = new Map();
  const missingRefs = [];
  for (const ref of new Set(refs)) {
    const item = availableByRef.get(ref);
    if (item) selected.set(item.review_ref, item);
    else missingRefs.push(ref);
  }
  if (selected.size === 0) {
    const wanted = titles.map(normalizeIdentityText).filter(Boolean);
    for (const item of items) {
      const haystack = normalizeIdentityText(item.title ?? item.name ?? "");
      if (!haystack) continue;
      if (wanted.some((needle) => haystack.includes(needle) || needle.includes(haystack))) {
        selected.set(item.review_ref, item);
        if (selected.size >= 8) break;
      }
    }
  }
  return { selected: [...selected.values()], missingRefs };
}

function buildIssueFixInput({ repository, issueNumber, issueUrl, marker, state, baseSha, collectInput, generatedAt }) {
  assert(SHA40.test(baseSha), "invalid base SHA for fix input");
  const findings = assignFindingIds(state.findings);
  assert(findings.length > 0, "issue has no findings to remediate");
  const targetGames = DEFAULT_GAMES.filter((game) =>
    findings.some((finding) => finding.game === game)
  );
  assert(targetGames.length > 0, "issue findings reference no known game");
  // The collected input stores the suppression-filtered evidence the review
  // agents saw under review_datasets (schema v3); `datasets` holds the
  // unfiltered snapshots and must not leak suppressed items into repair.
  const datasetsByGame = new Map(
    (collectInput?.review_datasets ?? []).map((dataset) => [dataset.game, dataset])
  );
  const evidenceWarnings = [];
  const evidence = targetGames.map((game) => {
    const dataset = datasetsByGame.get(game);
    assert(dataset, `today's collected input has no ${game} dataset`);
    const gameFindings = findings.filter((finding) => finding.game === game);
    const rawSelection = selectEvidenceTolerant(
      dataset.raw_notices ?? [],
      gameFindings.flatMap((finding) => finding.raw_refs ?? []),
      gameFindings.flatMap((finding) => [finding.raw_title, finding.title])
    );
    const apiSelection = selectEvidenceTolerant(
      dataset.api_events ?? [],
      gameFindings.flatMap((finding) => finding.api_refs ?? []),
      gameFindings.flatMap((finding) => [finding.api_title, finding.title])
    );
    for (const ref of [...rawSelection.missingRefs, ...apiSelection.missingRefs]) {
      evidenceWarnings.push(`${game}: stored evidence ref ${ref} is absent from today's snapshot`);
    }
    return {
      game,
      notes: dataset.notes ?? "",
      matching_raw_notices: rawSelection.selected,
      matching_api_events: apiSelection.selected,
    };
  });
  assert(
    evidence.some(
      (entry) => entry.matching_raw_notices.length > 0 || entry.matching_api_events.length > 0
    ),
    "no evidence in today's snapshot matches the tracked findings"
  );
  const fixInput = {
    schema_version: 3,
    mode: "agentic_fix",
    source_report: {
      generated_at: normalizeText(generatedAt, 100),
      finalized_at: new Date().toISOString(),
      issue_number: issueNumber,
      issue_url: issueUrl,
      remediation_cycle: marker.remediation_cycle,
      base_sha: baseSha,
    },
    finding_fingerprint: getFindingFingerprint(state.findings),
    fix_branch: state.fix_branch ?? `codex/autopatch-i${issueNumber}`,
    target_games: targetGames,
    allowed_files: [...targetGames.map((game) => GAME_SOURCE_FILES[game]), AGENT_TEST_FILE],
    findings,
    evidence,
  };
  validateFixInput(fixInput);
  return { fixInput, evidenceWarnings };
}

function buildAttemptInput({ repository, fixInput, attempt, maxAttempts, baseSha, feedback }) {
  assert(Number.isInteger(attempt) && attempt >= 0 && attempt < maxAttempts, "invalid attempt number");
  if (feedback != null) {
    assert(feedback.retryable === true, "revision feedback is not retryable");
    assert(feedback.attempt === attempt - 1, "revision feedback is from the wrong attempt");
  }
  const cycleId = sha256({
    repository,
    issue_number: fixInput.source_report.issue_number,
    finding_fingerprint: fixInput.finding_fingerprint,
  });
  if (feedback != null) {
    assert(feedback.cycle_id === cycleId, "feedback belongs to another remediation cycle");
  }
  const input = {
    schema_version: 1,
    mode: "upstream_remediation_attempt",
    cycle: {
      cycle_id: cycleId,
      attempt,
      max_attempts: maxAttempts,
      base_sha: baseSha,
      start_sha: baseSha,
      issue_number: fixInput.source_report.issue_number,
      fix_branch: fixInput.fix_branch,
      finding_fingerprint: fixInput.finding_fingerprint,
    },
    allowed_files: [...fixInput.allowed_files].sort(),
    findings: fixInput.findings,
    evidence: fixInput.evidence,
    feedback,
  };
  return { ...input, context_sha256: sha256(input) };
}

function renderPullRequestBody({ issueNumber, fingerprint, state }) {
  return [
    "## Automated upstream remediation",
    "",
    `- Remediation issue: #${issueNumber}`,
    `- Finding fingerprint: \`${fingerprint}\``,
    `- Lifetime attempt budget: ${state.attempts_used}/${state.max_attempts} used`,
    "",
    "This draft pull request is maintained by the upstream autopatch workflow.",
    "Every pushed head passed the trusted gates (safeguard tests, parser regressions,",
    "typecheck, build) before publication, then receives an independent agent review",
    "and an exact-head runtime replay before approval and native squash auto-merge.",
    "Rejected rounds appear as request-changes reviews so the history stays on the PR.",
    "",
    `Closes #${issueNumber}`,
    "",
    `<!-- upstream-autopatch-pr:issue=${issueNumber} -->`,
  ].join("\n");
}

function renderFeedbackForReviewBody(feedback) {
  const lines = feedback.diagnostics.map(
    (item) => `- **${item.id}** — expected \`${item.expected || "-"}\`, got \`${item.actual || "-"}\`: ${item.message}`
  );
  return [
    `Automated independent ${feedback.source} gate requested another bounded repair attempt`,
    `(attempt ${feedback.attempt + 1}, classification \`${feedback.classification}\`).`,
    "",
    ...lines,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// GitHub API helpers.
// ---------------------------------------------------------------------------

function createGithubClient({ repository, token, fetchImpl = fetch }) {
  assert(/^[^/\s]+\/[^/\s]+$/.test(repository), "invalid repository");
  assert(token, "missing GitHub token");
  async function request(pathname, { method = "GET", body, accept } = {}) {
    const url = pathname.startsWith("https://")
      ? pathname
      : `https://api.github.com${pathname}`;
    const response = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: accept ?? "application/vnd.github+json",
        "user-agent": "game-cal-upstream-autopatch/1",
        ...(body != null ? { "content-type": "application/json" } : {}),
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new InfrastructureError(
        `GitHub ${method} ${pathname} failed: HTTP ${response.status} ${text.slice(0, 400)}`
      );
    }
    return text ? JSON.parse(text) : null;
  }
  async function graphql(query, variables) {
    const response = await fetchImpl("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "game-cal-upstream-autopatch/1",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json();
    if (!response.ok || payload.errors?.length) {
      throw new InfrastructureError(
        `GitHub GraphQL failed: ${JSON.stringify(payload.errors ?? payload).slice(0, 400)}`
      );
    }
    return payload.data;
  }
  return { request, graphql, repository };
}

async function listPaginated(client, pathname) {
  const results = [];
  for (let page = 1; page <= 10; page += 1) {
    const separator = pathname.includes("?") ? "&" : "?";
    const batch = await client.request(`${pathname}${separator}per_page=100&page=${page}`);
    results.push(...batch);
    if (batch.length < 100) break;
  }
  return results;
}

async function loadOpenManagedIssues(client) {
  const raw = await listPaginated(client, `/repos/${client.repository}/issues?state=open`);
  const issues = raw.filter((issue) => !issue.pull_request);
  for (const issue of issues) {
    if (!parseIssueMarker(issue.body)) continue;
    const comments = await listPaginated(
      client,
      `/repos/${client.repository}/issues/${issue.number}/comments`
    );
    const stateComment = comments.findLast((comment) => parseStateComment(comment.body));
    issue.autopatch_state = stateComment ? parseStateComment(stateComment.body) : null;
    issue.autopatch_state_comment_id = stateComment?.id ?? null;
  }
  return issues;
}

async function saveIssueState(client, issue, state) {
  state.updated_at = new Date().toISOString();
  const body = renderStateComment(state);
  if (issue.autopatch_state_comment_id) {
    await client.request(
      `/repos/${client.repository}/issues/comments/${issue.autopatch_state_comment_id}`,
      { method: "PATCH", body: { body } }
    );
  } else {
    const created = await client.request(
      `/repos/${client.repository}/issues/${issue.number}/comments`,
      { method: "POST", body: { body } }
    );
    issue.autopatch_state_comment_id = created.id;
  }
}

async function commentOnIssue(client, issueNumber, body) {
  await client.request(`/repos/${client.repository}/issues/${issueNumber}/comments`, {
    method: "POST",
    body: { body },
  });
}

async function ensureLabels(client) {
  for (const [name, color, description] of [
    [BLOCKED_LABEL, "b60205", "Autopatch exhausted its attempt budget; needs a human"],
    [PAUSED_LABEL, "d4c5f9", "Autopatch will not touch this issue while present"],
  ]) {
    try {
      await client.request(`/repos/${client.repository}/labels`, {
        method: "POST",
        body: { name, color, description },
      });
    } catch (error) {
      if (!String(error.message).includes("HTTP 422")) throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Local process helpers (git, gates, codex, runtime API).
// ---------------------------------------------------------------------------

async function git(args, options = {}) {
  const result = await execFileAsync("git", args, {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...(options.env ?? {}) },
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout.trim();
}

const CANDIDATE_PROCESS_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "NODE_ENV",
  "PORT",
  "HOST",
  "CACHE_TTL_SECONDS",
  "ZZZ_SNAPSHOT_API_URL",
  "GENSHIN_API_URL",
  "GENSHIN_CONTENT_API_URL",
  "STARRAIL_API_URL",
  "STARRAIL_CONTENT_API_URL",
  "ZZZ_API_URL",
  "ZZZ_ACTIVITY_API_URL",
  "ZZZ_CONTENT_API_URL",
  "WW_NOTICE_API_URL",
];

// Trusted gates and the candidate API execute code the repair agent may have
// written (the agent-owned regression test and the patched parsers), so they
// must never inherit GitHub or model credentials from the driver process.
function scrubbedCandidateEnv(base = process.env) {
  const env = {};
  for (const key of CANDIDATE_PROCESS_ENV_ALLOWLIST) {
    if (base[key] != null && base[key] !== "") env[key] = base[key];
  }
  return env;
}

function scrubbedAgentEnv(base = process.env) {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "NO_COLOR",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "CODEX_HOME",
  ];
  const env = {};
  for (const key of allowed) {
    if (base[key] != null && base[key] !== "") env[key] = base[key];
  }
  return env;
}

async function runCodexAgent({
  promptPath,
  schemaPath,
  outputPath,
  sandbox,
  cwd,
  timeoutMs = 25 * 60 * 1000,
  env = process.env,
}) {
  assert(["read-only", "workspace-write"].includes(sandbox), `invalid sandbox: ${sandbox}`);
  const prompt = await readFile(promptPath, "utf8");
  const model = env.OPENAI_MODEL;
  const effort = env.OPENAI_REASONING_EFFORT;
  assert(model && effort, "missing OPENAI_MODEL or OPENAI_REASONING_EFFORT");
  const args = [
    "exec",
    "--sandbox",
    sandbox,
    "--skip-git-repo-check",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "--model",
    model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(effort)}`,
    "-c",
    'preferred_auth_method="apikey"',
    prompt,
  ];
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "autopatch-codex-"));
  await new Promise((resolve, reject) => {
    const child = spawn(env.AUTOPATCH_CODEX_BIN || "codex", args, {
      cwd,
      env: { ...scrubbedAgentEnv(env), CODEX_HOME: codexHome },
      stdio: ["ignore", "inherit", "inherit"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new InfrastructureError(`codex ${sandbox} invocation timed out`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new InfrastructureError(`codex failed to start: ${error.message}`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new InfrastructureError(`codex exited with code ${code}`));
    });
  });
  try {
    return JSON.parse(await readFile(outputPath, "utf8"));
  } catch (error) {
    throw new InfrastructureError(`codex produced unparsable output: ${error.message}`);
  }
}

async function runCommand(command, args, { cwd, env, timeoutMs = 20 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn(command, args, {
      cwd: cwd ?? process.cwd(),
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, output: String(error.message) });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

async function runTrustedGates({ cwd }) {
  const gateEnv = scrubbedCandidateEnv();
  const reinstall = await runCommand("pnpm", ["install", "--frozen-lockfile"], {
    cwd,
    env: gateEnv,
  });
  if (reinstall.code !== 0) {
    throw new InfrastructureError(
      `dependency reinstall failed before gates: ${reinstall.output.slice(-1500)}`
    );
  }
  const gates = {};
  for (const [id, args] of [
    ["safeguards", ["test:upstream-review"]],
    ["parsers", ["test:game-parsers"]],
    ["typecheck", ["typecheck"]],
    ["build", ["build"]],
  ]) {
    const result = await runCommand("pnpm", args, { cwd, env: gateEnv });
    gates[id] = {
      executed: true,
      outcome: result.code === 0 ? "success" : "failure",
      message: result.output.slice(-2000),
    };
  }
  return gates;
}

async function withCandidateApi({ cwd }, callback) {
  const child = spawn(
    "pnpm",
    ["--filter", "@game-cal/api", "exec", "tsx", "src/index.ts"],
    { cwd, env: scrubbedCandidateEnv(), stdio: ["ignore", "pipe", "pipe"] }
  );
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(chunk));
  child.stderr.on("data", (chunk) => logs.push(chunk));
  try {
    let healthy = false;
    for (let poll = 0; poll < 30; poll += 1) {
      try {
        const response = await fetch("http://127.0.0.1:8787/api/health", {
          signal: AbortSignal.timeout(3_000),
        });
        if (response.ok) {
          healthy = true;
          break;
        }
      } catch {
        // keep polling
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (!healthy) {
      throw new InfrastructureError(
        `candidate API did not become healthy: ${Buffer.concat(logs).toString("utf8").slice(-1500)}`
      );
    }
    return await callback("http://127.0.0.1:8787");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (child.exitCode == null) child.kill("SIGKILL");
  }
}

// ---------------------------------------------------------------------------
// Remediation execution.
// ---------------------------------------------------------------------------

async function publishCandidate({ client, deps, item, manifest, state, baseSha, attempt }) {
  const branch = item.fixInput.fix_branch;
  const commitSha = await deps.git(
    [
      "commit-tree",
      manifest.result_tree,
      "-p",
      baseSha,
      "-m",
      `fix: repair upstream findings (attempt ${attempt + 1})`,
    ],
    {
      env: {
        GIT_AUTHOR_NAME: "github-actions[bot]",
        GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
        GIT_COMMITTER_NAME: "github-actions[bot]",
        GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
      },
    }
  );
  assert(SHA40.test(commitSha), "git returned an invalid candidate commit");
  await deps.git(["push", "--force", deps.pushUrl, `${commitSha}:refs/heads/${branch}`]);

  const body = renderPullRequestBody({
    issueNumber: item.issue_number,
    fingerprint: item.fixInput.finding_fingerprint,
    state,
  });
  let prNumber = state.pr_number;
  let prUrl;
  if (prNumber) {
    const pr = await client.request(`/repos/${client.repository}/pulls/${prNumber}`);
    if (pr.state !== "open" || pr.head.ref !== branch) prNumber = null;
    else {
      await client.request(`/repos/${client.repository}/pulls/${prNumber}`, {
        method: "PATCH",
        body: { body },
      });
      prUrl = pr.html_url;
    }
  }
  if (!prNumber) {
    const created = await client.request(`/repos/${client.repository}/pulls`, {
      method: "POST",
      body: {
        title: "fix: repair confirmed upstream findings",
        head: branch,
        base: deps.defaultBranch,
        body,
        draft: true,
      },
    });
    prNumber = created.number;
    prUrl = created.html_url;
  }
  await client.request(`/repos/${client.repository}/statuses/${commitSha}`, {
    method: "POST",
    body: {
      state: "success",
      context: "upstream-agentic/validate",
      description: `Attempt ${attempt + 1} passed every trusted gate`,
      target_url: deps.runUrl,
    },
  });
  return { headSha: commitSha, prNumber, prUrl };
}

async function submitIndependentReview({ reviewClient, client, prNumber, headSha, event, body }) {
  const pr = await client.request(`/repos/${client.repository}/pulls/${prNumber}`);
  assert(pr.head.sha === headSha, "pull request head moved before review submission");
  const reviewer = await reviewClient.request("/user");
  assert(reviewer.login !== pr.user.login, "reviewer identity must differ from the PR author");
  await reviewClient.request(`/repos/${client.repository}/pulls/${prNumber}/reviews`, {
    method: "POST",
    body: { commit_id: headSha, event, body },
  });
}

async function armAutoMergeAndWait({ client, prNumber, headSha, waitSeconds = MERGE_POLL_SECONDS }) {
  const pr = await client.request(`/repos/${client.repository}/pulls/${prNumber}`);
  assert(pr.head.sha === headSha, "pull request head moved before merge");
  if (pr.draft) {
    const [owner, name] = client.repository.split("/");
    const data = await client.graphql(
      `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id}}}`,
      { owner, name, number: prNumber }
    );
    await client.graphql(
      `mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{number}}}`,
      { id: data.repository.pullRequest.id }
    );
  }
  const [owner, name] = client.repository.split("/");
  const node = await client.graphql(
    `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id}}}`,
    { owner, name, number: prNumber }
  );
  try {
    await client.graphql(
      `mutation($id:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:SQUASH}){pullRequest{number}}}`,
      { id: node.repository.pullRequest.id }
    );
  } catch (error) {
    // Auto-merge fails when the PR is already mergeable with all requirements
    // satisfied ("Pull request is in clean status"); fall through to polling
    // after attempting a direct squash merge.
    try {
      await client.request(`/repos/${client.repository}/pulls/${prNumber}/merge`, {
        method: "PUT",
        body: { merge_method: "squash", sha: headSha },
      });
    } catch {
      throw error;
    }
  }
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    const current = await client.request(`/repos/${client.repository}/pulls/${prNumber}`);
    if (current.merged_at) return { merged: true };
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  return { merged: false };
}

async function remediateIssue({ item, context, deps }) {
  const { client, reviewClient, budgets, baseSha, collectInput, report, workspace } = context;
  const state = item.state;
  const issueNumber = item.issue_number;
  const roundLog = [];
  const artifactsDir = path.join(workspace, "artifacts");
  await mkdir(artifactsDir, { recursive: true });

  await deps.git(["checkout", "--", "."], { cwd: workspace });
  await deps.git(["clean", "-fd", "--", "apps"], { cwd: workspace });

  if (!state.fix_branch) state.fix_branch = `codex/autopatch-i${issueNumber}`;

  const { fixInput, evidenceWarnings } = buildIssueFixInput({
    repository: client.repository,
    issueNumber,
    issueUrl: item.issue_url,
    marker: item.marker,
    state,
    baseSha,
    collectInput,
    generatedAt: report.generated_at ?? new Date().toISOString(),
  });
  item.fixInput = fixInput;
  for (const warning of evidenceWarnings) roundLog.push(`note: ${warning}`);

  // Recovery fast path: an already approved, validated head only needs merging.
  if (item.pull) {
    const recovered = await tryRecoverApprovedHead({ item, context, roundLog });
    if (recovered) return { outcome: "merged", roundLog };
  }

  let feedback = state.last_feedback;
  let outcome = "deferred";
  let roundsUsed = 0;
  while (true) {
    if (state.attempts_used >= state.max_attempts) {
      outcome = "blocked:code_attempt_budget_exhausted";
      break;
    }
    if (roundsUsed >= budgets.roundsPerRun) {
      outcome = "paused:round_budget";
      break;
    }
    if (Date.now() > context.deadlineAt) {
      outcome = "paused:deadline";
      break;
    }
    roundsUsed += 1;
    const attempt = state.attempts_used;
    const attemptInput = buildAttemptInput({
      repository: client.repository,
      fixInput,
      attempt,
      maxAttempts: state.max_attempts,
      baseSha,
      feedback,
    });
    await writeFile(
      path.join(artifactsDir, "upstream-agentic-attempt-input.json"),
      canonicalJson(attemptInput),
      "utf8"
    );

    const repairOutput = await deps.runCodexAgent({
      promptPath: path.join(workspace, ".github/prompts/upstream-agentic-repair.md"),
      schemaPath: path.join(workspace, ".github/schemas/upstream-agentic-repair-output.schema.json"),
      outputPath: path.join(artifactsDir, "upstream-agentic-repair-output.json"),
      sandbox: "workspace-write",
      cwd: workspace,
    });

    const candidateDir = await mkdtemp(path.join(os.tmpdir(), "autopatch-candidate-"));
    const manifest = await deps.createCandidate({
      attemptInput,
      agentOutput: repairOutput,
      outputDirectory: candidateDir,
    });
    state.attempts_used += 1;

    if (state.tree_history.includes(manifest.result_tree)) {
      state.status = "blocked";
      state.blocked_reason = "no_progress_tree_repeated";
      outcome = "blocked:no_progress_tree_repeated";
      roundLog.push(`attempt ${attempt + 1}: candidate repeats tree ${manifest.result_tree.slice(0, 12)}; no progress`);
      break;
    }
    state.tree_history = [...state.tree_history.slice(-11), manifest.result_tree];

    const gates = await deps.runTrustedGates({ cwd: workspace });
    const validation = classifyValidation({
      cycleId: attemptInput.cycle.cycle_id,
      attempt,
      gates,
      maxAttempts: state.max_attempts,
    });
    if (validation.disposition !== "review") {
      feedback = validation.feedback;
      state.last_feedback = feedback;
      const failedGates = validation.feedback.diagnostics.map((d) => d.id).join(", ");
      roundLog.push(`attempt ${attempt + 1}: trusted gates failed (${failedGates})`);
      if (validation.disposition === "blocked") {
        state.status = "blocked";
        state.blocked_reason = "code_attempt_budget_exhausted";
        outcome = "blocked:code_attempt_budget_exhausted";
        break;
      }
      continue;
    }

    const published = await deps.publishCandidate({
      client,
      deps,
      item,
      manifest,
      state,
      baseSha,
      attempt,
    });
    state.pr_number = published.prNumber;
    item.pr_url = published.prUrl;
    roundLog.push(
      `attempt ${attempt + 1}: published \`${published.headSha.slice(0, 12)}\` to PR #${published.prNumber}`
    );

    const reviewInput = buildReviewInput({
      fixInput,
      manifest,
      repository: client.repository,
      prNumber: published.prNumber,
      headSha: published.headSha,
    });
    await writeFile(
      path.join(artifactsDir, "upstream-agentic-review-input.json"),
      canonicalJson(reviewInput),
      "utf8"
    );
    const reviewOutput = await deps.runCodexAgent({
      promptPath: path.join(workspace, ".github/prompts/upstream-agentic-review.md"),
      schemaPath: path.join(workspace, ".github/schemas/upstream-agentic-review-output.schema.json"),
      outputPath: path.join(artifactsDir, "upstream-agentic-review-output.json"),
      sandbox: "read-only",
      cwd: workspace,
    });
    const reviewDecision = classifyReview({
      cycleId: attemptInput.cycle.cycle_id,
      attempt,
      headSha: published.headSha,
      review: reviewOutput,
      maxAttempts: state.max_attempts,
      expectedContextSha256: reviewInput.context_sha256,
      allowedFiles: reviewInput.changed_files,
    });

    if (reviewDecision.disposition !== "approved") {
      feedback = reviewDecision.feedback;
      state.last_feedback = feedback;
      await deps.submitIndependentReview({
        reviewClient,
        client,
        prNumber: published.prNumber,
        headSha: published.headSha,
        event: "REQUEST_CHANGES",
        body: renderFeedbackForReviewBody(reviewDecision.feedback),
      });
      roundLog.push(
        `attempt ${attempt + 1}: independent review requested changes (${reviewDecision.feedback.diagnostics.length} finding(s))`
      );
      if (reviewDecision.disposition === "blocked") {
        state.status = "blocked";
        state.blocked_reason = "code_attempt_budget_exhausted";
        outcome = "blocked:code_attempt_budget_exhausted";
        break;
      }
      continue;
    }

    const runtimeDecision = await deps.verifyRuntime({
      context,
      item,
      attemptInput,
      headSha: published.headSha,
      artifactsDir,
      workspace,
      state,
    });
    if (runtimeDecision.disposition !== "approved") {
      feedback = runtimeDecision.feedback;
      state.last_feedback = feedback;
      await deps.submitIndependentReview({
        reviewClient,
        client,
        prNumber: published.prNumber,
        headSha: published.headSha,
        event: "REQUEST_CHANGES",
        body: renderFeedbackForReviewBody(runtimeDecision.feedback),
      });
      roundLog.push(
        `attempt ${attempt + 1}: exact-head runtime replay left findings unresolved`
      );
      if (runtimeDecision.disposition === "blocked") {
        state.status = "blocked";
        state.blocked_reason = "code_attempt_budget_exhausted";
        outcome = "blocked:code_attempt_budget_exhausted";
        break;
      }
      continue;
    }

    await deps.submitIndependentReview({
      reviewClient,
      client,
      prNumber: published.prNumber,
      headSha: published.headSha,
      event: "APPROVE",
      body: `Automated independent review approved exact head \`${published.headSha}\`: trusted gates, agent review, and runtime replay all passed.`,
    });
    state.last_feedback = null;
    const mergeResult = await deps.armAutoMergeAndWait({
      client,
      prNumber: published.prNumber,
      headSha: published.headSha,
    });
    if (mergeResult.merged) {
      state.status = "resolved";
      roundLog.push(
        `attempt ${attempt + 1}: approved and merged \`${published.headSha.slice(0, 12)}\` ✅`
      );
      outcome = "merged";
      try {
        await client.request(
          `/repos/${client.repository}/git/refs/heads/${item.fixInput.fix_branch}`,
          { method: "DELETE" }
        );
      } catch {
        // branch deletion is cosmetic
      }
    } else {
      roundLog.push(
        `attempt ${attempt + 1}: approved \`${published.headSha.slice(0, 12)}\`; auto-merge armed but not yet merged`
      );
      outcome = "approved_pending_merge";
    }
    break;
  }

  return { outcome, roundLog };
}

async function tryRecoverApprovedHead({ item, context, roundLog }) {
  const { client, reviewClient } = context;
  const pull = item.pull;
  try {
    const reviewer = await reviewClient.request("/user");
    const reviews = await listPaginated(
      client,
      `/repos/${client.repository}/pulls/${pull.number}/reviews`
    );
    const approved = reviews.some(
      (review) =>
        review.user?.login === reviewer.login &&
        review.commit_id === pull.head.sha &&
        review.state === "APPROVED"
    );
    if (!approved) return false;
    const status = await client.request(
      `/repos/${client.repository}/commits/${pull.head.sha}/status`
    );
    const validated = (status.statuses ?? []).some(
      (entry) => entry.context === "upstream-agentic/validate" && entry.state === "success"
    );
    if (!validated) return false;
    const mergeResult = await context.deps.armAutoMergeAndWait({
      client,
      prNumber: pull.number,
      headSha: pull.head.sha,
    });
    if (mergeResult.merged) {
      item.state.status = "resolved";
      roundLog.push(`recovered previously approved head \`${pull.head.sha.slice(0, 12)}\` and merged ✅`);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function verifyRuntime({ context, item, attemptInput, headSha, artifactsDir, workspace, state }) {
  return withCandidateApi({ cwd: workspace }, async (apiBaseUrl) => {
    const runtimeInput = await buildRuntimeInput({
      fixInput: item.fixInput,
      cycleId: attemptInput.cycle.cycle_id,
      attempt: attemptInput.cycle.attempt,
      headSha,
      apiBaseUrl,
    });
    await writeFile(
      path.join(artifactsDir, "upstream-agentic-runtime-input.json"),
      canonicalJson(runtimeInput),
      "utf8"
    );
    const runtimeOutput = await context.deps.runCodexAgent({
      promptPath: path.join(workspace, ".github/prompts/upstream-agentic-runtime.md"),
      schemaPath: path.join(workspace, ".github/schemas/upstream-agentic-runtime-output.schema.json"),
      outputPath: path.join(artifactsDir, "upstream-agentic-runtime-output.json"),
      sandbox: "read-only",
      cwd: workspace,
    });
    return classifyRuntime({
      cycleId: attemptInput.cycle.cycle_id,
      attempt: attemptInput.cycle.attempt,
      headSha,
      runtime: runtimeOutput,
      runtimeInput,
      maxAttempts: state.max_attempts,
    });
  });
}

// ---------------------------------------------------------------------------
// Plan execution.
// ---------------------------------------------------------------------------

function renderRunComment({ runUrl, roundLog, outcome, state }) {
  const heading = {
    merged: "✅ Remediation merged",
    approved_pending_merge: "🟡 Approved; auto-merge armed",
    "paused:round_budget": "🔁 Paused after this run's round budget; resumes next scheduled run",
    "paused:deadline": "🔁 Paused at the run deadline; resumes next scheduled run",
  };
  const title = outcome.startsWith("blocked:")
    ? `🛑 Blocked (${outcome.slice("blocked:".length)}) — human attention required`
    : heading[outcome] ?? `Autopatch update (${outcome})`;
  return [
    `### ${title}`,
    "",
    ...roundLog.map((line) => `- ${line}`),
    "",
    `Attempt budget: ${state.attempts_used}/${state.max_attempts} used. [Workflow run](${runUrl})`,
  ].join("\n");
}

async function executePlan({ plan, context, deps }) {
  const { client } = context;
  const summary = [];
  for (const warning of plan.warnings) summary.push(`⚠️ ${warning}`);

  for (const action of plan.actions) {
    if (action.type === "close_orphan_pr") {
      try {
        await client.request(`/repos/${client.repository}/issues/${action.pr_number}/comments`, {
          method: "POST",
          body: {
            body: `Closing this autopatch pull request: ${action.reason}. A future run will open a fresh PR if the findings are confirmed again.`,
          },
        });
        await client.request(`/repos/${client.repository}/pulls/${action.pr_number}`, {
          method: "PATCH",
          body: { state: "closed" },
        });
        await client.request(`/repos/${client.repository}/git/refs/heads/${action.branch}`, {
          method: "DELETE",
        }).catch(() => {});
        summary.push(`🧹 closed orphan PR #${action.pr_number} (${action.reason})`);
      } catch (error) {
        summary.push(`⚠️ failed to close orphan PR #${action.pr_number}: ${error.message}`);
      }
      continue;
    }

    const issue = context.issuesByNumber.get(action.issue_number);
    if (!issue) continue;

    if (action.type === "skip") {
      summary.push(`⏸️ issue #${action.issue_number}: skipped (${action.reason})`);
      continue;
    }
    if (action.type === "wait" || action.type === "defer") {
      try {
        await saveIssueState(client, issue, action.state);
      } catch (error) {
        summary.push(`⚠️ issue #${action.issue_number}: failed to persist state: ${error.message}`);
      }
      summary.push(`⏭️ issue #${action.issue_number}: ${action.reason}`);
      continue;
    }
    if (action.type === "block") {
      action.state.status = "blocked";
      action.state.blocked_reason = action.reason;
      try {
        await client.request(`/repos/${client.repository}/issues/${action.issue_number}/labels`, {
          method: "POST",
          body: { labels: [BLOCKED_LABEL] },
        });
        await commentOnIssue(
          client,
          action.issue_number,
          `🛑 Autopatch exhausted its lifetime attempt budget (${action.state.attempts_used}/${action.state.max_attempts}) without an approved fix. Remove the \`${BLOCKED_LABEL}\` label and clear the state comment to retry, or fix manually. [Workflow run](${context.runUrl})`
        );
        await saveIssueState(client, issue, action.state);
      } catch (error) {
        summary.push(`⚠️ issue #${action.issue_number}: failed to record block: ${error.message}`);
      }
      summary.push(`🛑 issue #${action.issue_number}: blocked (${action.reason})`);
      continue;
    }
    if (action.type === "close_stale") {
      try {
        if (action.pr_number) {
          await client.request(`/repos/${client.repository}/issues/${action.pr_number}/comments`, {
            method: "POST",
            body: {
              body: `Closing: the findings tracked by #${action.issue_number} were not re-confirmed in ${action.misses} consecutive daily reviews.`,
            },
          });
          await client.request(`/repos/${client.repository}/pulls/${action.pr_number}`, {
            method: "PATCH",
            body: { state: "closed" },
          });
          if (action.branch) {
            await client
              .request(`/repos/${client.repository}/git/refs/heads/${action.branch}`, {
                method: "DELETE",
              })
              .catch(() => {});
          }
        }
        await commentOnIssue(
          client,
          action.issue_number,
          `Closing as stale: these findings were not re-confirmed in ${action.misses} consecutive daily upstream reviews. A future review will open a fresh issue if they reappear.`
        );
        await client.request(`/repos/${client.repository}/issues/${action.issue_number}`, {
          method: "PATCH",
          body: { state: "closed", state_reason: "not_planned" },
        });
        summary.push(`🧹 issue #${action.issue_number}: closed as stale after ${action.misses} misses`);
      } catch (error) {
        summary.push(`⚠️ issue #${action.issue_number}: stale close failed: ${error.message}`);
      }
      continue;
    }
    if (action.type === "remediate") {
      let result;
      try {
        result = await remediateIssue({ item: action, context, deps });
      } catch (error) {
        action.state.infra_failures += 1;
        const infraNote =
          action.state.infra_failures >= MAX_INFRA_FAILURES
            ? ` This is infrastructure failure ${action.state.infra_failures}; autopatch is blocking the issue until a human clears the \`${BLOCKED_LABEL}\` label.`
            : " The next scheduled run will retry; the code-attempt budget was not consumed.";
        if (action.state.infra_failures >= MAX_INFRA_FAILURES) {
          action.state.status = "blocked";
          action.state.blocked_reason = "infrastructure_retry_budget_exhausted";
          await client
            .request(`/repos/${client.repository}/issues/${action.issue_number}/labels`, {
              method: "POST",
              body: { labels: [BLOCKED_LABEL] },
            })
            .catch(() => {});
        }
        await commentOnIssue(
          client,
          action.issue_number,
          `⚠️ Autopatch attempt aborted (infrastructure): ${normalizeText(error.message, 600)}.${infraNote} [Workflow run](${context.runUrl})`
        ).catch(() => {});
        await saveIssueState(client, issue, action.state).catch(() => {});
        summary.push(`⚠️ issue #${action.issue_number}: infrastructure failure (${normalizeText(error.message, 200)})`);
        continue;
      }
      action.state.infra_failures = 0;
      if (result.outcome.startsWith("blocked:")) {
        await client
          .request(`/repos/${client.repository}/issues/${action.issue_number}/labels`, {
            method: "POST",
            body: { labels: [BLOCKED_LABEL] },
          })
          .catch(() => {});
      }
      try {
        await commentOnIssue(
          client,
          action.issue_number,
          renderRunComment({
            runUrl: context.runUrl,
            roundLog: result.roundLog,
            outcome: result.outcome,
            state: action.state,
          })
        );
        await saveIssueState(client, issue, action.state);
      } catch (error) {
        summary.push(`⚠️ issue #${action.issue_number}: failed to persist result: ${error.message}`);
      }
      summary.push(`issue #${action.issue_number}: ${result.outcome}`);
      continue;
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------------

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function appendSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`, "utf8");
}

async function run() {
  const repository = process.env.GITHUB_REPOSITORY;
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const token = process.env.GITHUB_TOKEN;
  const reviewToken = process.env.UPSTREAM_REVIEW_APPROVAL_TOKEN;
  assert(repository && token && reviewToken, "missing repository or GitHub tokens");
  const budgets = {
    roundsPerRun: parseBudget(process.env.AUTOPATCH_ROUNDS_PER_RUN, DEFAULT_ROUNDS_PER_RUN, 1, 4),
    lifetimeAttempts: parseBudget(
      process.env.AUTOPATCH_LIFETIME_ATTEMPTS,
      DEFAULT_LIFETIME_ATTEMPTS,
      1,
      8
    ),
    issuesPerRun: parseBudget(process.env.AUTOPATCH_ISSUES_PER_RUN, DEFAULT_ISSUES_PER_RUN, 1, 6),
    staleMissLimit: parseBudget(
      process.env.AUTOPATCH_STALE_MISS_LIMIT,
      DEFAULT_STALE_MISS_LIMIT,
      1,
      10
    ),
    deadlineMinutes: parseBudget(
      process.env.AUTOPATCH_DEADLINE_MINUTES,
      DEFAULT_DEADLINE_MINUTES,
      10,
      300
    ),
  };

  const report = await readJson(process.env.AUTOPATCH_REPORT_PATH);
  const collectInput = await readJson(process.env.AUTOPATCH_COLLECT_INPUT_PATH);
  const baseSha = await git(["rev-parse", "HEAD"], { cwd: workspace });
  assert(SHA40.test(baseSha), "workspace HEAD is not a valid commit");
  await appendFile(path.join(workspace, ".git/info/exclude"), "artifacts/\n", "utf8");

  const client = createGithubClient({ repository, token });
  const reviewClient = createGithubClient({ repository, token: reviewToken });
  await ensureLabels(client);

  const issues = await loadOpenManagedIssues(client);
  const pulls = await listPaginated(client, `/repos/${repository}/pulls?state=open`);
  const plan = planReconciliation({
    issues,
    pulls,
    report,
    budgets,
    warnings: [],
  });

  const runUrl = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}`;
  const context = {
    client,
    reviewClient,
    budgets,
    baseSha,
    collectInput,
    report,
    workspace,
    runUrl,
    deadlineAt: Date.now() + budgets.deadlineMinutes * 60 * 1000,
    issuesByNumber: new Map(issues.map((issue) => [issue.number, issue])),
    roundsUsed: 0,
  };
  const deps = {
    git: (args, options = {}) => git(args, { cwd: workspace, ...options }),
    runCodexAgent,
    createCandidate: (options) => createCandidate(options),
    runTrustedGates,
    publishCandidate,
    submitIndependentReview,
    armAutoMergeAndWait,
    verifyRuntime,
    pushUrl: `https://x-access-token:${token}@github.com/${repository}.git`,
    defaultBranch: process.env.AUTOPATCH_DEFAULT_BRANCH || "main",
    runUrl,
  };
  context.deps = deps;

  const summary = await executePlan({ plan, context, deps });
  const lines = [
    "## Upstream autopatch",
    "",
    ...(summary.length > 0 ? summary.map((line) => `- ${line}`) : ["- no open remediation work"]),
  ];
  console.log(lines.join("\n"));
  await appendSummary(lines);
}

async function cli() {
  const command = process.argv[2];
  if (command === "run") {
    await run();
    return;
  }
  throw new Error(`Unknown upstream-autopatch command: ${command || "<empty>"}`);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  cli().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  buildAttemptInput,
  buildIssueFixInput,
  createIssueState,
  executePlan,
  groupConfirmedFindingsByIssue,
  parseIssueMarker,
  parsePrIssueNumber,
  parseStateComment,
  planReconciliation,
  remediateIssue,
  renderFeedbackForReviewBody,
  renderPullRequestBody,
  renderRunComment,
  renderStateComment,
  scrubbedAgentEnv,
  scrubbedCandidateEnv,
  selectEvidenceTolerant,
  validateIssueState,
};
