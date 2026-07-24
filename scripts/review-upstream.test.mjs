import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  buildAgenticFixInput,
  buildAgenticPrReviewInput,
  buildAgenticPrReworkInput,
  extractGameReviewInput,
  finalizeAgenticFix,
  finalizeAgenticPrReview,
  finalizeAgenticPrRework,
  finalizeAgenticReview,
  parseAgentReview,
  parseAgentFixOutput,
  parseAgentPrReviewOutput,
  parseAgentPrReworkOutput,
  prepareAgenticPrRework,
  renderFixPrBody,
  renderIssueBody,
  prepareAgenticPrReview,
  renderPrReviewBody,
  renderPrReviewRequest,
  validateAgenticPrReviewInput,
  validateAgenticPrReworkInput,
  validateCollectedReviewInput,
  validateFixManifest,
  validatePrReworkManifest,
  verifyAgenticFixArtifact,
  verifyAgenticPrReworkArtifact,
} from "./review-upstream.mjs";

const execFileAsync = promisify(execFile);
const games = ["genshin", "starrail", "ww", "zzz", "snowbreak", "endfield"];
const gameLabels = {
  genshin: "原神",
  starrail: "崩坏：星穹铁道",
  ww: "鸣潮",
  zzz: "绝区零",
  snowbreak: "尘白禁区",
  endfield: "明日方舟：终末地",
};

function dataset(game) {
  return {
    game,
    game_label: gameLabels[game],
    notes: "Review this dataset conservatively.",
    raw_notice_count: 1,
    api_event_count: 1,
    raw_notices: [{ title: `${game} raw notice` }],
    api_events: [{ title: `${game} API event` }],
  };
}

function collectedInput() {
  return {
    schema_version: 2,
    mode: "collect_only",
    generated_at: "2026-07-23T12:00:00.000Z",
    api_base_url: "http://127.0.0.1:8787",
    max_items: 60,
    datasets: games.map(dataset),
    review_datasets: games.map(dataset),
    suppressions: {
      path: ".github/upstream-review-suppressions.json",
      count: 0,
      review_input_exclusions: games.map((game) => ({
        game,
        raw_notices: 0,
        api_events: 0,
      })),
    },
  };
}

function finding(game, overrides = {}) {
  return {
    game,
    severity: "medium",
    confidence: "high",
    kind: "missing_event",
    title: `${game} finding`,
    raw_title: `${game} raw notice`,
    api_title: "",
    start_time: "",
    end_time: "",
    reason: "Missing from the API.",
    ...overrides,
  };
}

function gameReview(game, overrides = {}) {
  return {
    complete: true,
    errors: [],
    summary: `Reviewed ${game}.`,
    reviewed_games: [game],
    findings: [],
    ...overrides,
  };
}

function agenticReviewReport(findings = []) {
  const input = collectedInput();
  return {
    schema_version: 2,
    mode: "agentic_review",
    generated_at: input.generated_at,
    finalized_at: "2026-07-23T12:05:00.000Z",
    api_base_url: input.api_base_url,
    datasets: input.datasets,
    review_datasets: input.review_datasets,
    review: {
      findings,
    },
    issue: {
      issue_url: "https://github.com/example/game-cal/issues/1",
    },
  };
}

function agentFixOutput(fixInput, changedFiles, overrides = {}) {
  const changedGames = new Set(
    changedFiles.map((file) =>
      Object.entries({
        genshin: "apps/api/src/games/genshin.ts",
        starrail: "apps/api/src/games/starrail.ts",
        ww: "apps/api/src/games/ww.ts",
        zzz: "apps/api/src/games/zzz.ts",
        snowbreak: "apps/api/src/games/snowbreak.ts",
        endfield: "apps/api/src/games/endfield.ts",
      }).find(([, sourceFile]) => sourceFile === file)?.[0]
    )
  );
  return {
    complete: true,
    errors: [],
    summary: "Prepared a focused parser fix.",
    changed_files: changedFiles,
    outcomes: fixInput.findings.map((item) => ({
      finding_id: item.finding_id,
      status: changedGames.has(item.game) ? "fixed" : "not_fixed",
      reason: changedGames.has(item.game)
        ? "Updated the matching parser."
        : "No safe automatic change was available.",
    })),
    ...overrides,
  };
}

function prReviewContext(overrides = {}) {
  return {
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    patch_sha256: "c".repeat(64),
    finding_fingerprint: "d".repeat(64),
    pull_request: {
      number: 42,
      url: "https://github.com/example/game-cal/pull/42",
    },
    changed_files: ["apps/api/src/games/starrail.ts"],
    ...overrides,
  };
}

function agentPrReviewOutput(input, overrides = {}) {
  return {
    complete: true,
    errors: [],
    context_sha256: input.context_sha256,
    verdict: "approve",
    summary: "The parser change is focused and passes the required checks.",
    findings: [],
    ...overrides,
  };
}

function agentPrReworkOutput(input, changedFiles, overrides = {}) {
  const changedFileSet = new Set(changedFiles);
  return {
    complete: true,
    errors: [],
    context_sha256: input.context_sha256,
    summary: "Addressed the blocking review feedback.",
    changed_files: changedFiles,
    outcomes: input.blocking_findings.map((finding) => ({
      finding_id: finding.finding_id,
      status: changedFileSet.has(finding.path) ? "fixed" : "not_fixed",
      reason: changedFileSet.has(finding.path)
        ? "Updated the affected parser."
        : "No safe in-scope change was available.",
    })),
    ...overrides,
  };
}

function prReworkContext(overrides = {}) {
  return {
    round: 1,
    max_rounds: 3,
    base_sha: "a".repeat(40),
    reviewed_head_sha: "b".repeat(40),
    finding_fingerprint: "d".repeat(64),
    fix_branch: `codex/upstream-review-${"d".repeat(16)}`,
    pull_request: {
      number: 42,
      url: "https://github.com/example/game-cal/pull/42",
    },
    fix_input_sha256: "e".repeat(64),
    previous_manifest_sha256: "f".repeat(64),
    previous_patch_sha256: "c".repeat(64),
    review_context_sha256: "1".repeat(64),
    review_result_sha256: "2".repeat(64),
    allowed_files: ["apps/api/src/games/starrail.ts"],
    changed_files: ["apps/api/src/games/starrail.ts"],
    blocking_findings: [
      {
        finding_id: "review-finding-001",
        severity: "P2",
        path: "apps/api/src/games/starrail.ts",
        line: 12,
        title: "Incorrect filter",
        body: "The parser still includes expired events.",
      },
    ],
    ...overrides,
  };
}

test("accepts a complete six-game collector input", () => {
  assert.equal(validateCollectedReviewInput(collectedInput()).mode, "collect_only");
});

test("rejects an incomplete collector input", () => {
  const input = collectedInput();
  input.review_datasets.pop();
  assert.throws(
    () => validateCollectedReviewInput(input),
    /expected all six game datasets/
  );
});

