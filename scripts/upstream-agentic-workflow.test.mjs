import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainPath = new URL("../.github/workflows/upstream-review-v2.yml", import.meta.url);
const attemptPath = new URL("../.github/workflows/upstream-agentic-attempt.yml", import.meta.url);
const pullRequestGatePath = new URL(
  "../.github/workflows/upstream-agentic-pr-gate.yml",
  import.meta.url
);
const runtimePromptPath = new URL(
  "../.github/prompts/upstream-agentic-runtime.md",
  import.meta.url
);
const archiveMainPath = new URL(
  "../.github/workflow-archive/upstream-review.v1.yml.disabled",
  import.meta.url
);
const archiveReworkPath = new URL(
  "../.github/workflow-archive/upstream-review-pr-rework.v1.yml.disabled",
  import.meta.url
);

test("v1 workflows are archived outside GitHub's active workflow directory", async () => {
  const [archivedMain, archivedRework] = await Promise.all([
    readFile(archiveMainPath, "utf8"),
    readFile(archiveReworkPath, "utf8"),
  ]);
  assert.match(archivedMain, /^name: Upstream Review$/m);
  assert.match(archivedRework, /^name: Upstream Review PR Rework Round$/m);
  assert.equal(archiveMainPath.pathname.includes("/.github/workflows/"), false);
  assert.equal(archiveReworkPath.pathname.includes("/.github/workflows/"), false);
});

test("v2 exposes one bounded four-slot loop instead of copied rework jobs", async () => {
  const workflow = await readFile(mainPath, "utf8");
  assert.match(workflow, /^name: Upstream Agentic Review v2$/m);
  assert.match(workflow, /max_code_attempts:/);
  for (const attempt of [0, 1, 2, 3]) {
    assert.match(workflow, new RegExp(`^  attempt_${attempt}:$`, "m"));
    assert.match(workflow, new RegExp(`attempt: ${attempt}`));
  }
  assert.equal(workflow.match(/uses: \.\/\.github\/workflows\/upstream-agentic-attempt\.yml/g)?.length, 4);
  assert.doesNotMatch(workflow, /rework_round_/);
  assert.match(workflow, /^  resolve_terminal:$/m);
  assert.match(workflow, /^  terminal_guard:$/m);
});

test("preflight checks reviewer role without requiring token contents write or protected reviews", async () => {
  const workflow = await readFile(mainPath, "utf8");
  const preflightStart = workflow.indexOf("\n  preflight:\n");
  const collectStart = workflow.indexOf("\n  collect:\n", preflightStart);
  const preflight = workflow.slice(preflightStart, collectStart);
  assert.match(preflight, /collaborators\/\$reviewer\/permission/);
  assert.match(preflight, /admin\|maintain\|write/);
  assert.doesNotMatch(preflight, /\.permissions\.push/);
  assert.doesNotMatch(preflight, /required_pull_request_reviews/);
  assert.doesNotMatch(preflight, /allow_squash_merge|allow_auto_merge/);
  assert.match(preflight, /has insufficient repository role/);
  assert.match(preflight, /Default branch protection does not satisfy/);
  assert.match(preflight, /Default branch moved during preflight/);
});

test("every expected code failure becomes structured feedback", async () => {
  const workflow = await readFile(attemptPath, "utf8");
  assert.match(workflow, /classify-validation/);
  assert.match(workflow, /classify-review/);
  assert.match(workflow, /classify-runtime/);
  assert.match(workflow, /upstream-agentic-feedback-\$\{\{ inputs\.attempt \}\}/);
  assert.match(workflow, /needs\.validate\.outputs\.disposition/);
  assert.match(workflow, /needs\.review\.outputs\.disposition/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /Attempt did not reach an explicit terminal or retry state/);
});

test("validation cannot be skipped and still publish a candidate", async () => {
  const workflow = await readFile(attemptPath, "utf8");
  const validateStart = workflow.indexOf("\n  validate:\n");
  const publishStart = workflow.indexOf("\n  publish:\n", validateStart);
  const reviewStart = workflow.indexOf("\n  review:\n", publishStart);
  const validate = workflow.slice(validateStart, publishStart);
  const publish = workflow.slice(publishStart, reviewStart);
  for (const gate of ["safeguards", "parsers", "typecheck", "build"]) {
    assert.match(validate, new RegExp(`id: ${gate}`));
    assert.match(validate, new RegExp(`${gate}: \\{executed: true, outcome:`));
  }
  assert.match(publish, /if: needs\.validate\.outputs\.disposition == 'review'/);
  assert.match(publish, /upstream-agentic\/validate/);
  assert.match(publish, /result_tree/);
});

