import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { canonicalJson, createCycle, sha256 } from "./upstream-agentic-state.mjs";

const execFileAsync = promisify(execFile);
const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const BRANCH = /^codex\/[A-Za-z0-9._/-]+$/;

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

function validateFixInput(input) {
  assert(isObject(input), "fix input must be an object");
  assert(input.schema_version === 2 || input.schema_version === 3, "unsupported fix input schema");
  assert(input.mode === "agentic_fix", "invalid fix input mode");
  assert(isObject(input.source_report), "fix input source report is missing");
  assert(SHA40.test(input.source_report.base_sha), "invalid fix input base SHA");
  assert(SHA64.test(input.source_report.remediation_cycle), "invalid remediation cycle");
  assert(Number.isInteger(input.source_report.issue_number) && input.source_report.issue_number > 0, "invalid Issue number");
  assert(SHA64.test(input.finding_fingerprint), "invalid finding fingerprint");
  assert(BRANCH.test(input.fix_branch), "invalid fix branch");
  assert(Array.isArray(input.findings) && input.findings.length > 0, "fix input has no findings");
  assert(Array.isArray(input.allowed_files) && input.allowed_files.length > 0, "fix input has no allowed files");
  assert(input.allowed_files.length <= 8, "fix input allows too many files");
  for (const file of input.allowed_files) {
    assert(
      /^apps\/api\/src\/games\/(genshin|starrail|ww|zzz|snowbreak|endfield|parser-regressions\.agent\.test)\.ts$/.test(file),
      `disallowed automatic repair path: ${file}`
    );
  }
  return input;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, canonicalJson(value), "utf8");
}

async function appendOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  const content = Object.entries(values)
    .map(([key, value]) => `${key}=${String(value)}\n`)
    .join("");
  await writeFile(process.env.GITHUB_OUTPUT, content, { encoding: "utf8", flag: "a" });
}

