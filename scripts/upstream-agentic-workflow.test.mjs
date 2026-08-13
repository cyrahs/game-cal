import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const autopatchPath = new URL("../.github/workflows/upstream-autopatch.yml", import.meta.url);
const pullRequestGatePath = new URL(
  "../.github/workflows/upstream-agentic-pr-gate.yml",
  import.meta.url
);
const runtimePromptPath = new URL(
  "../.github/prompts/upstream-agentic-runtime.md",
  import.meta.url
);

test("the retired v2 chain and reusable attempt workflow are gone", () => {
  for (const retired of [
    "../.github/workflows/upstream-review-v2.yml",
    "../.github/workflows/upstream-agentic-attempt.yml",
  ]) {
    assert.equal(
      existsSync(fileURLToPath(new URL(retired, import.meta.url))),
      false,
      `${retired} must not exist`
    );
  }
});

test("autopatch runs daily, accepts manual budgets, and resolves them exactly once", async () => {
  const workflow = await readFile(autopatchPath, "utf8");
  assert.match(workflow, /^name: Upstream Autopatch$/m);
  assert.match(workflow, /schedule:\n    - cron: "0 9 \* \* \*"/);
  assert.match(workflow, /timezone: "America\/Los_Angeles"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /concurrency:\n  group: upstream-autopatch\n  cancel-in-progress: false/);
  // Budgets resolve in one place with schedule-safe fallbacks; the
  // fromJSON(inputs...) pattern broke scheduled runs before (#50).
  assert.match(workflow, /AUTOPATCH_ROUNDS_PER_RUN: \$\{\{ inputs\.rounds_per_run \|\| '3' \}\}/);
  assert.match(workflow, /AUTOPATCH_ISSUES_PER_RUN: \$\{\{ inputs\.issues_per_run \|\| '2' \}\}/);
  assert.doesNotMatch(workflow, /fromJSON\(inputs/);
  // The copied attempt chain is replaced by one reconciling remediate job.
  assert.doesNotMatch(workflow, /attempt_\d|resolve_terminal|terminal_guard|rework_round_/);
  assert.match(workflow, /^  remediate:$/m);
  assert.match(workflow, /node scripts\/upstream-autopatch\.mjs run/);
});

test("preflight keeps hard identity checks but degrades protection drift to warnings", async () => {
  const workflow = await readFile(autopatchPath, "utf8");
  const preflightStart = workflow.indexOf("\n  preflight:\n");
  const collectStart = workflow.indexOf("\n  collect:\n", preflightStart);
  const preflight = workflow.slice(preflightStart, collectStart);
  assert.match(preflight, /gh api user --jq \.login/);
  assert.match(preflight, /must use an independent reviewer identity/);
  assert.match(preflight, /collaborators\/\$reviewer\/permission/);
  assert.match(preflight, /admin\|maintain\|write/);
  assert.match(preflight, /::warning::Default branch protection does not require/);
  assert.doesNotMatch(preflight, /Default branch moved during preflight/);
});

test("discovery and confirmation model jobs stay read-only and secret-minimal", async () => {
  const workflow = await readFile(autopatchPath, "utf8");
  for (const job of ["discover", "confirm"]) {
    const start = workflow.indexOf(`\n  ${job}:\n`);
    assert.ok(start > 0, `missing job ${job}`);
    const body = workflow.slice(start, workflow.indexOf("\n  sync_findings:\n"));
    assert.match(body, /permission-profile: ":read-only"/);
  }
  assert.doesNotMatch(
    workflow.slice(workflow.indexOf("\n  discover:\n"), workflow.indexOf("\n  sync_findings:\n")),
    /UPSTREAM_REVIEW_APPROVAL_TOKEN|contents: write|pull-requests: write/
  );
});

test("sync_findings runs even without candidates and owns the only issues write before remediation", async () => {
  const workflow = await readFile(autopatchPath, "utf8");
  const start = workflow.indexOf("\n  sync_findings:\n");
  const end = workflow.indexOf("\n  remediate:\n", start);
  const sync = workflow.slice(start, end);
  assert.match(sync, /always\(\)/);
  assert.match(sync, /has_candidates == 'false' \|\|/);
  assert.match(sync, /issues: write/);
  assert.match(sync, /--finalize-confirmation/);
  assert.match(sync, /name: upstream-autopatch-report/);
});

test("remediate reconciles on every successful sync, with pinned codex and no sudo", async () => {
  const workflow = await readFile(autopatchPath, "utf8");
  const start = workflow.indexOf("\n  remediate:\n");
  const remediate = workflow.slice(start);
  assert.match(remediate, /if: always\(\) && needs\.sync_findings\.result == 'success'/);
  assert.match(remediate, /contents: write/);
  assert.match(remediate, /pull-requests: write/);
  assert.match(remediate, /statuses: write/);
  assert.match(remediate, /npm install -g @openai\/codex@0\.145\.0/);
  assert.match(remediate, /Drop sudo before running model agents/);
  assert.match(remediate, /refusing to run model agents/);
  assert.match(remediate, /persist-credentials: false/);
  assert.match(remediate, /UPSTREAM_REVIEW_APPROVAL_TOKEN: \$\{\{ secrets\.UPSTREAM_REVIEW_APPROVAL_TOKEN \}\}/);
  const dropSudoIndex = remediate.indexOf("Drop sudo before running model agents");
  const driverIndex = remediate.indexOf("node scripts/upstream-autopatch.mjs run");
  assert.ok(dropSudoIndex >= 0 && driverIndex > dropSudoIndex, "sudo must be dropped before the driver runs");
});

test("the agent sandbox is prepared and proven before sudo is dropped", async () => {
  const workflow = await readFile(autopatchPath, "utf8");
  const remediate = workflow.slice(workflow.indexOf("\n  remediate:\n"));
  // Ubuntu 24.04+ denies CAP_NET_ADMIN in unprivileged user namespaces, which
  // breaks every bubblewrap-sandboxed agent command; both fixes need root.
  const prepareIndex = remediate.indexOf("Prepare the agent sandbox");
  const verifyIndex = remediate.indexOf("Verify the agent sandbox actually isolates");
  const dropSudoIndex = remediate.indexOf("Drop sudo before running model agents");
  assert.ok(prepareIndex >= 0, "sandbox preparation step is missing");
  assert.ok(verifyIndex > prepareIndex, "sandbox verification must follow preparation");
  assert.ok(dropSudoIndex > verifyIndex, "sandbox must be prepared and verified before sudo is dropped");
  assert.match(remediate, /apt-get install -y --no-install-recommends bubblewrap/);
  assert.match(remediate, /sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0/);
  assert.match(remediate, /bwrap --ro-bind \/ \/ --dev \/dev --unshare-all --die-with-parent true/);
  assert.match(remediate, /cannot create an isolated namespace on this runner/);
});

test("runtime verifier is explicitly allowed to read its exact-head input", async () => {
  const prompt = await readFile(runtimePromptPath, "utf8");
  assert.match(prompt, /must read this file before deciding\s+the verdict/i);
  assert.match(prompt, /as many read-only `jq` commands as needed/);
  assert.match(prompt, /Do not rely on one\s+full-file display because command output may be truncated/);
  assert.match(prompt, /\.context_sha256, \.findings\[\]/);
  assert.match(prompt, /\.candidate_datasets\[\]/);
  assert.match(prompt, /\.original_evidence\[\]/);
  assert.doesNotMatch(prompt, /Do not use the network, modify\s+files, run commands/);
});

test("review prompt describes the driver workspace truthfully", async () => {
  const prompt = await readFile(
    new URL("../.github/prompts/upstream-agentic-review.md", import.meta.url),
    "utf8"
  );
  assert.match(prompt, /`HEAD` is `base_sha`/);
  assert.match(prompt, /applied as uncommitted changes/);
});

test("every pull request into main receives the required validation context", async () => {
  const workflow = await readFile(pullRequestGatePath, "utf8");
  assert.match(workflow, /^name: Upstream Agentic Validation Gate$/m);
  assert.match(workflow, /^  pull_request:$/m);
  assert.match(workflow, /branches:\n      - main/);
  assert.match(workflow, /^    name: upstream-agentic\/validate$/m);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  for (const command of [
    "pnpm install --frozen-lockfile",
    "pnpm test:upstream-review",
    "pnpm test:game-parsers",
    "pnpm typecheck",
    "pnpm build",
  ]) {
    assert.ok(workflow.includes(command), `missing PR gate command: ${command}`);
  }
  assert.doesNotMatch(workflow, /secrets\.|contents: write|pull-requests: write/);
});
