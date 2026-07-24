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
  buildGameDataset,
  buildRemediationVerificationInput,
  extractGameReviewInput,
  finalizeFindingConfirmation,
  finalizeRemediationIssue,
  finalizeAgenticFix,
  finalizeAgenticPrReview,
  finalizeAgenticPrRework,
  finalizeAgenticReview,
  getFixBranch,
  getFindingFingerprint,
  getFindingKey,
  parseAgentReview,
  parseFindingConfirmationOutput,
  parseAgentFixOutput,
  parseAgentPrReviewOutput,
  parseAgentPrReworkOutput,
  parseRemediationVerificationOutput,
  prepareFindingConfirmation,
  prepareAgenticPrRework,
  renderFixPrBody,
  renderIssueBody,
  prepareAgenticPrReview,
  renderPrReviewBody,
  renderPrReviewRequest,
  syncIssue,
  validateAgenticFixInput,
  validateAgenticPrReviewInput,
  validateAgenticPrReworkInput,
  validateCollectedReviewInput,
  validateFindingConfirmationInput,
  validateFindingConfirmationPlan,
  validateRemediationVerificationBinding,
  validateRemediationVerificationInput,
  validateFixManifest,
  validatePrReworkManifest,
  verifyAgenticFixArtifact,
  verifyAgenticFixArtifactAtHead,
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
const repository = "example/game-cal";
const issueNumber = 42;
const issueUrl = `https://github.com/${repository}/issues/${issueNumber}`;
const remediationCycle = "9".repeat(64);
const reviewBaseSha = "a".repeat(40);

function cycleMarker(findingFingerprint, cycle = remediationCycle) {
  return `<!-- upstream-review-cycle:v1 fingerprint=${findingFingerprint} cycle=${cycle} -->`;
}

