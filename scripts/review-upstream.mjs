import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const GENSHIN_LIST_API =
  "https://hk4e-api.mihoyo.com/common/hk4e_cn/announcement/api/getAnnList?game=hk4e&game_biz=hk4e_cn&lang=zh-cn&bundle_id=hk4e_cn&platform=pc&region=cn_gf01&level=55&uid=100000000";

const STARRAIL_LIST_API =
  "https://hkrpg-api-static.mihoyo.com/common/hkrpg_cn/announcement/api/getAnnList?game=hkrpg&game_biz=hkrpg_cn&lang=zh-cn&bundle_id=hkrpg_cn&platform=pc&region=prod_gf_cn&level=30&uid=11111111";

const ENDFIELD_WEBVIEW_URL =
  "https://ef-webview.hypergryph.com/page/game_bulletin?target=IOS";

const ENDFIELD_AGGREGATE_API =
  "https://game-hub.hypergryph.com/bulletin/v2/aggregate";

const ENDFIELD_CODE_FALLBACK = "endfield_5SD9TN";
const DEFAULT_API_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_MODEL = "gpt-5-mini";
const DEFAULT_ISSUE_TITLE = "Upstream Review Alerts";
const DEFAULT_SUPPRESSIONS_PATH = ".github/upstream-review-suppressions.json";
const DEFAULT_GAMES = ["genshin", "starrail", "endfield"];
const SUPPORTED_GAMES = new Set(DEFAULT_GAMES);
const GITHUB_API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 30_000;
const MODEL_TIMEOUT_MS = 120_000;

const GAME_LABELS = {
  genshin: "原神",
  starrail: "崩坏：星穹铁道",
  endfield: "明日方舟：终末地",
};

