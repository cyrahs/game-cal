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
  extractGameReviewInput,
  finalizeAgenticFix,
  finalizeAgenticReview,
  parseAgentReview,
  parseAgentFixOutput,
  renderFixPrBody,
  renderIssueBody,
  validateCollectedReviewInput,
  validateFixManifest,
  verifyAgenticFixArtifact,
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