function findingIdentity(item) {
  const normalize = (value) =>
    String(value ?? "")
      .replace(/\\[rnt]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  return {
    game: item.game,
    kind: item.kind,
    raw_title: normalize(item.raw_title),
    api_title: normalize(item.api_title),
    start_time: normalize(item.start_time),
    end_time: normalize(item.end_time),
  };
}

function findingKey(item) {
  return createHash("sha256")
    .update(
      `upstream-review-finding:v1\n${JSON.stringify(findingIdentity(item))}`
    )
    .digest("hex");
}

function findingKeys(findings) {
  return [...new Set(findings.map(findingKey))].sort();
}

function findingCoverageFingerprint(findings) {
  return createHash("sha256")
    .update(
      `upstream-review-coverage:v1\n${JSON.stringify(findingKeys(findings))}`
    )
    .digest("hex");
}

function cycleMarkerV2(
  findings,
  {
    findingFingerprint: cycleFingerprint = findingFingerprint(findings),
    coverageFingerprint = findingCoverageFingerprint(findings),
    cycle = remediationCycle,
  } = {}
) {
  return `<!-- upstream-review-cycle:v2 fingerprint=${cycleFingerprint} cycle=${cycle} coverage=${coverageFingerprint} keys=${findingKeys(findings).join(",")} -->`;
}

function cycleMarkerV3(
  findings,
  {
    findingFingerprint: cycleFingerprint = getFindingFingerprint(findings),
    cycle = remediationCycle,
  } = {}
) {
  const keys = [...new Set(findings.map(getFindingKey))].sort();
  const coverageFingerprint = sha256Text(
    `upstream-review-coverage:v3\n${JSON.stringify(keys)}`
  );
  return `<!-- upstream-review-cycle:v2 fingerprint=${cycleFingerprint} cycle=${cycle} coverage=${coverageFingerprint} keys=${keys.join(",")} -->`;
}

function parseRequestBody(init = {}) {
  if (init.body == null || init.body === "") return null;
  return typeof init.body === "string" ? JSON.parse(init.body) : init.body;
}

function managedIssue({
  number,
  findings,
  state = "open",
  cycle = remediationCycle,
  version = "v2",
  cycleFindings = findings,
}) {
  const marker =
    version === "v1"
      ? cycleMarker(findingFingerprint(cycleFindings), cycle)
      : version === "v3"
        ? cycleMarkerV3(findings, {
            findingFingerprint: getFindingFingerprint(cycleFindings),
            cycle,
          })
      : cycleMarkerV2(findings, {
          findingFingerprint: findingFingerprint(cycleFindings),
          coverageFingerprint: findingCoverageFingerprint(findings),
          cycle,
        });
  return {
    number,
    html_url: `https://github.com/${repository}/issues/${number}`,
    title: "Upstream Review Alerts",
    state,
    body: `${marker}\n\nManaged Issue.\n`,
    user: { login: "github-actions[bot]" },
  };
}

function managedPullRequest({
  number = 77,
  findings,
  issue = issueNumber,
  cycle = remediationCycle,
  baseSha = reviewBaseSha,
  state = "open",
  merged = false,
  body = null,
}) {
  const fingerprint = getFindingFingerprint(findings);
  return {
    number,
    html_url: `https://github.com/${repository}/pull/${number}`,
    state,
    merged_at: merged ? "2026-07-23T13:00:00Z" : null,
    body:
      body ??
      `<!-- upstream-review-pr:v1 issue=${issue} fingerprint=${fingerprint} cycle=${cycle} -->\n\nManaged PR.\n`,
    user: { login: "github-actions[bot]" },
    base: {
      ref: "main",
      sha: baseSha,
      repo: { full_name: repository },
    },
    head: {
      ref: getFixBranch(fingerprint, issue, baseSha),
      repo: { full_name: repository },
    },
  };
}

function syncIssueRequest(
  issues,
  { createdIssueNumber = 90, pullRequests = [] } = {}
) {
  const calls = [];
  const request = async (pathname, init = {}) => {
    const method = String(init.method ?? "GET").toUpperCase();
    const body = parseRequestBody(init);
    calls.push({ pathname, method, body });
    if (
      method === "GET" &&
      pathname.startsWith(`/repos/${repository}/issues?`)
    ) {
      return issues;
    }
    if (
      method === "GET" &&
      pathname.startsWith(`/repos/${repository}/pulls?`)
    ) {
      const page = Number(
        new URL(`https://fixture.invalid${pathname}`).searchParams.get("page")
      );
      return page === 1 ? pullRequests : [];
    }
    if (method === "GET") {
      const match = new RegExp(
        `^/repos/${repository.replace("/", "\\/")}/issues/([1-9]\\d*)$`
      ).exec(pathname);
      if (match) {
        const issue = issues.find((candidate) => candidate.number === Number(match[1]));
        if (issue) return issue;
      }
    }
    if (
      method === "POST" &&
      pathname === `/repos/${repository}/issues`
    ) {
      return {
        number: createdIssueNumber,
        html_url:
          `https://github.com/${repository}/issues/${createdIssueNumber}`,
        title: body.title,
        body: body.body,
        state: "open",
        user: { login: "github-actions[bot]" },
      };
    }
    throw new Error(`Unexpected GitHub request: ${method} ${pathname}`);
  };
  return { request, calls };
}

function remediationFinalizationFixture({
  allFindingsAddressed = true,
  issueState = "open",
  issueBody = null,
  findingFingerprint = "d".repeat(64),
  cycle = remediationCycle,
  pullRequestBody = null,
  headSha = "b".repeat(40),
  mergeParentSha = reviewBaseSha,
  mergeTreeSha = "0".repeat(40),
} = {}) {
  const pullRequestNumber = 77;
  const pullRequestUrl =
    `https://github.com/${repository}/pull/${pullRequestNumber}`;
  const mergeSha = "f".repeat(40);
  const relation = allFindingsAddressed
    ? `Closes #${issueNumber}`
    : `Refs #${issueNumber}`;
  const prMarker =
    `<!-- upstream-review-pr:v1 issue=${issueNumber} fingerprint=${findingFingerprint} cycle=${cycle} -->`;
  const prBody =
    pullRequestBody ??
    `${prMarker}\n\n## Summary\n\nAutomatic remediation.\n\n${relation}\n`;
  const prBodySha256 = createHash("sha256")
    .update(prBody)
    .digest("hex");
  const issue = {
    number: issueNumber,
    html_url: issueUrl,
    title: "Upstream Review Alerts",
    state: issueState,
    state_reason: issueState === "closed" ? "completed" : null,
    user: {
      login: "github-actions[bot]",
    },
    body:
      issueBody ??
      `${cycleMarker(findingFingerprint, cycle)}\n\nIssue body.\n`,
  };
  const pullRequest = {
    number: pullRequestNumber,
    html_url: pullRequestUrl,
    state: "closed",
    merged: true,
    merged_at: "2026-07-23T13:00:00.000Z",
    merge_commit_sha: mergeSha,
    body: prBody,
    user: {
      login: "github-actions[bot]",
    },
    base: {
      repo: {
        full_name: repository,
      },
    },
    head: {
      sha: headSha,
      repo: {
        full_name: repository,
      },
    },
  };
  const mergeCommit = {
    sha: mergeSha,
    parents: [{ sha: mergeParentSha }],
    tree: { sha: mergeTreeSha },
  };
  const calls = [];
  const request = async (pathname, init = {}) => {
    const method = String(init.method ?? "GET").toUpperCase();
    const body = parseRequestBody(init);
    calls.push({ pathname, method, body });
    if (
      method === "GET" &&
      pathname === `/repos/${repository}/pulls/${pullRequestNumber}`
    ) {
      return pullRequest;
    }
    if (
      method === "GET" &&
      pathname === `/repos/${repository}/issues/${issueNumber}`
    ) {
      return issue;
    }
    if (
      method === "GET" &&
      pathname === `/repos/${repository}/git/commits/${mergeSha}`
    ) {
      return mergeCommit;
    }
    if (
      method === "PATCH" &&
      pathname === `/repos/${repository}/issues/${issueNumber}`
    ) {
      return {
        ...issue,
        ...body,
        number: issueNumber,
        html_url: issueUrl,
      };
    }
    throw new Error(`Unexpected GitHub request: ${method} ${pathname}`);
  };
  return {
    args: {
      request,
      repository,
      issueNumber,
      issueUrl,
      findingFingerprint,
      remediationCycle: cycle,
      pullRequestNumber,
      pullRequestUrl,
      prBodySha256,
      mergeSha,
      allFindingsAddressed,
      baseSha: reviewBaseSha,
    },
    calls,
  };
}

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

function findingFingerprint(findings) {
  const canonical = [
    ...new Map(
      findings.map((item) => {
        const identity = findingIdentity(item);
        return [JSON.stringify(identity), identity];
      })
    ).values(),
  ]
    .sort((left, right) => {
      const a = JSON.stringify(left);
      const b = JSON.stringify(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
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

function collectedInputV3() {
  const input = collectedInput();
  const buildDataset = (game) =>
    buildGameDataset(
      game,
      [
        {
          ann_id: games.indexOf(game) + 1,
          title: `${game} raw notice`,
          start_time: "2026-07-23T10:00:00+08:00",
          end_time: "2026-08-01T10:00:00+08:00",
        },
      ],
      [
        {
          title: `${game} API event`,
          start_time: "2026-07-23T10:00:00+08:00",
          end_time: "2026-08-01T10:00:00+08:00",
        },
      ],
      input.max_items
    );
  return {
    ...input,
    schema_version: 3,
    datasets: games.map(buildDataset),
    review_datasets: games.map(buildDataset),
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

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function confirmationInput(candidates) {
  const context = {
    schema_version: 1,
    mode: "confirm_findings",
    generated_at: "2026-07-23T12:00:00.000Z",
    target_game: "genshin",
    notes: "Confirm each candidate against the cited evidence.",
    candidates,
  };
  return {
    ...context,
    input_sha256: sha256Text(JSON.stringify(context)),
  };
}

function rehashConfirmationInput(input) {
  return confirmationInput(input.candidates);
}

function rehashFindingConfirmationInput(input) {
  const context = structuredClone(input);
  delete context.input_sha256;
  return {
    ...context,
    input_sha256: sha256Text(JSON.stringify(context)),
  };
}

function rehashFindingConfirmationPlan(plan) {
  const context = structuredClone(plan);
  delete context.plan_sha256;
  return {
    ...context,
    plan_sha256: sha256Text(JSON.stringify(context)),
  };
}

async function findingConfirmationFixture() {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "game-cal-upstream-confirmation-")
  );
  const inputPath = path.join(tempDir, "input.json");
  const agentDir = path.join(tempDir, "agent-reviews");
  const confirmationDir = path.join(tempDir, "confirmation");
  const planPath = path.join(
    confirmationDir,
    "upstream-review-confirmation-plan.json"
  );
  const input = collectedInputV3();
  const targetDataset = buildGameDataset(
    "genshin",
    [
      { ann_id: 101, title: "First Confirmation Event" },
      { ann_id: 102, title: "Second Confirmation Event" },
    ],
    [{ title: "Existing API Event" }],
    input.max_items
  );
  const targetIndex = games.indexOf("genshin");
  input.datasets[targetIndex] = targetDataset;
  input.review_datasets[targetIndex] = targetDataset;
  const targetFindings = targetDataset.raw_notices.map((item) =>
    finding("genshin", {
      title: item.title,
      raw_title: item.title,
      raw_refs: [item.review_ref],
      api_refs: [],
    })
  );

  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(inputPath, JSON.stringify(input), "utf8");
  await Promise.all(
    games.map((game) =>
      fs.writeFile(
        path.join(agentDir, `upstream-review-agent-${game}.json`),
        JSON.stringify(
          gameReview(game, {
            findings: game === "genshin" ? targetFindings : [],
          })
        ),
        "utf8"
      )
    )
  );
  const plan = await prepareFindingConfirmation({
    inputPath,
    agentOutputDir: agentDir,
    planPath,
    outputDir: confirmationDir,
    suppressionsPath: path.join(tempDir, "missing-suppressions.json"),
    baseSha: reviewBaseSha,
  });
  return {
    tempDir,
    confirmationDir,
    planPath,
    plan,
    gameInputPath: path.join(
      confirmationDir,
      plan.games[0].filename
    ),
  };
}

function remediationVerificationInput({
  headSha = "b".repeat(40),
  rawSnapshotStatuses = ["unchanged", "unchanged"],
} = {}) {
  const evidenceItems = ["genshin", "starrail"].map((game, index) =>
    buildGameDataset(
      game,
      [
        {
          ann_id: index + 101,
          title: `${game} remediation evidence`,
        },
      ],
      [],
      10
    ).raw_notices[0]
  );
  const findings = evidenceItems.map((item, index) => ({
    finding_id: `finding-${String(index + 1).padStart(3, "0")}`,
    ...finding(index === 0 ? "genshin" : "starrail", {
      title: item.title,
      raw_title: item.title,
      raw_refs: [item.review_ref],
      api_refs: [],
      subject_refs: [item.identity_ref],
    }),
  }));
  const patchedApiItems = findings.map((item) =>
    buildGameDataset(
      item.game,
      [],
      [
        {
          title: item.raw_title,
          start_time: "2026-07-24T12:00:00+08:00",
          end_time: null,
          end_time_kind: "relative",
          end_time_text: "长期开放",
          is_gacha: false,
        },
      ],
      1
    ).api_events[0]
  );
  const evidence = findings.map((item, index) => ({
    finding_id: item.finding_id,
    game: item.game,
    notes: "Verify the exact patched head against current evidence.",
    raw_snapshot_status: rawSnapshotStatuses[index],
    raw_before: [evidenceItems[index]],
    raw_current: [evidenceItems[index]],
    api_before: [],
    api_patched: [patchedApiItems[index]],
  }));
  const context = {
    schema_version: 1,
    mode: "verify_remediation",
    base_sha: "a".repeat(40),
    head_sha: headSha,
    finding_fingerprint: getFindingFingerprint(findings),
    remediation_cycle: remediationCycle,
    patch_sha256: "d".repeat(64),
    fix_input_sha256: "e".repeat(64),
    fix_manifest_sha256: "f".repeat(64),
    findings,
    evidence,
    patched_api_snapshots: findings.map((item, index) => ({
      game: item.game,
      status: "complete",
      api_event_count: 1,
      api_events: [patchedApiItems[index]],
    })),
  };
  return {
    ...context,
    input_sha256: sha256Text(JSON.stringify(context)),
  };
}

function boundRemediationVerificationInput(
  fixInput,
  manifest,
  { headSha = "b".repeat(40) } = {}
) {
  const sourceEvidenceByGame = new Map(
    fixInput.evidence.map((entry) => [entry.game, entry])
  );
  const patchedApiByGame = new Map(
    fixInput.target_games.map((game) => [game, []])
  );
  const evidence = fixInput.findings.map((item) => {
    const source = sourceEvidenceByGame.get(item.game);
    const rawBefore = source.matching_raw_notices.filter((candidate) =>
      item.raw_refs.includes(candidate.review_ref)
    );
    const apiBefore = source.matching_api_events.filter((candidate) =>
      item.api_refs.includes(candidate.review_ref)
    );
    let apiPatched = apiBefore;
    if (item.kind === "missing_event" && apiPatched.length === 0) {
      apiPatched = buildGameDataset(
        item.game,
        [],
        [
          {
            title: item.raw_title || item.title,
            start_time: "2026-07-24T12:00:00+08:00",
            end_time: null,
            end_time_kind: "relative",
            end_time_text: "长期开放",
            is_gacha: false,
          },
        ],
        1
      ).api_events;
    } else if (item.kind === "non_event_included") {
      apiPatched = [];
    } else if (item.kind === "duplicate_event") {
      apiPatched = apiPatched.slice(0, 1);
    }
    const patchedForGame = patchedApiByGame.get(item.game);
    for (const candidate of apiPatched) {
      if (
        !patchedForGame.some(
          (existing) => existing.review_ref === candidate.review_ref
        )
      ) {
        patchedForGame.push(candidate);
      }
    }
    return {
      finding_id: item.finding_id,
      game: item.game,
      notes: buildGameDataset(item.game, [], [], 1).notes,
      raw_snapshot_status:
        rawBefore.length > 0 ? "unchanged" : "not_applicable",
      raw_before: rawBefore,
      raw_current: rawBefore,
      api_before: apiBefore,
      api_patched: apiPatched,
    };
  });
  const context = {
    schema_version: 1,
    mode: "verify_remediation",
    base_sha: manifest.base_sha,
    head_sha: headSha,
    finding_fingerprint: fixInput.finding_fingerprint,
    remediation_cycle: fixInput.source_report.remediation_cycle,
    patch_sha256: manifest.patch_sha256,
    fix_input_sha256: sha256Text(JSON.stringify(fixInput)),
    fix_manifest_sha256: sha256Text(JSON.stringify(manifest)),
    findings: fixInput.findings,
    evidence,
    patched_api_snapshots: fixInput.target_games.map((game) => {
      const apiEvents = patchedApiByGame.get(game);
      return {
        game,
        status: "complete",
        api_event_count: apiEvents.length,
        api_events: apiEvents,
      };
    }),
  };
  return {
    ...context,
    input_sha256: sha256Text(JSON.stringify(context)),
  };
}

function resolvedRemediationVerificationResult(input) {
  return parseRemediationVerificationOutput(
    JSON.stringify({
      complete: true,
      errors: [],
      input_sha256: input.input_sha256,
      summary: "Every original finding is resolved on the approved head.",
      outcomes: input.findings.map((item) => ({
        finding_id: item.finding_id,
        status: "resolved",
        confidence: "high",
        reason: "The approved runtime no longer reproduces this finding.",
      })),
    }),
    input
  );
}

function rehashRemediationVerificationInput(input) {
  const { input_sha256: _inputSha256, ...context } = input;
  return {
    ...context,
    input_sha256: sha256Text(JSON.stringify(context)),
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

function agenticReviewReport(
  findings = [],
  { baseSha = reviewBaseSha } = {}
) {
  const input = collectedInput();
  return {
    schema_version: 2,
    mode: "agentic_review",
    generated_at: input.generated_at,
    finalized_at: "2026-07-23T12:05:00.000Z",
    base_sha: baseSha,
    api_base_url: input.api_base_url,
    datasets: input.datasets,
    review_datasets: input.review_datasets,
    review: {
      model: "Codex via Responses API",
      summary: `${findings.length} finding(s) detected.`,
      findings,
    },
    issue: {
      action: findings.length > 0 ? "created" : "noop",
      issue_number: issueNumber,
      issue_url: issueUrl,
      finding_fingerprint: findingFingerprint(findings),
      coverage_fingerprint: findingCoverageFingerprint(findings),
      finding_keys: findingKeys(findings),
      remediation_cycle: remediationCycle,
    },
  };
}

function agenticReviewReportV3(game = "starrail") {
  const targetGames = Array.isArray(game) ? game : [game];
  const input = collectedInputV3();
  const reportFindings = targetGames.map((targetGame) => {
    const dataset = input.review_datasets.find(
      (item) => item.game === targetGame
    );
    const rawEvidence = dataset.raw_notices[0];
    return finding(targetGame, {
      title: rawEvidence.title,
      raw_title: rawEvidence.title,
      raw_refs: [rawEvidence.review_ref],
      api_refs: [],
      subject_refs: [rawEvidence.identity_ref],
    });
  });

  return {
    schema_version: 3,
    finding_identity_version: 3,
    mode: "agentic_review",
    generated_at: input.generated_at,
    finalized_at: "2026-07-23T12:05:00.000Z",
    base_sha: reviewBaseSha,
    api_base_url: input.api_base_url,
    datasets: input.datasets,
    review_datasets: input.review_datasets,
    review: {
      model: "Codex via Responses API",
      summary: `${reportFindings.length} finding(s) detected.`,
      findings: reportFindings,
    },
    issue: {
      action: "created",
      issue_number: issueNumber,
      issue_url: issueUrl,
      finding_fingerprint: getFindingFingerprint(reportFindings),
      finding_keys: reportFindings.map(getFindingKey).sort(),
      remediation_cycle: remediationCycle,
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

function fixManifest(fixInput, changedFiles, patch, overrides = {}) {
  return {
    schema_version: 2,
    mode: "agentic_fix_manifest",
    base_sha: fixInput.source_report.base_sha,
    finding_fingerprint: fixInput.finding_fingerprint,
    issue_number: fixInput.source_report.issue_number,
    remediation_cycle: fixInput.source_report.remediation_cycle,
    fix_branch: fixInput.fix_branch,
    finding_ids: fixInput.findings.map((item) => item.finding_id),
    target_games: fixInput.target_games,
    changed_files: changedFiles,
    patch_sha256: createHash("sha256").update(patch).digest("hex"),
    patch_bytes: patch.length,
    result_tree: "0".repeat(40),
    ...overrides,
  };
}

function prReviewContext(overrides = {}) {
  const findingFingerprint = "d".repeat(64);
  const baseSha = reviewBaseSha;
  return {
    base_sha: baseSha,
    head_sha: "b".repeat(40),
    patch_sha256: "c".repeat(64),
    finding_fingerprint: findingFingerprint,
    issue_number: issueNumber,
    remediation_cycle: remediationCycle,
    fix_branch: getFixBranch(findingFingerprint, issueNumber, baseSha),
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
  const findingFingerprint = "d".repeat(64);
  const baseSha = reviewBaseSha;
  return {
    round: 1,
    max_rounds: 3,
    base_sha: baseSha,
    reviewed_head_sha: "b".repeat(40),
    finding_fingerprint: findingFingerprint,
    issue_number: issueNumber,
    remediation_cycle: remediationCycle,
    fix_branch: getFixBranch(findingFingerprint, issueNumber, baseSha),
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

test("builds deterministic snapshot and identity refs for raw and API evidence", () => {
  const rawNotice = {
    ann_id: 101,
    title: "Example Event",
    start_time: "2026-07-23T10:00:00+08:00",
    end_time: "2026-08-01T10:00:00+08:00",
  };
  const apiEvent = {
    title: "Example Event",
    start_time: "2026-07-23T10:00:00+08:00",
    end_time: "2026-08-01T10:00:00+08:00",
  };
  const first = buildGameDataset(
    "genshin",
    [rawNotice],
    [apiEvent],
    10
  );
  const repeated = buildGameDataset(
    "genshin",
    [{ ...rawNotice }],
    [{ ...apiEvent }],
    10
  );

  assert.deepEqual(
    first.raw_notices.map(({ review_ref, identity_ref }) => ({
      review_ref,
      identity_ref,
    })),
    repeated.raw_notices.map(({ review_ref, identity_ref }) => ({
      review_ref,
      identity_ref,
    }))
  );
  assert.deepEqual(
    first.api_events.map(({ review_ref, identity_ref }) => ({
      review_ref,
      identity_ref,
    })),
    repeated.api_events.map(({ review_ref, identity_ref }) => ({
      review_ref,
      identity_ref,
    }))
  );
  assert.match(
    first.raw_notices[0].review_ref,
    /^raw:genshin:[a-f0-9]{32}$/
  );
  assert.match(
    first.api_events[0].identity_ref,
    /^api:genshin:[a-f0-9]{32}$/
  );

  const changedWindow = buildGameDataset(
    "genshin",
    [
      {
        ...rawNotice,
        start_time: "2026-07-24T10:00:00+08:00",
        end_time: "2026-08-02T10:00:00+08:00",
      },
    ],
    [
      {
        ...apiEvent,
        start_time: "2026-07-24T10:00:00+08:00",
        end_time: "2026-08-02T10:00:00+08:00",
      },
    ],
    10
  );
  assert.notEqual(
    changedWindow.raw_notices[0].review_ref,
    first.raw_notices[0].review_ref
  );
  assert.notEqual(
    changedWindow.api_events[0].review_ref,
    first.api_events[0].review_ref
  );
  assert.equal(
    changedWindow.raw_notices[0].identity_ref,
    first.raw_notices[0].identity_ref
  );
  assert.equal(
    changedWindow.api_events[0].identity_ref,
    first.api_events[0].identity_ref
  );
});

test("keeps raw evidence identity stable when a source ID title drifts", () => {
  const original = buildGameDataset(
    "genshin",
    [{ ann_id: 101, title: "Example Event" }],
    [],
    10
  ).raw_notices[0];
  const renamed = buildGameDataset(
    "genshin",
    [{ ann_id: 101, title: "Example Event — Updated Details" }],
    [],
    10
  ).raw_notices[0];

  assert.equal(renamed.identity_ref, original.identity_ref);
  assert.notEqual(renamed.review_ref, original.review_ref);
});

test("disambiguates Star Rail records that reuse the same ann_id", () => {
  const records = buildGameDataset(
    "starrail",
    [
      {
        ann_id: 1300,
        title: "Fate[UBW] 联动跃迁说明",
        start_time: "2026-07-03 20:55:00",
        end_time: "2036-07-03 00:00:00",
        type: 3,
        type_label: "资讯",
      },
      {
        ann_id: 1300,
        title: "Fate[UBW] 联动更新公告",
        start_time: "2026-07-24 12:00:00",
        end_time: "2036-07-24 12:00:00",
        type: 3,
        type_label: "资讯",
      },
    ],
    [],
    10
  ).raw_notices;

  assert.notEqual(records[0].identity_ref, records[1].identity_ref);

  const shiftedWindow = buildGameDataset(
    "starrail",
    [
      {
        ann_id: 1300,
        title: "Fate[UBW] 联动跃迁说明",
        start_time: "2026-07-24 12:00:00",
        end_time: "9999-12-31 23:59:59",
        type: 3,
        type_label: "资讯",
      },
    ],
    [],
    10
  ).raw_notices[0];
  assert.equal(shiftedWindow.identity_ref, records[0].identity_ref);
});

test("falls back to normalized titles when raw evidence has no source ID", () => {
  const original = buildGameDataset(
    "genshin",
    [{ title: "Example Event" }],
    [],
    10
  ).raw_notices[0];
  const equivalentTitle = buildGameDataset(
    "genshin",
    [{ title: "  EXAMPLE： event!  " }],
    [],
    10
  ).raw_notices[0];
  const differentTitle = buildGameDataset(
    "genshin",
    [{ title: "Another Event" }],
    [],
    10
  ).raw_notices[0];

  assert.equal(equivalentTitle.identity_ref, original.identity_ref);
  assert.notEqual(differentTitle.identity_ref, original.identity_ref);
});

test("keys v3 findings by stable subjects and kind instead of prose or windows", () => {
  const evidence = buildGameDataset(
    "genshin",
    [
      { ann_id: 101, title: "Example Event" },
      { ann_id: 102, title: "Another Event" },
    ],
    [],
    10
  ).raw_notices;
  const original = finding("genshin", {
    raw_refs: [evidence[0].review_ref],
    api_refs: [],
    subject_refs: [evidence[0].identity_ref],
    start_time: "2026-07-23 10:00",
    end_time: "2026-08-01 10:00",
    reason: "The first explanation.",
  });
  const rewritten = {
    ...original,
    start_time: "July 24 after maintenance",
    end_time: "Until the event page closes",
    reason: "Different prose describing the same subject.",
  };
  const differentSubject = {
    ...original,
    raw_refs: [evidence[1].review_ref],
    subject_refs: [evidence[1].identity_ref],
  };
  const differentKind = {
    ...original,
    kind: "wrong_time_window",
  };

  assert.equal(getFindingKey(rewritten), getFindingKey(original));
  assert.notEqual(getFindingKey(differentSubject), getFindingKey(original));
  assert.notEqual(getFindingKey(differentKind), getFindingKey(original));
});

test("fails closed when a v3 collected dataset lacks stable evidence refs", () => {
  const input = collectedInputV3();
  assert.equal(validateCollectedReviewInput(input).schema_version, 3);

  delete input.review_datasets[0].raw_notices[0].identity_ref;
  assert.throws(
    () => validateCollectedReviewInput(input),
    /lacks stable evidence refs/
  );
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

test("strictly validates complete ordered finding confirmation decisions", () => {
  const rawEvidence = buildGameDataset(
    "genshin",
    [
      { ann_id: 101, title: "First Event" },
      { ann_id: 102, title: "Second Event" },
      { ann_id: 103, title: "Third Event" },
    ],
    [],
    10
  ).raw_notices;
  const candidates = rawEvidence.map((item, index) => {
    const candidateFinding = finding("genshin", {
      title: item.title,
      raw_title: item.title,
      raw_refs: [item.review_ref],
      api_refs: [],
      subject_refs: [item.identity_ref],
    });
    return {
      finding_id: `finding-${String(index + 1).padStart(3, "0")}`,
      finding_key: getFindingKey(candidateFinding),
      finding: candidateFinding,
      raw_evidence: [item],
      api_evidence: [],
    };
  });
  const input = confirmationInput(candidates);
  assert.equal(validateFindingConfirmationInput(input), input);

  const decisions = [
    {
      finding_id: "finding-001",
      verdict: "confirmed",
      confidence: "high",
      reason: "The mismatch is reproduced.",
    },
    {
      finding_id: "finding-002",
      verdict: "rejected",
      confidence: "high",
      reason: "The parser behavior is intentional.",
    },
    {
      finding_id: "finding-003",
      verdict: "ambiguous",
      confidence: "medium",
      reason: "The cited evidence is inconclusive.",
    },
  ];
  const output = {
    complete: true,
    errors: [],
    input_sha256: input.input_sha256,
    decisions,
  };
  assert.deepEqual(
    parseFindingConfirmationOutput(JSON.stringify(output), input).map(
      ({ finding_id, verdict }) => ({ finding_id, verdict })
    ),
    [
      { finding_id: "finding-001", verdict: "confirmed" },
      { finding_id: "finding-002", verdict: "rejected" },
      { finding_id: "finding-003", verdict: "ambiguous" },
    ]
  );

  assert.throws(
    () =>
      parseFindingConfirmationOutput(
        JSON.stringify({
          ...output,
          input_sha256: "f".repeat(64),
        }),
        input
      ),
    /incomplete/
  );
  assert.throws(
    () =>
      parseFindingConfirmationOutput(
        JSON.stringify({
          ...output,
          decisions: decisions.slice(0, -1),
        }),
        input
      ),
    /incomplete/
  );
  assert.throws(
    () =>
      parseFindingConfirmationOutput(
        JSON.stringify({
          ...output,
          decisions: [decisions[1], decisions[0], decisions[2]],
        }),
        input
      ),
    /decision at index 0/
  );
  assert.throws(
    () =>
      parseFindingConfirmationOutput(
        JSON.stringify({
          ...output,
          decisions: [
            { ...decisions[0], verdict: "maybe" },
            decisions[1],
            decisions[2],
          ],
        }),
        input
      ),
    /decision at index 0/
  );
});

test("rejects a confirmation candidate that cites a fabricated evidence ref", () => {
  const rawEvidence = buildGameDataset(
    "genshin",
    [{ ann_id: 101, title: "Example Event" }],
    [],
    10
  ).raw_notices[0];
  const candidateFinding = finding("genshin", {
    raw_refs: [rawEvidence.review_ref],
    api_refs: [],
    subject_refs: [rawEvidence.identity_ref],
  });
  const valid = confirmationInput([
    {
      finding_id: "finding-001",
      finding_key: getFindingKey(candidateFinding),
      finding: candidateFinding,
      raw_evidence: [rawEvidence],
      api_evidence: [],
    },
  ]);
  const forged = structuredClone(valid);
  forged.candidates[0].finding.raw_refs = [
    `raw:genshin:${"f".repeat(32)}`,
  ];
  const rehashed = rehashConfirmationInput(forged);

  assert.throws(
    () => validateFindingConfirmationInput(rehashed),
    /evidence mismatch/
  );
});

test("binds confirmation plan candidates and game metadata to the draft report", async () => {
  const fixture = await findingConfirmationFixture();
  try {
    assert.equal(validateFindingConfirmationPlan(fixture.plan), fixture.plan);
    assert.equal(fixture.plan.candidates.length, 2);
    assert.equal(fixture.plan.games.length, 1);

    const mutatedGameEntry = JSON.parse(JSON.stringify(fixture.plan));
    mutatedGameEntry.games[0].input_sha256 = "f".repeat(64);
    assert.throws(
      () =>
        validateFindingConfirmationPlan(
          rehashFindingConfirmationPlan(mutatedGameEntry)
        ),
      /plan games do not match/
    );

    const reorderedCandidates = JSON.parse(JSON.stringify(fixture.plan));
    reorderedCandidates.candidates.reverse();
    assert.throws(
      () =>
        validateFindingConfirmationPlan(
          rehashFindingConfirmationPlan(reorderedCandidates)
        ),
      /plan candidates do not match/
    );

    const substitutedCandidate = JSON.parse(JSON.stringify(fixture.plan));
    substitutedCandidate.candidates[0].finding.reason =
      "A substituted reason under the same stable finding key.";
    assert.equal(
      getFindingKey(substitutedCandidate.candidates[0].finding),
      substitutedCandidate.candidates[0].finding_key
    );
    assert.throws(
      () =>
        validateFindingConfirmationPlan(
          rehashFindingConfirmationPlan(substitutedCandidate)
        ),
      /plan candidates do not match/
    );
  } finally {
    await fs.rm(fixture.tempDir, { recursive: true, force: true });
  }
});

test("rejects reordered or substituted per-game confirmation input", async () => {
  const fixture = await findingConfirmationFixture();
  try {
    const originalInput = JSON.parse(
      await fs.readFile(fixture.gameInputPath, "utf8")
    );
    const mutations = [
      (input) => {
        input.candidates.reverse();
      },
      (input) => {
        input.candidates[0].finding.reason =
          "A substituted candidate payload with a still-valid stable key.";
      },
    ];

    for (const mutate of mutations) {
      const mutatedInput = structuredClone(originalInput);
      mutate(mutatedInput);
      const rehashedInput = rehashFindingConfirmationInput(mutatedInput);
      assert.equal(
        validateFindingConfirmationInput(rehashedInput),
        rehashedInput
      );
      await fs.writeFile(
        fixture.gameInputPath,
        JSON.stringify(rehashedInput),
        "utf8"
      );
      await assert.rejects(
        () =>
          finalizeFindingConfirmation({
            planPath: fixture.planPath,
            outputDir: path.join(fixture.tempDir, "confirmation-results"),
            reportPath: path.join(fixture.tempDir, "report.json"),
          }),
        /input does not match its trusted plan/
      );
    }
  } finally {
    await fs.rm(fixture.tempDir, { recursive: true, force: true });
  }
});

test("keeps a low-confidence rejection deferred instead of treating it as disproved", async () => {
  const fixture = await findingConfirmationFixture();
  const outputDir = path.join(
    fixture.tempDir,
    "confirmation-results"
  );
  const reportPath = path.join(fixture.tempDir, "report.json");
  const previousDryRun = process.env.UPSTREAM_REVIEW_DRY_RUN;
  const previousLog = console.log;
  try {
    await fs.mkdir(outputDir, { recursive: true });
    const input = JSON.parse(
      await fs.readFile(fixture.gameInputPath, "utf8")
    );
    await fs.writeFile(
      path.join(
        outputDir,
        "upstream-review-confirm-agent-genshin.json"
      ),
      JSON.stringify({
        complete: true,
        errors: [],
        input_sha256: input.input_sha256,
        decisions: input.candidates.map((candidate, index) => ({
          finding_id: candidate.finding_id,
          verdict: "rejected",
          confidence: index === 0 ? "low" : "high",
          reason:
            index === 0
              ? "The evidence is too uncertain to reject confidently."
              : "The supplied evidence disproves this candidate.",
        })),
      }),
      "utf8"
    );
    process.env.UPSTREAM_REVIEW_DRY_RUN = "1";
    console.log = () => {};
    const report = await finalizeFindingConfirmation({
      planPath: fixture.planPath,
      outputDir,
      reportPath,
    });

    assert.equal(report.review.confirmation.rejected_count, 1);
    assert.equal(report.review.confirmation.deferred_count, 1);
    assert.equal(
      report.review.deferred_findings[0].decision.confidence,
      "low"
    );
  } finally {
    console.log = previousLog;
    if (previousDryRun == null) {
      delete process.env.UPSTREAM_REVIEW_DRY_RUN;
    } else {
      process.env.UPSTREAM_REVIEW_DRY_RUN = previousDryRun;
    }
    await fs.rm(fixture.tempDir, { recursive: true, force: true });
  }
});

test("accepts fully resolved verification and reports unresolved outcomes", () => {
  const input = remediationVerificationInput();
  assert.equal(validateRemediationVerificationInput(input), input);
  const resolvedOutcomes = input.findings.map((item) => ({
    finding_id: item.finding_id,
    status: "resolved",
    confidence: "high",
    reason: "The exact patched head resolves this finding.",
  }));
  const resolvedOutput = {
    complete: true,
    errors: [],
    input_sha256: input.input_sha256,
    summary: "All findings are resolved at the exact patched head.",
    outcomes: resolvedOutcomes,
  };

  const resolved = parseRemediationVerificationOutput(
    JSON.stringify(resolvedOutput),
    input
  );
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.head_sha, input.head_sha);
  assert.deepEqual(
    resolved.outcomes.map(({ finding_id, status }) => ({
      finding_id,
      status,
    })),
    [
      { finding_id: "finding-001", status: "resolved" },
      { finding_id: "finding-002", status: "resolved" },
    ]
  );

  const unresolved = parseRemediationVerificationOutput(
    JSON.stringify({
      ...resolvedOutput,
      summary: "One finding remains unresolved.",
      outcomes: [
        resolvedOutcomes[0],
        {
          ...resolvedOutcomes[1],
          status: "unresolved",
          reason: "The patched API still reproduces the mismatch.",
        },
      ],
    }),
    input
  );
  assert.equal(unresolved.status, "unresolved");
  assert.equal(unresolved.outcomes[1].status, "unresolved");
});

test("rejects incomplete, reordered, or replayed verification outcomes", () => {
  const input = remediationVerificationInput();
  const outcomes = input.findings.map((item) => ({
    finding_id: item.finding_id,
    status: "resolved",
    confidence: "high",
    reason: "Resolved at the exact patched head.",
  }));
  const output = {
    complete: true,
    errors: [],
    input_sha256: input.input_sha256,
    summary: "All findings are resolved.",
    outcomes,
  };

  assert.throws(
    () =>
      parseRemediationVerificationOutput(
        JSON.stringify({
          ...output,
          outcomes: outcomes.slice(0, -1),
        }),
        input
      ),
    /incomplete/
  );
  assert.throws(
    () =>
      parseRemediationVerificationOutput(
        JSON.stringify({
          ...output,
          outcomes: [outcomes[1], outcomes[0]],
        }),
        input
      ),
    /outcome at index 0/
  );

  const replayedInput = remediationVerificationInput({
    headSha: "e".repeat(40),
  });
  assert.notEqual(replayedInput.input_sha256, input.input_sha256);
  assert.throws(
    () =>
      parseRemediationVerificationOutput(
        JSON.stringify({
          ...output,
          input_sha256: replayedInput.input_sha256,
        }),
        input
      ),
    /incomplete/
  );
});

test("rejects a resolved claim when the raw remediation snapshot drifted", () => {
  const input = remediationVerificationInput({
    rawSnapshotStatuses: ["drifted", "unchanged"],
  });
  const outcomes = input.findings.map((item) => ({
    finding_id: item.finding_id,
    status: "resolved",
    confidence: "high",
    reason: "The model claims this finding is resolved.",
  }));
  const output = {
    complete: true,
    errors: [],
    input_sha256: input.input_sha256,
    summary: "Verification completed.",
    outcomes,
  };

  assert.throws(
    () =>
      parseRemediationVerificationOutput(JSON.stringify(output), input),
    /Drifted raw evidence must be indeterminate/
  );

  const indeterminate = parseRemediationVerificationOutput(
    JSON.stringify({
      ...output,
      outcomes: [
        {
          ...outcomes[0],
          status: "indeterminate",
          reason: "The raw snapshot drift prevents a closed-set conclusion.",
        },
        outcomes[1],
      ],
    }),
    input
  );
  assert.equal(indeterminate.status, "indeterminate");
});

test("rejects a resolved missing event without patched API evidence", () => {
  const input = remediationVerificationInput();
  input.evidence[0].api_patched = [];
  const reboundInput = rehashRemediationVerificationInput(input);
  const outcomes = reboundInput.findings.map((item) => ({
    finding_id: item.finding_id,
    status: "resolved",
    confidence: "high",
    reason: "The model claims this finding is resolved.",
  }));

  assert.throws(
    () =>
      parseRemediationVerificationOutput(
        JSON.stringify({
          complete: true,
          errors: [],
          input_sha256: reboundInput.input_sha256,
          summary: "Verification completed.",
          outcomes,
        }),
        reboundInput
      ),
    /lacks patched API evidence/
  );
});

test("binds remediation verification findings and patch to the approved artifact", () => {
  const report = agenticReviewReportV3();
  const fixInput = buildAgenticFixInput(report);
  const patch = Buffer.from("approved cumulative v3 patch");
  const changedFiles = [
    "apps/api/src/games/starrail.ts",
    "apps/api/src/games/parser-regressions.agent.test.ts",
  ];
  const manifest = validateFixManifest(
    fixManifest(fixInput, changedFiles, patch),
    fixInput,
    patch,
    reviewBaseSha
  );
  const headSha = "b".repeat(40);
  const input = boundRemediationVerificationInput(
    fixInput,
    manifest,
    { headSha }
  );

  assert.equal(
    validateRemediationVerificationBinding(
      input,
      fixInput,
      manifest,
      headSha
    ),
    input
  );

  const substituted = structuredClone(input);
  substituted.findings[0].reason = "Substituted verification scope.";
  substituted.finding_fingerprint = getFindingFingerprint(
    substituted.findings
  );
  assert.throws(
    () =>
      validateRemediationVerificationBinding(
        rehashRemediationVerificationInput(substituted),
        fixInput,
        manifest,
        headSha
      ),
    /not bound to the trusted fix artifact/
  );

  const differentPatch = rehashRemediationVerificationInput({
    ...input,
    patch_sha256: "9".repeat(64),
  });
  assert.throws(
    () =>
      validateRemediationVerificationBinding(
        differentPatch,
        fixInput,
        manifest,
        headSha
      ),
    /not bound to the trusted fix artifact/
  );

  const substitutedEvidence = structuredClone(input);
  substitutedEvidence.evidence[0].raw_before[0].title =
    "Substituted pre-fix evidence";
  assert.throws(
    () =>
      validateRemediationVerificationBinding(
        rehashRemediationVerificationInput(substitutedEvidence),
        fixInput,
        manifest,
        headSha
      ),
    /evidence is not bound/
  );

  const falseSnapshotStatus = structuredClone(input);
  falseSnapshotStatus.evidence[0].raw_snapshot_status = "drifted";
  assert.throws(
    () =>
      validateRemediationVerificationBinding(
        rehashRemediationVerificationInput(falseSnapshotStatus),
        fixInput,
        manifest,
        headSha
      ),
    /evidence is not bound/
  );

  assert.throws(
    () =>
      validateRemediationVerificationBinding(
        input,
        fixInput,
        manifest,
        "c".repeat(40)
      ),
    /does not match the approved head/
  );
});

test("shares a complete patched API snapshot so API-only findings cannot hide by renaming", () => {
  const report = agenticReviewReportV3("starrail");
  const sourceDataset = buildGameDataset(
    "starrail",
    [],
    [
      {
        title: "Permanent mini-program launch",
        start_time: "2026-07-15T14:00:00+08:00",
        end_time: "2036-07-15T14:00:00+08:00",
      },
    ],
    60
  );
  const datasetIndex = games.indexOf("starrail");
  report.datasets[datasetIndex] = sourceDataset;
  report.review_datasets[datasetIndex] = sourceDataset;
  const originalApi = sourceDataset.api_events[0];
  report.review.findings = [
    finding("starrail", {
      kind: "non_event_included",
      title: originalApi.title,
      raw_title: "",
      api_title: originalApi.title,
      raw_refs: [],
      api_refs: [originalApi.review_ref],
      subject_refs: [originalApi.identity_ref],
    }),
  ];
  report.issue.finding_fingerprint = getFindingFingerprint(
    report.review.findings
  );
  report.issue.finding_keys = report.review.findings
    .map(getFindingKey)
    .sort();
  const fixInput = buildAgenticFixInput(report);
  const patch = Buffer.from("rename-only candidate patch");
  const manifest = fixManifest(
    fixInput,
    [
      "apps/api/src/games/starrail.ts",
      "apps/api/src/games/parser-regressions.agent.test.ts",
    ],
    patch
  );
  const renamedDataset = buildGameDataset(
    "starrail",
    [],
    [
      {
        title: "Completely different calendar title",
        start_time: "2026-07-15T14:00:00+08:00",
        end_time: "2036-07-15T14:00:00+08:00",
      },
    ],
    60
  );
  const input = buildRemediationVerificationInput(
    fixInput,
    manifest,
    "b".repeat(40),
    [renamedDataset]
  );

  assert.deepEqual(input.evidence[0].api_patched, []);
  assert.equal(input.patched_api_snapshots[0].status, "complete");
  assert.equal(
    input.patched_api_snapshots[0].api_events[0].title,
    "Completely different calendar title"
  );

  const truncatedDataset = buildGameDataset(
    "starrail",
    [],
    Array.from({ length: 61 }, (_, index) => ({
      title: `Calendar event ${index + 1}`,
      start_time: "2026-07-15T14:00:00+08:00",
      end_time: "2026-07-16T14:00:00+08:00",
    })),
    60
  );
  const truncatedInput = buildRemediationVerificationInput(
    fixInput,
    manifest,
    "b".repeat(40),
    [truncatedDataset]
  );
  assert.equal(
    truncatedInput.patched_api_snapshots[0].status,
    "truncated"
  );
  assert.throws(
    () =>
      parseRemediationVerificationOutput(
        JSON.stringify({
          complete: true,
          errors: [],
          input_sha256: truncatedInput.input_sha256,
          summary: "The API-only finding is resolved.",
          outcomes: [
            {
              finding_id: "finding-001",
              status: "resolved",
              confidence: "high",
              reason: "The old title is absent.",
            },
          ],
        }),
        truncatedInput
      ),
    /complete patched API snapshot/
  );
});

test("preserves and validates more than four v3 evidence refs for one game", () => {
  const report = agenticReviewReportV3("starrail");
  const targetDataset = buildGameDataset(
    "starrail",
    Array.from({ length: 5 }, (_, index) => ({
      ann_id: 2000 + index,
      title: `Star Rail missing event ${index + 1}`,
      type: 2,
      type_label: "活动",
    })),
    [],
    10
  );
  const datasetIndex = games.indexOf("starrail");
  report.datasets[datasetIndex] = targetDataset;
  report.review_datasets[datasetIndex] = targetDataset;
  report.review.findings = targetDataset.raw_notices.map((item) =>
    finding("starrail", {
      title: item.title,
      raw_title: item.title,
      raw_refs: [item.review_ref],
      api_refs: [],
      subject_refs: [item.identity_ref],
    })
  );
  report.review.summary = "Five distinct Star Rail findings.";
  report.issue.finding_fingerprint = getFindingFingerprint(
    report.review.findings
  );
  report.issue.finding_keys = report.review.findings
    .map(getFindingKey)
    .sort();

  const fixInput = buildAgenticFixInput(report);
  assert.equal(
    fixInput.evidence[0].matching_raw_notices.length,
    5
  );
  assert.equal(validateAgenticFixInput(fixInput), fixInput);

  const truncated = structuredClone(fixInput);
  truncated.evidence[0].matching_raw_notices.pop();
  assert.throws(
    () => validateAgenticFixInput(truncated),
    /incomplete raw evidence/
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

  assert.equal(input.schema_version, 2);
  assert.equal(input.mode, "agentic_fix");
  assert.deepEqual(input.source_report, {
    generated_at: report.generated_at,
    finalized_at: report.finalized_at,
    issue_number: issueNumber,
    issue_url: issueUrl,
    remediation_cycle: remediationCycle,
    base_sha: report.base_sha,
  });
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
  assert.equal(
    input.fix_branch,
    getFixBranch(input.finding_fingerprint, issueNumber, report.base_sha)
  );
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

test("keeps trusted parser regressions outside fix and rework allowlists", () => {
  const agentTestFile =
    "apps/api/src/games/parser-regressions.agent.test.ts";
  const trustedTestFile =
    "apps/api/src/games/parser-regressions.trusted.test.ts";
  const parserFile = "apps/api/src/games/starrail.ts";
  const fixInput = buildAgenticFixInput(agenticReviewReportV3());

  assert.deepEqual(fixInput.allowed_files, [parserFile, agentTestFile]);
  assert.deepEqual(fixInput.required_test_files, [agentTestFile]);
  assert.equal(fixInput.allowed_files.includes(trustedTestFile), false);
  assert.throws(
    () =>
      parseAgentFixOutput(
        JSON.stringify(agentFixOutput(fixInput, [parserFile])),
        fixInput,
        [parserFile]
      ),
    /must include a deterministic parser regression test/
  );
  assert.doesNotThrow(() =>
    parseAgentFixOutput(
      JSON.stringify(agentFixOutput(fixInput, [parserFile, agentTestFile])),
      fixInput,
      [parserFile, agentTestFile]
    )
  );

  const validReworkContext = prReworkContext({
    allowed_files: [parserFile, agentTestFile],
    changed_files: [agentTestFile, parserFile],
  });
  assert.deepEqual(
    buildAgenticPrReworkInput(validReworkContext).allowed_files,
    [parserFile, agentTestFile]
  );
  assert.throws(
    () =>
      buildAgenticPrReworkInput({
        ...validReworkContext,
        allowed_files: [parserFile, trustedTestFile],
        changed_files: [trustedTestFile, parserFile],
      }),
    /allowed_files/
  );
});

test("runs trusted and agent-owned parser regression suites", async () => {
  const trustedTestFile =
    "apps/api/src/games/parser-regressions.trusted.test.ts";
  const agentTestFile =
    "apps/api/src/games/parser-regressions.agent.test.ts";
  const apiPackage = JSON.parse(
    await fs.readFile(
      new URL("../apps/api/package.json", import.meta.url),
      "utf8"
    )
  );

  assert.equal(
    apiPackage.scripts["test:game-parsers"],
    "node --import tsx --test src/games/parser-regressions.trusted.test.ts src/games/parser-regressions.agent.test.ts"
  );
  const trustedTestSource = await fs.readFile(
    new URL(`../${trustedTestFile}`, import.meta.url),
    "utf8"
  );
  for (const requiredTitle of [
    "Star Rail uses a title-scoped long-term window",
    "Star Rail emits the title-scoped long-term window in the final event",
    "Star Rail excludes external mini-program and web-service launches",
    "Endfield preserves Protocol Reconnection as a player-relative window",
    "Endfield emits Protocol Reconnection as a relative final event",
  ]) {
    assert.ok(
      trustedTestSource.includes(`test("${requiredTitle}`),
      `missing trusted parser regression: ${requiredTitle}`
    );
  }
  await fs.access(new URL(`../${agentTestFile}`, import.meta.url));

  for (const schemaFile of [
    "../.github/schemas/upstream-review-fix-output.schema.json",
    "../.github/schemas/upstream-review-pr-review-output.schema.json",
    "../.github/schemas/upstream-review-pr-rework-output.schema.json",
  ]) {
    const schema = await fs.readFile(new URL(schemaFile, import.meta.url), "utf8");
    assert.match(schema, /parser-regressions\.agent\.test\.ts/);
    assert.doesNotMatch(schema, /parser-regressions\.trusted\.test\.ts/);
  }
});

test("deduplicates semantic findings before fingerprinting and repair", () => {
  const original = finding("starrail");
  const duplicate = {
    ...original,
    severity: "high",
    confidence: "medium",
    reason: "A second model explanation for the same semantic finding.",
  };
  const duplicatedInput = buildAgenticFixInput(
    agenticReviewReport([original, duplicate])
  );
  const singleInput = buildAgenticFixInput(
    agenticReviewReport([duplicate])
  );

  assert.equal(duplicatedInput.findings.length, 1);
  assert.equal(
    duplicatedInput.finding_fingerprint,
    singleInput.finding_fingerprint
  );
  assert.deepEqual(
    findingKeys([original, duplicate]),
    findingKeys([original])
  );
});

test("scopes an automatic fix branch to its remediation Issue cycle", () => {
  const fingerprint = "d".repeat(64);
  const firstBase = "a".repeat(40);
  const nextBase = "b".repeat(40);
  const first = getFixBranch(fingerprint, 42, firstBase);
  const repeated = getFixBranch(fingerprint, 42, firstBase);
  const recurrence = getFixBranch(fingerprint, 43, firstBase);
  const advancedBase = getFixBranch(fingerprint, 42, nextBase);

  assert.equal(
    first,
    `codex/upstream-review-${"d".repeat(16)}-i42-b${"a".repeat(12)}`
  );
  assert.equal(repeated, first);
  assert.equal(
    recurrence,
    `codex/upstream-review-${"d".repeat(16)}-i43-b${"a".repeat(12)}`
  );
  assert.equal(
    advancedBase,
    `codex/upstream-review-${"d".repeat(16)}-i42-b${"b".repeat(12)}`
  );
  assert.notEqual(recurrence, first);
  assert.notEqual(advancedBase, first);
  assert.throws(
    () => getFixBranch("short", 42, firstBase),
    /fingerprint/i
  );
  assert.throws(
    () => getFixBranch(fingerprint, 0, firstBase),
    /issue/i
  );
  assert.throws(
    () => getFixBranch(fingerprint, 42, "short"),
    /base SHA/i
  );
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
    agenticReviewReport([
      finding("starrail"),
      finding("starrail", { raw_title: "another starrail raw notice" }),
    ])
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
  const manifest = fixManifest(input, changedFiles, patch);
  validateFixManifest(manifest, input, patch, manifest.base_sha);

  const body = renderFixPrBody(metadata, manifest, {
    repository,
    runId: "12345",
    patchSha256: manifest.patch_sha256,
    issueUrl,
  });
  assert.match(body, /finding-001/);
  assert.match(body, /@​team/);
  assert.doesNotMatch(body, /<script>/);
  assert.match(body, /actions\/runs\/12345/);
  assert.match(body, /pnpm typecheck/);
  assert.match(body, new RegExp(`^Closes #${issueNumber}$`, "m"));
  assert.doesNotMatch(body, new RegExp(`^Refs #${issueNumber}$`, "m"));
  assert.match(body, new RegExp(`/issues/${issueNumber}\\b`));
});

test("uses a non-closing Issue reference when an automatic fix is partial", () => {
  const input = buildAgenticFixInput(
    agenticReviewReport([finding("starrail"), finding("zzz")])
  );
  const changedFiles = ["apps/api/src/games/starrail.ts"];
  const metadata = parseAgentFixOutput(
    JSON.stringify(agentFixOutput(input, changedFiles)),
    input,
    changedFiles
  );
  const patch = Buffer.from("diff --git a/a b/a\n");
  const manifest = fixManifest(input, changedFiles, patch);
  validateFixManifest(manifest, input, patch, manifest.base_sha);

  const body = renderFixPrBody(metadata, manifest, {
    repository,
    runId: "12345",
    patchSha256: manifest.patch_sha256,
    issueUrl,
  });

  assert.match(body, new RegExp(`^Refs #${issueNumber}$`, "m"));
  assert.doesNotMatch(body, new RegExp(`^Closes #${issueNumber}$`, "m"));
  assert.match(body, new RegExp(`/issues/${issueNumber}\\b`));
});

test("builds a digest-bound PR review input and validates exact trusted context", () => {
  const context = prReviewContext();
  const input = buildAgenticPrReviewInput(context);

  assert.equal(input.schema_version, 2);
  assert.equal(input.mode, "agentic_pr_review");
  assert.match(input.context_sha256, /^[a-f0-9]{64}$/);
  assert.equal(input.issue_number, issueNumber);
  assert.equal(input.remediation_cycle, remediationCycle);
  assert.equal(input.fix_branch, context.fix_branch);
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
    {
      ...context,
      base_sha: "e".repeat(40),
      fix_branch: getFixBranch(
        context.finding_fingerprint,
        context.issue_number,
        "e".repeat(40)
      ),
    },
    { ...context, head_sha: "e".repeat(40) },
    { ...context, patch_sha256: "e".repeat(64) },
    {
      ...context,
      finding_fingerprint: "e".repeat(64),
      fix_branch: getFixBranch(
        "e".repeat(64),
        context.issue_number,
        context.base_sha
      ),
    },
    {
      ...context,
      issue_number: 43,
      fix_branch: getFixBranch(
        context.finding_fingerprint,
        43,
        context.base_sha
      ),
    },
    { ...context, remediation_cycle: "8".repeat(64) },
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
  assert.throws(
    () =>
      buildAgenticPrReviewInput({
        ...context,
        fix_branch: "codex/upstream-review-wrong",
      }),
    /fix branch|fix_branch|branch|remediation cycle context/i
  );
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

  assert.equal(input.schema_version, 2);
  assert.equal(input.mode, "agentic_pr_rework");
  assert.equal(input.round, 1);
  assert.equal(input.max_rounds, 3);
  assert.equal(input.issue_number, issueNumber);
  assert.equal(input.remediation_cycle, remediationCycle);
  assert.equal(input.fix_branch, context.fix_branch);
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
    { ...context, issue_number: 0 },
    { ...context, remediation_cycle: "short" },
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
  const replayedCycle = buildAgenticPrReworkInput({
    ...context,
    remediation_cycle: "8".repeat(64),
  });
  assert.throws(
    () => validateAgenticPrReworkInput(replayedCycle, context),
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

test("accepts a v3 parser rework with its required companion regression test", () => {
  const parserFile = "apps/api/src/games/starrail.ts";
  const agentTestFile =
    "apps/api/src/games/parser-regressions.agent.test.ts";
  const input = buildAgenticPrReworkInput(
    prReworkContext({
      allowed_files: [parserFile, agentTestFile],
      changed_files: [agentTestFile, parserFile],
    })
  );
  const changedFiles = [agentTestFile, parserFile];
  const parsed = parseAgentPrReworkOutput(
    JSON.stringify(agentPrReworkOutput(input, changedFiles)),
    input,
    changedFiles
  );
  assert.deepEqual(parsed.changed_files, changedFiles);

  assert.throws(
    () =>
      parseAgentPrReworkOutput(
        JSON.stringify(agentPrReworkOutput(input, [parserFile])),
        input,
        [parserFile]
      ),
    /must update the regression test/
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
    issue_number: fixInput.source_report.issue_number,
    remediation_cycle: fixInput.source_report.remediation_cycle,
    fix_branch: fixInput.fix_branch,
    allowed_files: previousChangedFiles,
    changed_files: previousChangedFiles,
  });
  const input = buildAgenticPrReworkInput(context);
  const incrementalPatch = Buffer.from("incremental patch");
  const cumulativePatch = Buffer.from("cumulative patch");
  const cumulativeManifest = {
    schema_version: 2,
    mode: "agentic_fix_manifest",
    base_sha: input.base_sha,
    finding_fingerprint: fixInput.finding_fingerprint,
    issue_number: fixInput.source_report.issue_number,
    remediation_cycle: fixInput.source_report.remediation_cycle,
    fix_branch: fixInput.fix_branch,
    finding_ids: fixInput.findings.map((item) => item.finding_id),
    target_games: fixInput.target_games,
    changed_files: remainingChangedFiles,
    patch_sha256: createHash("sha256")
      .update(cumulativePatch)
      .digest("hex"),
    patch_bytes: cumulativePatch.length,
    result_tree: "3".repeat(40),
  };
  const manifest = {
    schema_version: 2,
    mode: "agentic_pr_rework_manifest",
    round: input.round,
    max_rounds: input.max_rounds,
    base_sha: input.base_sha,
    parent_sha: input.reviewed_head_sha,
    finding_fingerprint: input.finding_fingerprint,
    issue_number: input.issue_number,
    remediation_cycle: input.remediation_cycle,
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
      agenticReviewReport([finding("starrail")], { baseSha })
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
    assert.equal(result.manifest.schema_version, 2);
    assert.equal(result.manifest.issue_number, issueNumber);
    assert.equal(result.manifest.remediation_cycle, remediationCycle);
    assert.equal(result.manifest.fix_branch, input.fix_branch);
    assert.ok(patch.length > 0);
    assert.equal(result.manifest.patch_bytes, patch.length);
    assert.equal(
      result.manifest.patch_sha256,
      createHash("sha256").update(patch).digest("hex")
    );
    assert.match(result.manifest.result_tree, /^[a-f0-9]{40}$/);
    assert.throws(
      () =>
        validateFixManifest(
          { ...result.manifest, result_tree: "" },
          input,
          patch,
          baseSha
        ),
      /Invalid agentic fix manifest/
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
    const exactHeadManifest = await verifyAgenticFixArtifactAtHead({
      cwd: repoDir,
      inputPath,
      manifestPath,
      patchPath,
      expectedBaseSha: baseSha,
      headSha,
      githubOutputPath: "",
    });
    assert.equal(exactHeadManifest.result_tree, result.manifest.result_tree);
    await assert.rejects(
      () =>
        verifyAgenticFixArtifactAtHead({
          cwd: repoDir,
          inputPath,
          manifestPath,
          patchPath,
          expectedBaseSha: baseSha,
          headSha: "f".repeat(40),
          githubOutputPath: "",
        }),
      /checkout mismatch/
    );
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
      agenticReviewReport([finding("starrail")], { baseSha })
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
    assert.equal(rework.rework_manifest.schema_version, 2);
    assert.equal(rework.rework_manifest.issue_number, issueNumber);
    assert.equal(rework.rework_manifest.remediation_cycle, remediationCycle);
    assert.equal(rework.rework_manifest.fix_branch, fixInput.fix_branch);
    assert.notEqual(
      rework.rework_manifest.incremental_patch_sha256,
      rework.rework_manifest.patch_sha256
    );
    assert.ok(rework.rework_manifest.patch_bytes <= 128 * 1024);
    assert.equal(
      rework.fix_manifest.result_tree,
      rework.rework_manifest.result_tree
    );

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
    await execFileAsync("git", ["commit", "-qm", "replacement fix"], {
      cwd: repoDir,
    });
    const { stdout: replacementHeadStdout } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: repoDir, encoding: "utf8" }
    );
    const replacementHeadSha = replacementHeadStdout.trim();
    const exactReplacementManifest = await verifyAgenticFixArtifactAtHead({
      cwd: repoDir,
      inputPath: fixInputPath,
      manifestPath: cumulativeManifestPath,
      patchPath: cumulativePatchPath,
      expectedBaseSha: baseSha,
      headSha: replacementHeadSha,
      githubOutputPath: "",
    });
    assert.equal(
      exactReplacementManifest.result_tree,
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

test("skips a finding set already contained in one open managed Issue", async () => {
  const trackedFindings = [
    finding("starrail"),
    finding("genshin"),
  ];
  const report = agenticReviewReport([trackedFindings[0]]);
  delete report.issue;
  const issue = managedIssue({
    number: issueNumber,
    findings: trackedFindings,
    cycle: "8".repeat(64),
  });
  const { request, calls } = syncIssueRequest([issue]);

  const result = await syncIssue(report, {
    request,
    repository,
    runId: "12345",
    runAttempt: "2",
    dryRun: false,
  });

  assert.equal(result.action, "covered");
  assert.deepEqual(result.covered_by_issue_numbers, [issueNumber]);
  assert.equal(calls.some((call) => ["POST", "PATCH"].includes(call.method)), false);
  report.issue = result;
  const fixInput = buildAgenticFixInput(report);
  assert.deepEqual(fixInput.findings, []);
  assert.deepEqual(fixInput.target_games, []);
  assert.deepEqual(fixInput.allowed_files, []);
  assert.equal(fixInput.fix_branch, "");
  assert.equal(fixInput.source_report.issue_number, 0);
});

test("resumes an exact current-identity Open Issue for repair", async () => {
  const report = agenticReviewReportV3();
  const trackedFinding = report.review.findings[0];
  delete report.issue;
  const issue = managedIssue({
    number: issueNumber,
    findings: [trackedFinding],
    cycle: "8".repeat(64),
    version: "v3",
  });
  const { request, calls } = syncIssueRequest([issue]);

  const result = await syncIssue(report, {
    request,
    repository,
    defaultBranch: "main",
    runId: "12345",
    runAttempt: "2",
    dryRun: false,
  });

  assert.equal(result.action, "resume_orphan");
  assert.equal(result.issue_number, issueNumber);
  assert.equal(result.issue_url, issue.html_url);
  assert.equal(
    result.finding_fingerprint,
    getFindingFingerprint([trackedFinding])
  );
  assert.deepEqual(result.finding_keys, [getFindingKey(trackedFinding)]);
  assert.equal(result.remediation_cycle, "8".repeat(64));
  assert.equal(
    calls.some((call) => ["POST", "PATCH"].includes(call.method)),
    false
  );

  report.issue = result;
  const fixInput = buildAgenticFixInput(report);
  assert.equal(fixInput.findings.length, 1);
  assert.deepEqual(fixInput.target_games, ["starrail"]);
  assert.equal(fixInput.source_report.issue_number, issueNumber);
  assert.equal(fixInput.source_report.remediation_cycle, "8".repeat(64));
});

test("does not resume an exact Issue that already has a related PR", async () => {
  for (const fixture of [
    { state: "open", merged: false, expected: "active_pr" },
    {
      state: "closed",
      merged: true,
      expected: "merged_pr_pending_finalization",
    },
    {
      state: "closed",
      merged: false,
      expected: "closed_pr_requires_manual_recovery",
    },
  ]) {
    const report = agenticReviewReportV3();
    const trackedFinding = report.review.findings[0];
    delete report.issue;
    const cycle = "8".repeat(64);
    const issue = managedIssue({
      number: issueNumber,
      findings: [trackedFinding],
      cycle,
      version: "v3",
    });
    const pullRequest = managedPullRequest({
      findings: [trackedFinding],
      cycle,
      state: fixture.state,
      merged: fixture.merged,
    });
    const { request } = syncIssueRequest([issue], {
      pullRequests: [pullRequest],
    });

    const result = await syncIssue(report, {
      request,
      repository,
      defaultBranch: "main",
      runId: "12345",
      runAttempt: "2",
      dryRun: false,
    });

    assert.equal(result.action, "covered");
    assert.equal(result.recovery.status, fixture.expected);
    assert.equal(result.recovery.pull_request_number, pullRequest.number);
    report.issue = result;
    assert.deepEqual(buildAgenticFixInput(report).findings, []);
  }
});

test("fails closed for conflicting or duplicate PRs on an exact Issue cycle", async () => {
  const report = agenticReviewReportV3();
  const trackedFinding = report.review.findings[0];
  delete report.issue;
  const cycle = "8".repeat(64);
  const issue = managedIssue({
    number: issueNumber,
    findings: [trackedFinding],
    cycle,
    version: "v3",
  });
  const validPullRequest = managedPullRequest({
    findings: [trackedFinding],
    cycle,
  });
  const conflict = managedPullRequest({
    findings: [trackedFinding],
    cycle,
    body:
      `<!-- upstream-review-pr:v1 issue=${issueNumber} ` +
      `fingerprint=${getFindingFingerprint([trackedFinding])} ` +
      `cycle=${"7".repeat(64)} -->\n\nConflicting PR.\n`,
  });

  for (const pullRequests of [
    [validPullRequest, { ...validPullRequest, number: 78, html_url: `https://github.com/${repository}/pull/78` }],
    [conflict],
  ]) {
    const { request } = syncIssueRequest([issue], { pullRequests });
    await assert.rejects(
      () =>
        syncIssue(report, {
          request,
          repository,
          defaultBranch: "main",
          runId: "12345",
          runAttempt: "2",
          dryRun: false,
        }),
      /More than one pull request|Conflicting pull request/
    );
  }
});

test("uses the union of non-overlapping open Issues before skipping repair", async () => {
  const starrailFinding = finding("starrail");
  const genshinFinding = finding("genshin");
  const report = agenticReviewReport([
    starrailFinding,
    genshinFinding,
  ]);
  delete report.issue;
  const issues = [
    managedIssue({ number: 40, findings: [starrailFinding] }),
    managedIssue({
      number: 41,
      findings: [genshinFinding],
      cycle: "8".repeat(64),
    }),
  ];
  const { request, calls } = syncIssueRequest(issues);

  const result = await syncIssue(report, {
    request,
    repository,
    runId: "12345",
    runAttempt: "1",
    dryRun: false,
  });

  assert.equal(result.action, "covered");
  assert.deepEqual(result.covered_by_issue_numbers, [40, 41]);
  assert.equal(result.covered_finding_count, 2);
  assert.equal(calls.some((call) => ["POST", "PATCH"].includes(call.method)), false);
});

test("creates and repairs only the non-overlapping complement", async () => {
  const trackedFinding = finding("starrail");
  const newFinding = finding("genshin");
  const report = agenticReviewReport([trackedFinding, newFinding]);
  delete report.issue;
  const trackedIssue = managedIssue({
    number: 40,
    findings: [trackedFinding],
  });
  const { request, calls } = syncIssueRequest([trackedIssue], {
    createdIssueNumber: issueNumber,
  });

  const result = await syncIssue(report, {
    request,
    repository,
    runId: "12345",
    runAttempt: "1",
    dryRun: false,
  });

  assert.equal(result.action, "created");
  assert.deepEqual(result.finding_keys, findingKeys([newFinding]));
  assert.equal(result.finding_fingerprint, findingFingerprint([newFinding]));
  assert.deepEqual(result.covered_by_issue_numbers, [40]);
  assert.equal(calls.some((call) => call.method === "PATCH"), false);
  const create = calls.find((call) => call.method === "POST");
  assert.ok(create);
  assert.equal(
    create.body.body.split("\n")[0],
    cycleMarkerV2([newFinding], {
      cycle: result.remediation_cycle,
    })
  );
  assert.match(create.body.body, /Excluded as already tracked.*#40/);
  assert.doesNotMatch(create.body.body, /starrail raw notice/);
  assert.match(create.body.body, /genshin raw notice/);

  report.issue = result;
  const fixInput = buildAgenticFixInput(report);
  assert.equal(fixInput.findings.length, 1);
  assert.equal(fixInput.findings[0].game, "genshin");
  assert.deepEqual(fixInput.target_games, ["genshin"]);
  assert.deepEqual(fixInput.allowed_files, [
    "apps/api/src/games/genshin.ts",
  ]);
  assert.equal(fixInput.finding_fingerprint, findingFingerprint([newFinding]));
  assert.equal(
    fixInput.fix_branch,
    getFixBranch(
      findingFingerprint([newFinding]),
      issueNumber,
      reviewBaseSha
    )
  );
});

test("rejects overlapping coverage across existing open managed Issues", async () => {
  const sharedFinding = finding("starrail");
  const report = agenticReviewReport([sharedFinding]);
  delete report.issue;
  const issues = [
    managedIssue({
      number: 40,
      findings: [sharedFinding],
      cycleFindings: [sharedFinding, finding("genshin")],
    }),
    managedIssue({
      number: 41,
      findings: [sharedFinding],
      cycle: "8".repeat(64),
      cycleFindings: [sharedFinding, finding("ww")],
    }),
  ];
  const { request, calls } = syncIssueRequest(issues);

  await assert.rejects(
    () =>
      syncIssue(report, {
        request,
        repository,
        runId: "12345",
        runAttempt: "1",
        dryRun: false,
      }),
    /overlapping finding coverage/
  );
  assert.equal(calls.some((call) => ["POST", "PATCH"].includes(call.method)), false);
});

test("fails closed when v2 coverage is malformed or changes during reconciliation", async () => {
  const findings = [finding("starrail"), finding("genshin")];
  const report = agenticReviewReport(findings);
  delete report.issue;
  const validIssue = managedIssue({ number: 40, findings });
  const keys = findingKeys(findings);
  const malformedIssue = {
    ...validIssue,
    body:
      `<!-- upstream-review-cycle:v2 fingerprint=${findingFingerprint(findings)} cycle=${remediationCycle} coverage=${findingCoverageFingerprint(findings)} keys=${[...keys].reverse().join(",")} -->\n\nManaged Issue.\n`,
  };
  const malformedFixture = syncIssueRequest([malformedIssue]);
  await assert.rejects(
    () =>
      syncIssue(report, {
        request: malformedFixture.request,
        repository,
        runId: "12345",
        runAttempt: "1",
        dryRun: false,
      }),
    /sorted and unique/
  );
  assert.equal(
    malformedFixture.calls.some((call) =>
      ["POST", "PATCH"].includes(call.method)
    ),
    false
  );

  const mismatchedCoverageIssue = {
    ...validIssue,
    body: validIssue.body.replace(
      /coverage=[a-f0-9]{64}/,
      `coverage=${"f".repeat(64)}`
    ),
  };
  const mismatchedFixture = syncIssueRequest([mismatchedCoverageIssue]);
  await assert.rejects(
    () =>
      syncIssue(report, {
        request: mismatchedFixture.request,
        repository,
        runId: "12345",
        runAttempt: "1",
        dryRun: false,
      }),
    /coverage fingerprint does not match/
  );
  assert.equal(
    mismatchedFixture.calls.some((call) =>
      ["POST", "PATCH"].includes(call.method)
    ),
    false
  );

  const closedMalformedFixture = syncIssueRequest([
    { ...mismatchedCoverageIssue, state: "closed" },
  ]);
  const closedMalformedResult = await syncIssue(report, {
    request: closedMalformedFixture.request,
    repository,
    runId: "12345",
    runAttempt: "1",
    dryRun: false,
  });
  assert.equal(closedMalformedResult.action, "created");
  assert.equal(
    closedMalformedResult.regression_of_issue_number,
    null
  );

  const calls = [];
  const request = async (pathname, init = {}) => {
    const method = String(init.method ?? "GET").toUpperCase();
    calls.push({ pathname, method });
    if (pathname.startsWith(`/repos/${repository}/issues?`)) {
      return [validIssue];
    }
    if (pathname === `/repos/${repository}/issues/40`) {
      return { ...validIssue, state: "closed" };
    }
    throw new Error(`Unexpected GitHub request: ${method} ${pathname}`);
  };
  await assert.rejects(
    () =>
      syncIssue(report, {
        request,
        repository,
        runId: "12345",
        runAttempt: "1",
        dryRun: false,
      }),
    /unexpected managed Issue snapshot/
  );
  assert.equal(calls.some((call) => ["POST", "PATCH"].includes(call.method)), false);
});

test("supports an exact legacy open cycle but fails closed for unknown legacy overlap", async () => {
  const starrailFinding = finding("starrail");
  const exactReport = agenticReviewReport([starrailFinding]);
  delete exactReport.issue;
  const legacyIssue = managedIssue({
    number: 40,
    findings: [starrailFinding],
    version: "v1",
  });
  const exactFixture = syncIssueRequest([legacyIssue]);
  const exactResult = await syncIssue(exactReport, {
    request: exactFixture.request,
    repository,
    runId: "12345",
    runAttempt: "1",
    dryRun: false,
  });
  assert.equal(exactResult.action, "covered");
  assert.deepEqual(exactResult.covered_by_issue_numbers, [40]);

  const expandedReport = agenticReviewReport([
    starrailFinding,
    finding("genshin"),
  ]);
  delete expandedReport.issue;
  const expandedFixture = syncIssueRequest([legacyIssue]);
  await assert.rejects(
    () =>
      syncIssue(expandedReport, {
        request: expandedFixture.request,
        repository,
        runId: "12345",
        runAttempt: "1",
        dryRun: false,
      }),
    /legacy Open managed Issue/
  );
  assert.equal(
    expandedFixture.calls.some((call) =>
      ["POST", "PATCH"].includes(call.method)
    ),
    false
  );
});

test("does not create a duplicate beside unmatched identity-v1 Issue coverage", async () => {
  const legacyFinding = finding("starrail");
  const legacyIdentityIssue = managedIssue({
    number: 40,
    findings: [legacyFinding],
  });

  const exactReport = agenticReviewReportV3("starrail");
  delete exactReport.issue;
  const exactFixture = syncIssueRequest([legacyIdentityIssue]);
  const exactResult = await syncIssue(exactReport, {
    request: exactFixture.request,
    repository,
    runId: "12345",
    runAttempt: "1",
    dryRun: false,
  });
  assert.equal(exactResult.action, "covered");
  assert.deepEqual(exactResult.covered_by_issue_numbers, [40]);

  const driftedReport = agenticReviewReportV3("starrail");
  delete driftedReport.issue;
  driftedReport.review.findings[0] = {
    ...driftedReport.review.findings[0],
    title: "Revised Star Rail notice wording",
    raw_title: "Revised Star Rail notice wording",
  };
  const driftedFixture = syncIssueRequest([legacyIdentityIssue]);
  await assert.rejects(
    () =>
      syncIssue(driftedReport, {
        request: driftedFixture.request,
        repository,
        runId: "12345",
        runAttempt: "2",
        dryRun: false,
      }),
    /legacy identity-v1 Open managed Issue coverage is unmatched/
  );
  assert.equal(
    driftedFixture.calls.some((call) =>
      ["POST", "PATCH"].includes(call.method)
    ),
    false
  );
});

test("creates a new remediation Issue instead of reopening a closed cycle", async () => {
  const findings = [finding("starrail")];
  const report = agenticReviewReport(findings);
  const findingFingerprint =
    buildAgenticFixInput(report).finding_fingerprint;
  delete report.issue;
  const closedCycle = "7".repeat(64);
  const closedIssue = {
    number: 39,
    html_url: `https://github.com/${repository}/issues/39`,
    title: "Upstream Review Alerts",
    state: "closed",
    body: `${cycleMarker(findingFingerprint, closedCycle)}\n`,
    user: { login: "github-actions[bot]" },
  };
  const createdIssueNumber = 43;
  const createdIssueUrl =
    `https://github.com/${repository}/issues/${createdIssueNumber}`;
  const calls = [];
  const request = async (pathname, init = {}) => {
    const method = String(init.method ?? "GET").toUpperCase();
    const body = parseRequestBody(init);
    calls.push({ pathname, method, body });
    if (
      method === "GET" &&
      pathname.startsWith(`/repos/${repository}/issues?`)
    ) {
      return [closedIssue];
    }
    if (
      method === "POST" &&
      pathname === `/repos/${repository}/issues`
    ) {
      return {
        number: createdIssueNumber,
        html_url: createdIssueUrl,
        title: body.title,
        body: body.body,
        state: "open",
        user: { login: "github-actions[bot]" },
      };
    }
    throw new Error(`Unexpected GitHub request: ${method} ${pathname}`);
  };

  const result = await syncIssue(report, {
    request,
    repository,
    runId: "67890",
    runAttempt: "1",
    dryRun: false,
  });

  assert.equal(result.issue_number, createdIssueNumber);
  assert.equal(result.issue_url, createdIssueUrl);
  assert.match(result.remediation_cycle, /^[a-f0-9]{64}$/);
  assert.notEqual(result.remediation_cycle, closedCycle);
  assert.equal(calls.some((call) => call.method === "PATCH"), false);
  const create = calls.find((call) => call.method === "POST");
  assert.ok(create);
  assert.equal(
    create.body.body.split("\n")[0],
    cycleMarkerV2(findings, {
      findingFingerprint,
      coverageFingerprint: findingCoverageFingerprint(findings),
      cycle: result.remediation_cycle,
    })
  );
  assert.match(create.body.body, /Regression of: #39/);
});

test("does not query or mutate GitHub when a review has no findings", async () => {
  const report = agenticReviewReport([]);
  delete report.issue;
  let requestCount = 0;

  const result = await syncIssue(report, {
    request: async () => {
      requestCount += 1;
      throw new Error("A clean review must not call GitHub");
    },
    repository,
    runId: "12345",
    runAttempt: "1",
    dryRun: false,
  });

  assert.equal(result.action, "noop");
  assert.equal(requestCount, 0);
});

test("closes an exact all-addressed remediation Issue after its PR merges", async () => {
  const fixture = remediationFinalizationFixture();

  await finalizeRemediationIssue(fixture.args);

  const updates = fixture.calls.filter((call) => call.method === "PATCH");
  assert.equal(updates.length, 1);
  assert.equal(
    updates[0].pathname,
    `/repos/${repository}/issues/${issueNumber}`
  );
  assert.equal(updates[0].body.state, "closed");
  assert.equal(updates[0].body.state_reason, "completed");
});

test("rejects remediation finalization when the squash commit is off-base", async () => {
  const fixture = remediationFinalizationFixture({
    mergeParentSha: "e".repeat(40),
  });

  await assert.rejects(
    () => finalizeRemediationIssue(fixture.args),
    /does not match the trusted base and result tree/
  );
  assert.equal(
    fixture.calls.some((call) => call.method === "PATCH"),
    false
  );
});

test("rejects remediation finalization when the squash tree differs from the verified patch", async () => {
  const findings = [finding("starrail")];
  const report = agenticReviewReport(findings);
  const fixInput = buildAgenticFixInput(report);
  const patch = Buffer.from("verified tree-bound patch");
  const changedFiles = ["apps/api/src/games/starrail.ts"];
  const fixOutput = agentFixOutput(fixInput, changedFiles);
  const manifest = fixManifest(fixInput, changedFiles, patch);
  const metadata = parseAgentFixOutput(
    JSON.stringify(fixOutput),
    fixInput,
    changedFiles
  );
  const pullRequestBody = renderFixPrBody(metadata, manifest, {
    repository,
    runId: "12345",
    patchSha256: manifest.patch_sha256,
    issueUrl,
  });
  const fixture = remediationFinalizationFixture({
    findingFingerprint: fixInput.finding_fingerprint,
    pullRequestBody,
    mergeTreeSha: "e".repeat(40),
    issueBody:
      `${cycleMarkerV2(findings, {
        findingFingerprint: fixInput.finding_fingerprint,
      })}\n\nIssue body.\n`,
  });

  await assert.rejects(
    () =>
      finalizeRemediationIssue({
        ...fixture.args,
        runId: "12345",
        fixInput,
        fixAgentOutput: fixOutput,
        fixManifest: manifest,
        fixPatch: patch,
        report,
        approvedStage: "initial-review",
      }),
    /does not match the trusted base and result tree/
  );
  assert.equal(
    fixture.calls.some((call) => call.method === "PATCH"),
    false
  );
});

test("closes a v2 Issue from verified artifact file paths", async () => {
  const findings = [finding("starrail")];
  const report = agenticReviewReport(findings);
  const fixInput = buildAgenticFixInput(report);
  const patch = Buffer.from("verified full patch");
  const changedFiles = ["apps/api/src/games/starrail.ts"];
  const fixOutput = agentFixOutput(fixInput, changedFiles);
  const manifest = fixManifest(fixInput, changedFiles, patch);
  const metadata = parseAgentFixOutput(
    JSON.stringify(fixOutput),
    fixInput,
    changedFiles
  );
  const pullRequestBody = renderFixPrBody(metadata, manifest, {
    repository,
    runId: "12345",
    patchSha256: manifest.patch_sha256,
    issueUrl,
  });
  const fixture = remediationFinalizationFixture({
    allFindingsAddressed: true,
    findingFingerprint: fixInput.finding_fingerprint,
    pullRequestBody,
    issueBody:
      `${cycleMarkerV2(findings, {
        findingFingerprint: fixInput.finding_fingerprint,
      })}\n\nIssue body.\n`,
  });
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "game-cal-finalize-paths-")
  );
  const inputPath = path.join(tempDir, "upstream-review-fix-input.json");
  const agentOutputPath = path.join(
    tempDir,
    "upstream-review-fix-agent.json"
  );
  const manifestPath = path.join(tempDir, "manifest.json");
  const patchPath = path.join(tempDir, "fix.patch");
  const reportPath = path.join(tempDir, "upstream-review.json");
  try {
    await Promise.all([
      fs.writeFile(inputPath, `${JSON.stringify(fixInput)}\n`),
      fs.writeFile(agentOutputPath, `${JSON.stringify(fixOutput)}\n`),
      fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`),
      fs.writeFile(patchPath, patch),
      fs.writeFile(reportPath, `${JSON.stringify(report)}\n`),
    ]);

    const result = await finalizeRemediationIssue({
      ...fixture.args,
      runId: "12345",
      baseSha: reviewBaseSha,
      approvedStage: "initial-review",
      inputPath,
      agentOutputPath,
      manifestPath,
      patchPath,
      reportPath,
    });

    assert.equal(result.action, "closed");
    const update = fixture.calls.find((call) => call.method === "PATCH");
    assert.equal(update.body.state, "closed");
    assert.equal(update.body.state_reason, "completed");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("treats an Issue auto-closed by a merged PR as finalized", async () => {
  const fixture = remediationFinalizationFixture({
    issueState: "closed",
  });

  await finalizeRemediationIssue(fixture.args);

  assert.equal(
    fixture.calls.some((call) => call.method === "PATCH"),
    false
  );
});

test("keeps a partially addressed remediation Issue open after merge", async () => {
  const fixture = remediationFinalizationFixture({
    allFindingsAddressed: false,
  });

  await finalizeRemediationIssue(fixture.args);

  assert.equal(
    fixture.calls.some((call) => call.method === "PATCH"),
    false
  );
});

test("closes a v3 Issue when exact-head verification resolves an initially partial fix", async () => {
  const report = agenticReviewReportV3(["starrail", "genshin"]);
  const fixInput = buildAgenticFixInput(report);
  const changedFiles = [
    "apps/api/src/games/starrail.ts",
    "apps/api/src/games/parser-regressions.agent.test.ts",
  ];
  const initialPatch = Buffer.from("initial partial v3 patch");
  const initialManifest = validateFixManifest(
    fixManifest(fixInput, changedFiles, initialPatch),
    fixInput,
    initialPatch,
    reviewBaseSha
  );
  const fixOutput = agentFixOutput(fixInput, changedFiles);
  const metadata = parseAgentFixOutput(
    JSON.stringify(fixOutput),
    fixInput,
    changedFiles
  );
  assert.equal(
    metadata.outcomes.some((outcome) => outcome.status === "not_fixed"),
    true
  );
  const pullRequestBody = renderFixPrBody(metadata, initialManifest, {
    repository,
    runId: "12345",
    patchSha256: initialManifest.patch_sha256,
    issueUrl,
  });

  const terminalPatch = Buffer.from("terminal cumulative v3 rework patch");
  const terminalManifest = validateFixManifest(
    fixManifest(fixInput, changedFiles, terminalPatch, {
      result_tree: "1".repeat(40),
    }),
    fixInput,
    terminalPatch,
    reviewBaseSha
  );
  const headSha = "b".repeat(40);
  const verificationInput = boundRemediationVerificationInput(
    fixInput,
    terminalManifest,
    { headSha }
  );
  const verificationResult =
    resolvedRemediationVerificationResult(verificationInput);
  const fixture = remediationFinalizationFixture({
    allFindingsAddressed: false,
    findingFingerprint: fixInput.finding_fingerprint,
    pullRequestBody,
    headSha,
    mergeTreeSha: terminalManifest.result_tree,
    issueBody:
      `${cycleMarkerV3(report.review.findings, {
        findingFingerprint: fixInput.finding_fingerprint,
      })}\n\nIssue body.\n`,
  });

  const result = await finalizeRemediationIssue({
    ...fixture.args,
    runId: "12345",
    baseSha: reviewBaseSha,
    approvedStage: "rework-round-1",
    fixInput,
    fixAgentOutput: fixOutput,
    fixManifest: initialManifest,
    fixPatch: initialPatch,
    report,
    approvedFixInput: fixInput,
    approvedFixManifest: terminalManifest,
    approvedFixPatch: terminalPatch,
    verificationInput,
    verificationResult,
  });

  assert.equal(result.action, "closed");
  const update = fixture.calls.find((call) => call.method === "PATCH");
  assert.equal(update.body.state, "closed");
  assert.equal(update.body.state_reason, "completed");
});

test("shrinks v2 Issue coverage to unresolved findings after a partial merge", async () => {
  const fixedFinding = finding("starrail");
  const unresolvedFinding = finding("genshin");
  const report = agenticReviewReport([fixedFinding, unresolvedFinding]);
  const fixInput = buildAgenticFixInput(report);
  const patch = Buffer.from("verified patch");
  const changedFiles = ["apps/api/src/games/starrail.ts"];
  const fixOutput = agentFixOutput(fixInput, changedFiles);
  const manifest = fixManifest(fixInput, changedFiles, patch);
  const metadata = parseAgentFixOutput(
    JSON.stringify(fixOutput),
    fixInput,
    changedFiles
  );
  const pullRequestBody = renderFixPrBody(metadata, manifest, {
    repository,
    runId: "12345",
    patchSha256: manifest.patch_sha256,
    issueUrl,
  });
  const originalIssueBody =
    `${cycleMarkerV2([fixedFinding, unresolvedFinding], {
      findingFingerprint: fixInput.finding_fingerprint,
      coverageFingerprint:
        findingCoverageFingerprint([fixedFinding, unresolvedFinding]),
    })}\n\nIssue body.\n`;
  const fixture = remediationFinalizationFixture({
    allFindingsAddressed: false,
    findingFingerprint: fixInput.finding_fingerprint,
    pullRequestBody,
    issueBody: originalIssueBody,
  });

  const result = await finalizeRemediationIssue({
    ...fixture.args,
    runId: "12345",
    baseSha: reviewBaseSha,
    approvedStage: "initial-review",
    fixInput,
    fixAgentOutput: fixOutput,
    fixManifest: manifest,
    fixPatch: patch,
    report,
  });

  assert.equal(result.action, "coverage_reduced");
  assert.deepEqual(result.finding_keys, findingKeys([unresolvedFinding]));
  const update = fixture.calls.find((call) => call.method === "PATCH");
  assert.ok(update);
  assert.equal(Object.hasOwn(update.body, "state"), false);
  assert.equal(
    update.body.body.split("\n")[0],
    cycleMarkerV2([unresolvedFinding], {
      findingFingerprint: fixInput.finding_fingerprint,
      coverageFingerprint: findingCoverageFingerprint([unresolvedFinding]),
    })
  );
  assert.match(update.body.body, /genshin raw notice/);
  assert.doesNotMatch(update.body.body, /starrail raw notice/);

  const repeatedFixture = remediationFinalizationFixture({
    allFindingsAddressed: false,
    findingFingerprint: fixInput.finding_fingerprint,
    pullRequestBody,
    issueBody: update.body.body,
  });
  const repeatedResult = await finalizeRemediationIssue({
    ...repeatedFixture.args,
    runId: "12345",
    baseSha: reviewBaseSha,
    approvedStage: "initial-review",
    fixInput,
    fixAgentOutput: fixOutput,
    fixManifest: manifest,
    fixPatch: patch,
    report,
  });
  assert.equal(repeatedResult.action, "already_reduced");
  assert.equal(
    repeatedFixture.calls.some((call) => call.method === "PATCH"),
    false
  );

  const downgradedFixture = remediationFinalizationFixture({
    allFindingsAddressed: false,
    findingFingerprint: fixInput.finding_fingerprint,
    pullRequestBody,
    issueBody:
      `${cycleMarker(fixInput.finding_fingerprint, remediationCycle)}\n\nIssue body.\n`,
  });
  await assert.rejects(
    () =>
      finalizeRemediationIssue({
        ...downgradedFixture.args,
        runId: "12345",
        baseSha: reviewBaseSha,
        approvedStage: "initial-review",
        fixInput,
        fixAgentOutput: fixOutput,
        fixManifest: manifest,
        fixPatch: patch,
        report,
      }),
    /require a v2 managed Issue marker/
  );
  assert.equal(
    downgradedFixture.calls.some((call) => call.method === "PATCH"),
    false
  );

  const reworkFixture = remediationFinalizationFixture({
    allFindingsAddressed: false,
    findingFingerprint: fixInput.finding_fingerprint,
    pullRequestBody,
    issueBody: originalIssueBody,
  });
  const reworkResult = await finalizeRemediationIssue({
    ...reworkFixture.args,
    runId: "12345",
    baseSha: reviewBaseSha,
    approvedStage: "rework-round-1",
    fixInput,
    fixAgentOutput: fixOutput,
    fixManifest: manifest,
    fixPatch: patch,
    report,
  });
  assert.equal(reworkResult.action, "left_open_after_rework");
  assert.equal(reworkResult.approved_stage, "rework-round-1");
  assert.deepEqual(
    reworkResult.finding_keys,
    findingKeys([fixedFinding, unresolvedFinding])
  );
  assert.equal(
    reworkFixture.calls.some((call) => call.method === "PATCH"),
    false
  );

  const shrunkIssue = {
    number: issueNumber,
    html_url: issueUrl,
    title: update.body.title,
    body: update.body.body,
    state: "open",
    user: { login: "github-actions[bot]" },
  };
  const regressionReport = agenticReviewReport([fixedFinding]);
  delete regressionReport.issue;
  const regressionFixture = syncIssueRequest([shrunkIssue], {
    createdIssueNumber: 91,
  });
  const regressionResult = await syncIssue(regressionReport, {
    request: regressionFixture.request,
    repository,
    runId: "99999",
    runAttempt: "1",
    dryRun: false,
  });
  assert.equal(regressionResult.action, "created");
  assert.deepEqual(regressionResult.finding_keys, findingKeys([fixedFinding]));

  const unresolvedReport = agenticReviewReport([unresolvedFinding]);
  delete unresolvedReport.issue;
  const unresolvedFixture = syncIssueRequest([shrunkIssue]);
  const unresolvedResult = await syncIssue(unresolvedReport, {
    request: unresolvedFixture.request,
    repository,
    runId: "99999",
    runAttempt: "2",
    dryRun: false,
  });
  assert.equal(unresolvedResult.action, "covered");

  const closedShrunkIssue = { ...shrunkIssue, state: "closed" };
  const closedRegressionReport = agenticReviewReport([unresolvedFinding]);
  delete closedRegressionReport.issue;
  const closedRegressionFixture = syncIssueRequest([closedShrunkIssue], {
    createdIssueNumber: 92,
  });
  const closedRegressionResult = await syncIssue(closedRegressionReport, {
    request: closedRegressionFixture.request,
    repository,
    runId: "99999",
    runAttempt: "3",
    dryRun: false,
  });
  assert.equal(closedRegressionResult.action, "created");
  assert.equal(
    closedRegressionResult.regression_of_issue_number,
    issueNumber
  );
});

test("refuses to finalize an Issue whose remediation marker changed", async () => {
  const fixture = remediationFinalizationFixture({
    issueBody: `${cycleMarker("e".repeat(64), remediationCycle)}\n`,
  });

  await assert.rejects(
    () => finalizeRemediationIssue(fixture.args),
    /managed Issue|fingerprint|marker|cycle/i
  );
  assert.equal(
    fixture.calls.some((call) => call.method === "PATCH"),
    false
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

test("final merge isolates approved-head runtime and commits merge outputs before finalization", async () => {
  const workflow = await fs.readFile(
    new URL("../.github/workflows/upstream-review.yml", import.meta.url),
    "utf8"
  );
  const resolveJobStart = workflow.indexOf("\n  resolve_approved_snapshot:\n");
  const collectJobStart = workflow.indexOf(
    "\n  collect_approved_runtime_input:\n",
    resolveJobStart
  );
  const verifyJobStart = workflow.indexOf(
    "\n  verify_approved_runtime_input:\n",
    collectJobStart
  );
  const mergeJobStart = workflow.indexOf(
    "\n  finalize_approved_pr:\n",
    verifyJobStart
  );
  const finalIssueJobStart = workflow.indexOf(
    "\n  finalize_remediation_issue:\n",
    mergeJobStart
  );
  const initialCollectStart = workflow.indexOf("\n  collect:\n");
  const initialReviewStart = workflow.indexOf(
    "\n  review:\n",
    initialCollectStart
  );

  assert.notEqual(resolveJobStart, -1);
  assert.notEqual(collectJobStart, -1);
  assert.notEqual(verifyJobStart, -1);
  assert.notEqual(mergeJobStart, -1);
  assert.notEqual(finalIssueJobStart, -1);
  assert.notEqual(initialCollectStart, -1);
  assert.notEqual(initialReviewStart, -1);

  const initialCollectJob = workflow.slice(
    initialCollectStart,
    initialReviewStart
  );
  const resolveJob = workflow.slice(resolveJobStart, collectJobStart);
  const collectJob = workflow.slice(collectJobStart, verifyJobStart);
  const verifyJob = workflow.slice(verifyJobStart, mergeJobStart);
  const mergeJob = workflow.slice(mergeJobStart, finalIssueJobStart);

  assert.match(initialCollectJob, /pnpm install --frozen-lockfile/);
  assert.doesNotMatch(initialCollectJob, /pnpm install --no-lockfile/);
  assert.match(
    workflow,
    /- name: Refuse stale review publication[\s\S]*?current_tip[\s\S]*?no Issue will be changed/
  );

  assert.match(
    resolveJob,
    /permissions:\n      contents: read\n      pull-requests: read/
  );
  assert.match(
    resolveJob,
    /GH_TOKEN: \$\{\{ secrets\.UPSTREAM_REVIEW_APPROVAL_TOKEN \}\}/
  );
  assert.doesNotMatch(resolveJob, /uses: actions\/checkout@/);
  assert.doesNotMatch(resolveJob, /secrets\.OPENAI_/);

  assert.match(
    collectJob,
    /permissions:\n      actions: read\n      contents: read/
  );
  assert.match(
    collectJob,
    /- name: Check out the trusted base[\s\S]*?ref: \$\{\{ github\.sha \}\}[\s\S]*?persist-credentials: false/
  );
  assert.match(
    collectJob,
    /- name: Check out the exact approved head in an isolated subdirectory[\s\S]*?ref: \$\{\{ needs\.resolve_approved_snapshot\.outputs\.head_sha \}\}[\s\S]*?path: approved-head[\s\S]*?persist-credentials: false/
  );
  assert.match(
    collectJob,
    /verifyAgenticFixArtifactAtHead\(\{\s+cwd: process\.env\.APPROVED_WORKSPACE/
  );
  assert.match(
    collectJob,
    /prepareRemediationVerification\(\{\s+cwd: process\.env\.APPROVED_WORKSPACE/
  );
  const allowlistVerification = collectJob.indexOf(
    "verifyAgenticFixArtifactAtHead"
  );
  const dependencyInstall = collectJob.indexOf(
    "npm install --global --prefix /work/pnpm pnpm@9.9.0"
  );
  assert.notEqual(allowlistVerification, -1);
  assert.notEqual(dependencyInstall, -1);
  assert.ok(allowlistVerification < dependencyInstall);
  assert.match(collectJob, /--user 1000:1000/);
  assert.match(collectJob, /--read-only/);
  assert.match(collectJob, /--cap-drop ALL/);
  assert.match(collectJob, /--security-opt no-new-privileges=true/);
  assert.match(collectJob, /--pids-limit 256/);
  assert.match(collectJob, /--memory 2g/);
  assert.match(
    collectJob,
    /--mount "type=bind,src=\$APPROVED_WORKSPACE,dst=\/approved,readonly"/
  );
  assert.equal(collectJob.match(/^\s+--mount /gm)?.length, 2);
  const testContainerStart = collectJob.indexOf(
    "      - name: Test the approved head in a disposable locked-down container"
  );
  const runtimeContainerStart = collectJob.indexOf(
    "      - name: Start the approved API from a fresh locked-down container"
  );
  const healthStepStart = collectJob.indexOf(
    "      - name: Wait for approved API health"
  );
  assert.notEqual(testContainerStart, -1);
  assert.notEqual(runtimeContainerStart, -1);
  assert.notEqual(healthStepStart, -1);
  const testContainerStep = collectJob.slice(
    testContainerStart,
    runtimeContainerStart
  );
  const runtimeContainerStep = collectJob.slice(
    runtimeContainerStart,
    healthStepStart
  );
  assert.match(testContainerStep, /docker run \\\n            --rm/);
  assert.match(
    testContainerStep,
    /\/work\/pnpm\/bin\/pnpm test:game-parsers/
  );
  assert.doesNotMatch(
    testContainerStep,
    /--filter @game-cal\/api exec tsx src\/index\.ts/
  );
  assert.match(runtimeContainerStep, /docker run \\\n            --detach/);
  assert.match(
    runtimeContainerStep,
    /exec \/work\/pnpm\/bin\/pnpm --filter @game-cal\/api exec tsx src\/index\.ts/
  );
  assert.doesNotMatch(runtimeContainerStep, /test:game-parsers/);
  assert.equal(testContainerStep.match(/^\s+--mount /gm)?.length, 1);
  assert.equal(runtimeContainerStep.match(/^\s+--mount /gm)?.length, 1);
  assert.match(
    collectJob,
    /UPSTREAM_REVIEW_REMEDIATION_VERIFY_INPUT_PATH: artifacts\/upstream-remediation-verify-input\.json/
  );
  assert.doesNotMatch(
    collectJob,
    /UPSTREAM_REVIEW_REMEDIATION_VERIFY_INPUT_PATH: [^\n]*approved-head/
  );
  assert.match(
    collectJob,
    /- name: Stop and remove the approved runtime container\n        if: always\(\)[\s\S]*?docker rm --force/
  );
  assert.doesNotMatch(
    collectJob,
    /run: pnpm install|run: pnpm test:game-parsers|nohup pnpm/
  );
  assert.doesNotMatch(collectJob, /secrets\./);
  assert.doesNotMatch(collectJob, /contents: write|pull-requests: write/);

  assert.match(
    verifyJob,
    /permissions:\n      actions: read\n      contents: read/
  );
  assert.match(verifyJob, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(
    verifyJob,
    /openai-api-key: \$\{\{ secrets\.OPENAI_API_KEY \}\}/
  );
  assert.doesNotMatch(
    verifyJob,
    /UPSTREAM_REVIEW_APPROVAL_TOKEN|github\.token|contents: write|pull-requests: write/
  );
  assert.doesNotMatch(
    verifyJob,
    /pnpm install|pnpm test:game-parsers|Start the approved local API/
  );

  assert.match(mergeJob, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(mergeJob, /contents: write\n      pull-requests: write/);
  assert.match(
    mergeJob,
    /GH_TOKEN: \$\{\{ secrets\.UPSTREAM_REVIEW_APPROVAL_TOKEN \}\}/
  );
  assert.match(mergeJob, /MERGE_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(mergeJob, /secrets\.OPENAI_/);
  assert.doesNotMatch(
    mergeJob,
    /pnpm install|pnpm test:game-parsers|Start the approved local API/
  );
  const mergeStepStart = mergeJob.indexOf(
    "      - name: Mark ready and squash-merge the approved head"
  );
  assert.notEqual(mergeStepStart, -1);
  const mergeStep = mergeJob.slice(mergeStepStart);
  const mergeResponseValidation = mergeStep.indexOf(".merged == true");
  const mergedOutput = mergeStep.indexOf(
    'echo "merged=true" >> "$GITHUB_OUTPUT"'
  );
  assert.notEqual(mergeResponseValidation, -1);
  assert.notEqual(mergedOutput, -1);
  assert.ok(mergeResponseValidation < mergedOutput);
  assert.doesNotMatch(
    mergeStep.slice(mergedOutput),
    /gh api|exit 1/
  );
  assert.doesNotMatch(
    mergeStep,
    /upstream-review-merge-commit|upstream-review-merged-pr/
  );

  const start = workflow.indexOf(
    "      - name: Resolve and verify the exact approved PR snapshot"
  );
  const end = workflow.indexOf(
    "      - name: Mark ready and squash-merge the approved head",
    start
  );

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const approvalStep = workflow.slice(start, end);

  assert.match(
    approvalStep,
    /GH_TOKEN: \$\{\{ secrets\.UPSTREAM_REVIEW_APPROVAL_TOKEN \}\}/
  );
  assert.match(approvalStep, /MERGE_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(
    approvalStep,
    /jq -e '\.permissions\.admin == true' "\$reviewer_repository_path"/
  );
  assert.match(
    approvalStep,
    /if ! gh api "repos\/\$GH_REPO" > "\$reviewer_repository_path"; then/
  );
  assert.match(
    approvalStep,
    /if ! GH_TOKEN="\$MERGE_TOKEN" gh api "repos\/\$GH_REPO" > "\$merge_repository_path"; then/
  );
  assert.match(
    approvalStep,
    /jq -e '\.allow_squash_merge == true' "\$merge_repository_path"/
  );
  assert.doesNotMatch(
    approvalStep,
    /\.allow_squash_merge == true and\s+\.permissions\.admin == true/
  );
  assert.deepEqual(
    approvalStep.match(
      /(?:GH_TOKEN="\$MERGE_TOKEN" )?gh api "repos\/\$GH_REPO" > "\$[A-Za-z_]+"/g
    ),
    [
      'gh api "repos/$GH_REPO" > "$reviewer_repository_path"',
      'GH_TOKEN="$MERGE_TOKEN" gh api "repos/$GH_REPO" > "$merge_repository_path"',
      'GH_TOKEN="$MERGE_TOKEN" gh api "repos/$GH_REPO" > "$merge_repository_path"',
    ]
  );
});

test("final remediation Issue job survives intentionally skipped rework branches", async () => {
  const workflow = await fs.readFile(
    new URL("../.github/workflows/upstream-review.yml", import.meta.url),
    "utf8"
  );
  const jobStart = workflow.indexOf("\n  finalize_remediation_issue:\n");

  assert.notEqual(jobStart, -1);
  const finalizationJob = workflow.slice(jobStart);
  const conditionStart = finalizationJob.indexOf("    if: >-\n");
  const conditionEnd = finalizationJob.indexOf(
    "    runs-on:",
    conditionStart
  );

  assert.notEqual(conditionStart, -1);
  assert.notEqual(conditionEnd, -1);
  const condition = finalizationJob.slice(conditionStart, conditionEnd);

  assert.match(condition, /^    if: >-\n      always\(\) &&\n/);
  assert.match(
    condition,
    /needs\.finalize_approved_pr\.result == 'success'/
  );
  assert.match(
    condition,
    /needs\.finalize_approved_pr\.outputs\.merged == 'true'/
  );
});