test("rejects a hollow collector dataset", () => {
  const input = collectedInput();
  input.review_datasets[0] = { game: "genshin" };
  assert.throws(
    () => validateCollectedReviewInput(input),
    /game_label/
  );
});

test("accepts a complete structured Codex result", () => {
  const result = parseAgentReview(
    JSON.stringify({
      complete: true,
      errors: [],
      summary: "No clear findings.",
      reviewed_games: games,
      findings: [],
    })
  );
  assert.deepEqual(result, {
    summary: "No clear findings.",
    findings: [],
  });
});

test("extracts a compact single-game review input in place", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "game-cal-upstream-shard-"));
  const inputPath = path.join(tempDir, "input.json");
  const previousLog = console.log;

  try {
    await fs.writeFile(inputPath, JSON.stringify(collectedInput()), "utf8");
    console.log = () => {};

    const shard = await extractGameReviewInput("ww", {
      inputPath,
      outputPath: inputPath,
    });
    const writtenText = await fs.readFile(inputPath, "utf8");
    const written = JSON.parse(writtenText);

    assert.deepEqual(written, shard);
    assert.equal(writtenText.includes('\n  "'), false);
    assert.equal(written.mode, "review_game");
    assert.equal(written.target_game, "ww");
    assert.equal(written.review_dataset.game, "ww");
    assert.equal("datasets" in written, false);
    assert.equal("review_datasets" in written, false);
    assert.equal("suppressions" in written, false);
  } finally {
    console.log = previousLog;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("accepts a complete single-game Codex result", () => {
  const result = parseAgentReview(
    JSON.stringify(gameReview("genshin")),
    ["genshin"],
    8
  );
  assert.deepEqual(result, {
    summary: "Reviewed genshin.",
    findings: [],
  });
});

test("rejects a single-game result for the wrong matrix game", () => {
  assert.throws(
    () =>
      parseAgentReview(
        JSON.stringify(gameReview("starrail")),
        ["genshin"],
        8
      ),
    /reviewed_games must cover genshin exactly once/
  );
});

test("rejects a finding for a different matrix game", () => {
  assert.throws(
    () =>
      parseAgentReview(
        JSON.stringify(
          gameReview("genshin", {
            findings: [finding("starrail")],
          })
        ),
        ["genshin"],
        8
      ),
    /outside the expected game set/
  );
});

test("rejects more than eight findings from one matrix job", () => {
  assert.throws(
    () =>
      parseAgentReview(
        JSON.stringify(
          gameReview("genshin", {
            findings: Array.from({ length: 9 }, () => finding("genshin")),
          })
        ),
        ["genshin"],
        8
      ),
    /exceeds the 8 limit/
  );
});

test("truncates oversized agent prose instead of failing publish", () => {
  const result = parseAgentReview(
    JSON.stringify({
      complete: true,
      errors: [],
      summary: "s".repeat(2_100),
      reviewed_games: games,
      findings: [
        {
          game: "genshin",
          severity: "medium",
          confidence: "high",
          kind: "missing_event",
          title: "t".repeat(600),
          raw_title: "",
          api_title: "",
          start_time: "",
          end_time: "",
          reason: "r".repeat(1_100),
        },
      ],
    })
  );
  assert.equal(Array.from(result.summary).length, 2_000);
  assert.equal(Array.from(result.findings[0].title).length, 500);
  assert.equal(Array.from(result.findings[0].reason).length, 1_000);
});

test("rejects a clean result that did not cover all games", () => {
  assert.throws(
    () =>
      parseAgentReview(
        JSON.stringify({
          complete: true,
          errors: [],
          summary: "No clear findings.",
          reviewed_games: games.slice(0, -1),
          findings: [],
        })
      ),
    /reviewed_games must cover all six games/
  );
});

test("rejects malformed finding fields after schema output", () => {
  assert.throws(
    () =>
      parseAgentReview(
        JSON.stringify({
          complete: true,
          errors: [],
          summary: "One finding.",
          reviewed_games: games,
          findings: [
            {
              game: "genshin",
              severity: "urgent",
              confidence: "high",
              kind: "missing_event",
              title: "Example",
              raw_title: "Example",
              api_title: "",
              start_time: "",
              end_time: "",
              reason: "Missing from the API.",
            },
          ],
        })
      ),
    /severity/
  );
});

test("builds a compact, stable fix request from unsuppressed findings", () => {
  const report = agenticReviewReport([
    finding("starrail"),
    finding("zzz", {
      title: "../../.github/workflows/unsafe.yml",
      raw_title: "zzz raw notice",
    }),
  ]);
  const input = buildAgenticFixInput(report);

  assert.equal(input.mode, "agentic_fix");
  assert.deepEqual(
    input.findings.map((item) => item.finding_id),
    ["finding-001", "finding-002"]
  );
  assert.deepEqual(input.target_games, ["starrail", "zzz"]);
  assert.deepEqual(input.allowed_files, [
    "apps/api/src/games/starrail.ts",
    "apps/api/src/games/zzz.ts",
  ]);
  assert.match(input.finding_fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    input.evidence.map((entry) => entry.game),
    ["starrail", "zzz"]
  );
  assert.equal(
    input.evidence[0].matching_raw_notices[0].title,
    "starrail raw notice"
  );
  assert.equal(
    JSON.stringify(input).includes("genshin raw notice"),
    false
  );
  assert.equal(
    input.allowed_files.some((file) => file.includes("workflows")),
    false
  );
  const reordered = buildAgenticFixInput(
    agenticReviewReport([...report.review.findings].reverse())
  );
  assert.equal(reordered.finding_fingerprint, input.finding_fingerprint);
  assert.deepEqual(reordered.findings, input.findings);
});

test("accepts a partial fix only when fixed games match the actual diff", () => {
  const input = buildAgenticFixInput(
    agenticReviewReport([finding("starrail"), finding("zzz")])
  );
  const changedFiles = ["apps/api/src/games/starrail.ts"];
  const output = agentFixOutput(input, changedFiles);
  const result = parseAgentFixOutput(
    JSON.stringify(output),
    input,
    changedFiles
  );

  assert.equal(result.has_patch, true);
  assert.deepEqual(result.changed_files, changedFiles);
  assert.deepEqual(
    result.outcomes.map((outcome) => outcome.status),
    ["fixed", "not_fixed"]
  );
});

test("rejects a Codex fix that claims a different diff", () => {
  const input = buildAgenticFixInput(
    agenticReviewReport([finding("starrail")])
  );
  const output = agentFixOutput(input, [
    "apps/api/src/games/starrail.ts",
  ]);

  assert.throws(
    () =>
      parseAgentFixOutput(
        JSON.stringify(output),
        input,
        ["apps/api/src/games/zzz.ts"]
      ),
    /outside the allowlist/
  );
  assert.throws(
    () =>
      parseAgentFixOutput(
        JSON.stringify(output),
        input,
        []
      ),
    /does not match the actual tracked diff/
  );
});

test("rejects missing or duplicate finding outcomes", () => {
  const input = buildAgenticFixInput(
    agenticReviewReport([finding("starrail"), finding("starrail")])
  );
  const changedFiles = ["apps/api/src/games/starrail.ts"];
  const output = agentFixOutput(input, changedFiles);

  assert.throws(
    () =>
      parseAgentFixOutput(
        JSON.stringify({ ...output, outcomes: output.outcomes.slice(0, 1) }),
        input,
        changedFiles
      ),
    /cover every finding exactly once/
  );
  assert.throws(
    () =>
      parseAgentFixOutput(
        JSON.stringify({
          ...output,
          outcomes: [output.outcomes[0], output.outcomes[0]],
        }),
        input,
        changedFiles
      ),
    /Duplicate finding outcome/
  );
});

test("validates patch bytes and renders escaped deterministic PR copy", () => {
  const input = buildAgenticFixInput(
    agenticReviewReport([
      finding("starrail", {
        api_title: "@team <script>`bad`",
      }),
    ])
  );
  const changedFiles = ["apps/api/src/games/starrail.ts"];
  const metadata = parseAgentFixOutput(
    JSON.stringify(agentFixOutput(input, changedFiles)),
    input,
    changedFiles
  );
  const patch = Buffer.from("diff --git a/a b/a\n");
  const manifest = {
    schema_version: 1,
    mode: "agentic_fix_manifest",
    base_sha: "a".repeat(40),
    finding_fingerprint: input.finding_fingerprint,
    finding_ids: input.findings.map((item) => item.finding_id),
    target_games: input.target_games,
    changed_files: changedFiles,
    patch_sha256: createHash("sha256").update(patch).digest("hex"),
    patch_bytes: patch.length,
  };
  validateFixManifest(manifest, input, patch, manifest.base_sha);

  const body = renderFixPrBody(metadata, manifest, {
    repository: "example/game-cal",
    runId: "12345",
    patchSha256: manifest.patch_sha256,
  });
  assert.match(body, /finding-001/);
  assert.match(body, /@​team/);
  assert.doesNotMatch(body, /<script>/);
  assert.match(body, /actions\/runs\/12345/);
  assert.match(body, /pnpm typecheck/);
});

test("builds a digest-bound PR review input and validates exact trusted context", () => {
  const context = prReviewContext();
  const input = buildAgenticPrReviewInput(context);

  assert.equal(input.mode, "agentic_pr_review");
  assert.match(input.context_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(input.pull_request, context.pull_request);
  assert.deepEqual(
    validateAgenticPrReviewInput(input, context),
    input
  );
  assert.equal(
    buildAgenticPrReviewInput(context).context_sha256,
    input.context_sha256
  );

  const tamperedInput = {
    ...input,
    head_sha: "e".repeat(40),
  };
  assert.throws(
    () => validateAgenticPrReviewInput(tamperedInput, context),
    /context SHA-256 mismatch/
  );
  for (const changedContext of [
    { ...context, base_sha: "e".repeat(40) },
    { ...context, head_sha: "e".repeat(40) },
    { ...context, patch_sha256: "e".repeat(64) },
    { ...context, finding_fingerprint: "e".repeat(64) },
    {
      ...context,
      pull_request: {
        number: 43,
        url: "https://github.com/example/game-cal/pull/43",
      },
    },
    {
      ...context,
      changed_files: ["apps/api/src/games/zzz.ts"],
    },
  ]) {
    const replayedInput = buildAgenticPrReviewInput(changedContext);
    assert.throws(
      () => validateAgenticPrReviewInput(replayedInput, context),
      /does not match the trusted PR context/
    );
  }
});

test("accepts P3-only approval and renders a deterministic escaped review request", () => {
  const input = buildAgenticPrReviewInput(prReviewContext());
  const rawOutput = agentPrReviewOutput(input, {
    summary: "@team <script>alert(1)</script>",
    findings: [
      {
        severity: "P3",
        path: "apps/api/src/games/starrail.ts",
        line: 19,
        title: "Prefer `const` @maintainers",
        body: "This is non-blocking. <img src=x onerror=alert(1)>",
      },
      {
        severity: "P3",
        path: "apps/api/src/games/starrail.ts",
        line: 3,
        title: "Earlier line",
        body: "Keep the helper local.",
      },
    ],
  });
  const review = parseAgentPrReviewOutput(
    JSON.stringify(rawOutput),
    input
  );
  assert.equal(review.verdict, "approve");
  assert.deepEqual(
    review.findings.map((finding) => finding.line),
    [3, 19]
  );

  const request = renderPrReviewRequest(review, input);
  const body = renderPrReviewBody(review, input);
  assert.deepEqual(Object.keys(request), ["body", "event", "commit_id"]);
  assert.equal(request.event, "APPROVE");
  assert.equal(request.commit_id, input.head_sha);
  assert.equal(request.body, body);
  assert.match(body, /@​team/);
  assert.match(body, /@​maintainers/);
  assert.doesNotMatch(body, /<script>/);
  assert.doesNotMatch(body, /<img /);

  const reordered = parseAgentPrReviewOutput(
    JSON.stringify({
      ...rawOutput,
      findings: [...rawOutput.findings].reverse(),
    }),
    input
  );
  assert.equal(
    renderPrReviewBody(reordered, input),
    body
  );
});

test("requires blocking findings exactly when requesting PR changes", () => {
  const input = buildAgenticPrReviewInput(prReviewContext());
  const blockingFinding = {
    severity: "P2",
    path: "apps/api/src/games/starrail.ts",
    line: 12,
    title: "Incorrect filter",
    body: "This still includes expired events.",
  };

  assert.throws(
    () =>
      parseAgentPrReviewOutput(
        JSON.stringify(
          agentPrReviewOutput(input, {
            verdict: "approve",
            findings: [blockingFinding],
          })
        ),
        input
      ),
    /cannot approve with P1 or P2/
  );
  assert.throws(
    () =>
      parseAgentPrReviewOutput(
        JSON.stringify(
          agentPrReviewOutput(input, {
            verdict: "request_changes",
            findings: [
              {
                ...blockingFinding,
                severity: "P3",
              },
            ],
          })
        ),
        input
      ),
    /must include a P1 or P2/
  );

  const review = parseAgentPrReviewOutput(
    JSON.stringify(
      agentPrReviewOutput(input, {
        verdict: "request_changes",
        findings: [blockingFinding],
      })
    ),
    input
  );
  const request = renderPrReviewRequest(review, input);
  assert.equal(request.event, "REQUEST_CHANGES");
  assert.equal(request.commit_id, input.head_sha);
});

test("rejects PR review output with a replayed context or invalid finding location", () => {
  const input = buildAgenticPrReviewInput(prReviewContext());
  const baseFinding = {
    severity: "P3",
    path: "apps/api/src/games/starrail.ts",
    line: 1,
    title: "Small cleanup",
    body: "This is optional.",
  };

  assert.throws(
    () =>
      parseAgentPrReviewOutput(
        JSON.stringify(
          agentPrReviewOutput(input, {
            context_sha256: "f".repeat(64),
          })
        ),
        input
      ),
    /context does not match/
  );
  for (const [findingPatch, expectedError] of [
    [
      { path: "README.md" },
      /outside changed_files/,
    ],
    [
      { line: 0 },
      /finding line/,
    ],
    [
      { line: 1.5 },
      /finding line/,
    ],
    [
      { severity: "P0" },
      /finding severity/,
    ],
  ]) {
    assert.throws(
      () =>
        parseAgentPrReviewOutput(
          JSON.stringify(
            agentPrReviewOutput(input, {
              findings: [{ ...baseFinding, ...findingPatch }],
            })
          ),
          input
        ),
      expectedError
    );
  }
});

test("enforces PR review field and finding count limits", () => {
  const input = buildAgenticPrReviewInput(prReviewContext());
  const validFinding = {
    severity: "P3",
    path: "apps/api/src/games/starrail.ts",
    line: 1,
    title: "Small cleanup",
    body: "This is optional.",
  };

  assert.throws(
    () =>
      parseAgentPrReviewOutput(
        JSON.stringify(
          agentPrReviewOutput(input, {
            summary: "s".repeat(2_001),
          })
        ),
        input
      ),
    /summary/
  );
  assert.throws(
    () =>
      parseAgentPrReviewOutput(
        JSON.stringify(
          agentPrReviewOutput(input, {
            findings: [
              {
                ...validFinding,
                title: "t".repeat(201),
              },
            ],
          })
        ),
        input
      ),
    /finding title/
  );
  assert.throws(
    () =>
      parseAgentPrReviewOutput(
        JSON.stringify(
          agentPrReviewOutput(input, {
            findings: [
              {
                ...validFinding,
                body: "b".repeat(2_001),
              },
            ],
          })
        ),
        input
      ),
    /finding body/
  );
  assert.throws(
    () =>
      parseAgentPrReviewOutput(
        JSON.stringify(
          agentPrReviewOutput(input, {
            findings: Array.from({ length: 21 }, (_, index) => ({
              ...validFinding,
              line: index + 1,
            })),
          })
        ),
        input
      ),
    /at most 20/
  );
  assert.throws(
    () =>
      parseAgentPrReviewOutput(
        JSON.stringify({
          ...agentPrReviewOutput(input),
          unexpected: true,
        }),
        input
      ),
    /unexpected or missing fields/
  );
  assert.throws(
    () =>
      parseAgentPrReviewOutput(
        JSON.stringify(
          agentPrReviewOutput(input, {
            errors: [" "],
          })
        ),
        input
      ),
    /incomplete PR review/
  );
});

test("builds a strict digest-bound PR rework input for one of three rounds", () => {
  const context = prReworkContext();
  const input = buildAgenticPrReworkInput(context);

  assert.equal(input.mode, "agentic_pr_rework");
  assert.equal(input.round, 1);
  assert.equal(input.max_rounds, 3);
  assert.match(input.context_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(validateAgenticPrReworkInput(input, context), input);
  assert.equal(
    buildAgenticPrReworkInput(context).context_sha256,
    input.context_sha256
  );
  const secondRoundInput = buildAgenticPrReworkInput({
    ...context,
    round: 2,
  });
  assert.equal(secondRoundInput.round, 2);
  assert.equal(secondRoundInput.max_rounds, 3);
  const thirdRoundInput = buildAgenticPrReworkInput({
    ...context,
    round: 3,
  });
  assert.equal(thirdRoundInput.round, 3);
  assert.equal(thirdRoundInput.max_rounds, 3);

  for (const changedContext of [
    { ...context, round: 0 },
    { ...context, round: 4 },
    { ...context, max_rounds: 2 },
    { ...context, reviewed_head_sha: "a".repeat(40) },
    { ...context, fix_branch: "codex/upstream-review-wrong" },
    {
      ...context,
      blocking_findings: [
        {
          ...context.blocking_findings[0],
          severity: "P3",
        },
      ],
    },
    {
      ...context,
      allowed_files: ["README.md"],
    },
  ]) {
    assert.throws(() => buildAgenticPrReworkInput(changedContext));
  }

  const replayed = buildAgenticPrReworkInput({
    ...context,
    reviewed_head_sha: "c".repeat(40),
  });
  assert.throws(
    () => validateAgenticPrReworkInput(replayed, context),
    /does not match the trusted context/
  );
});

test("validates PR rework model output against context, outcomes, and actual paths", () => {
  const input = buildAgenticPrReworkInput(prReworkContext());
  const changedFiles = ["apps/api/src/games/starrail.ts"];
  const output = agentPrReworkOutput(input, changedFiles);
  const parsed = parseAgentPrReworkOutput(
    JSON.stringify(output),
    input,
    changedFiles
  );
  assert.equal(parsed.has_patch, true);
  assert.equal(parsed.round, 1);
  assert.deepEqual(parsed.changed_files, changedFiles);

  for (const [patch, expectedError] of [
    [
      { context_sha256: "0".repeat(64) },
      /context does not match/,
    ],
    [
      { changed_files: [] },
      /does not match the actual tracked diff/,
    ],
    [
      { outcomes: [] },
      /cover every blocking finding/,
    ],
    [
      {
        outcomes: [
          output.outcomes[0],
          output.outcomes[0],
        ],
      },
      /Duplicate PR rework finding/,
    ],
  ]) {
    assert.throws(
      () =>
        parseAgentPrReworkOutput(
          JSON.stringify({ ...output, ...patch }),
          input,
          changedFiles
        ),
      expectedError
    );
  }
  assert.throws(
    () =>
      parseAgentPrReworkOutput(
        JSON.stringify({
          ...output,
          changed_files: ["README.md"],
        }),
        input,
        ["README.md"]
      ),
    /outside the allowlist/
  );
});

test("rejects a rework that drops a previously changed parser", () => {
  const fixInput = buildAgenticFixInput(
    agenticReviewReport([finding("genshin"), finding("starrail")])
  );
  const previousChangedFiles = [
    "apps/api/src/games/genshin.ts",
    "apps/api/src/games/starrail.ts",
  ];
  const remainingChangedFiles = ["apps/api/src/games/starrail.ts"];
  const context = prReworkContext({
    finding_fingerprint: fixInput.finding_fingerprint,
    fix_branch: `codex/upstream-review-${fixInput.finding_fingerprint.slice(0, 16)}`,
    allowed_files: previousChangedFiles,
    changed_files: previousChangedFiles,
  });
  const input = buildAgenticPrReworkInput(context);
  const incrementalPatch = Buffer.from("incremental patch");
  const cumulativePatch = Buffer.from("cumulative patch");
  const cumulativeManifest = {
    schema_version: 1,
    mode: "agentic_fix_manifest",
    base_sha: input.base_sha,
    finding_fingerprint: fixInput.finding_fingerprint,
    finding_ids: fixInput.findings.map((item) => item.finding_id),
    target_games: fixInput.target_games,
    changed_files: remainingChangedFiles,
    patch_sha256: createHash("sha256")
      .update(cumulativePatch)
      .digest("hex"),
    patch_bytes: cumulativePatch.length,
  };
  const manifest = {
    schema_version: 1,
    mode: "agentic_pr_rework_manifest",
    round: input.round,
    max_rounds: input.max_rounds,
    base_sha: input.base_sha,
    parent_sha: input.reviewed_head_sha,
    finding_fingerprint: input.finding_fingerprint,
    fix_branch: input.fix_branch,
    rework_context_sha256: input.context_sha256,
    review_context_sha256: input.review_context_sha256,
    review_result_sha256: input.review_result_sha256,
    previous_patch_sha256: input.previous_patch_sha256,
    incremental_patch_sha256: createHash("sha256")
      .update(incrementalPatch)
      .digest("hex"),
    incremental_patch_bytes: incrementalPatch.length,
    incremental_changed_files: remainingChangedFiles,
    patch_sha256: cumulativeManifest.patch_sha256,
    patch_bytes: cumulativeManifest.patch_bytes,
    changed_files: remainingChangedFiles,
    result_tree: "3".repeat(40),
  };

  assert.throws(
    () =>
      validatePrReworkManifest(
        manifest,
        input,
        incrementalPatch,
        cumulativeManifest,
        cumulativePatch,
        fixInput
      ),
    /removed a previously changed file/
  );
});

test("finalizes an allowed tracked parser modification into a bounded patch", async () => {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "game-cal-fix-repo-"));
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "game-cal-fix-output-"));
  const sourcePath = path.join(repoDir, "apps/api/src/games/starrail.ts");
  const readmePath = path.join(repoDir, "README.md");
  const inputPath = path.join(repoDir, "artifacts/upstream-review-fix-input.json");
  const agentOutputPath = path.join(
    repoDir,
    "artifacts/upstream-review-fix-agent.json"
  );
  const metadataPath = path.join(outputDir, "metadata.json");
  const manifestPath = path.join(outputDir, "manifest.json");
  const patchPath = path.join(outputDir, "fix.patch");
  const reviewInputPath = path.join(outputDir, "review-input.json");
  const reviewBodyPath = path.join(outputDir, "review-body.md");
  const reviewResultPath = path.join(outputDir, "review-result.json");
  const reviewRequestPath = path.join(outputDir, "review-request.json");
  const githubOutputPath = path.join(outputDir, "github-output.txt");

  try {
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.mkdir(path.dirname(inputPath), { recursive: true });
    await fs.writeFile(sourcePath, "export const value = 1;\n", "utf8");
    await fs.writeFile(readmePath, "# Test\n", "utf8");
    await execFileAsync("git", ["init", "-q"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: repoDir,
    });
    await execFileAsync("git", ["add", "."], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-qm", "initial"], { cwd: repoDir });
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    });
    const baseSha = stdout.trim();
    const input = buildAgenticFixInput(
      agenticReviewReport([finding("starrail")])
    );
    await fs.writeFile(inputPath, JSON.stringify(input), "utf8");
    await fs.writeFile(
      agentOutputPath,
      JSON.stringify(
        agentFixOutput(input, ["apps/api/src/games/starrail.ts"])
      ),
      "utf8"
    );
    await fs.writeFile(sourcePath, "export const value = 2;\n", "utf8");

    const result = await finalizeAgenticFix({
      cwd: repoDir,
      inputPath,
      agentOutputPath,
      metadataPath,
      manifestPath,
      patchPath,
      baseSha,
      githubOutputPath: "",
    });
    const patch = await fs.readFile(patchPath);
    assert.equal(result.metadata.has_patch, true);
    assert.ok(patch.length > 0);
    assert.equal(result.manifest.patch_bytes, patch.length);
    assert.equal(
      result.manifest.patch_sha256,
      createHash("sha256").update(patch).digest("hex")
    );

    await fs.writeFile(sourcePath, "export const value = 1;\n", "utf8");
    const verifiedManifest = await verifyAgenticFixArtifact({
      cwd: repoDir,
      inputPath,
      manifestPath,
      patchPath,
      expectedBaseSha: baseSha,
      githubOutputPath: "",
    });
    assert.deepEqual(
      verifiedManifest.changed_files,
      ["apps/api/src/games/starrail.ts"]
    );

    await execFileAsync("git", ["apply", patchPath], { cwd: repoDir });
    await execFileAsync(
      "git",
      ["add", "apps/api/src/games/starrail.ts"],
      { cwd: repoDir }
    );
    await execFileAsync("git", ["commit", "-qm", "candidate fix"], {
      cwd: repoDir,
    });
    const { stdout: headStdout } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: repoDir, encoding: "utf8" }
    );
    const headSha = headStdout.trim();
    const reviewInput = await prepareAgenticPrReview({
      cwd: repoDir,
      outputPath: reviewInputPath,
      inputPath,
      manifestPath,
      patchPath,
      expectedBaseSha: baseSha,
      headSha,
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/example/game-cal/pull/42",
      githubOutputPath: "",
    });
    const agentOutputJson = JSON.stringify(
      agentPrReviewOutput(reviewInput)
    );
    await assert.rejects(
      () =>
        finalizeAgenticPrReview({
          cwd: repoDir,
          prReviewInputPath: reviewInputPath,
          agentOutputJson: "",
          bodyPath: reviewBodyPath,
          resultPath: reviewResultPath,
          requestPath: reviewRequestPath,
          githubOutputPath,
          inputPath,
          manifestPath,
          patchPath,
          expectedBaseSha: baseSha,
          headSha,
          pullRequestNumber: 42,
          pullRequestUrl: "https://github.com/example/game-cal/pull/42",
        }),
      /Missing Codex PR review output/
    );
    const finalizedReview = await finalizeAgenticPrReview({
      cwd: repoDir,
      prReviewInputPath: reviewInputPath,
      agentOutputJson,
      bodyPath: reviewBodyPath,
      resultPath: reviewResultPath,
      requestPath: reviewRequestPath,
      githubOutputPath,
      inputPath,
      manifestPath,
      patchPath,
      expectedBaseSha: baseSha,
      headSha,
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/example/game-cal/pull/42",
    });
    assert.equal(finalizedReview.request.event, "APPROVE");
    assert.equal(finalizedReview.request.commit_id, headSha);
    const reviewRequestText = await fs.readFile(reviewRequestPath, "utf8");
    const reviewResultText = await fs.readFile(reviewResultPath, "utf8");
    assert.deepEqual(
      JSON.parse(reviewRequestText),
      finalizedReview.request
    );
    assert.equal(
      finalizedReview.request_sha256,
      createHash("sha256").update(reviewRequestText).digest("hex")
    );
    assert.deepEqual(
      JSON.parse(reviewResultText),
      finalizedReview.review
    );
    assert.equal(
      finalizedReview.result_sha256,
      createHash("sha256").update(reviewResultText).digest("hex")
    );
    assert.match(
      await fs.readFile(githubOutputPath, "utf8"),
      /review_event=APPROVE/
    );
    assert.match(
      await fs.readFile(githubOutputPath, "utf8"),
      /review_verdict=approve/
    );
    assert.match(
      await fs.readFile(githubOutputPath, "utf8"),
      new RegExp(`review_context_sha256=${reviewInput.context_sha256}`)
    );
    assert.match(
      await fs.readFile(githubOutputPath, "utf8"),
      /blocking_finding_count=0/
    );
    assert.match(
      await fs.readFile(githubOutputPath, "utf8"),
      new RegExp(
        `review_request_sha256=${finalizedReview.request_sha256}`
      )
    );

    await execFileAsync("git", ["checkout", "-q", baseSha], {
      cwd: repoDir,
    });
    await fs.writeFile(readmePath, "# Tampered artifact\n", "utf8");
    const { stdout: tamperedPatch } = await execFileAsync(
      "git",
      [
        "diff",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "--no-textconv",
        "HEAD",
        "--",
        "README.md",
      ],
      { cwd: repoDir, encoding: null }
    );
    const tamperedManifest = {
      ...result.manifest,
      patch_sha256: createHash("sha256").update(tamperedPatch).digest("hex"),
      patch_bytes: tamperedPatch.length,
    };
    await fs.writeFile(patchPath, tamperedPatch);
    await fs.writeFile(manifestPath, JSON.stringify(tamperedManifest), "utf8");
    await fs.writeFile(readmePath, "# Test\n", "utf8");
    await assert.rejects(
      () =>
        verifyAgenticFixArtifact({
          cwd: repoDir,
          inputPath,
          manifestPath,
          patchPath,
          expectedBaseSha: baseSha,
          githubOutputPath: "",
        }),
      /patch paths/
    );

    await fs.writeFile(patchPath, patch);
    await fs.writeFile(manifestPath, JSON.stringify(result.manifest), "utf8");
    await fs.writeFile(readmePath, "# Changed outside allowlist\n", "utf8");
    await assert.rejects(
      () =>
        finalizeAgenticFix({
          cwd: repoDir,
          inputPath,
          agentOutputPath,
          metadataPath,
          manifestPath,
          patchPath,
          baseSha,
          githubOutputPath: "",
        }),
      /outside the allowlist/
    );
  } finally {
    await fs.rm(repoDir, { recursive: true, force: true });
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test("prepares, finalizes, and verifies a bounded squash-style PR rework", async () => {
  const repoDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "game-cal-rework-repo-")
  );
  const outputDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "game-cal-rework-output-")
  );
  const recoveryRepoDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "game-cal-rework-recovery-")
  );
  const sourcePath = path.join(
    repoDir,
    "apps/api/src/games/starrail.ts"
  );
  const fixInputPath = path.join(outputDir, "upstream-review-fix-input.json");
  const fixAgentPath = path.join(outputDir, "upstream-review-fix-agent.json");
  const fixMetadataPath = path.join(outputDir, "initial-metadata.json");
  const fixManifestPath = path.join(outputDir, "initial-manifest.json");
  const fixPatchPath = path.join(outputDir, "initial-fix.patch");
  const reviewInputPath = path.join(outputDir, "review-input.json");
  const reviewResultPath = path.join(outputDir, "review-result.json");
  const reviewRequestPath = path.join(outputDir, "review-request.json");
  const reworkInputPath = path.join(outputDir, "rework-input.json");
  const reworkAgentPath = path.join(outputDir, "rework-agent.json");
  const reworkMetadataPath = path.join(outputDir, "rework-metadata.json");
  const reworkManifestPath = path.join(outputDir, "rework-manifest.json");
  const incrementalPatchPath = path.join(outputDir, "incremental.patch");
  const cumulativeManifestPath = path.join(
    outputDir,
    "cumulative-manifest.json"
  );
  const cumulativePatchPath = path.join(outputDir, "fix.patch");

  try {
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "export const value = 1;\n", "utf8");
    await execFileAsync("git", ["init", "-q"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.name", "Test"], {
      cwd: repoDir,
    });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: repoDir,
    });
    await execFileAsync("git", ["add", "."], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: repoDir });
    const { stdout: baseStdout } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: repoDir, encoding: "utf8" }
    );
    const baseSha = baseStdout.trim();

    const fixInput = buildAgenticFixInput(
      agenticReviewReport([finding("starrail")])
    );
    await fs.writeFile(
      fixInputPath,
      `${JSON.stringify(fixInput)}\n`,
      "utf8"
    );
    await fs.writeFile(
      fixAgentPath,
      JSON.stringify(
        agentFixOutput(fixInput, ["apps/api/src/games/starrail.ts"])
      ),
      "utf8"
    );
    await fs.writeFile(sourcePath, "export const value = 2;\n", "utf8");
    const initial = await finalizeAgenticFix({
      cwd: repoDir,
      inputPath: fixInputPath,
      agentOutputPath: fixAgentPath,
      metadataPath: fixMetadataPath,
      manifestPath: fixManifestPath,
      patchPath: fixPatchPath,
      baseSha,
      githubOutputPath: "",
    });
    assert.ok(initial.manifest.patch_bytes > 0);

    await execFileAsync("git", ["add", "."], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-qm", "initial fix"], {
      cwd: repoDir,
    });
    const { stdout: headStdout } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: repoDir, encoding: "utf8" }
    );
    const reviewedHeadSha = headStdout.trim();
    const { stdout: preservedHeadCommit } = await execFileAsync(
      "git",
      ["cat-file", "commit", reviewedHeadSha],
      { cwd: repoDir, encoding: "utf8" }
    );
    const pullRequestUrl =
      "https://github.com/example/game-cal/pull/42";
    const reviewInput = await prepareAgenticPrReview({
      cwd: repoDir,
      outputPath: reviewInputPath,
      inputPath: fixInputPath,
      manifestPath: fixManifestPath,
      patchPath: fixPatchPath,
      expectedBaseSha: baseSha,
      headSha: reviewedHeadSha,
      pullRequestNumber: 42,
      pullRequestUrl,
      githubOutputPath: "",
    });
    await finalizeAgenticPrReview({
      cwd: repoDir,
      prReviewInputPath: reviewInputPath,
      agentOutputJson: JSON.stringify(
        agentPrReviewOutput(reviewInput, {
          verdict: "request_changes",
          summary: "The parser fix still has a blocking regression.",
          findings: [
            {
              severity: "P2",
              path: "apps/api/src/games/starrail.ts",
              line: 1,
              title: "Use the corrected value",
              body: "The current value is still incorrect.",
            },
          ],
        })
      ),
      resultPath: reviewResultPath,
      requestPath: reviewRequestPath,
      githubOutputPath: "",
      inputPath: fixInputPath,
      manifestPath: fixManifestPath,
      patchPath: fixPatchPath,
      expectedBaseSha: baseSha,
      headSha: reviewedHeadSha,
      pullRequestNumber: 42,
      pullRequestUrl,
    });
    const reworkInput = await prepareAgenticPrRework({
      inputPath: fixInputPath,
      manifestPath: fixManifestPath,
      patchPath: fixPatchPath,
      prReviewInputPath: reviewInputPath,
      prReviewResultPath: reviewResultPath,
      outputPath: reworkInputPath,
      baseSha,
      headSha: reviewedHeadSha,
      pullRequestNumber: 42,
      pullRequestUrl,
      round: 1,
      maxRounds: 3,
      githubOutputPath: "",
    });
    assert.equal(reworkInput.blocking_findings.length, 1);

    await fs.writeFile(
      reworkAgentPath,
      JSON.stringify(
        agentPrReworkOutput(reworkInput, [
          "apps/api/src/games/starrail.ts",
        ])
      ),
      "utf8"
    );
    await fs.writeFile(sourcePath, "export const value = 3;\n", "utf8");
    const rework = await finalizeAgenticPrRework({
      cwd: repoDir,
      inputPath: fixInputPath,
      manifestPath: fixManifestPath,
      patchPath: fixPatchPath,
      reworkInputPath,
      agentOutputPath: reworkAgentPath,
      metadataPath: reworkMetadataPath,
      reworkManifestPath,
      incrementalPatchPath,
      cumulativeManifestPath,
      cumulativePatchPath,
      baseSha,
      headSha: reviewedHeadSha,
      pullRequestNumber: 42,
      pullRequestUrl,
      round: 1,
      githubOutputPath: "",
    });
    assert.equal(rework.rework_manifest.parent_sha, reviewedHeadSha);
    assert.equal(rework.rework_manifest.base_sha, baseSha);
    assert.notEqual(
      rework.rework_manifest.incremental_patch_sha256,
      rework.rework_manifest.patch_sha256
    );
    assert.ok(rework.rework_manifest.patch_bytes <= 128 * 1024);

    await execFileAsync("git", ["reset", "--hard", "-q", baseSha], {
      cwd: repoDir,
    });
    const verified = await verifyAgenticPrReworkArtifact({
      cwd: repoDir,
      inputPath: fixInputPath,
      manifestPath: fixManifestPath,
      patchPath: fixPatchPath,
      reworkInputPath,
      reworkManifestPath,
      incrementalPatchPath,
      cumulativeManifestPath,
      cumulativePatchPath,
      baseSha,
      headSha: reviewedHeadSha,
      pullRequestNumber: 42,
      pullRequestUrl,
      round: 1,
      githubOutputPath: "",
    });
    assert.equal(
      verified.rework_manifest.result_tree,
      rework.rework_manifest.result_tree
    );

    await execFileAsync(
      "git",
      ["clone", "-q", "--no-local", repoDir, recoveryRepoDir]
    );
    const preservedHeadPath = path.join(outputDir, "previous-head.commit");
    await fs.writeFile(preservedHeadPath, preservedHeadCommit, "utf8");
    const { stdout: restoredHeadStdout } = await execFileAsync(
      "git",
      ["hash-object", "-t", "commit", "-w", preservedHeadPath],
      { cwd: recoveryRepoDir, encoding: "utf8" }
    );
    assert.equal(restoredHeadStdout.trim(), reviewedHeadSha);
    const recoveredVerification = await verifyAgenticPrReworkArtifact({
      cwd: recoveryRepoDir,
      inputPath: fixInputPath,
      manifestPath: fixManifestPath,
      patchPath: fixPatchPath,
      reworkInputPath,
      reworkManifestPath,
      incrementalPatchPath,
      cumulativeManifestPath,
      cumulativePatchPath,
      baseSha,
      headSha: reviewedHeadSha,
      pullRequestNumber: 42,
      pullRequestUrl,
      round: 1,
      githubOutputPath: "",
    });
    assert.equal(
      recoveredVerification.rework_manifest.result_tree,
      rework.rework_manifest.result_tree
    );

    await execFileAsync("git", ["apply", cumulativePatchPath], {
      cwd: repoDir,
    });
    await execFileAsync(
      "git",
      ["add", "apps/api/src/games/starrail.ts"],
      { cwd: repoDir }
    );
    const { stdout: appliedTreeStdout } = await execFileAsync(
      "git",
      ["write-tree"],
      { cwd: repoDir, encoding: "utf8" }
    );
    assert.equal(
      appliedTreeStdout.trim(),
      rework.rework_manifest.result_tree
    );

    const originalIncrementalPatch = await fs.readFile(incrementalPatchPath);
    const originalCumulativePatch = await fs.readFile(cumulativePatchPath);
    const originalReworkManifest = await fs.readFile(
      reworkManifestPath,
      "utf8"
    );
    await fs.writeFile(
      incrementalPatchPath,
      Buffer.concat([originalIncrementalPatch, Buffer.from("\n")])
    );
    await execFileAsync("git", ["reset", "--hard", "-q", baseSha], {
      cwd: repoDir,
    });
    await assert.rejects(
      () =>
        verifyAgenticPrReworkArtifact({
          cwd: repoDir,
          inputPath: fixInputPath,
          manifestPath: fixManifestPath,
          patchPath: fixPatchPath,
          reworkInputPath,
          reworkManifestPath,
          incrementalPatchPath,
          cumulativeManifestPath,
          cumulativePatchPath,
          baseSha,
          headSha: reviewedHeadSha,
          pullRequestNumber: 42,
          pullRequestUrl,
          round: 1,
          githubOutputPath: "",
        }),
      /incremental patch mismatch/
    );

    await fs.writeFile(incrementalPatchPath, originalIncrementalPatch);
    await fs.writeFile(
      cumulativePatchPath,
      Buffer.concat([originalCumulativePatch, Buffer.from("\n")])
    );
    await assert.rejects(
      () =>
        verifyAgenticPrReworkArtifact({
          cwd: repoDir,
          inputPath: fixInputPath,
          manifestPath: fixManifestPath,
          patchPath: fixPatchPath,
          reworkInputPath,
          reworkManifestPath,
          incrementalPatchPath,
          cumulativeManifestPath,
          cumulativePatchPath,
          baseSha,
          headSha: reviewedHeadSha,
          pullRequestNumber: 42,
          pullRequestUrl,
          round: 1,
          githubOutputPath: "",
        }),
      /patch byte count mismatch|cumulative patch mismatch/
    );

    await fs.writeFile(cumulativePatchPath, originalCumulativePatch);
    const tamperedReworkManifest = {
      ...JSON.parse(originalReworkManifest),
      result_tree: "f".repeat(40),
    };
    await fs.writeFile(
      reworkManifestPath,
      `${JSON.stringify(tamperedReworkManifest)}\n`,
      "utf8"
    );
    await assert.rejects(
      () =>
        verifyAgenticPrReworkArtifact({
          cwd: repoDir,
          inputPath: fixInputPath,
          manifestPath: fixManifestPath,
          patchPath: fixPatchPath,
          reworkInputPath,
          reworkManifestPath,
          incrementalPatchPath,
          cumulativeManifestPath,
          cumulativePatchPath,
          baseSha,
          headSha: reviewedHeadSha,
          pullRequestNumber: 42,
          pullRequestUrl,
          round: 1,
          githubOutputPath: "",
        }),
      /result tree mismatch/
    );
  } finally {
    await fs.rm(repoDir, { recursive: true, force: true });
    await fs.rm(outputDir, { recursive: true, force: true });
    await fs.rm(recoveryRepoDir, { recursive: true, force: true });
  }
});