test("publishing a replacement head tolerates bounded GitHub API propagation", async () => {
  const workflow = await readFile(attemptPath, "utf8");
  const publishStart = workflow.indexOf("\n  publish:\n");
  const reviewStart = workflow.indexOf("\n  review:\n", publishStart);
  const publish = workflow.slice(publishStart, reviewStart);
  assert.match(publish, /for poll in \$\(seq 1 15\)/);
  assert.match(publish, /\.state == "open" and \.head\.ref == \$branch/);
  assert.match(publish, /\.head\.sha == \$head/);
  assert.match(publish, /test "\$head_visible" = true/);
});

test("model jobs never receive GitHub write credentials", async () => {
  const workflow = await readFile(attemptPath, "utf8");
  const repairStart = workflow.indexOf("\n  repair:\n");
  const validateStart = workflow.indexOf("\n  validate:\n", repairStart);
  const reviewStart = workflow.indexOf("\n  review:\n");
  const runtimeStart = workflow.indexOf("\n  runtime:\n", reviewStart);
  const submitStart = workflow.indexOf("\n  submit_review:\n", runtimeStart);
  const repair = workflow.slice(repairStart, validateStart);
  const review = workflow.slice(reviewStart, runtimeStart);
  const runtime = workflow.slice(runtimeStart, submitStart);
  for (const job of [repair, review, runtime]) {
    assert.match(job, /contents: read/);
    assert.doesNotMatch(job, /contents: write|pull-requests: write|UPSTREAM_REVIEW_APPROVAL_TOKEN/);
  }
  assert.match(repair, /permission-profile: ":workspace"/);
  assert.doesNotMatch(repair, /permission-profile: workspace-write/);
  assert.match(review, /permission-profile: ":read-only"/);
  assert.match(runtime, /permission-profile: ":read-only"/);
  assert.match(runtime, /prepare-runtime/);
  assert.match(runtime, /classify-runtime/);
});

test("runtime verifier is explicitly allowed to read its exact-head input", async () => {
  const prompt = await readFile(runtimePromptPath, "utf8");
  assert.match(prompt, /must read this file before deciding\s+the verdict/i);
  assert.match(prompt, /read-only command solely to display this exact file/);
  assert.doesNotMatch(prompt, /Do not use the network, modify\s+files, run commands/);
});

test("approval and merge are exact-head, separate, and never use admin bypass", async () => {
  const [main, attempt] = await Promise.all([readFile(mainPath, "utf8"), readFile(attemptPath, "utf8")]);
  const submitStart = attempt.indexOf("\n  submit_review:\n");
  const resolveStart = attempt.indexOf("\n  resolve:\n", submitStart);
  const submit = attempt.slice(submitStart, resolveStart);
  assert.match(submit, /GH_TOKEN: \$\{\{ secrets\.UPSTREAM_REVIEW_APPROVAL_TOKEN \}\}/);
  assert.match(submit, /-f commit_id="\$HEAD_SHA"/);
  assert.match(submit, /event=APPROVE/);
  assert.match(submit, /RUNTIME_DISPOSITION/);

  const finalizeStart = main.indexOf("\n  finalize:\n");
  const guardStart = main.indexOf("\n  terminal_guard:\n", finalizeStart);
  const finalize = main.slice(finalizeStart, guardStart);
  assert.match(finalize, /upstream-agentic\/validate/);
  assert.match(finalize, /\.commit_id == \$head and \.state == "APPROVED"/);
  assert.match(finalize, /gh pr merge "\$PR_NUMBER" --repo "\$GH_REPO" --auto --squash/);
  assert.doesNotMatch(finalize, /--admin/);
  assert.match(finalize, /\.merged == true and \.head\.sha == \$head/);
});

test("blocked or incomplete cycles make the workflow fail truthfully", async () => {
  const workflow = await readFile(mainPath, "utf8");
  const guardStart = workflow.indexOf("\n  terminal_guard:\n");
  const guard = workflow.slice(guardStart);
  assert.match(guard, /if: always\(\)/);
  assert.match(guard, /DISPOSITION:/);
  assert.match(guard, /The workflow did not merge and intentionally reports failure/);
  assert.match(guard, /exit 1/);
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