async function git(args, options = {}) {
  const result = await execFileAsync("git", args, {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...(options.env ?? {}) },
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function gitRaw(args, options = {}) {
  const result = await execFileAsync("git", args, {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...(options.env ?? {}) },
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout;
}

async function prepareAttempt({
  fixInput,
  repository,
  attempt,
  maxAttempts,
  startSha,
  feedback = null,
}) {
  validateFixInput(fixInput);
  assert(SHA40.test(startSha), "invalid attempt start SHA");
  assert(Number.isInteger(attempt) && attempt >= 0 && attempt < maxAttempts, "invalid attempt number");
  if (attempt === 0) assert(feedback === null, "initial attempt cannot contain repair feedback");
  if (attempt > 0) {
    assert(isObject(feedback), "revision attempt requires feedback");
    assert(feedback.retryable === true, "revision feedback is not retryable");
    assert(feedback.attempt === attempt - 1, "revision feedback is from the wrong attempt");
  }

  const cycle = createCycle({
    repository,
    baseSha: fixInput.source_report.base_sha,
    findingFingerprint: fixInput.finding_fingerprint,
    remediationCycle: fixInput.source_report.remediation_cycle,
    issueNumber: fixInput.source_report.issue_number,
    fixBranch: fixInput.fix_branch,
    maxCodeAttempts: maxAttempts,
  });
  if (feedback) assert(feedback.cycle_id === cycle.cycle_id, "feedback belongs to another cycle");

  const input = {
    schema_version: 1,
    mode: "upstream_remediation_attempt",
    cycle: {
      cycle_id: cycle.cycle_id,
      attempt,
      max_attempts: maxAttempts,
      base_sha: cycle.base_sha,
      start_sha: startSha,
      issue_number: cycle.issue_number,
      fix_branch: cycle.fix_branch,
      finding_fingerprint: cycle.finding_fingerprint,
    },
    allowed_files: [...fixInput.allowed_files].sort(),
    findings: fixInput.findings,
    evidence: fixInput.evidence ?? [],
    feedback,
  };
  return { cycle, input: { ...input, context_sha256: sha256(input) } };
}

function validateAgentOutput(output, attemptInput) {
  assert(isObject(output), "agent output must be an object");
  const expected = ["changed_files", "complete", "errors", "summary"];
  assert(
    JSON.stringify(Object.keys(output).sort()) === JSON.stringify(expected),
    "agent output has unexpected fields"
  );
  assert(output.complete === true, "agent did not complete the repair");
  assert(Array.isArray(output.errors) && output.errors.length === 0, "agent reported repair errors");
  assert(Array.isArray(output.changed_files), "agent changed_files must be an array");
  assert(output.changed_files.length > 0 && output.changed_files.length <= 8, "agent changed_files is empty or too large");
  const unique = [...new Set(output.changed_files)].sort();
  assert(unique.length === output.changed_files.length, "agent changed_files contains duplicates");
  assert(unique.every((file) => attemptInput.allowed_files.includes(file)), "agent reported a disallowed path");
  return { ...output, summary: normalizeText(output.summary), changed_files: unique };
}

async function createCandidate({ attemptInput, agentOutput, outputDirectory }) {
  agentOutput = validateAgentOutput(agentOutput, attemptInput);
  const { base_sha: baseSha, start_sha: startSha, attempt, cycle_id: cycleId } = attemptInput.cycle;
  assert((await git(["rev-parse", "HEAD"])) === startSha, "workspace is not at the trusted attempt start SHA");

  const status = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
  const statusLines = status ? status.split("\n") : [];
  assert(statusLines.length > 0, "agent produced no tracked change");
  for (const line of statusLines) {
    const code = line.slice(0, 2);
    const file = line.slice(3);
    assert(code !== "??", `agent created an untracked file: ${file}`);
    assert(!/[DRTUC]/.test(code), `agent used a forbidden change type ${code}: ${file}`);
  }

  const incrementalFiles = (await git(["diff", "--name-only", startSha, "--"])).split("\n").filter(Boolean).sort();
  const cumulativeFiles = (await git(["diff", "--name-only", baseSha, "--"])).split("\n").filter(Boolean).sort();
  assert(incrementalFiles.length > 0, "agent produced no incremental patch");
  assert(cumulativeFiles.length > 0, "candidate contains no cumulative patch");
  assert(
    incrementalFiles.every((file) => attemptInput.allowed_files.includes(file)) &&
      cumulativeFiles.every((file) => attemptInput.allowed_files.includes(file)),
    "candidate patch escapes the allowed file policy"
  );
  assert(
    JSON.stringify(incrementalFiles) === JSON.stringify(agentOutput.changed_files),
    "agent changed_files does not match the tracked incremental diff"
  );
  await git(["diff", "--check", startSha, "--"]);
  const structuralChanges = await git(["diff", "--summary", startSha, "--"]);
  assert(structuralChanges === "", "candidate changes a file type, mode, or path");

  const agentTestFile = "apps/api/src/games/parser-regressions.agent.test.ts";
  const changesParser = cumulativeFiles.some(
    (file) => file.startsWith("apps/api/src/games/") && file !== agentTestFile
  );
  if (changesParser && attemptInput.allowed_files.includes(agentTestFile)) {
    assert(
      cumulativeFiles.includes(agentTestFile),
      "parser candidate must include its allowed agent regression test"
    );
  }

  const incrementalPatch = await gitRaw(["diff", "--binary", "--full-index", startSha, "--"]);
  const cumulativePatch = await gitRaw(["diff", "--binary", "--full-index", baseSha, "--"]);
  assert(Buffer.byteLength(cumulativePatch) <= 512 * 1024, "candidate patch exceeds 512 KiB");

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "upstream-agentic-index-"));
  const temporaryIndex = path.join(temporaryDirectory, "index");
  const indexEnvironment = { GIT_INDEX_FILE: temporaryIndex };
  await git(["read-tree", startSha], { env: indexEnvironment });
  await git(["add", "--", ...incrementalFiles], { env: indexEnvironment });
  const resultTree = await git(["write-tree"], { env: indexEnvironment });
  assert(SHA40.test(resultTree), "git returned an invalid candidate tree");

  const manifest = {
    schema_version: 1,
    cycle_id: cycleId,
    attempt,
    base_sha: baseSha,
    start_sha: startSha,
    result_tree: resultTree,
    context_sha256: attemptInput.context_sha256,
    changed_files: cumulativeFiles,
    incremental_files: incrementalFiles,
    incremental_patch_sha256: sha256(incrementalPatch),
    cumulative_patch_sha256: sha256(cumulativePatch),
    agent_output_sha256: sha256(agentOutput),
  };

  await writeFile(path.join(outputDirectory, "incremental.patch"), incrementalPatch, "utf8");
  await writeFile(path.join(outputDirectory, "cumulative.patch"), cumulativePatch, "utf8");
  await writeJson(path.join(outputDirectory, "attempt-input.json"), attemptInput);
  await writeJson(path.join(outputDirectory, "agent-output.json"), agentOutput);
  await writeJson(path.join(outputDirectory, "manifest.json"), manifest);
  return manifest;
}

function buildReviewInput({ fixInput, manifest, repository, prNumber, headSha }) {
  validateFixInput(fixInput);
  assert(manifest.cycle_id && SHA64.test(manifest.cycle_id), "invalid candidate cycle id");
  assert(SHA40.test(headSha), "invalid review head SHA");
  assert(Number.isInteger(prNumber) && prNumber > 0, "invalid review PR number");
  assert(manifest.result_tree && SHA40.test(manifest.result_tree), "invalid candidate tree");
  const context = {
    schema_version: 1,
    mode: "upstream_remediation_review",
    cycle_id: manifest.cycle_id,
    attempt: manifest.attempt,
    repository,
    pr_number: prNumber,
    base_sha: manifest.base_sha,
    head_sha: headSha,
    result_tree: manifest.result_tree,
    finding_fingerprint: fixInput.finding_fingerprint,
    changed_files: manifest.changed_files,
    findings: fixInput.findings,
  };
  return { ...context, context_sha256: sha256(context) };
}

async function buildRuntimeInput({ fixInput, cycleId, attempt, headSha, apiBaseUrl }) {
  validateFixInput(fixInput);
  assert(SHA64.test(cycleId), "invalid runtime cycle id");
  assert(Number.isInteger(attempt) && attempt >= 0, "invalid runtime attempt");
  assert(SHA40.test(headSha), "invalid runtime head SHA");
  assert(/^https?:\/\//.test(apiBaseUrl), "invalid runtime API base URL");
  assert(Array.isArray(fixInput.target_games) && fixInput.target_games.length > 0, "runtime target games are missing");

  const candidateDatasets = [];
  for (const game of fixInput.target_games) {
    assert(/^(genshin|starrail|ww|zzz|snowbreak|endfield)$/.test(game), `invalid runtime game: ${game}`);
    const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/events?game=${encodeURIComponent(game)}`, {
      signal: AbortSignal.timeout(20_000),
      headers: { "user-agent": "game-cal-upstream-agentic-runtime/1" },
    });
    assert(response.ok, `candidate API failed for ${game}: HTTP ${response.status}`);
    const payload = await response.json();
    assert(isObject(payload) && Array.isArray(payload.data), `candidate API returned invalid ${game} data`);
    assert(payload.data.length <= 500, `candidate API returned too many ${game} events`);
    assert(
      Buffer.byteLength(JSON.stringify(payload.data)) <= 512 * 1024,
      `candidate API returned an oversized ${game} dataset`
    );
    candidateDatasets.push({ game, events: payload.data });
  }

  const context = {
    schema_version: 1,
    mode: "upstream_remediation_runtime",
    cycle_id: cycleId,
    attempt,
    base_sha: fixInput.source_report.base_sha,
    head_sha: headSha,
    finding_fingerprint: fixInput.finding_fingerprint,
    findings: fixInput.findings,
    original_evidence: fixInput.evidence ?? [],
    candidate_datasets: candidateDatasets,
  };
  assert(Buffer.byteLength(canonicalJson(context)) <= 1536 * 1024, "runtime context exceeds 1.5 MiB");
  return { ...context, context_sha256: sha256(context) };
}

function renderPrBody({ fixInput, cycleId, maxAttempts }) {
  validateFixInput(fixInput);
  return [
    "## Automated upstream remediation",
    "",
    `- Remediation Issue: #${fixInput.source_report.issue_number}`,
    `- Cycle: \`${cycleId}\``,
    `- Finding fingerprint: \`${fixInput.finding_fingerprint}\``,
    `- Maximum code attempts: ${maxAttempts}`,
    "",
    "This pull request is maintained by the bounded upstream agentic workflow.",
    "Each pushed head is revalidated and independently reviewed. Stale approvals must not be reused.",
    "",
    `Closes #${fixInput.source_report.issue_number}`,
    "",
    `<!-- upstream-agentic-cycle:${cycleId} -->`,
  ].join("\n");
}

async function cli() {
  const command = process.argv[2];
  if (command === "prepare-attempt") {
    const fixInput = await readJson(process.env.AGENTIC_FIX_INPUT_PATH);
    const feedback = process.env.AGENTIC_FEEDBACK_PATH
      ? await readJson(process.env.AGENTIC_FEEDBACK_PATH)
      : null;
    const result = await prepareAttempt({
      fixInput,
      repository: process.env.GITHUB_REPOSITORY,
      attempt: Number(process.env.AGENTIC_ATTEMPT),
      maxAttempts: Number(process.env.AGENTIC_MAX_ATTEMPTS),
      startSha: process.env.AGENTIC_START_SHA,
      feedback,
    });
    await writeJson(process.env.AGENTIC_ATTEMPT_INPUT_PATH, result.input);
    await writeJson(process.env.AGENTIC_CYCLE_PATH, result.cycle);
    await appendOutputs({ cycle_id: result.cycle.cycle_id });
    return;
  }
  if (command === "finalize-candidate") {
    const attemptInput = await readJson(process.env.AGENTIC_ATTEMPT_INPUT_PATH);
    const agentOutput = await readJson(process.env.AGENTIC_AGENT_OUTPUT_PATH);
    const manifest = await createCandidate({
      attemptInput,
      agentOutput,
      outputDirectory: process.env.AGENTIC_CANDIDATE_DIRECTORY,
    });
    await appendOutputs({ result_tree: manifest.result_tree });
    return;
  }
  if (command === "prepare-review") {
    const fixInput = await readJson(process.env.AGENTIC_FIX_INPUT_PATH);
    const manifest = await readJson(process.env.AGENTIC_MANIFEST_PATH);
    const input = buildReviewInput({
      fixInput,
      manifest,
      repository: process.env.GITHUB_REPOSITORY,
      prNumber: Number(process.env.AGENTIC_PR_NUMBER),
      headSha: process.env.AGENTIC_HEAD_SHA,
    });
    await writeJson(process.env.AGENTIC_REVIEW_INPUT_PATH, input);
    await appendOutputs({ context_sha256: input.context_sha256, cycle_id: input.cycle_id });
    return;
  }
  if (command === "render-pr-body") {
    const fixInput = await readJson(process.env.AGENTIC_FIX_INPUT_PATH);
    const body = renderPrBody({
      fixInput,
      cycleId: process.env.AGENTIC_CYCLE_ID,
      maxAttempts: Number(process.env.AGENTIC_MAX_ATTEMPTS),
    });
    await writeFile(process.env.AGENTIC_PR_BODY_PATH, `${body}\n`, "utf8");
    return;
  }
  if (command === "prepare-runtime") {
    const fixInput = await readJson(process.env.AGENTIC_FIX_INPUT_PATH);
    const input = await buildRuntimeInput({
      fixInput,
      cycleId: process.env.AGENTIC_CYCLE_ID,
      attempt: Number(process.env.AGENTIC_ATTEMPT),
      headSha: process.env.AGENTIC_HEAD_SHA,
      apiBaseUrl: process.env.AGENTIC_API_BASE_URL,
    });
    await writeJson(process.env.AGENTIC_RUNTIME_INPUT_PATH, input);
    await appendOutputs({ context_sha256: input.context_sha256 });
    return;
  }
  throw new Error(`Unknown upstream-agentic-artifact command: ${command || "<empty>"}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  cli().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  buildReviewInput,
  buildRuntimeInput,
  createCandidate,
  prepareAttempt,
  renderPrBody,
  validateAgentOutput,
  validateFixInput,
};