function trimTrailingSlash(input) {
  return input.replace(/\/+$/, "");
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseGameList(value) {
  if (!value?.trim()) return [...DEFAULT_GAMES];
  const out = [];
  for (const part of value.split(",")) {
    const game = part.trim();
    if (!SUPPORTED_GAMES.has(game) || out.includes(game)) continue;
    out.push(game);
  }
  return out.length > 0 ? out : [...DEFAULT_GAMES];
}

function parseMaxItems(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeWhitespace(input) {
  return String(input ?? "")
    .replace(/\\[rnt]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(input) {
  return normalizeWhitespace(
    String(input ?? "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h\d|li|tr)>/gi, "\n")
      .replace(/<(p|div|h\d|li|tr)[^>]*>/gi, "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
  );
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

async function request(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Request failed: ${res.status} ${res.statusText} for ${url}\n${text}`.trim());
  }

  return res;
}

async function requestJson(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const res = await request(url, init, timeoutMs);
  return await res.json();
}

async function requestText(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const res = await request(url, init, timeoutMs);
  return await res.text();
}

async function fetchApiEvents(apiBaseUrl, game) {
  const json = await requestJson(`${apiBaseUrl}/api/events/${game}`, {
    headers: { accept: "application/json" },
  });

  if (!isRecord(json) || Number(json.code) >= 400 || !Array.isArray(json.data)) {
    throw new Error(`Unexpected API response for ${game}`);
  }

  return json.data.map((item) => ({
    title: normalizeWhitespace(item?.title),
    start_time: String(item?.start_time ?? ""),
    end_time: String(item?.end_time ?? ""),
    is_gacha: Boolean(item?.is_gacha),
  }));
}

async function fetchGenshinRawNotices() {
  const json = await requestJson(GENSHIN_LIST_API);
  const categories = ensureArray(json?.data?.list);
  const eventCategory = categories.find((item) => item?.type_id === 1);
  const items = ensureArray(eventCategory?.list);

  return items.map((item) => ({
    ann_id: item?.ann_id ?? null,
    title: normalizeWhitespace(item?.title || item?.subtitle || ""),
    subtitle: normalizeWhitespace(item?.subtitle || ""),
    start_time: String(item?.start_time ?? ""),
    end_time: String(item?.end_time ?? ""),
  }));
}

function starRailMakeItemKey(item) {
  return [
    item.ann_id,
    item.title ?? "",
    item.subtitle ?? "",
    item.start_time ?? "",
    item.end_time ?? "",
    item.type ?? "",
    item.type_label ?? "",
  ].join("|");
}

function parseStarRailItem(raw) {
  if (!isRecord(raw) || typeof raw.ann_id !== "number") return null;
  return {
    ann_id: raw.ann_id,
    title: typeof raw.title === "string" ? raw.title : "",
    subtitle: typeof raw.subtitle === "string" ? raw.subtitle : "",
    start_time: typeof raw.start_time === "string" ? raw.start_time : "",
    end_time: typeof raw.end_time === "string" ? raw.end_time : "",
    type: typeof raw.type === "number" ? raw.type : null,
    type_label: typeof raw.type_label === "string" ? raw.type_label : "",
  };
}

function extractStarRailItems(list) {
  const out = new Map();
  for (const raw of list) {
    const item = parseStarRailItem(raw);
    if (!item) continue;
    out.set(starRailMakeItemKey(item), item);
  }
  return [...out.values()];
}

function parseStarRailCategory(raw) {
  if (!isRecord(raw) || typeof raw.type_id !== "number" || !Array.isArray(raw.list)) {
    return null;
  }

  return {
    type_id: raw.type_id,
    type_label: typeof raw.type_label === "string" ? raw.type_label : "",
    list: extractStarRailItems(raw.list),
  };
}

function collectStarRailCategories(node, out) {
  if (!isRecord(node)) return;

  const category = parseStarRailCategory(node);
  const list = ensureArray(node.list);
  if (category) {
    out.push(category);
  } else if (list.length > 0) {
    const fallbackItems = extractStarRailItems(list);
    if (fallbackItems.length > 0) {
      out.push({
        type_id: 0,
        type_label: typeof node.type_label === "string" ? node.type_label : "",
        list: fallbackItems,
      });
    }
  }

  for (const item of list) collectStarRailCategories(item, out);
  for (const item of ensureArray(node.type_list)) collectStarRailCategories(item, out);
  for (const item of ensureArray(node.pic_list)) collectStarRailCategories(item, out);
}

function getStarRailSelectedItems(categories) {
  const byKey = new Map();

  const isCategorySelected = (category) => {
    if (category.type_id === 3 || category.type_id === 4) return true;
    return String(category.type_label ?? "").includes("公告") || String(category.type_label ?? "").includes("资讯");
  };

  const isItemSelected = (item) => {
    if (item.type === 3 || item.type === 4) return true;
    return String(item.type_label ?? "").includes("公告") || String(item.type_label ?? "").includes("资讯");
  };

  for (const category of categories) {
    const categorySelected = isCategorySelected(category);
    for (const item of ensureArray(category.list)) {
      if (!categorySelected && !isItemSelected(item)) continue;
      byKey.set(starRailMakeItemKey(item), item);
    }
  }

  return [...byKey.values()];
}

async function fetchStarRailRawNotices() {
  const json = await requestJson(STARRAIL_LIST_API);
  const categories = [];
  collectStarRailCategories(json?.data ?? null, categories);
  const items = getStarRailSelectedItems(categories);

  return items.map((item) => ({
    ann_id: item.ann_id,
    title: normalizeWhitespace(item.title || item.subtitle || ""),
    subtitle: normalizeWhitespace(item.subtitle || ""),
    start_time: String(item.start_time ?? ""),
    end_time: String(item.end_time ?? ""),
    type: item.type,
    type_label: item.type_label,
  }));
}

function extractEndfieldCommonsJsUrl(html) {
  const match = /<script[^>]+src="([^"]+\/commons\.[^"]+\.js)"/i.exec(html);
  if (match?.[1]) return match[1];
  return html.match(/https?:\/\/[^\s"'<>]+\/commons\.[^\s"'<>]+\.js/i)?.[0] ?? null;
}

function scoreEndfieldCodeCandidate(code) {
  const suffix = code.slice("endfield_".length);
  let score = suffix.length;
  if (/[0-9]/.test(suffix)) score += 10;
  if (/[A-Z]/.test(suffix)) score += 5;
  return score;
}

function extractEndfieldCodeFromCommonsJs(js) {
  const direct = /"code","(endfield_[A-Za-z0-9]+)"/.exec(js);
  if (direct?.[1]) return direct[1];

  const matches = js.match(/endfield_[A-Za-z0-9]+/g) ?? [];
  const candidates = matches.filter((item) => item !== "endfield_webview");
  candidates.sort((a, b) => scoreEndfieldCodeCandidate(b) - scoreEndfieldCodeCandidate(a));
  return candidates[0] ?? null;
}

async function fetchEndfieldCode() {
  const override = process.env.ENDFIELD_CODE?.trim();
  if (override) return override;

  const webviewUrl = process.env.ENDFIELD_WEBVIEW_URL?.trim() || ENDFIELD_WEBVIEW_URL;
  try {
    const html = await requestText(webviewUrl);
    const commonsUrl = extractEndfieldCommonsJsUrl(html);
    if (!commonsUrl) throw new Error("Missing commons js url");
    const commonsJs = await requestText(commonsUrl);
    return extractEndfieldCodeFromCommonsJs(commonsJs) ?? ENDFIELD_CODE_FALLBACK;
  } catch {
    return ENDFIELD_CODE_FALLBACK;
  }
}

async function fetchEndfieldRawNotices() {
  const aggregateBase = process.env.ENDFIELD_AGGREGATE_API_URL?.trim() || ENDFIELD_AGGREGATE_API;
  const code = await fetchEndfieldCode();
  const url = new URL(aggregateBase);
  url.searchParams.set("type", "0");
  url.searchParams.set("code", code);
  url.searchParams.set("hideDetail", "0");

  const json = await requestJson(url.toString());
  const items = ensureArray(json?.data?.list)
    .filter((item) => {
      const tab = String(item?.tab ?? "").toLowerCase();
      return tab === "event" || tab === "events";
    })
    .map((item) => ({
      cid: String(item?.cid ?? ""),
      tab: String(item?.tab ?? ""),
      title: normalizeWhitespace(item?.title || item?.header || ""),
      header: normalizeWhitespace(item?.header || ""),
      start_at: item?.startAt ?? null,
      has_detail: Boolean(item?.data?.html),
      snippet: stripHtml(item?.data?.html ?? "").slice(0, 220),
    }));

  return items;
}

async function fetchRawNotices(game) {
  switch (game) {
    case "genshin":
      return await fetchGenshinRawNotices();
    case "starrail":
      return await fetchStarRailRawNotices();
    case "endfield":
      return await fetchEndfieldRawNotices();
    default:
      throw new Error(`Unsupported game: ${game}`);
  }
}

function buildGameDataset(game, rawNotices, apiEvents, maxItems) {
  return {
    game,
    game_label: GAME_LABELS[game] ?? game,
    notes:
      game === "endfield"
        ? "Endfield API events may include events parsed from version update notices and not only standalone event bulletins. Do not flag Endfield items merely because they lack a standalone raw bulletin match."
        : "Compare raw upstream notices with current API output. Be conservative and only flag clear issues.",
    raw_notice_count: rawNotices.length,
    api_event_count: apiEvents.length,
    raw_notices: rawNotices.slice(0, maxItems),
    api_events: apiEvents.slice(0, maxItems),
  };
}

function extractJsonObjectFromText(input) {
  const text = String(input ?? "").trim();
  if (!text) {
    throw new Error("Model returned empty content");
  }

  try {
    return JSON.parse(text);
  } catch {}

  const fenced = /```(?:json)?\s*([\s\S]+?)```/i.exec(text);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {}
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(text.slice(start, end + 1));
  }

  throw new Error("Failed to parse JSON from model response");
}

function normalizeFinding(raw) {
  const game = SUPPORTED_GAMES.has(raw?.game) ? raw.game : "unknown";
  const severity = ["high", "medium", "low"].includes(raw?.severity) ? raw.severity : "medium";
  const confidence = ["high", "medium", "low"].includes(raw?.confidence) ? raw.confidence : "medium";
  const kind = typeof raw?.kind === "string" && raw.kind ? raw.kind : "other";
  return {
    game,
    severity,
    confidence,
    kind,
    title: normalizeWhitespace(raw?.title || ""),
    raw_title: normalizeWhitespace(raw?.raw_title || ""),
    api_title: normalizeWhitespace(raw?.api_title || ""),
    start_time: String(raw?.start_time ?? ""),
    end_time: String(raw?.end_time ?? ""),
    reason: normalizeWhitespace(raw?.reason || ""),
  };
}

function getFindingTitleCandidates(finding) {
  return [...new Set([finding.api_title, finding.raw_title, finding.title].filter(Boolean))];
}

function normalizeSuppression(raw, index) {
  if (!isRecord(raw)) {
    throw new Error(`Invalid suppression at index ${index}`);
  }

  const game = raw.game == null || raw.game === "" ? null : String(raw.game).trim();
  if (game != null && !SUPPORTED_GAMES.has(game)) {
    throw new Error(`Invalid suppression game at index ${index}: ${game}`);
  }

  const kind = raw.kind == null || raw.kind === "" ? null : String(raw.kind).trim();
  const titles = [...new Set(
    [raw.title, raw.api_title, raw.raw_title]
      .filter((value) => value != null && value !== "")
      .map((value) => normalizeWhitespace(value))
      .filter(Boolean)
  )];
  if (titles.length === 0) {
    throw new Error(`Suppression at index ${index} must include title, api_title, or raw_title`);
  }

  return {
    game,
    kind,
    titles,
    reason: normalizeWhitespace(raw.reason || ""),
  };
}

async function loadSuppressions(configPath) {
  const resolved = path.resolve(configPath);
  let text;
  try {
    text = await fs.readFile(resolved, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const parsed = JSON.parse(text);
  const list = ensureArray(parsed?.suppressions);
  return list.map((item, index) => normalizeSuppression(item, index));
}

function findMatchingSuppression(finding, suppressions) {
  const titles = getFindingTitleCandidates(finding);
  return (
    suppressions.find((suppression) => {
      if (suppression.game && suppression.game !== finding.game) return false;
      if (suppression.kind && suppression.kind !== finding.kind) return false;
      return suppression.titles.some((title) => titles.includes(title));
    }) ?? null
  );
}

function applySuppressions(findings, suppressions) {
  const filteredFindings = [];
  const suppressedFindings = [];

  for (const finding of findings) {
    const suppression = findMatchingSuppression(finding, suppressions);
    if (!suppression) {
      filteredFindings.push(finding);
      continue;
    }

    suppressedFindings.push({
      ...finding,
      suppression_reason: suppression.reason,
    });
  }

  return { filteredFindings, suppressedFindings };
}

function summarizeFilteredReview(summary, unsuppressedCount, suppressedCount) {
  if (suppressedCount === 0) return summary;
  if (unsuppressedCount === 0) {
    return `No unsuppressed findings. ${suppressedCount} finding(s) matched suppression rules.`;
  }
  return `${unsuppressedCount} unsuppressed finding(s) detected. ${suppressedCount} finding(s) matched suppression rules.`;
}

async function reviewWithOpenAi(payload) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const openAiBaseUrl = trimTrailingSlash(
    process.env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL
  );
  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
  const reasoningEffort = process.env.OPENAI_REASONING_EFFORT?.trim();
  const prompt = {
    current_time: payload.generated_at,
    instructions: [
      "Review the upstream notice snapshots against the current API event output.",
      "Only report issues that are likely real. Be conservative.",
      "Focus on: non-event notices incorrectly included, real events incorrectly filtered out, duplicate events, and clearly wrong time windows.",
      "Ignore pure style or wording preferences.",
      "For Endfield, API events may come from version-note extraction, so lack of a standalone raw notice is not enough to flag an issue.",
      "Return JSON only with shape { summary: string, findings: Finding[] }.",
      "Each Finding must include game, severity, confidence, kind, title, raw_title, api_title, start_time, end_time, reason.",
      "Use findings: [] when there is nothing clearly wrong.",
    ],
    datasets: payload.datasets,
  };

  const response = await requestJson(
    `${openAiBaseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        temperature: 0,
        max_completion_tokens: 4000,
        messages: [
          {
            role: "system",
            content:
              "You review game event calendar filtering. Be cautious, concrete, and return JSON only.",
          },
          {
            role: "user",
            content: JSON.stringify(prompt),
          },
        ],
      }),
    },
    MODEL_TIMEOUT_MS
  );

  const content = response?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OpenAI response missing message content");
  }

  const parsed = extractJsonObjectFromText(content);
  const findings = ensureArray(parsed?.findings).map(normalizeFinding);
  return {
    model,
    summary: normalizeWhitespace(parsed?.summary || ""),
    findings,
    raw_response: content,
  };
}

function renderIssueBody(report) {
  const lines = [
    "# Upstream Review Alerts",
    "",
    `Last run: \`${report.generated_at}\``,
    `API base: \`${report.api_base_url}\``,
    `Model: \`${report.review.model}\``,
    "",
    "## Summary",
    report.review.summary || `${report.review.findings.length} finding(s) detected.`,
    "",
    "## Snapshot",
  ];

  for (const dataset of report.datasets) {
    lines.push(
      `- ${dataset.game_label}: raw notices ${dataset.raw_notice_count}, API events ${dataset.api_event_count}`
    );
  }

  lines.push("");
  lines.push("## Findings");

  if (report.review.findings.length === 0) {
    lines.push("No findings.");
  } else {
    let index = 1;
    for (const finding of report.review.findings) {
      const label = GAME_LABELS[finding.game] ?? finding.game;
      const title = finding.api_title || finding.raw_title || finding.title || "(untitled)";
      lines.push(
        `${index}. [${finding.severity}] ${label} / ${finding.kind} / \`${title}\``
      );
      if (finding.title && finding.title !== title) {
        lines.push(`Finding title: \`${finding.title}\``);
      }
      if (finding.api_title && finding.api_title !== title) {
        lines.push(`API title: \`${finding.api_title}\``);
      }
      if (finding.raw_title && finding.raw_title !== title && finding.raw_title !== finding.api_title) {
        lines.push(`Raw title: \`${finding.raw_title}\``);
      }
      if (finding.start_time || finding.end_time) {
        lines.push(`Window: \`${finding.start_time || "?"}\` -> \`${finding.end_time || "?"}\``);
      }
      lines.push(`Confidence: ${finding.confidence}`);
      lines.push(finding.reason || "No reason provided.");
      lines.push("");
      index += 1;
    }
  }

  lines.push("This issue is managed automatically by `scripts/review-upstream.mjs`.");
  return lines.join("\n").trim() + "\n";
}

async function githubRequest(pathname, init = {}) {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    throw new Error("Missing GITHUB_TOKEN");
  }

  return await requestJson(`https://api.github.com${pathname}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": GITHUB_API_VERSION,
      ...(init.headers ?? {}),
    },
  });
}

async function listAllRepositoryIssues(owner, repo) {
  const out = [];

  for (let page = 1; ; page += 1) {
    const issues = await githubRequest(
      `/repos/${owner}/${repo}/issues?state=all&per_page=100&page=${page}`
    );
    const list = ensureArray(issues);
    if (list.length === 0) break;
    out.push(...list);
    if (list.length < 100) break;
  }

  return out;
}

function parseRepoSlug() {
  const slug = process.env.GITHUB_REPOSITORY?.trim();
  if (!slug || !slug.includes("/")) {
    throw new Error("Missing GITHUB_REPOSITORY");
  }
  const [owner, repo] = slug.split("/");
  return { owner, repo };
}

async function syncIssue(report) {
  const dryRun = parseBoolean(process.env.UPSTREAM_REVIEW_DRY_RUN, false);
  if (dryRun) {
    return { action: "dry_run" };
  }

  const { owner, repo } = parseRepoSlug();
  const title = process.env.UPSTREAM_REVIEW_ISSUE_TITLE?.trim() || DEFAULT_ISSUE_TITLE;
  const issues = await listAllRepositoryIssues(owner, repo);
  const existing = ensureArray(issues).find(
    (issue) => !issue?.pull_request && issue?.title === title
  );
  const openExisting = existing?.state === "open" ? existing : null;

  if (report.review.findings.length === 0) {
    if (!openExisting) return { action: "noop" };

    await githubRequest(`/repos/${owner}/${repo}/issues/${openExisting.number}/comments`, {
      method: "POST",
      body: JSON.stringify({
        body: `No findings detected in scheduled run \`${report.generated_at}\`. Closing this issue.`,
      }),
    });

    await githubRequest(`/repos/${owner}/${repo}/issues/${openExisting.number}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
    return { action: "closed", issue_number: openExisting.number };
  }

  const body = renderIssueBody(report);
  if (existing) {
    const updated = await githubRequest(`/repos/${owner}/${repo}/issues/${existing.number}`, {
      method: "PATCH",
      body: JSON.stringify({
        title,
        body,
        state: "open",
      }),
    });
    return {
      action: existing.state === "open" ? "updated" : "reopened",
      issue_number: updated.number,
      issue_url: updated.html_url,
    };
  }

  const created = await githubRequest(`/repos/${owner}/${repo}/issues`, {
    method: "POST",
    body: JSON.stringify({ title, body }),
  });
  return {
    action: "created",
    issue_number: created.number,
    issue_url: created.html_url,
  };
}

async function writeReport(report, outputPath) {
  if (!outputPath) return;
  const resolved = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, JSON.stringify(report, null, 2) + "\n", "utf8");
}

async function main() {
  const apiBaseUrl = trimTrailingSlash(
    process.env.UPSTREAM_REVIEW_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL
  );
  const suppressionsPath =
    process.env.UPSTREAM_REVIEW_SUPPRESSIONS_PATH?.trim() || DEFAULT_SUPPRESSIONS_PATH;
  const games = parseGameList(process.env.UPSTREAM_REVIEW_GAMES);
  const maxItems = parseMaxItems(process.env.UPSTREAM_REVIEW_MAX_ITEMS, 60);
  const generatedAt = new Date().toISOString();

  const datasets = [];
  for (const game of games) {
    const [rawNotices, apiEvents] = await Promise.all([
      fetchRawNotices(game),
      fetchApiEvents(apiBaseUrl, game),
    ]);
    datasets.push(buildGameDataset(game, rawNotices, apiEvents, maxItems));
  }

  const suppressions = await loadSuppressions(suppressionsPath);
  const review = await reviewWithOpenAi({ generated_at: generatedAt, datasets });
  const { filteredFindings, suppressedFindings } = applySuppressions(review.findings, suppressions);
  const report = {
    generated_at: generatedAt,
    api_base_url: apiBaseUrl,
    datasets,
    suppressions: {
      path: suppressionsPath,
      count: suppressions.length,
    },
    review: {
      model: review.model,
      raw_summary: review.summary,
      summary: summarizeFilteredReview(
        review.summary,
        filteredFindings.length,
        suppressedFindings.length
      ),
      findings: filteredFindings,
      suppressed_findings: suppressedFindings,
    },
  };

  const issue = await syncIssue(report).catch((error) => ({
    action: "failed",
    error: error instanceof Error ? error.message : String(error),
  }));
  report.issue = issue;

  const reportPath = process.env.UPSTREAM_REVIEW_REPORT_PATH?.trim() || "";
  await writeReport(report, reportPath);

  console.log(JSON.stringify(report, null, 2));

  if (issue.action === "failed") {
    throw new Error(issue.error);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
