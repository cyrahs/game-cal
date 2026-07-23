import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  extractGameReviewInput,
  finalizeAgenticReview,
  parseAgentReview,
  renderIssueBody,
  validateCollectedReviewInput,
} from "./review-upstream.mjs";

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