test("rejects an issue body above the safety limit", () => {
  assert.throws(
    () =>
      renderIssueBody({
        generated_at: "2026-07-23T12:00:00.000Z",
        api_base_url: "http://127.0.0.1:8787",
        datasets: [],
        review: {
          model: "Codex via Responses API",
          summary: "x".repeat(61_000),
          findings: [],
        },
      }),
    /Rendered issue body/
  );
});

test("keeps a large valid finding set within the Issue body budget", () => {
  const findings = Array.from({ length: 50 }, (_, index) => ({
    game: games[index % games.length],
    severity: index === 49 ? "high" : "low",
    confidence: "high",
    kind: "missing_event",
    title: "t".repeat(500),
    raw_title: "r".repeat(500),
    api_title: "a".repeat(500),
    start_time: "s".repeat(100),
    end_time: "e".repeat(100),
    reason: "r".repeat(1_000),
  }));
  const body = renderIssueBody({
    generated_at: "2026-07-23T12:00:00.000Z",
    api_base_url: "http://127.0.0.1:8787",
    datasets: collectedInput().datasets,
    review: {
      model: "Codex via Responses API",
      summary: "Large review.",
      findings,
    },
  });
  assert.ok(Buffer.byteLength(body, "utf8") <= 60_000);
  assert.match(body, /additional finding\(s\) omitted/);
  assert.match(body, /\[high\]/);
});

test("rejects finalize when a matrix review output is missing", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "game-cal-upstream-missing-"));
  const inputPath = path.join(tempDir, "input.json");
  const agentDir = path.join(tempDir, "agent-reviews");
  const reportPath = path.join(tempDir, "report.json");
  const previousEnv = {
    UPSTREAM_REVIEW_INPUT_PATH: process.env.UPSTREAM_REVIEW_INPUT_PATH,
    UPSTREAM_REVIEW_AGENT_OUTPUT_DIR: process.env.UPSTREAM_REVIEW_AGENT_OUTPUT_DIR,
    UPSTREAM_REVIEW_AGENT_OUTPUT_PATH: process.env.UPSTREAM_REVIEW_AGENT_OUTPUT_PATH,
    UPSTREAM_REVIEW_REPORT_PATH: process.env.UPSTREAM_REVIEW_REPORT_PATH,
    UPSTREAM_REVIEW_DRY_RUN: process.env.UPSTREAM_REVIEW_DRY_RUN,
  };

  try {
    await fs.writeFile(inputPath, JSON.stringify(collectedInput()), "utf8");
    await fs.mkdir(agentDir, { recursive: true });
    await Promise.all(
      games.slice(0, -1).map((game) =>
        fs.writeFile(
          path.join(agentDir, `upstream-review-agent-${game}.json`),
          JSON.stringify(gameReview(game)),
          "utf8"
        )
      )
    );

    process.env.UPSTREAM_REVIEW_INPUT_PATH = inputPath;
    process.env.UPSTREAM_REVIEW_AGENT_OUTPUT_DIR = agentDir;
    delete process.env.UPSTREAM_REVIEW_AGENT_OUTPUT_PATH;
    process.env.UPSTREAM_REVIEW_REPORT_PATH = reportPath;
    process.env.UPSTREAM_REVIEW_DRY_RUN = "1";

    await assert.rejects(
      () => finalizeAgenticReview(),
      /Codex endfield review output/
    );
    await assert.rejects(() => fs.access(reportPath), /ENOENT/);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("finalizes a valid agent result without GitHub writes in dry-run mode", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "game-cal-upstream-review-"));
  const inputPath = path.join(tempDir, "input.json");
  const agentDir = path.join(tempDir, "agent-reviews");
  const reportPath = path.join(tempDir, "report.json");
  const previousEnv = {
    UPSTREAM_REVIEW_INPUT_PATH: process.env.UPSTREAM_REVIEW_INPUT_PATH,
    UPSTREAM_REVIEW_AGENT_OUTPUT_DIR: process.env.UPSTREAM_REVIEW_AGENT_OUTPUT_DIR,
    UPSTREAM_REVIEW_AGENT_OUTPUT_PATH: process.env.UPSTREAM_REVIEW_AGENT_OUTPUT_PATH,
    UPSTREAM_REVIEW_REPORT_PATH: process.env.UPSTREAM_REVIEW_REPORT_PATH,
    UPSTREAM_REVIEW_DRY_RUN: process.env.UPSTREAM_REVIEW_DRY_RUN,
  };
  const previousLog = console.log;

  try {
    await fs.writeFile(inputPath, JSON.stringify(collectedInput()), "utf8");
    await fs.mkdir(agentDir, { recursive: true });
    await Promise.all(
      games.map((game) =>
        fs.writeFile(
          path.join(agentDir, `upstream-review-agent-${game}.json`),
          JSON.stringify(gameReview(game)),
          "utf8"
        )
      )
    );

    process.env.UPSTREAM_REVIEW_INPUT_PATH = inputPath;
    process.env.UPSTREAM_REVIEW_AGENT_OUTPUT_DIR = agentDir;
    delete process.env.UPSTREAM_REVIEW_AGENT_OUTPUT_PATH;
    process.env.UPSTREAM_REVIEW_REPORT_PATH = reportPath;
    process.env.UPSTREAM_REVIEW_DRY_RUN = "1";
    console.log = () => {};

    await finalizeAgenticReview();
    const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
    assert.equal(report.mode, "agentic_review");
    assert.equal(report.issue.action, "dry_run");
    assert.deepEqual(
      report.review.game_reviews.map((review) => review.game),
      games
    );
    assert.deepEqual(report.review.findings, []);
  } finally {
    console.log = previousLog;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
