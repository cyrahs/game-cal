import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { isDeepStrictEqual, promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

const GENSHIN_LIST_API =
  "https://hk4e-api.mihoyo.com/common/hk4e_cn/announcement/api/getAnnList?game=hk4e&game_biz=hk4e_cn&lang=zh-cn&bundle_id=hk4e_cn&platform=pc&region=cn_gf01&level=55&uid=100000000";

const STARRAIL_LIST_API =
  "https://hkrpg-api-static.mihoyo.com/common/hkrpg_cn/announcement/api/getAnnList?game=hkrpg&game_biz=hkrpg_cn&lang=zh-cn&bundle_id=hkrpg_cn&platform=pc&region=prod_gf_cn&level=30&uid=11111111";

const STARRAIL_CONTENT_API =
  "https://hkrpg-api-static.mihoyo.com/common/hkrpg_cn/announcement/api/getAnnContent?game=hkrpg&game_biz=hkrpg_cn&lang=zh-cn&bundle_id=hkrpg_cn&platform=pc&region=prod_gf_cn&level=30&uid=11111111";

const WW_NOTICE_API =
  "https://aki-gm-resources-back.aki-game.com/gamenotice/G152/76402e5b20be2c39f095a152090afddc/zh-Hans.json";

const ZZZ_ACTIVITY_API =
  "https://announcement-static.mihoyo.com/common/nap_cn/announcement/api/getActivityList?uid=11111111&game=nap&game_biz=nap_cn&lang=zh-cn&bundle_id=nap_cn&channel_id=1&level=60&platform=pc&region=prod_gf_cn";

const ZZZ_LIST_API =
  "https://announcement-static.mihoyo.com/common/nap_cn/announcement/api/getAnnList?uid=11111111&game=nap&game_biz=nap_cn&lang=zh-cn&bundle_id=nap_cn&channel_id=1&level=60&platform=pc&region=prod_gf_cn";

const ZZZ_CONTENT_API =
  "https://announcement-static.mihoyo.com/common/nap_cn/announcement/api/getAnnContent?uid=11111111&game=nap&game_biz=nap_cn&lang=zh-cn&bundle_id=nap_cn&channel_id=1&level=60&platform=pc&region=prod_gf_cn";

const SNOWBREAK_ANNOUNCE_API =
  "https://cbjq-content.xoyocdn.com/ob202307/webfile/mainland/announce/config/pc_jinshan-pc_jinshan.json";

const ENDFIELD_WEBVIEW_URL =
  "https://ef-webview.hypergryph.com/page/game_bulletin?target=IOS";

const ENDFIELD_AGGREGATE_API =
  "https://game-hub.hypergryph.com/bulletin/v2/aggregate";

const ENDFIELD_CODE_FALLBACK = "endfield_5SD9TN";
const DEFAULT_API_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_ISSUE_TITLE = "Upstream Review Alerts";
const GITHUB_ACTIONS_LOGIN = "github-actions[bot]";
const ISSUE_MARKER_VERSION = "v2";
const LEGACY_ISSUE_MARKER_VERSION = "v1";
const FINDING_IDENTITY_VERSION = 3;
const FINDING_KEY_VERSION = "v3";
const FINDING_COVERAGE_VERSION = "v3";
const DEFAULT_SUPPRESSIONS_PATH = ".github/upstream-review-suppressions.json";
const DEFAULT_GAMES = ["genshin", "starrail", "ww", "zzz", "snowbreak", "endfield"];
const SUPPORTED_GAMES = new Set(DEFAULT_GAMES);
const SUPPORTED_FINDING_KINDS = new Set([
  "non_event_included",
  "missing_event",
  "duplicate_event",
  "wrong_time_window",
  "other",
]);
const GITHUB_API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 30_000;
const CHINA_TZ_OFFSET = "+08:00";
const RETRY_COUNT = 3;
const RETRY_BASE_DELAY_MS = 1_000;
const COLLECTION_POLICY_VERSION = 1;
const COLLECTION_REASON_CODES = new Set([
  "transport",
  "http_429",
  "http_5xx",
]);
const MAX_AGENT_FINDINGS = 50;
const MAX_AGENT_FINDINGS_PER_GAME = 8;
const MAX_AGENT_ERROR_LENGTH = 1_000;
const MAX_AGENT_SUMMARY_LENGTH = 2_000;
const MAX_AGENT_TITLE_LENGTH = 500;
const MAX_AGENT_TIME_LENGTH = 100;
const MAX_AGENT_REASON_LENGTH = 1_000;
const MAX_FINDING_EVIDENCE_REFS = 4;
const MAX_ISSUE_BODY_BYTES = 60_000;
const MAX_FIX_EVIDENCE_ITEMS = 4;
const MAX_FIX_PATCH_BYTES = 512_000;
const MAX_PR_REWORK_PATCH_BYTES = 128 * 1024;
const MAX_PR_REWORK_ROUNDS = 3;
const MAX_PR_REVIEW_CHANGED_FILES = 20;
const MAX_PR_REVIEW_FINDINGS = 20;
const MAX_PR_REVIEW_SUMMARY_LENGTH = 2_000;
const MAX_PR_REVIEW_TITLE_LENGTH = 200;
const MAX_PR_REVIEW_BODY_LENGTH = 2_000;
const MAX_PR_REVIEW_PATH_LENGTH = 500;
const MAX_PR_REVIEW_URL_LENGTH = 1_000;
const MAX_PR_REVIEW_LINE = 10_000_000;
const MAX_PR_REVIEW_BODY_BYTES = 60_000;
const FIX_WORKSPACE_ARTIFACTS = new Set([
  "artifacts/upstream-review-fix-input.json",
  "artifacts/upstream-review-fix-agent.json",
]);
const PR_REWORK_WORKSPACE_ARTIFACTS = new Set([
  "artifacts/upstream-review-fix-input.json",
  "artifacts/upstream-review-pr-review-input.json",
  "artifacts/upstream-review-pr-review-result.json",
  "artifacts/upstream-review-pr-rework-input.json",
  "artifacts/upstream-review-pr-rework-agent.json",
]);

const GAME_LABELS = {
  genshin: "原神",
  starrail: "崩坏：星穹铁道",
  ww: "鸣潮",
  zzz: "绝区零",
  snowbreak: "尘白禁区",
  endfield: "明日方舟：终末地",
};

const GAME_SOURCE_FILES = {
  genshin: "apps/api/src/games/genshin.ts",
  starrail: "apps/api/src/games/starrail.ts",
  ww: "apps/api/src/games/ww.ts",
  zzz: "apps/api/src/games/zzz.ts",
  snowbreak: "apps/api/src/games/snowbreak.ts",
  endfield: "apps/api/src/games/endfield.ts",
};
const AGENT_PARSER_REGRESSION_TEST_FILE =
  "apps/api/src/games/parser-regressions.agent.test.ts";
const TRUSTED_PARSER_REGRESSION_TEST_FILE =
  "apps/api/src/games/parser-regressions.trusted.test.ts";

function getAllowedFixFiles(targetGames) {
  const sourceFiles = targetGames.map((game) => GAME_SOURCE_FILES[game]);
  return targetGames.length > 0
    ? [...sourceFiles, AGENT_PARSER_REGRESSION_TEST_FILE]
    : [];
}

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

function parseMaxItems(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

class UpstreamRequestError extends Error {
  constructor(message, reasonCode, options = {}) {
    super(message, options);
    this.name = "UpstreamRequestError";
    this.reason_code = reasonCode;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(label, fn, retryCount = RETRY_COUNT) {
  const totalAttempts = retryCount + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === totalAttempts) {
        throw new Error(
          `${label} failed after ${totalAttempts} attempt(s): ${getErrorMessage(error)}`,
          { cause: error }
        );
      }

      const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(
        `${label} failed on attempt ${attempt}/${totalAttempts}; retrying in ${delayMs}ms: ${getErrorMessage(error)}`
      );
      await sleep(delayMs);
    }
  }

  throw new Error(`${label} failed unexpectedly`);
}

function classifyRawCollectionFailure(error) {
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (
      current instanceof UpstreamRequestError &&
      COLLECTION_REASON_CODES.has(current.reason_code)
    ) {
      return current.reason_code;
    }
    current =
      typeof current === "object" && current !== null
        ? current.cause
        : undefined;
  }
  return null;
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
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h\d|li|tr)>/gi, "\n")
      .replace(/<(p|div|h\d|li|tr)[^>]*>/gi, "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"")
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&ldquo;|&rdquo;/g, "\"")
      .replace(/&lsquo;|&rsquo;/g, "'")
      .replace(/&mdash;|&ndash;/g, "-")
  );
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseNumberLike(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function parsePositiveNumberLike(value) {
  const n = parseNumberLike(value);
  return n != null && n > 0 ? n : null;
}

function toIsoWithSourceOffset(input, sourceTzOffset = CHINA_TZ_OFFSET) {
  const s = String(input ?? "").trim();
  if (!s) return "";
  if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
    const m = /([+-])(\d{2})(\d{2})$/.exec(s);
    return m ? `${s.slice(0, -5)}${m[1]}${m[2]}:${m[3]}` : s;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    return `${s.length === 16 ? `${s}:00` : s}${sourceTzOffset}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return `${s}T00:00:00${sourceTzOffset}`;
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) {
    return `${s.replace(" ", "T")}:00${sourceTzOffset}`;
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return `${s.replace(" ", "T")}${sourceTzOffset}`;
  }
  return s;
}

function unixSecondsToIsoWithSourceOffset(value, sourceTzOffset = CHINA_TZ_OFFSET) {
  const n = parseNumberLike(value);
  if (n == null) return "";

  const offsetMatch = /^([+-])(\d{2}):(\d{2})$/.exec(sourceTzOffset);
  const sign = offsetMatch?.[1] === "-" ? -1 : 1;
  const hours = Number(offsetMatch?.[2] ?? "0");
  const minutes = Number(offsetMatch?.[3] ?? "0");
  const offsetMinutes = sign * (hours * 60 + minutes);
  const shiftedMs = Math.trunc(n) * 1000 + offsetMinutes * 60 * 1000;
  const d = new Date(shiftedMs);
  const pad2 = (x) => String(x).padStart(2, "0");

  return [
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    `T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`,
    sourceTzOffset,
  ].join("");
}

function unixMsToIsoWithSourceOffset(value, sourceTzOffset = CHINA_TZ_OFFSET) {
  const n = parsePositiveNumberLike(value);
  return n == null
    ? ""
    : unixSecondsToIsoWithSourceOffset(Math.floor(n / 1000), sourceTzOffset);
}

function parseLocalizedText(value) {
  if (typeof value !== "string") return "";
  const raw = value.trim();
  if (!raw) return "";

  try {
    const parsed = JSON.parse(raw);
    if (isRecord(parsed)) {
      for (const key of ["default", "zh-cn", "zh_cn", "zh", "cn"]) {
        const candidate = parsed[key];
        if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
      }
      for (const candidate of Object.values(parsed)) {
        if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
      }
    }
  } catch {
    // Plain strings are the common case for most upstreams.
  }

  return raw;
}

function extractTimeCandidates(input) {
  const text = stripHtml(input);
  const out = [];
  const seen = new Set();
  const re = /(?:\d{4}[\/.\-年]\d{1,2}[\/.\-月]\d{1,2}日?\s*\d{1,2}[:：]\d{2}(?::\d{2})?|\d{1,2}月\d{1,2}日\s*\d{1,2}[:：]\d{2})/g;
  for (const match of text.matchAll(re)) {
    const value = normalizeWhitespace(match[0]);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= 6) break;
  }
  return out;
}

async function request(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  let displayUrl;
  try {
    const parsedUrl = new URL(url);
    displayUrl = `${parsedUrl.origin}${parsedUrl.pathname}`;
  } catch {
    displayUrl = "(invalid URL)";
  }
  let res;
  try {
    res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new UpstreamRequestError(
      `Request transport failed for ${displayUrl}`,
      "transport",
      { cause: error }
    );
  }

  if (!res.ok) {
    const reasonCode =
      res.status === 429
        ? "http_429"
        : res.status >= 500 && res.status <= 599
          ? "http_5xx"
          : "http_other";
    throw new UpstreamRequestError(
      `Request failed: ${res.status} ${res.statusText} for ${displayUrl}`.trim(),
      reasonCode
    );
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
    end_time: item?.end_time == null ? null : String(item.end_time),
    end_time_kind: normalizeWhitespace(item?.end_time_kind || ""),
    end_time_text: normalizeWhitespace(item?.end_time_text || ""),
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

function collectStarRailContentItems(node, out) {
  if (!isRecord(node)) return;

  if (typeof node.ann_id === "number") {
    const item = {
      ann_id: node.ann_id,
      title: typeof node.title === "string" ? node.title : "",
      subtitle: typeof node.subtitle === "string" ? node.subtitle : "",
      content: typeof node.content === "string" ? node.content : "",
    };
    if (item.title || item.subtitle || item.content) {
      const list = out.get(item.ann_id) ?? [];
      list.push(item);
      out.set(item.ann_id, list);
    }
  }

  for (const item of ensureArray(node.list)) collectStarRailContentItems(item, out);
  for (const item of ensureArray(node.type_list)) collectStarRailContentItems(item, out);
  for (const item of ensureArray(node.pic_list)) collectStarRailContentItems(item, out);
}

function pickStarRailContentItem(contentById, item) {
  const items = contentById.get(item.ann_id) ?? [];
  if (items.length === 0) return null;
  const title = normalizeWhitespace(item.title || item.subtitle || "");
  const subtitle = normalizeWhitespace(item.subtitle || "");
  return (
    items.find((contentItem) => {
      const contentTitle = normalizeWhitespace(contentItem.title || contentItem.subtitle || "");
      const contentSubtitle = normalizeWhitespace(contentItem.subtitle || "");
      return contentTitle === title || (subtitle && contentSubtitle === subtitle);
    }) ??
    items[0] ??
    null
  );
}

function parseStarRailRawNotices(json, contentJson) {
  const categories = [];
  collectStarRailCategories(json?.data ?? null, categories);
  const items = getStarRailSelectedItems(categories);
  const contentById = new Map();
  collectStarRailContentItems(contentJson?.data ?? null, contentById);

  return items.flatMap((item) => {
    const title = normalizeWhitespace(item.title || item.subtitle || "");
    const subtitle = normalizeWhitespace(item.subtitle || "");
    // Some official picture cards carry an ann_id and schedule window but no
    // textual subject. They are not stable review evidence, so ignore them
    // instead of weakening the fail-closed identity rules below.
    if (!title && !subtitle) return [];

    const content = pickStarRailContentItem(contentById, item)?.content ?? "";
    return [{
      ann_id: item.ann_id,
      title,
      subtitle,
      start_time: String(item.start_time ?? ""),
      end_time: String(item.end_time ?? ""),
      type: item.type,
      type_label: item.type_label,
      content_time_candidates: extractTimeCandidates(content),
      snippet: stripHtml(content).slice(0, 220),
    }];
  });
}

async function fetchStarRailRawNotices() {
  const contentUrl = process.env.STARRAIL_CONTENT_API_URL?.trim() || STARRAIL_CONTENT_API;
  const [json, contentJson] = await Promise.all([
    requestJson(STARRAIL_LIST_API),
    requestJson(contentUrl).catch(() => null),
  ]);
  return parseStarRailRawNotices(json, contentJson);
}

async function fetchWwRawNotices() {
  const url = process.env.WW_NOTICE_API_URL?.trim() || WW_NOTICE_API;
  const json = await requestJson(url);
  const sections = [
    ["game", json?.game],
    ["activity", json?.activity],
    ["recommend", json?.recommend],
  ];
  const byKey = new Map();

  for (const [source, list] of sections) {
    for (const item of ensureArray(list)) {
      const id = String(item?.id ?? "").trim();
      const title = normalizeWhitespace(item?.tabTitle ?? "");
      if (!title) continue;

      const startMs = parsePositiveNumberLike(item?.startTimeMs);
      const endMs = parsePositiveNumberLike(item?.endTimeMs);
      const category = item?.category == null ? "" : String(item.category);
      const tag = item?.tag == null ? "" : String(item.tag);
      const permanent = item?.permanent == null ? "" : String(item.permanent);
      const key = [id, title, startMs ?? "", endMs ?? "", category, tag, permanent].join("|");
      const prev = byKey.get(key);
      if (prev) {
        if (!prev.source_sections.includes(source)) prev.source_sections.push(source);
        continue;
      }

      byKey.set(key, {
        source_sections: [source],
        id,
        title,
        start_time: startMs == null ? "" : unixMsToIsoWithSourceOffset(startMs),
        end_time: endMs == null ? "" : unixMsToIsoWithSourceOffset(endMs),
        category,
        tag,
        permanent,
        has_detail: Boolean(item?.content),
        snippet: stripHtml(item?.content ?? "").slice(0, 220),
      });
    }
  }

  return [...byKey.values()];
}

function validateZzzRawPayloads(activityJson, listJson, contentJson) {
  if (
    !isRecord(activityJson) ||
    activityJson.retcode !== 0 ||
    !isRecord(activityJson.data) ||
    !Array.isArray(activityJson.data.activity_list)
  ) {
    throw new Error("Invalid ZZZ activity payload");
  }
  if (
    !isRecord(listJson) ||
    listJson.retcode !== 0 ||
    !isRecord(listJson.data) ||
    !Array.isArray(listJson.data.list)
  ) {
    throw new Error("Invalid ZZZ announcement list payload");
  }
  if (
    !isRecord(contentJson) ||
    contentJson.retcode !== 0 ||
    !isRecord(contentJson.data) ||
    !Array.isArray(contentJson.data.list) ||
    !Array.isArray(contentJson.data.pic_list)
  ) {
    throw new Error("Invalid ZZZ announcement content payload");
  }
}

function parseZzzRawNotices(activityJson, listJson, contentJson) {
  validateZzzRawPayloads(activityJson, listJson, contentJson);
  const out = [];
  for (const item of ensureArray(activityJson?.data?.activity_list)) {
    const title = normalizeWhitespace(item?.name ?? "");
    if (!title) continue;
    out.push({
      source: "activity_list",
      activity_id: String(item?.activity_id ?? ""),
      title,
      start_time: unixSecondsToIsoWithSourceOffset(item?.start_time),
      end_time: unixSecondsToIsoWithSourceOffset(item?.end_time),
      raw_start_time: String(item?.start_time ?? ""),
      raw_end_time: String(item?.end_time ?? ""),
    });
  }

  for (const category of ensureArray(listJson?.data?.list)) {
    const typeId = category?.type_id ?? null;
    const typeLabel = normalizeWhitespace(category?.type_label ?? "");
    for (const item of ensureArray(category?.list)) {
      const title = normalizeWhitespace(stripHtml(item?.title || item?.subtitle || ""));
      if (!title) continue;
      out.push({
        source: "ann_list",
        type_id: typeId,
        type_label: typeLabel,
        ann_id: item?.ann_id ?? null,
        title,
        subtitle: normalizeWhitespace(stripHtml(item?.subtitle ?? "")),
        start_time: toIsoWithSourceOffset(item?.start_time),
        end_time: toIsoWithSourceOffset(item?.end_time),
      });
    }
  }

  const addContentItems = (source, list) => {
    for (const item of ensureArray(list)) {
      const content = item?.content ?? "";
      const title = normalizeWhitespace(stripHtml(item?.title || item?.subtitle || ""));
      if (!title) continue;
      out.push({
        source,
        ann_id: item?.ann_id ?? null,
        title,
        subtitle: normalizeWhitespace(stripHtml(item?.subtitle ?? "")),
        has_detail: Boolean(content),
        time_candidates: extractTimeCandidates(content),
        snippet: stripHtml(content).slice(0, 220),
      });
    }
  };

  addContentItems("ann_content_list", contentJson?.data?.list);
  addContentItems("ann_content_pic_list", contentJson?.data?.pic_list);

  return out;
}

async function fetchZzzRawNotices() {
  const snapshotUrl = process.env.ZZZ_SNAPSHOT_API_URL?.trim() || "";
  let activityJson;
  let listJson;
  let contentJson;
  if (snapshotUrl) {
    const bundle = await requestJson(snapshotUrl);
    assertExactObjectFields(
      bundle,
      ["schema_version", "game", "activity", "list", "content"],
      "ZZZ snapshot bundle"
    );
    if (bundle.schema_version !== 1 || bundle.game !== "zzz") {
      throw new Error("Invalid ZZZ snapshot bundle identity");
    }
    activityJson = bundle.activity;
    listJson = bundle.list;
    contentJson = bundle.content;
  } else {
    const activityUrl =
      process.env.ZZZ_ACTIVITY_API_URL?.trim() || ZZZ_ACTIVITY_API;
    const listUrl =
      process.env.ZZZ_API_URL?.trim() || ZZZ_LIST_API;
    const contentUrl =
      process.env.ZZZ_CONTENT_API_URL?.trim() || ZZZ_CONTENT_API;
    [activityJson, listJson, contentJson] = await Promise.all([
      requestJson(activityUrl),
      requestJson(listUrl),
      requestJson(contentUrl),
    ]);
  }
  return parseZzzRawNotices(activityJson, listJson, contentJson);
}

async function fetchSnowbreakRawNotices() {
  const url = process.env.SNOWBREAK_ANNOUNCE_API_URL?.trim() || SNOWBREAK_ANNOUNCE_API;
  const json = await requestJson(url);
  const items = ensureArray(json?.announce);

  return items.map((item) => {
    const title = normalizeWhitespace(
      parseLocalizedText(item?.title) || parseLocalizedText(item?.left_title)
    );
    const leftTitle = normalizeWhitespace(parseLocalizedText(item?.left_title));
    const content = parseLocalizedText(item?.content);
    return {
      id: item?.id == null ? "" : String(item.id),
      title,
      left_title: leftTitle,
      type: item?.type ?? null,
      start_time: unixSecondsToIsoWithSourceOffset(item?.start_time),
      end_time: unixSecondsToIsoWithSourceOffset(item?.end_time),
      raw_start_time: String(item?.start_time ?? ""),
      raw_end_time: String(item?.end_time ?? ""),
      has_detail: Boolean(content),
      time_candidates: extractTimeCandidates(content),
      snippet: stripHtml(content).slice(0, 220),
    };
  });
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
    case "ww":
      return await fetchWwRawNotices();
    case "zzz":
      return await fetchZzzRawNotices();
    case "snowbreak":
      return await fetchSnowbreakRawNotices();
    case "endfield":
      return await fetchEndfieldRawNotices();
    default:
      throw new Error(`Unsupported game: ${game}`);
  }
}

function getDatasetNotes(game) {
  switch (game) {
    case "starrail":
      return "Star Rail list metadata can disagree with the full announcement body. When content_time_candidates/snippet are present and clearly match the event window, prefer the full announcement body over list start_time/end_time for wrong_time_window judgments.";
    case "endfield":
      return "Endfield API events may include events parsed from version update notices and not only standalone event bulletins. Do not flag Endfield items merely because they lack a standalone raw bulletin match.";
    case "ww":
      return "Wuthering Waves raw notices include game/activity/recommend entries, including permanent, system, community, and shop/promotion notices. Category, permanent, and promotion filters are intentional; only flag clear event omissions or non-event inclusions.";
    case "zzz":
      return "ZZZ normal events come from activity_list. Gacha events may be extracted from announcement content. Not every ann_list or ann_content item is expected to appear as an API event.";
    case "snowbreak":
      return "Snowbreak API events are parsed from the current version activity announcement content plus gacha notices. Raw announcements include shop, outfit, system, and other notices that are not expected API events.";
    default:
      return "Compare raw upstream notices with current API output. Be conservative and only flag clear issues.";
  }
}

function normalizeIdentityText(input) {
  return normalizeWhitespace(input)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s·・•‧．.「」『』“”"'’‘:：,，。!！?？()[\]（）【】{}]/gu, "");
}

function getEvidenceTitle(item) {
  return normalizeWhitespace(
    item?.title || item?.subtitle || item?.left_title || item?.name || ""
  );
}

function getRawEvidenceSourceId(game, item) {
  for (const field of [
    "ann_id",
    "activity_id",
    "article_id",
    "notice_id",
    "cid",
    "id",
    "url",
    "linkUrl",
  ]) {
    const value = item?.[field];
    if (
      (typeof value === "string" && value.trim()) ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      const sourceId = `${field}:${normalizeWhitespace(value)}`;
      if (game === "starrail" && field === "ann_id") {
        const titleKey = normalizeIdentityText(getEvidenceTitle(item));
        const typeKey = normalizeIdentityText(
          `${item?.type ?? ""}:${item?.type_label ?? ""}`
        );
        if (!titleKey) {
          throw new Error(
            "Cannot disambiguate Star Rail evidence with a reused ann_id"
          );
        }
        // Star Rail can reuse ann_id for distinct records. Keep mutable
        // windows out of the identity, but include the record subject so
        // separate announcements cannot collapse into one finding.
        return `${sourceId}|title:${titleKey}|type:${typeKey}`;
      }
      return sourceId;
    }
  }
  return "";
}

function getEvidenceIdentityRef(game, side, item) {
  const titleKey = normalizeIdentityText(getEvidenceTitle(item));
  const sourceId = side === "raw" ? getRawEvidenceSourceId(game, item) : "";
  const basis = sourceId || `title:${titleKey}`;
  if (!titleKey && !sourceId) {
    throw new Error(`Cannot derive stable ${side} evidence identity for ${game}`);
  }
  return `${side}:${game}:${sha256(
    `upstream-review-evidence-identity:v1\n${basis}`
  ).slice(0, 32)}`;
}

function decorateEvidenceItems(game, side, items) {
  const decorated = items.map((item, index) => {
    const serialized = JSON.stringify(item);
    return {
      ...item,
      review_ref: `${side}:${game}:${sha256(
        `upstream-review-evidence-snapshot:v1\n${index}\n${serialized}`
      ).slice(0, 32)}`,
      identity_ref: getEvidenceIdentityRef(game, side, item),
    };
  });
  const reviewRefs = decorated.map((item) => item.review_ref);
  if (new Set(reviewRefs).size !== reviewRefs.length) {
    throw new Error(`Duplicate ${side} evidence review_ref in ${game} dataset`);
  }
  return decorated;
}

function buildGameDataset(game, rawNotices, apiEvents, maxItems) {
  return {
    game,
    game_label: GAME_LABELS[game] ?? game,
    notes: getDatasetNotes(game),
    raw_notice_count: rawNotices.length,
    api_event_count: apiEvents.length,
    raw_notices: decorateEvidenceItems(
      game,
      "raw",
      rawNotices.slice(0, maxItems)
    ),
    api_events: decorateEvidenceItems(
      game,
      "api",
      apiEvents.slice(0, maxItems)
    ),
  };
}

function filterApiEventsForReviewer(game, apiEvents, suppressions, generatedAt) {
  const generatedAtMs = Date.parse(generatedAt);

  return apiEvents.filter((event) => {
    const title = normalizeWhitespace(event?.title || "");
    if (findMatchingReviewerInputSuppression(game, "non_event_included", {
      title,
      api_title: title,
      raw_title: "",
    }, suppressions)) {
      return false;
    }

    const endTimeMs = Date.parse(String(event?.end_time ?? ""));
    if (Number.isFinite(generatedAtMs) && Number.isFinite(endTimeMs) && endTimeMs <= generatedAtMs) {
      return false;
    }

    return true;
  });
}

function filterRawNoticesForReviewer(game, rawNotices, suppressions) {
  return rawNotices.filter((notice) => {
    const title = normalizeWhitespace(notice?.title || notice?.subtitle || "");
    if (!title) return true;

    return !findMatchingReviewerInputSuppression(game, "missing_event", {
      title,
      api_title: "",
      raw_title: title,
    }, suppressions);
  });
}

async function readTextFile(filePath, label) {
  if (!filePath) {
    throw new Error(`Missing ${label} path`);
  }

  try {
    return await fs.readFile(path.resolve(filePath), "utf8");
  } catch (error) {
    throw new Error(`Failed to read ${label} at ${filePath}: ${getErrorMessage(error)}`);
  }
}

function truncateText(value, maxLength) {
  const characters = Array.from(String(value ?? ""));
  if (characters.length <= maxLength) return characters.join("");
  return `${characters.slice(0, Math.max(0, maxLength - 1)).join("")}…`;
}

function normalizeEvidenceRefs(value, label, { required = false } = {}) {
  if (value == null && !required) return [];
  if (
    !Array.isArray(value) ||
    value.length > MAX_FINDING_EVIDENCE_REFS ||
    value.some(
      (ref) =>
        typeof ref !== "string" ||
        !/^(?:raw|api):[a-z]+:[a-f0-9]{32}$/.test(ref)
    )
  ) {
    throw new Error(
      `Invalid ${label}: expected at most ${MAX_FINDING_EVIDENCE_REFS} evidence refs`
    );
  }
  const refs = value.map((ref) => ref.trim());
  if (new Set(refs).size !== refs.length) {
    throw new Error(`Invalid ${label}: evidence refs must be unique`);
  }
  return refs.sort(compareCodePoints);
}

function normalizeFinding(raw, fallbackGame = "unknown") {
  const game = SUPPORTED_GAMES.has(fallbackGame) ? fallbackGame : "unknown";
  const severity = ["high", "medium", "low"].includes(raw?.severity) ? raw.severity : "medium";
  const confidence = ["high", "medium", "low"].includes(raw?.confidence) ? raw.confidence : "medium";
  const kind = typeof raw?.kind === "string" && raw.kind ? raw.kind : "other";
  return {
    game,
    severity,
    confidence,
    kind,
    title: truncateText(normalizeWhitespace(raw?.title || ""), MAX_AGENT_TITLE_LENGTH),
    raw_title: truncateText(
      normalizeWhitespace(raw?.raw_title || ""),
      MAX_AGENT_TITLE_LENGTH
    ),
    api_title: truncateText(
      normalizeWhitespace(raw?.api_title || ""),
      MAX_AGENT_TITLE_LENGTH
    ),
    start_time: truncateText(raw?.start_time, MAX_AGENT_TIME_LENGTH),
    end_time: truncateText(raw?.end_time, MAX_AGENT_TIME_LENGTH),
    reason: truncateText(normalizeWhitespace(raw?.reason || ""), MAX_AGENT_REASON_LENGTH),
    raw_refs: normalizeEvidenceRefs(raw?.raw_refs, "finding raw_refs"),
    api_refs: normalizeEvidenceRefs(raw?.api_refs, "finding api_refs"),
    ...(Array.isArray(raw?.subject_refs)
      ? {
          subject_refs: [...new Set(
            raw.subject_refs.map((ref) => {
              if (
                typeof ref !== "string" ||
                !/^(?:raw|api):[a-z]+:[a-f0-9]{32}$/.test(ref)
              ) {
                throw new Error("Invalid finding subject_refs");
              }
              return ref;
            })
          )].sort(compareCodePoints),
        }
      : {}),
  };
}

function validateAgentFinding(
  raw,
  index,
  { requireEvidenceRefs = false } = {}
) {
  if (!isRecord(raw)) {
    throw new Error(`Invalid agent finding at index ${index}: expected an object`);
  }

  const requiredStringFields = [
    "game",
    "severity",
    "confidence",
    "kind",
    "title",
    "raw_title",
    "api_title",
    "start_time",
    "end_time",
    "reason",
  ];
  for (const field of requiredStringFields) {
    if (typeof raw[field] !== "string") {
      throw new Error(`Invalid agent finding at index ${index}: ${field} must be a string`);
    }
  }

  const game = String(raw.game ?? "").trim();
  if (!SUPPORTED_GAMES.has(game)) {
    throw new Error(`Invalid agent finding game at index ${index}: ${game || "(empty)"}`);
  }

  if (!["high", "medium", "low"].includes(raw.severity)) {
    throw new Error(`Invalid agent finding severity at index ${index}: ${raw.severity}`);
  }
  if (!["high", "medium", "low"].includes(raw.confidence)) {
    throw new Error(`Invalid agent finding confidence at index ${index}: ${raw.confidence}`);
  }

  const kind = String(raw.kind ?? "").trim();
  if (!SUPPORTED_FINDING_KINDS.has(kind)) {
    throw new Error(`Invalid agent finding kind at index ${index}: ${kind || "(empty)"}`);
  }

  const finding = normalizeFinding(raw, game);
  if (!finding.reason) {
    throw new Error(`Invalid agent finding at index ${index}: reason is required`);
  }
  if (!finding.title && !finding.raw_title && !finding.api_title) {
    throw new Error(`Invalid agent finding at index ${index}: at least one title is required`);
  }
  if (requireEvidenceRefs) {
    normalizeEvidenceRefs(raw.raw_refs, `finding raw_refs at index ${index}`, {
      required: true,
    });
    normalizeEvidenceRefs(raw.api_refs, `finding api_refs at index ${index}`, {
      required: true,
    });
  }

  return finding;
}

function getFindingEvidenceMinimums(kind) {
  switch (kind) {
    case "missing_event":
      return { raw: 1, api: 0 };
    case "non_event_included":
      return { raw: 0, api: 1 };
    case "duplicate_event":
      return { raw: 0, api: 2 };
    case "wrong_time_window":
      return { raw: 1, api: 1 };
    default:
      return { raw: 0, api: 0, either: 1 };
  }
}

function materializeFindingEvidence(finding, dataset, index) {
  if (!isRecord(dataset) || dataset.game !== finding.game) {
    throw new Error(
      `Finding at index ${index} has no matching trusted review dataset`
    );
  }
  const rawByRef = new Map(
    dataset.raw_notices.map((item) => [item.review_ref, item])
  );
  const apiByRef = new Map(
    dataset.api_events.map((item) => [item.review_ref, item])
  );
  const rawItems = finding.raw_refs.map((ref) => {
    const item = rawByRef.get(ref);
    if (!item) {
      throw new Error(
        `Finding at index ${index} cites unknown raw evidence ref ${ref}`
      );
    }
    return item;
  });
  const apiItems = finding.api_refs.map((ref) => {
    const item = apiByRef.get(ref);
    if (!item) {
      throw new Error(
        `Finding at index ${index} cites unknown API evidence ref ${ref}`
      );
    }
    return item;
  });
  const minimums = getFindingEvidenceMinimums(finding.kind);
  if (
    rawItems.length < minimums.raw ||
    apiItems.length < minimums.api ||
    (minimums.either && rawItems.length + apiItems.length < minimums.either)
  ) {
    throw new Error(
      `Finding at index ${index} does not cite the required evidence for ${finding.kind}`
    );
  }

  let subjectItems;
  if (finding.kind === "missing_event" || finding.kind === "wrong_time_window") {
    subjectItems = rawItems.length > 0 ? rawItems : apiItems;
  } else if (
    finding.kind === "non_event_included" ||
    finding.kind === "duplicate_event"
  ) {
    subjectItems = apiItems;
  } else {
    subjectItems = [...rawItems, ...apiItems];
  }
  const subjectRefs = [
    ...new Set(subjectItems.map((item) => item.identity_ref).filter(Boolean)),
  ].sort(compareCodePoints);
  if (subjectRefs.length === 0) {
    throw new Error(`Finding at index ${index} has no stable evidence identity`);
  }

  return {
    ...finding,
    subject_refs: subjectRefs,
  };
}

function parseAgentReview(
  text,
  expectedGames = DEFAULT_GAMES,
  maxFindings = MAX_AGENT_FINDINGS,
  options = {}
) {
  if (
    !Array.isArray(expectedGames) ||
    expectedGames.length === 0 ||
    new Set(expectedGames).size !== expectedGames.length ||
    expectedGames.some((game) => !SUPPORTED_GAMES.has(game))
  ) {
    throw new Error("Invalid expected games for Codex review");
  }
  if (!Number.isInteger(maxFindings) || maxFindings <= 0) {
    throw new Error("Invalid maximum finding count for Codex review");
  }

  let parsed;
  try {
    parsed = JSON.parse(String(text ?? "").trim());
  } catch (error) {
    throw new Error(`Invalid Codex review JSON: ${getErrorMessage(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid agent review: expected an object");
  }

  if (!Array.isArray(parsed.errors)) {
    throw new Error("Invalid agent review: errors must be an array");
  }
  if (parsed.errors.length > 20 || parsed.errors.some((error) => typeof error !== "string")) {
    throw new Error("Invalid agent review: errors must contain at most 20 strings");
  }
  const errors = parsed.errors
    .map((error) =>
      truncateText(normalizeWhitespace(error), MAX_AGENT_ERROR_LENGTH)
    )
    .filter(Boolean);
  if (parsed.complete !== true || errors.length > 0) {
    const detail = errors.length > 0 ? `: ${errors.join("; ")}` : "";
    throw new Error(`Codex reported an incomplete review${detail}`);
  }

  if (typeof parsed.summary !== "string") {
    throw new Error("Invalid agent review: summary must be a string");
  }
  const summary = truncateText(
    normalizeWhitespace(parsed.summary),
    MAX_AGENT_SUMMARY_LENGTH
  );

  if (!Array.isArray(parsed.reviewed_games)) {
    throw new Error("Invalid agent review: reviewed_games must be an array");
  }
  if (parsed.reviewed_games.some((game) => typeof game !== "string")) {
    throw new Error("Invalid agent review: reviewed_games must contain strings");
  }
  const reviewedGames = parsed.reviewed_games.map((game) => String(game).trim());
  const sortedExpectedGames = [...expectedGames].sort();
  if (
    reviewedGames.length !== expectedGames.length ||
    new Set(reviewedGames).size !== expectedGames.length ||
    reviewedGames
      .slice()
      .sort()
      .some((game, index) => game !== sortedExpectedGames[index])
  ) {
    const expectedDescription =
      expectedGames.length === DEFAULT_GAMES.length
        ? "all six games exactly once"
        : `${expectedGames.join(", ")} exactly once`;
    throw new Error(
      `Invalid agent review: reviewed_games must cover ${expectedDescription}`
    );
  }

  if (!Array.isArray(parsed.findings)) {
    throw new Error("Invalid agent review: findings must be an array");
  }
  const rawFindings = parsed.findings;
  if (rawFindings.length > maxFindings) {
    throw new Error(
      `Invalid agent review: ${rawFindings.length} findings exceeds the ${maxFindings} limit`
    );
  }

  const allowedGames = new Set(expectedGames);
  const findings = rawFindings.map((finding, index) =>
    validateAgentFinding(finding, index, options)
  );
  const crossGameFinding = findings.find((finding) => !allowedGames.has(finding.game));
  if (crossGameFinding) {
    throw new Error(
      `Invalid agent review: finding for ${crossGameFinding.game} is outside the expected game set`
    );
  }

  return {
    summary,
    findings,
  };
}

function validateCollectionMetadata(collection, label = "collection") {
  assertExactObjectFields(
    collection,
    [
      "policy_version",
      "status",
      "available_games",
      "unavailable_games",
    ],
    label
  );
  if (collection.policy_version !== COLLECTION_POLICY_VERSION) {
    throw new Error(`${label}.policy_version is unsupported`);
  }
  if (!["complete", "degraded"].includes(collection.status)) {
    throw new Error(`${label}.status is invalid`);
  }
  if (
    !Array.isArray(collection.available_games) ||
    collection.available_games.some(
      (game) => typeof game !== "string" || !SUPPORTED_GAMES.has(game)
    ) ||
    new Set(collection.available_games).size !==
      collection.available_games.length
  ) {
    throw new Error(`${label}.available_games is invalid`);
  }
  if (!Array.isArray(collection.unavailable_games)) {
    throw new Error(`${label}.unavailable_games is invalid`);
  }
  const unavailableGames = collection.unavailable_games.map(
    (entry, index) => {
      assertExactObjectFields(
        entry,
        ["game", "reason_code"],
        `${label}.unavailable_games[${index}]`
      );
      if (
        !SUPPORTED_GAMES.has(entry.game) ||
        !COLLECTION_REASON_CODES.has(entry.reason_code)
      ) {
        throw new Error(
          `${label}.unavailable_games[${index}] is invalid`
        );
      }
      return entry.game;
    }
  );
  if (new Set(unavailableGames).size !== unavailableGames.length) {
    throw new Error(`${label}.unavailable_games contains duplicates`);
  }

  const expectedAvailableGames = DEFAULT_GAMES.filter(
    (game) => !unavailableGames.includes(game)
  );
  const expectedUnavailableGames = DEFAULT_GAMES.filter((game) =>
    unavailableGames.includes(game)
  );
  if (
    !isDeepStrictEqual(
      collection.available_games,
      expectedAvailableGames
    ) ||
    !isDeepStrictEqual(unavailableGames, expectedUnavailableGames)
  ) {
    throw new Error(
      `${label} must partition the configured games in canonical order`
    );
  }
  if (
    (collection.status === "complete" &&
      (unavailableGames.length !== 0 ||
        collection.available_games.length !== DEFAULT_GAMES.length)) ||
    (collection.status === "degraded" &&
      (unavailableGames.length !== 1 ||
        collection.available_games.length !== DEFAULT_GAMES.length - 1))
  ) {
    throw new Error(
      `${label}.status does not match its available game partition`
    );
  }
  return collection;
}

function getReviewableGamesForSchema(input, label) {
  if (input.schema_version !== 3) return [...DEFAULT_GAMES];
  return [
    ...validateCollectionMetadata(input.collection, `${label}.collection`)
      .available_games,
  ];
}

function assertCanonicalGameCoverage(actualGames, expectedGames, label) {
  if (!isDeepStrictEqual(actualGames, expectedGames)) {
    throw new Error(`${label} must cover the available games exactly`);
  }
}

function validateCollectedDataset(
  dataset,
  index,
  label,
  maxItems,
  { requireEvidenceRefs = false } = {}
) {
  if (!isRecord(dataset)) {
    throw new Error(`Invalid collected review input: ${label}[${index}] must be an object`);
  }

  const game = String(dataset.game ?? "").trim();
  if (!SUPPORTED_GAMES.has(game)) {
    throw new Error(
      `Invalid collected review input game at ${label}[${index}]: ${game || "(empty)"}`
    );
  }
  if (dataset.game_label !== (GAME_LABELS[game] ?? game)) {
    throw new Error(
      `Invalid collected review input: ${label}[${index}].game_label does not match ${game}`
    );
  }
  if (typeof dataset.notes !== "string" || !dataset.notes.trim()) {
    throw new Error(
      `Invalid collected review input: ${label}[${index}].notes is required`
    );
  }

  for (const field of ["raw_notice_count", "api_event_count"]) {
    if (!Number.isInteger(dataset[field]) || dataset[field] < 0) {
      throw new Error(
        `Invalid collected review input: ${label}[${index}].${field} must be a non-negative integer`
      );
    }
  }

  for (const [itemsField, countField] of [
    ["raw_notices", "raw_notice_count"],
    ["api_events", "api_event_count"],
  ]) {
    const items = dataset[itemsField];
    if (!Array.isArray(items) || items.some((item) => !isRecord(item))) {
      throw new Error(
        `Invalid collected review input: ${label}[${index}].${itemsField} must be an array of objects`
      );
    }
    const expectedLength = Math.min(dataset[countField], maxItems);
    if (items.length !== expectedLength) {
      throw new Error(
        `Invalid collected review input: ${label}[${index}].${itemsField} has ${items.length} item(s); expected ${expectedLength}`
      );
    }
    if (
      requireEvidenceRefs &&
      items.some(
        (item) =>
          typeof item.review_ref !== "string" ||
          typeof item.identity_ref !== "string" ||
          !/^(?:raw|api):[a-z]+:[a-f0-9]{32}$/.test(item.review_ref) ||
          !/^(?:raw|api):[a-z]+:[a-f0-9]{32}$/.test(item.identity_ref)
      )
    ) {
      throw new Error(
        `Invalid collected review input: ${label}[${index}].${itemsField} lacks stable evidence refs`
      );
    }
  }

  return game;
}

function validateCollectedReviewInput(input) {
  if (!isRecord(input) || input.mode !== "collect_only") {
    throw new Error("Invalid collected review input: expected mode=collect_only");
  }
  if (![2, 3].includes(input.schema_version)) {
    throw new Error("Invalid collected review input: unsupported schema_version");
  }
  const requireEvidenceRefs = input.schema_version === 3;
  if (
    typeof input.generated_at !== "string" ||
    !Number.isFinite(Date.parse(input.generated_at))
  ) {
    throw new Error("Invalid collected review input: generated_at must be an ISO timestamp");
  }
  if (typeof input.api_base_url !== "string" || !input.api_base_url) {
    throw new Error("Invalid collected review input: api_base_url is required");
  }
  if (!Number.isInteger(input.max_items) || input.max_items <= 0) {
    throw new Error("Invalid collected review input: max_items must be a positive integer");
  }
  if (!Array.isArray(input.datasets) || !Array.isArray(input.review_datasets)) {
    throw new Error("Invalid collected review input: missing datasets");
  }
  const expectedGames = getReviewableGamesForSchema(
    input,
    "collected review input"
  );

  const snapshotGames = input.datasets.map((dataset, index) =>
    validateCollectedDataset(dataset, index, "datasets", input.max_items, {
      requireEvidenceRefs,
    })
  );
  const games = input.review_datasets.map((dataset, index) =>
    validateCollectedDataset(dataset, index, "review_datasets", input.max_items, {
      requireEvidenceRefs,
    })
  );

  if (new Set(games).size !== games.length) {
    throw new Error("Invalid collected review input: duplicate game datasets");
  }
  if (
    input.schema_version === 2 &&
    !isDeepStrictEqual(games, expectedGames)
  ) {
    throw new Error("Invalid collected review input: expected all six game datasets");
  }
  assertCanonicalGameCoverage(
    games,
    expectedGames,
    "Invalid collected review input: review_datasets"
  );
  assertCanonicalGameCoverage(
    snapshotGames,
    expectedGames,
    "Invalid collected review input: datasets"
  );

  if (
    !isRecord(input.suppressions) ||
    typeof input.suppressions.path !== "string" ||
    !input.suppressions.path.trim() ||
    !Number.isInteger(input.suppressions.count) ||
    input.suppressions.count < 0 ||
    !Array.isArray(input.suppressions.review_input_exclusions)
  ) {
    throw new Error("Invalid collected review input: suppressions metadata is incomplete");
  }

  const snapshotsByGame = new Map(input.datasets.map((dataset) => [dataset.game, dataset]));
  const reviewDatasetsByGame = new Map(
    input.review_datasets.map((dataset) => [dataset.game, dataset])
  );
  const exclusionGames = input.suppressions.review_input_exclusions.map(
    (exclusion, index) => {
      if (
        !isRecord(exclusion) ||
        !SUPPORTED_GAMES.has(exclusion.game) ||
        !Number.isInteger(exclusion.raw_notices) ||
        exclusion.raw_notices < 0 ||
        !Number.isInteger(exclusion.api_events) ||
        exclusion.api_events < 0
      ) {
        throw new Error(
          `Invalid collected review input: suppressions.review_input_exclusions[${index}] is invalid`
        );
      }

      const snapshot = snapshotsByGame.get(exclusion.game);
      const reviewDataset = reviewDatasetsByGame.get(exclusion.game);
      if (
        !snapshot ||
        !reviewDataset ||
        snapshot.raw_notice_count - reviewDataset.raw_notice_count !==
          exclusion.raw_notices ||
        snapshot.api_event_count - reviewDataset.api_event_count !== exclusion.api_events
      ) {
        throw new Error(
          `Invalid collected review input: exclusion counts do not match ${exclusion.game} datasets`
        );
      }
      return exclusion.game;
    }
  );
  assertCanonicalGameCoverage(
    exclusionGames,
    expectedGames,
    "Invalid collected review input: exclusion metadata"
  );

  return input;
}

function parseJsonDocument(text, label) {
  try {
    return JSON.parse(String(text ?? "").trim());
  } catch (error) {
    throw new Error(`Failed to parse ${label}: ${getErrorMessage(error)}`);
  }
}

function validateAgenticReviewReport(report) {
  if (
    !isRecord(report) ||
    report.mode !== "agentic_review" ||
    ![2, 3].includes(report.schema_version)
  ) {
    throw new Error("Invalid agentic review report");
  }
  if (
    report.schema_version === 3 &&
    report.finding_identity_version !== FINDING_IDENTITY_VERSION
  ) {
    throw new Error("Invalid agentic review report finding identity version");
  }
  if (!isRecord(report.review) || !Array.isArray(report.review.findings)) {
    throw new Error("Invalid agentic review report: missing findings");
  }
  if (report.review.findings.length > MAX_AGENT_FINDINGS) {
    throw new Error(
      `Invalid agentic review report: ${report.review.findings.length} findings exceeds the ${MAX_AGENT_FINDINGS} limit`
    );
  }

  const requireEvidenceRefs = report.schema_version === 3;
  const expectedGames = getReviewableGamesForSchema(
    report,
    "agentic review report"
  );
  const normalizedFindings = report.review.findings.map((finding, index) =>
    validateAgentFinding(finding, index, { requireEvidenceRefs })
  );
  const snapshotDatasets = report.datasets;
  const reviewDatasets = report.review_datasets;
  if (!Array.isArray(snapshotDatasets) || !Array.isArray(reviewDatasets)) {
    throw new Error("Invalid agentic review report: missing datasets");
  }

  const validateReportDatasets = (datasets, label) =>
    datasets.map((dataset, index) => {
    if (
      !isRecord(dataset) ||
      !SUPPORTED_GAMES.has(dataset.game) ||
      typeof dataset.notes !== "string" ||
      !Array.isArray(dataset.raw_notices) ||
      !Array.isArray(dataset.api_events) ||
      dataset.raw_notices.some((item) => !isRecord(item)) ||
      dataset.api_events.some((item) => !isRecord(item))
    ) {
      throw new Error(
          `Invalid agentic review report: ${label}[${index}] is invalid`
      );
    }
    return dataset.game;
    });
  const snapshotDatasetGames = validateReportDatasets(
    snapshotDatasets,
    "datasets"
  );
  const datasetGames = validateReportDatasets(
    reviewDatasets,
    "review_datasets"
  );
  assertCanonicalGameCoverage(
    snapshotDatasetGames,
    expectedGames,
    "Invalid agentic review report: datasets"
  );
  assertCanonicalGameCoverage(
    datasetGames,
    expectedGames,
    "Invalid agentic review report: review_datasets"
  );
  if (Array.isArray(report.review.game_reviews)) {
    assertCanonicalGameCoverage(
      report.review.game_reviews.map((entry) => entry?.game),
      expectedGames,
      "Invalid agentic review report: review.game_reviews"
    );
  }

  const datasetsByGame = new Map(
    reviewDatasets.map((dataset) => [dataset.game, dataset])
  );
  const findings = requireEvidenceRefs
    ? normalizedFindings.map((finding, index) =>
        materializeFindingEvidence(
          finding,
          datasetsByGame.get(finding.game),
          index
        )
      )
    : normalizedFindings;

  return {
    ...report,
    review: {
      ...report.review,
      findings,
    },
  };
}

function getEvidenceTitles(item) {
  return [
    item?.title,
    item?.subtitle,
    item?.left_title,
    item?.name,
  ]
    .map((value) => normalizeWhitespace(value || ""))
    .filter(Boolean);
}

function evidenceTitleMatches(itemTitle, findingTitle) {
  if (itemTitle === findingTitle) return true;
  const shorterLength = Math.min(
    Array.from(itemTitle).length,
    Array.from(findingTitle).length
  );
  return (
    shorterLength >= 8 &&
    (itemTitle.includes(findingTitle) || findingTitle.includes(itemTitle))
  );
}

function selectFindingEvidence(items, candidateTitles) {
  const titles = [...new Set(candidateTitles.map(normalizeWhitespace).filter(Boolean))];
  return items
    .filter((item) =>
      getEvidenceTitles(item).some((itemTitle) =>
        titles.some((findingTitle) => evidenceTitleMatches(itemTitle, findingTitle))
      )
    )
    .slice(0, MAX_FIX_EVIDENCE_ITEMS);
}

function selectFindingEvidenceByRefs(items, refs, fallbackTitles = []) {
  const requestedRefs = new Set(refs);
  if (requestedRefs.size > 0) {
    const selected = items.filter((item) => requestedRefs.has(item.review_ref));
    if (selected.length !== requestedRefs.size) {
      throw new Error("Finding evidence refs are missing from the trusted dataset");
    }
    return selected;
  }
  return selectFindingEvidence(items, fallbackTitles);
}

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function compareCodePoints(a, b) {
  const left = String(a);
  const right = String(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalizeLegacyFindingIdentity(finding) {
  return {
    game: finding.game,
    kind: finding.kind,
    raw_title: normalizeWhitespace(finding.raw_title),
    api_title: normalizeWhitespace(finding.api_title),
    start_time: normalizeWhitespace(finding.start_time),
    end_time: normalizeWhitespace(finding.end_time),
  };
}

function getFallbackFindingSubjectRefs(finding) {
  const rawTitle = normalizeIdentityText(
    finding.raw_title || finding.title || ""
  );
  const apiTitle = normalizeIdentityText(
    finding.api_title || finding.title || ""
  );
  let subjects;
  if (finding.kind === "missing_event" || finding.kind === "wrong_time_window") {
    subjects = rawTitle ? [`legacy:raw-title:${rawTitle}`] : [];
  } else if (
    finding.kind === "non_event_included" ||
    finding.kind === "duplicate_event"
  ) {
    subjects = apiTitle ? [`legacy:api-title:${apiTitle}`] : [];
  } else {
    subjects = [
      ...(rawTitle ? [`legacy:raw-title:${rawTitle}`] : []),
      ...(apiTitle ? [`legacy:api-title:${apiTitle}`] : []),
    ];
  }
  if (subjects.length === 0) {
    throw new Error("Finding has no stable subject identity");
  }
  return [...new Set(subjects)].sort(compareCodePoints);
}

function canonicalizeFindingIdentity(finding) {
  const subjectRefs =
    Array.isArray(finding.subject_refs) && finding.subject_refs.length > 0
      ? [...new Set(finding.subject_refs.map(String))].sort(compareCodePoints)
      : getFallbackFindingSubjectRefs(finding);
  return {
    identity_version: FINDING_IDENTITY_VERSION,
    game: finding.game,
    kind: finding.kind,
    subject_refs: subjectRefs,
  };
}

function getLegacyFindingKey(finding) {
  return sha256(
    `upstream-review-finding:v1\n${JSON.stringify(
      canonicalizeLegacyFindingIdentity(finding)
    )}`
  );
}

function getLegacyFindingFingerprint(findings) {
  const canonicalFindings = [
    ...new Map(
      findings.map((finding) => {
        const canonical = canonicalizeLegacyFindingIdentity(finding);
        return [JSON.stringify(canonical), canonical];
      })
    ).values(),
  ].sort((a, b) => compareCodePoints(JSON.stringify(a), JSON.stringify(b)));
  return sha256(JSON.stringify(canonicalFindings));
}

function getFindingKey(finding) {
  if (!Array.isArray(finding.subject_refs) || finding.subject_refs.length === 0) {
    return getLegacyFindingKey(finding);
  }
  return sha256(
    `upstream-review-finding:${FINDING_KEY_VERSION}\n${JSON.stringify(
      canonicalizeFindingIdentity(finding)
    )}`
  );
}

function getUniqueFindingEntries(findings) {
  const entriesByKey = new Map();
  for (const finding of findings) {
    const findingKey = getFindingKey(finding);
    const existing = entriesByKey.get(findingKey);
    if (
      !existing ||
      compareCodePoints(JSON.stringify(finding), JSON.stringify(existing)) < 0
    ) {
      entriesByKey.set(findingKey, finding);
    }
  }
  return [...entriesByKey.entries()]
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([findingKey, finding]) => ({ finding_key: findingKey, finding }));
}

function getFindingKeys(findings) {
  return getUniqueFindingEntries(findings).map((entry) => entry.finding_key);
}

function getFindingFingerprint(findings) {
  const identityVersions = new Set(
    findings.map((finding) =>
      Array.isArray(finding.subject_refs) && finding.subject_refs.length > 0
        ? FINDING_IDENTITY_VERSION
        : 1
    )
  );
  if (identityVersions.size > 1) {
    throw new Error("Cannot fingerprint mixed finding identity versions");
  }
  if (identityVersions.has(1)) {
    return getLegacyFindingFingerprint(findings);
  }
  const canonicalFindings = [
    ...new Map(
      findings.map((finding) => {
        const canonical = canonicalizeFindingIdentity(finding);
        return [JSON.stringify(canonical), canonical];
      })
    ).values(),
  ].sort((a, b) => compareCodePoints(JSON.stringify(a), JSON.stringify(b)));
  return sha256(JSON.stringify(canonicalFindings));
}

function validateFindingKeys(
  value,
  { allowEmpty = false, label = "finding keys" } = {}
) {
  if (
    !Array.isArray(value) ||
    value.length > MAX_AGENT_FINDINGS ||
    (!allowEmpty && value.length === 0) ||
    value.some((findingKey) => !/^[a-f0-9]{64}$/.test(findingKey))
  ) {
    throw new Error(`Invalid ${label}`);
  }
  const sorted = [...value].sort(compareCodePoints);
  if (
    new Set(value).size !== value.length ||
    value.some((findingKey, index) => findingKey !== sorted[index])
  ) {
    throw new Error(`${label} must be sorted and unique`);
  }
  return value;
}

function getFindingCoverageFingerprintFromKeys(
  findingKeys,
  identityVersion = FINDING_IDENTITY_VERSION
) {
  const keys = validateFindingKeys(findingKeys, {
    allowEmpty: true,
    label: "coverage finding keys",
  });
  return sha256(
    `upstream-review-coverage:${
      identityVersion === 1 ? "v1" : FINDING_COVERAGE_VERSION
    }\n${JSON.stringify(
      keys
    )}`
  );
}

function getFindingCoverageFingerprint(findings) {
  const identityVersion =
    findings.length > 0 &&
    findings.every(
      (finding) =>
        !Array.isArray(finding.subject_refs) ||
        finding.subject_refs.length === 0
    )
      ? 1
      : FINDING_IDENTITY_VERSION;
  return getFindingCoverageFingerprintFromKeys(
    getFindingKeys(findings),
    identityVersion
  );
}

function validateIssueNumber(value, label = "issue number") {
  const number = Number(value);
  if (
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    number > 2_147_483_647
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return number;
}

function validateRepositorySlug(value) {
  const repository = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Invalid GitHub repository");
  }
  return repository;
}

function validateIssueUrl(value, repository, issueNumber) {
  const issueUrl = String(value ?? "").trim();
  const expectedUrl = `https://github.com/${repository}/issues/${issueNumber}`;
  if (
    issueUrl !== expectedUrl ||
    Array.from(issueUrl).length > MAX_PR_REVIEW_URL_LENGTH
  ) {
    throw new Error("Issue URL does not match the trusted repository and number");
  }
  return issueUrl;
}

function parseIssueUrl(value) {
  const issueUrl = String(value ?? "").trim();
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([1-9]\d*)$/.exec(
      issueUrl
    );
  if (!match || Array.from(issueUrl).length > MAX_PR_REVIEW_URL_LENGTH) {
    throw new Error("Invalid remediation cycle issue URL");
  }
  return {
    issue_url: issueUrl,
    repository: match[1],
    issue_number: validateIssueNumber(match[2]),
  };
}

function getFixBranch(findingFingerprint, issueNumber, baseSha) {
  if (
    typeof findingFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(findingFingerprint)
  ) {
    throw new Error("Invalid finding fingerprint for fix branch");
  }
  const number = validateIssueNumber(issueNumber, "fix branch issue number");
  if (typeof baseSha !== "string" || !/^[a-f0-9]{40}$/.test(baseSha)) {
    throw new Error("Invalid base SHA for fix branch");
  }
  return `codex/upstream-review-${findingFingerprint.slice(0, 16)}-i${number}-b${baseSha.slice(0, 12)}`;
}

function renderIssueCycleMarker(
  findingFingerprint,
  remediationCycle,
  coverageFingerprint,
  findingKeys
) {
  if (
    typeof findingFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(findingFingerprint) ||
    typeof remediationCycle !== "string" ||
    !/^[a-f0-9]{64}$/.test(remediationCycle) ||
    typeof coverageFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(coverageFingerprint)
  ) {
    throw new Error("Invalid remediation cycle marker");
  }
  const keys = validateFindingKeys(findingKeys);
  if (
    coverageFingerprint !==
      getFindingCoverageFingerprintFromKeys(
        keys,
        FINDING_IDENTITY_VERSION
      ) &&
    coverageFingerprint !== getFindingCoverageFingerprintFromKeys(keys, 1)
  ) {
    throw new Error(
      "Remediation cycle coverage fingerprint does not match its finding keys"
    );
  }
  return `<!-- upstream-review-cycle:${ISSUE_MARKER_VERSION} fingerprint=${findingFingerprint} cycle=${remediationCycle} coverage=${coverageFingerprint} keys=${keys.join(",")} -->`;
}

function parseIssueCycleMarker(body) {
  const text = String(body ?? "");
  const currentMatch =
    /^<!-- upstream-review-cycle:v2 fingerprint=([a-f0-9]{64}) cycle=([a-f0-9]{64}) coverage=([a-f0-9]{64}) keys=([a-f0-9]{64}(?:,[a-f0-9]{64})*) -->\n/.exec(
      text
    );
  if (currentMatch) {
    const findingKeys = currentMatch[4].split(",");
    validateFindingKeys(findingKeys, {
      label: "managed Issue finding keys",
    });
    const currentCoverageFingerprint =
      getFindingCoverageFingerprintFromKeys(
        findingKeys,
        FINDING_IDENTITY_VERSION
      );
    const legacyCoverageFingerprint =
      getFindingCoverageFingerprintFromKeys(findingKeys, 1);
    const identityVersion =
      currentMatch[3] === currentCoverageFingerprint
        ? FINDING_IDENTITY_VERSION
        : currentMatch[3] === legacyCoverageFingerprint
          ? 1
          : null;
    if (identityVersion == null) {
      throw new Error(
        "Managed Issue coverage fingerprint does not match its finding keys"
      );
    }
    return {
      version: ISSUE_MARKER_VERSION,
      finding_fingerprint: currentMatch[1],
      remediation_cycle: currentMatch[2],
      coverage_fingerprint: currentMatch[3],
      finding_keys: findingKeys,
      finding_identity_version: identityVersion,
    };
  }
  if (text.startsWith(`<!-- upstream-review-cycle:${ISSUE_MARKER_VERSION}`)) {
    throw new Error("Invalid v2 managed Issue cycle marker");
  }

  const legacyMatch =
    /^<!-- upstream-review-cycle:v1 fingerprint=([a-f0-9]{64}) cycle=([a-f0-9]{64}) -->\n/.exec(
      text
    );
  if (!legacyMatch) return null;
  return {
    version: LEGACY_ISSUE_MARKER_VERSION,
    finding_fingerprint: legacyMatch[1],
    remediation_cycle: legacyMatch[2],
    coverage_fingerprint: legacyMatch[1],
    finding_keys: null,
    finding_identity_version: 1,
  };
}

function createRemediationCycleId(
  repository,
  runId,
  runAttempt,
  findingFingerprint
) {
  const trustedRepository = validateRepositorySlug(repository);
  const normalizedRunId = String(runId ?? "").trim();
  const normalizedRunAttempt = String(runAttempt ?? "").trim();
  if (!/^[1-9]\d*$/.test(normalizedRunId)) {
    throw new Error("Invalid GitHub run id for remediation cycle");
  }
  if (!/^[1-9]\d*$/.test(normalizedRunAttempt)) {
    throw new Error("Invalid GitHub run attempt for remediation cycle");
  }
  if (
    typeof findingFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(findingFingerprint)
  ) {
    throw new Error("Invalid finding fingerprint for remediation cycle");
  }
  return sha256(
    JSON.stringify({
      repository: trustedRepository,
      run_id: normalizedRunId,
      run_attempt: normalizedRunAttempt,
      finding_fingerprint: findingFingerprint,
    })
  );
}

function compareFixFindings(a, b) {
  const gameOrder =
    DEFAULT_GAMES.indexOf(a.game) - DEFAULT_GAMES.indexOf(b.game);
  if (gameOrder !== 0) return gameOrder;
  for (const field of [
    "kind",
    "raw_title",
    "api_title",
    "start_time",
    "end_time",
    "title",
    "severity",
    "confidence",
  ]) {
    const comparison = compareCodePoints(a[field], b[field]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function buildAgenticFixInput(rawReport) {
  const report = validateAgenticReviewReport(rawReport);
  const uniqueFindingEntries = getUniqueFindingEntries(report.review.findings);
  const uniqueFindingsByKey = new Map(
    uniqueFindingEntries.map((entry) => [entry.finding_key, entry.finding])
  );
  const remediationFindingKeys = Array.isArray(report.issue?.finding_keys)
    ? validateFindingKeys(report.issue.finding_keys, {
        allowEmpty: true,
        label: "agentic review report remediation finding keys",
      })
    : uniqueFindingEntries.map((entry) => entry.finding_key);
  const unknownFindingKey = remediationFindingKeys.find(
    (findingKey) => !uniqueFindingsByKey.has(findingKey)
  );
  if (unknownFindingKey) {
    throw new Error(
      "Agentic review report remediation scope is not present in the detected findings"
    );
  }
  const findings = remediationFindingKeys
    .map((findingKey) => uniqueFindingsByKey.get(findingKey))
    .sort(compareFixFindings)
    .map((finding, index) => ({
      finding_id: `finding-${String(index + 1).padStart(3, "0")}`,
      ...finding,
    }));
  const findingGames = new Set(findings.map((finding) => finding.game));
  const targetGames = DEFAULT_GAMES.filter((game) => findingGames.has(game));
  const datasetsByGame = new Map(
    report.review_datasets.map((dataset) => [dataset.game, dataset])
  );

  const evidence = targetGames.map((game) => {
    const dataset = datasetsByGame.get(game);
    const gameFindings = findings.filter((finding) => finding.game === game);
    const rawTitles = gameFindings.flatMap((finding) => [
      finding.raw_title,
      finding.title,
    ]);
    const apiTitles = gameFindings.flatMap((finding) => [
      finding.api_title,
      finding.title,
    ]);
    const rawRefs = gameFindings.flatMap((finding) => finding.raw_refs ?? []);
    const apiRefs = gameFindings.flatMap((finding) => finding.api_refs ?? []);
    return {
      game,
      notes: dataset.notes,
      matching_raw_notices: selectFindingEvidenceByRefs(
        dataset.raw_notices,
        rawRefs,
        rawTitles
      ),
      matching_api_events: selectFindingEvidenceByRefs(
        dataset.api_events,
        apiRefs,
        apiTitles
      ),
    };
  });

  const findingFingerprint = getFindingFingerprint(findings);
  const hasFindings = findings.length > 0;
  const issueNumber = hasFindings
    ? validateIssueNumber(
        report.issue?.issue_number,
        "remediation cycle issue number"
      )
    : 0;
  const issueUrl = hasFindings
    ? parseIssueUrl(report.issue?.issue_url).issue_url
    : "";
  const remediationCycle = hasFindings
    ? String(report.issue?.remediation_cycle ?? "").trim()
    : "";
  const baseSha = hasFindings
    ? String(report.base_sha ?? "").trim()
    : "";
  if (
    hasFindings &&
    (
      parseIssueUrl(issueUrl).issue_number !== issueNumber ||
      report.issue?.finding_fingerprint !== findingFingerprint ||
      (
        report.issue?.coverage_fingerprint != null &&
        report.issue.coverage_fingerprint !==
          getFindingCoverageFingerprintFromKeys(
            remediationFindingKeys,
            report.schema_version === 3 ? FINDING_IDENTITY_VERSION : 1
          )
      ) ||
      !/^[a-f0-9]{64}$/.test(remediationCycle) ||
      !/^[a-f0-9]{40}$/.test(baseSha)
    )
  ) {
    throw new Error(
      "Agentic review report Issue does not match the finding fingerprint and remediation cycle"
    );
  }
  const fixBranch = hasFindings
    ? getFixBranch(findingFingerprint, issueNumber, baseSha)
    : "";

  return {
    schema_version: report.schema_version === 3 ? 3 : 2,
    mode: "agentic_fix",
    ...(report.schema_version === 3
      ? { finding_identity_version: FINDING_IDENTITY_VERSION }
      : {}),
    source_report: {
      generated_at: normalizeWhitespace(report.generated_at || ""),
      finalized_at: normalizeWhitespace(report.finalized_at || ""),
      issue_number: issueNumber,
      issue_url: issueUrl,
      remediation_cycle: remediationCycle,
      base_sha: baseSha,
    },
    finding_fingerprint: findingFingerprint,
    fix_branch: fixBranch,
    target_games: targetGames,
    allowed_files:
      report.schema_version === 3
        ? getAllowedFixFiles(targetGames)
        : targetGames.map((game) => GAME_SOURCE_FILES[game]),
    ...(report.schema_version === 3
      ? {
          required_test_files:
            targetGames.length > 0
              ? [AGENT_PARSER_REGRESSION_TEST_FILE]
              : [],
        }
      : {}),
    findings,
    evidence,
  };
}

function validateAgenticFixInput(input) {
  if (
    !isRecord(input) ||
    input.mode !== "agentic_fix" ||
    ![2, 3].includes(input.schema_version)
  ) {
    throw new Error("Invalid agentic fix input");
  }
  if (
    (input.schema_version === 3 &&
      input.finding_identity_version !== FINDING_IDENTITY_VERSION) ||
    (input.schema_version === 2 &&
      input.finding_identity_version != null &&
      input.finding_identity_version !== 1)
  ) {
    throw new Error("Invalid agentic fix input finding identity version");
  }
  if (
    !Array.isArray(input.target_games) ||
    input.target_games.some((game) => !SUPPORTED_GAMES.has(game)) ||
    new Set(input.target_games).size !== input.target_games.length
  ) {
    throw new Error("Invalid agentic fix input: target_games is invalid");
  }
  if (
    !isRecord(input.source_report) ||
    typeof input.source_report.generated_at !== "string" ||
    typeof input.source_report.finalized_at !== "string" ||
    !Number.isSafeInteger(input.source_report.issue_number) ||
    typeof input.source_report.issue_url !== "string" ||
    typeof input.source_report.remediation_cycle !== "string" ||
    typeof input.source_report.base_sha !== "string" ||
    typeof input.finding_fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.finding_fingerprint) ||
    typeof input.fix_branch !== "string"
  ) {
    throw new Error("Invalid agentic fix input: source metadata is invalid");
  }

  const expectedTargetGames = DEFAULT_GAMES.filter((game) =>
    input.target_games.includes(game)
  );
  if (
    input.target_games.some((game, index) => game !== expectedTargetGames[index])
  ) {
    throw new Error("Invalid agentic fix input: target_games must use canonical order");
  }

  const expectedAllowedFiles =
    input.schema_version === 3
      ? getAllowedFixFiles(expectedTargetGames)
      : expectedTargetGames.map((game) => GAME_SOURCE_FILES[game]);
  if (
    !Array.isArray(input.allowed_files) ||
    input.allowed_files.length !== expectedAllowedFiles.length ||
    input.allowed_files.some((file, index) => file !== expectedAllowedFiles[index])
  ) {
    throw new Error("Invalid agentic fix input: allowed_files does not match target_games");
  }
  const expectedTestFiles =
    expectedTargetGames.length > 0
      ? [AGENT_PARSER_REGRESSION_TEST_FILE]
      : [];
  if (
    input.schema_version === 3 &&
    (
      !Array.isArray(input.required_test_files) ||
      input.required_test_files.length !== expectedTestFiles.length ||
      input.required_test_files.some(
        (file, index) => file !== expectedTestFiles[index]
      )
    )
  ) {
    throw new Error(
      "Invalid agentic fix input: required_test_files does not match target_games"
    );
  }
  if (!Array.isArray(input.findings) || input.findings.length > MAX_AGENT_FINDINGS) {
    throw new Error("Invalid agentic fix input: findings is invalid");
  }

  const findingIds = new Set();
  const findingKeys = new Set();
  for (const [index, finding] of input.findings.entries()) {
    if (
      !isRecord(finding) ||
      typeof finding.finding_id !== "string" ||
      finding.finding_id !== `finding-${String(index + 1).padStart(3, "0")}` ||
      findingIds.has(finding.finding_id)
    ) {
      throw new Error(`Invalid agentic fix input finding at index ${index}`);
    }
    findingIds.add(finding.finding_id);
    const validatedFinding = validateAgentFinding(finding, index, {
      requireEvidenceRefs: input.schema_version === 3,
    });
    if (
      input.schema_version === 3 &&
      (
        !Array.isArray(finding.subject_refs) ||
        finding.subject_refs.length === 0 ||
        finding.subject_refs.some(
          (ref) =>
            typeof ref !== "string" ||
            !/^(?:raw|api):[a-z]+:[a-f0-9]{32}$/.test(ref)
        ) ||
        new Set(finding.subject_refs).size !== finding.subject_refs.length ||
        finding.subject_refs.some(
          (ref, refIndex) =>
            refIndex > 0 &&
            compareCodePoints(finding.subject_refs[refIndex - 1], ref) >= 0
        )
      )
    ) {
      throw new Error(
        `Invalid agentic fix input finding identity at index ${index}`
      );
    }
    const findingKey = getFindingKey(validatedFinding);
    if (findingKeys.has(findingKey)) {
      throw new Error(
        `Invalid agentic fix input: duplicate semantic finding at index ${index}`
      );
    }
    findingKeys.add(findingKey);
    if (!input.target_games.includes(validatedFinding.game)) {
      throw new Error(
        `Invalid agentic fix input: finding ${finding.finding_id} is outside target_games`
      );
    }
    if (
      index > 0 &&
      compareFixFindings(input.findings[index - 1], finding) > 0
    ) {
      throw new Error("Invalid agentic fix input: findings must use canonical order");
    }
  }
  const findingGames = new Set(input.findings.map((finding) => finding.game));
  const expectedFindingGames = DEFAULT_GAMES.filter((game) =>
    findingGames.has(game)
  );
  if (
    input.target_games.length !== expectedFindingGames.length ||
    input.target_games.some(
      (game, index) => game !== expectedFindingGames[index]
    )
  ) {
    throw new Error(
      "Invalid agentic fix input: target_games must exactly match findings"
    );
  }
  if (getFindingFingerprint(input.findings) !== input.finding_fingerprint) {
    throw new Error("Invalid agentic fix input: finding fingerprint mismatch");
  }
  if (input.findings.length === 0) {
    if (
      input.source_report.issue_number !== 0 ||
      input.source_report.issue_url !== "" ||
      input.source_report.remediation_cycle !== "" ||
      input.source_report.base_sha !== "" ||
      input.fix_branch !== ""
    ) {
      throw new Error(
        "Invalid agentic fix input: a clean review cannot have a remediation cycle"
      );
    }
  } else {
    const issueNumber = validateIssueNumber(
      input.source_report.issue_number,
      "agentic fix issue number"
    );
    const parsedIssueUrl = parseIssueUrl(input.source_report.issue_url);
    if (
      parsedIssueUrl.issue_number !== issueNumber ||
      !/^[a-f0-9]{64}$/.test(input.source_report.remediation_cycle) ||
      !/^[a-f0-9]{40}$/.test(input.source_report.base_sha) ||
      input.fix_branch !==
        getFixBranch(
          input.finding_fingerprint,
          issueNumber,
          input.source_report.base_sha
        )
    ) {
      throw new Error(
        "Invalid agentic fix input: remediation cycle metadata is inconsistent"
      );
    }
  }

  if (
    !Array.isArray(input.evidence) ||
    input.evidence.length !== expectedTargetGames.length ||
    input.evidence.some(
      (entry, index) =>
        !isRecord(entry) ||
        entry.game !== expectedTargetGames[index] ||
        typeof entry.notes !== "string" ||
        !Array.isArray(entry.matching_raw_notices) ||
        !Array.isArray(entry.matching_api_events) ||
        entry.matching_raw_notices.some((item) => !isRecord(item)) ||
        entry.matching_api_events.some((item) => !isRecord(item))
    )
  ) {
    throw new Error("Invalid agentic fix input: evidence is invalid");
  }
  if (input.schema_version === 3) {
    const evidenceByGame = new Map(
      input.evidence.map((entry) => [entry.game, entry])
    );
    for (const game of expectedTargetGames) {
      const entry = evidenceByGame.get(game);
      if (!entry || entry.notes !== getDatasetNotes(game)) {
        throw new Error(
          `Invalid agentic fix input: evidence policy mismatch for ${game}`
        );
      }
      const gameFindings = input.findings.filter(
        (finding) => finding.game === game
      );
      if (gameFindings.length > MAX_AGENT_FINDINGS_PER_GAME) {
        throw new Error(
          `Invalid agentic fix input: too many findings for ${game}`
        );
      }
      for (const [side, items] of [
        ["raw", entry.matching_raw_notices],
        ["api", entry.matching_api_events],
      ]) {
        const refs = items.map((item) => item.review_ref);
        if (
          items.length >
            MAX_AGENT_FINDINGS_PER_GAME * MAX_FINDING_EVIDENCE_REFS ||
          new Set(refs).size !== refs.length ||
          items.some(
            (item) =>
              typeof item.review_ref !== "string" ||
              typeof item.identity_ref !== "string" ||
              !new RegExp(
                `^${side}:${game}:[a-f0-9]{32}$`
              ).test(item.review_ref) ||
              !new RegExp(
                `^${side}:${game}:[a-f0-9]{32}$`
              ).test(item.identity_ref)
          )
        ) {
          throw new Error(
            `Invalid agentic fix input: malformed ${side} evidence for ${game}`
          );
        }
        const expectedRefs = [
          ...new Set(
            gameFindings.flatMap((finding) =>
              side === "raw" ? finding.raw_refs : finding.api_refs
            )
          ),
        ].sort(compareCodePoints);
        const actualRefs = [...refs].sort(compareCodePoints);
        if (
          actualRefs.length !== expectedRefs.length ||
          actualRefs.some((ref, index) => ref !== expectedRefs[index])
        ) {
          throw new Error(
            `Invalid agentic fix input: incomplete ${side} evidence for ${game}`
          );
        }
      }
    }
    for (const [index, finding] of input.findings.entries()) {
      const entry = evidenceByGame.get(finding.game);
      const materialized = materializeFindingEvidence(
        finding,
        {
          game: finding.game,
          raw_notices: entry.matching_raw_notices,
          api_events: entry.matching_api_events,
        },
        index
      );
      if (
        !isDeepStrictEqual(
          materialized.subject_refs,
          finding.subject_refs
        )
      ) {
        throw new Error(
          `Invalid agentic fix input: subject evidence mismatch at index ${index}`
        );
      }
    }
  }

  return input;
}

function normalizeChangedFiles(changedFiles) {
  if (!Array.isArray(changedFiles)) {
    throw new Error("Invalid changed-file list");
  }
  const normalized = changedFiles
    .map((file) => String(file ?? "").trim())
    .filter(Boolean);
  if (
    new Set(normalized).size !== normalized.length ||
    normalized.some(
      (file) =>
        path.posix.isAbsolute(file) ||
        file.includes("\\") ||
        file.split("/").includes("..")
    )
  ) {
    throw new Error("Invalid changed-file list");
  }
  return normalized.sort();
}

function assertExactStringSet(actual, expected, label) {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(`${label} does not match the actual tracked diff`);
  }
}

function parseAgentFixOutput(text, rawFixInput, actualChangedFiles) {
  const fixInput = validateAgenticFixInput(rawFixInput);
  const parsed = parseJsonDocument(text, "Codex fix output");
  if (!isRecord(parsed)) {
    throw new Error("Invalid Codex fix output: expected an object");
  }

  const allowedTopLevelFields = new Set([
    "complete",
    "errors",
    "summary",
    "changed_files",
    "outcomes",
  ]);
  if (Object.keys(parsed).some((field) => !allowedTopLevelFields.has(field))) {
    throw new Error("Invalid Codex fix output: unexpected field");
  }
  if (
    !Array.isArray(parsed.errors) ||
    parsed.errors.length > 20 ||
    parsed.errors.some((error) => typeof error !== "string")
  ) {
    throw new Error("Invalid Codex fix output: errors must contain at most 20 strings");
  }
  const errors = parsed.errors
    .map((error) => truncateText(normalizeWhitespace(error), MAX_AGENT_ERROR_LENGTH))
    .filter(Boolean);
  if (parsed.complete !== true || errors.length > 0) {
    const detail = errors.length > 0 ? `: ${errors.join("; ")}` : "";
    throw new Error(`Codex reported an incomplete fix${detail}`);
  }
  if (typeof parsed.summary !== "string") {
    throw new Error("Invalid Codex fix output: summary must be a string");
  }

  const claimedChangedFiles = normalizeChangedFiles(parsed.changed_files);
  const changedFiles = normalizeChangedFiles(actualChangedFiles);
  const allowedFiles = new Set(fixInput.allowed_files);
  const disallowedFile = changedFiles.find((file) => !allowedFiles.has(file));
  if (disallowedFile) {
    throw new Error(`Codex changed a file outside the allowlist: ${disallowedFile}`);
  }
  assertExactStringSet(
    claimedChangedFiles,
    changedFiles,
    "Codex changed_files"
  );

  if (!Array.isArray(parsed.outcomes)) {
    throw new Error("Invalid Codex fix output: outcomes must be an array");
  }
  const findingsById = new Map(
    fixInput.findings.map((finding) => [finding.finding_id, finding])
  );
  const seenFindingIds = new Set();
  const outcomes = parsed.outcomes.map((outcome, index) => {
    if (
      !isRecord(outcome) ||
      Object.keys(outcome).some(
        (field) => !["finding_id", "status", "reason"].includes(field)
      ) ||
      typeof outcome.finding_id !== "string" ||
      !["fixed", "not_fixed"].includes(outcome.status) ||
      typeof outcome.reason !== "string"
    ) {
      throw new Error(`Invalid Codex fix outcome at index ${index}`);
    }
    if (!findingsById.has(outcome.finding_id)) {
      throw new Error(`Unknown finding outcome: ${outcome.finding_id}`);
    }
    if (seenFindingIds.has(outcome.finding_id)) {
      throw new Error(`Duplicate finding outcome: ${outcome.finding_id}`);
    }
    seenFindingIds.add(outcome.finding_id);
    const reason = truncateText(
      normalizeWhitespace(outcome.reason),
      MAX_AGENT_REASON_LENGTH
    );
    if (!reason) {
      throw new Error(`Missing outcome reason for ${outcome.finding_id}`);
    }
    return {
      finding_id: outcome.finding_id,
      status: outcome.status,
      reason,
    };
  });

  if (
    outcomes.length !== fixInput.findings.length ||
    fixInput.findings.some((finding) => !seenFindingIds.has(finding.finding_id))
  ) {
    throw new Error("Codex fix outcomes must cover every finding exactly once");
  }

  const gameBySourceFile = new Map(
    Object.entries(GAME_SOURCE_FILES).map(([game, file]) => [file, game])
  );
  const fixedGames = new Set(
    outcomes
      .filter((outcome) => outcome.status === "fixed")
      .map((outcome) => findingsById.get(outcome.finding_id).game)
  );
  const changedGames = new Set(
    changedFiles
      .map((file) => gameBySourceFile.get(file))
      .filter(Boolean)
  );
  if (
    [...fixedGames].some((game) => !changedGames.has(game)) ||
    [...changedGames].some((game) => !fixedGames.has(game))
  ) {
    throw new Error(
      "Codex fixed outcomes and changed game parser files do not match"
    );
  }
  if (
    fixInput.schema_version === 3 &&
    fixedGames.size > 0 &&
    !changedFiles.includes(AGENT_PARSER_REGRESSION_TEST_FILE)
  ) {
    throw new Error(
      "Codex fixes must include a deterministic parser regression test"
    );
  }
  if (
    fixInput.schema_version === 3 &&
    changedFiles.includes(AGENT_PARSER_REGRESSION_TEST_FILE) &&
    fixedGames.size === 0
  ) {
    throw new Error(
      "Codex changed the parser regression test without fixing a finding"
    );
  }

  return {
    schema_version: 1,
    mode: "agentic_fix_result",
    source_report: fixInput.source_report,
    summary: truncateText(
      normalizeWhitespace(parsed.summary),
      MAX_AGENT_SUMMARY_LENGTH
    ),
    target_games: fixInput.target_games,
    allowed_files: fixInput.allowed_files,
    changed_files: changedFiles,
    has_patch: changedFiles.length > 0,
    findings: fixInput.findings,
    outcomes,
  };
}

async function extractGameReviewInput(game, options = {}) {
  const targetGame = String(game ?? "").trim();
  if (!SUPPORTED_GAMES.has(targetGame)) {
    throw new Error(`Invalid upstream review game: ${targetGame || "(empty)"}`);
  }

  const inputPath =
    options.inputPath ??
    process.env.UPSTREAM_REVIEW_INPUT_PATH?.trim();
  const outputPath =
    options.outputPath ??
    (process.env.UPSTREAM_REVIEW_GAME_INPUT_PATH?.trim() || inputPath);
  const inputText = await readTextFile(inputPath, "collected review input");

  let collectedInput;
  try {
    collectedInput = JSON.parse(inputText);
  } catch (error) {
    throw new Error(`Failed to parse collected review input: ${getErrorMessage(error)}`);
  }

  const input = validateCollectedReviewInput(collectedInput);
  const reviewDataset = input.review_datasets.find(
    (dataset) => dataset.game === targetGame
  );
  if (!reviewDataset) {
    throw new Error(`Collected review input is missing ${targetGame}`);
  }

  const gameInput = {
    schema_version: input.schema_version,
    mode: "review_game",
    generated_at: input.generated_at,
    target_game: targetGame,
    max_items: input.max_items,
    review_dataset: reviewDataset,
  };
  await writeReport(gameInput, outputPath, false);
  console.log(
    JSON.stringify({
      mode: gameInput.mode,
      target_game: targetGame,
      output_path: path.resolve(outputPath),
      raw_notice_count: reviewDataset.raw_notice_count,
      api_event_count: reviewDataset.api_event_count,
    })
  );
  return gameInput;
}

function getTitleValues(input) {
  return {
    title: normalizeWhitespace(input?.title || ""),
    api_title: normalizeWhitespace(input?.api_title || ""),
    raw_title: normalizeWhitespace(input?.raw_title || ""),
  };
}

function getTitleCandidates(values) {
  return [...new Set([values.api_title, values.raw_title, values.title].filter(Boolean))];
}

function getTargetTitleCandidates(values, target) {
  if (target === "api_title") return values.api_title ? [values.api_title] : [];
  if (target === "raw_title") return values.raw_title ? [values.raw_title] : [];
  if (target === "title") return values.title ? [values.title] : [];
  return getTitleCandidates(values);
}

function stringListFromValue(value, index, fieldName) {
  if (value == null || value === "") return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((item, itemIndex) => {
    if (typeof item !== "string") {
      const suffix = Array.isArray(value) ? `[${itemIndex}]` : "";
      throw new Error(
        `Invalid suppression matcher at index ${index} (${fieldName}${suffix}): expected string`
      );
    }
    return normalizeWhitespace(item);
  }).filter(Boolean);
}

function collectSuppressionStringMatchers(raw, index, fieldName, target) {
  return stringListFromValue(raw[fieldName], index, fieldName).map((value) => ({
    target,
    value,
    field: fieldName,
  }));
}

function collectSuppressionRegexMatchers(raw, index, fieldName, target) {
  return stringListFromValue(raw[fieldName], index, fieldName).map((pattern) => {
    let regex;
    try {
      regex = new RegExp(pattern);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid suppression regex at index ${index} (${fieldName}): ${message}`);
    }
    return {
      target,
      pattern,
      regex,
      field: fieldName,
    };
  });
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
  const exacts = [
    ...collectSuppressionStringMatchers(raw, index, "title", "any"),
    ...collectSuppressionStringMatchers(raw, index, "api_title", "any"),
    ...collectSuppressionStringMatchers(raw, index, "raw_title", "any"),
  ];
  const contains = [
    ...collectSuppressionStringMatchers(raw, index, "title_contains", "any"),
    ...collectSuppressionStringMatchers(raw, index, "api_title_contains", "api_title"),
    ...collectSuppressionStringMatchers(raw, index, "raw_title_contains", "raw_title"),
  ];
  const regexes = [
    ...collectSuppressionRegexMatchers(raw, index, "title_regex", "any"),
    ...collectSuppressionRegexMatchers(raw, index, "api_title_regex", "api_title"),
    ...collectSuppressionRegexMatchers(raw, index, "raw_title_regex", "raw_title"),
  ];

  if (exacts.length === 0 && contains.length === 0 && regexes.length === 0) {
    throw new Error(
      `Suppression at index ${index} must include title/api_title/raw_title or a *_contains/*_regex matcher`
    );
  }

  return {
    game,
    kind,
    exacts,
    contains,
    regexes,
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
  const values = getTitleValues(finding);
  return (
    suppressions.find((suppression) => {
      if (suppression.game && suppression.game !== finding.game) return false;
      if (suppression.kind && suppression.kind !== finding.kind) return false;
      return matchesSuppressionTitleValues(suppression, values);
    }) ?? null
  );
}

function findMatchingReviewerInputSuppression(game, defaultKind, values, suppressions) {
  return (
    suppressions.find((suppression) => {
      const kind = suppression.kind || "non_event_included";
      if (kind !== defaultKind) return false;
      if (suppression.game && suppression.game !== game) return false;
      return matchesSuppressionTitleValues(suppression, values);
    }) ?? null
  );
}

function matchesSuppressionTitleValues(suppression, values) {
  for (const matcher of suppression.exacts) {
    const targetCandidates = getTargetTitleCandidates(values, matcher.target);
    if (targetCandidates.some((title) => title === matcher.value)) return true;
  }

  for (const matcher of suppression.contains) {
    const targetCandidates = getTargetTitleCandidates(values, matcher.target);
    if (targetCandidates.some((title) => title.includes(matcher.value))) return true;
  }

  for (const matcher of suppression.regexes) {
    const targetCandidates = getTargetTitleCandidates(values, matcher.target);
    if (targetCandidates.some((title) => matcher.regex.test(title))) return true;
  }

  return false;
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
  const counts =
    unsuppressedCount === 0
      ? "No unsuppressed findings detected."
      : `${unsuppressedCount} unsuppressed finding(s) detected.`;
  const suppressionSummary =
    suppressedCount > 0
      ? ` ${suppressedCount} finding(s) matched suppression rules.`
      : "";
  const agentSummary = summary ? ` Codex summary: ${summary}` : "";
  return `${counts}${suppressionSummary}${agentSummary}`;
}

function escapeIssueText(value) {
  return normalizeWhitespace(value)
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]<>#|])/g, "\\$1")
    .replace(/@/g, "@\u200b");
}

function escapeIssueCode(value) {
  return normalizeWhitespace(value)
    .replace(/`/g, "ˋ")
    .replace(/@/g, "@\u200b")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderFindingLines(finding, index) {
  const lines = [];
  const label = GAME_LABELS[finding.game] ?? finding.game;
  const title = finding.api_title || finding.raw_title || finding.title || "(untitled)";
  lines.push(
    `${index}. [${finding.severity}] ${escapeIssueText(label)} / ${finding.kind} / \`${escapeIssueCode(title)}\``
  );
  if (finding.title && finding.title !== title) {
    lines.push(`Finding title: \`${escapeIssueCode(finding.title)}\``);
  }
  if (finding.api_title && finding.api_title !== title) {
    lines.push(`API title: \`${escapeIssueCode(finding.api_title)}\``);
  }
  if (
    finding.raw_title &&
    finding.raw_title !== title &&
    finding.raw_title !== finding.api_title
  ) {
    lines.push(`Raw title: \`${escapeIssueCode(finding.raw_title)}\``);
  }
  if (finding.start_time || finding.end_time) {
    lines.push(
      `Window: \`${escapeIssueCode(finding.start_time || "?")}\` -> \`${escapeIssueCode(finding.end_time || "?")}\``
    );
  }
  lines.push(`Confidence: ${finding.confidence}`);
  lines.push(escapeIssueText(finding.reason || "No reason provided."));
  lines.push("");
  return lines;
}

function prioritizeFindings(findings) {
  const rank = { high: 0, medium: 1, low: 2 };
  return findings
    .map((finding, sourceIndex) => ({ finding, sourceIndex }))
    .sort(
      (a, b) =>
        (rank[a.finding.severity] ?? 3) - (rank[b.finding.severity] ?? 3) ||
        (rank[a.finding.confidence] ?? 3) - (rank[b.finding.confidence] ?? 3) ||
        a.sourceIndex - b.sourceIndex
    )
    .map(({ finding }) => finding);
}

function finalizeIssueLines(lines) {
  return lines.join("\n").trim() + "\n";
}

function renderIssueTitle(report, findingFingerprint) {
  const count = report.review.findings.length;
  return `${DEFAULT_ISSUE_TITLE} · ${count} finding${count === 1 ? "" : "s"} · ${findingFingerprint.slice(0, 8)}`;
}

function renderIssueBody(report, options = {}) {
  const collection =
    report.schema_version === 3
      ? validateCollectionMetadata(
          report.collection,
          "agentic review report.collection"
        )
      : null;
  const findingFingerprint = String(options.findingFingerprint ?? "").trim();
  const remediationCycle = String(options.remediationCycle ?? "").trim();
  const coverageFingerprint = String(
    options.coverageFingerprint ?? findingFingerprint
  ).trim();
  const findingKeys = options.findingKeys;
  const marker =
    findingFingerprint || remediationCycle
      ? renderIssueCycleMarker(
          findingFingerprint,
          remediationCycle,
          coverageFingerprint,
          findingKeys
        )
      : "";
  const regressionOfIssueNumbers = [
    ...new Set(
      (
        Array.isArray(options.regressionOfIssueNumbers)
          ? options.regressionOfIssueNumbers
          : options.regressionOfIssueNumber == null
            ? []
            : [options.regressionOfIssueNumber]
      ).map((issueNumber) =>
        validateIssueNumber(issueNumber, "regression Issue number")
      )
    ),
  ].sort((left, right) => left - right);
  const coveredByIssueNumbers = ensureArray(options.coveredByIssueNumbers)
    .map((issueNumber) =>
      validateIssueNumber(issueNumber, "covering Issue number")
    )
    .sort((left, right) => left - right);
  if (new Set(coveredByIssueNumbers).size !== coveredByIssueNumbers.length) {
    throw new Error("Covering Issue numbers must be unique");
  }
  const lines = [
    ...(marker ? [marker, ""] : []),
    "# Upstream Review Alerts",
    "",
    `Last run: \`${escapeIssueCode(report.generated_at)}\``,
    ...(report.base_sha
      ? [`Base commit: \`${escapeIssueCode(report.base_sha)}\``]
      : []),
    `API base: \`${escapeIssueCode(report.api_base_url)}\``,
    `Model: \`${escapeIssueCode(report.review.model)}\``,
    ...(collection?.status === "degraded"
      ? [
          `Review coverage: ${collection.available_games.length}/${DEFAULT_GAMES.length} games (degraded)`,
          `Unavailable: ${collection.unavailable_games
            .map(
              ({ game, reason_code: reasonCode }) =>
                `${escapeIssueText(GAME_LABELS[game] ?? game)} (\`${game}\`, \`${reasonCode}\`)`
            )
            .join(", ")}`,
        ]
      : []),
    ...(marker
      ? [
          `Cycle fingerprint: \`${findingFingerprint}\``,
          `Open coverage fingerprint: \`${coverageFingerprint}\``,
          `Remediation cycle: \`${remediationCycle}\``,
        ]
      : []),
    ...(regressionOfIssueNumbers.length === 0
      ? []
      : [
          `Regression of: ${regressionOfIssueNumbers
            .map((issueNumber) => `#${issueNumber}`)
            .join(", ")}`,
        ]),
    ...(coveredByIssueNumbers.length === 0
      ? []
      : [
          `Excluded as already tracked by Open Issue(s): ${coveredByIssueNumbers
            .map((issueNumber) => `#${issueNumber}`)
            .join(", ")}`,
        ]),
    "",
    "## Summary",
    escapeIssueText(
      report.review.summary || `${report.review.findings.length} finding(s) detected.`
    ),
    "",
    "## Snapshot",
  ];

  for (const dataset of report.datasets) {
    lines.push(
      `- ${escapeIssueText(dataset.game_label)}: raw notices ${dataset.raw_notice_count}, API events ${dataset.api_event_count}`
    );
  }

  lines.push("");
  lines.push("## Findings");

  if (report.review.findings.length === 0) {
    lines.push("No findings.");
  } else {
    const prioritizedFindings = prioritizeFindings(report.review.findings);
    const includedFindingLines = [];
    let includedCount = 0;
    for (const finding of prioritizedFindings) {
      const proposedLines = [
        ...includedFindingLines,
        ...renderFindingLines(finding, includedCount + 1),
      ];
      const proposedCount = includedCount + 1;
      const omittedCount = prioritizedFindings.length - proposedCount;
      const budgetProbe = finalizeIssueLines([
        ...lines,
        ...proposedLines,
        ...(omittedCount > 0
          ? [
              `_${omittedCount} additional finding(s) omitted from this Issue body; see the upstream-review artifact._`,
              "",
            ]
          : []),
        "This issue is managed automatically by the Codex upstream-review workflow.",
      ]);
      if (Buffer.byteLength(budgetProbe, "utf8") > MAX_ISSUE_BODY_BYTES) break;
      includedFindingLines.splice(0, includedFindingLines.length, ...proposedLines);
      includedCount = proposedCount;
    }
    lines.push(...includedFindingLines);
    const omittedCount = prioritizedFindings.length - includedCount;
    if (omittedCount > 0) {
      lines.push(
        `_${omittedCount} additional finding(s) omitted from this Issue body; see the upstream-review artifact._`,
        ""
      );
    }
  }

  lines.push("This issue is managed automatically by the Codex upstream-review workflow.");
  const body = finalizeIssueLines(lines);
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > MAX_ISSUE_BODY_BYTES) {
    throw new Error(
      `Rendered issue body is ${bodyBytes} bytes; limit is ${MAX_ISSUE_BODY_BYTES}`
    );
  }
  return body;
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

async function listAllRepositoryIssues(owner, repo, request = githubRequest) {
  const out = [];

  for (let page = 1; ; page += 1) {
    const issues = await request(
      `/repos/${owner}/${repo}/issues?state=all&per_page=100&page=${page}`
    );
    const list = ensureArray(issues);
    if (list.length === 0) break;
    out.push(...list);
    if (list.length < 100) break;
  }

  return out;
}

async function listAllRepositoryPullRequests(
  owner,
  repo,
  request = githubRequest
) {
  const out = [];

  for (let page = 1; ; page += 1) {
    const pullRequests = await request(
      `/repos/${owner}/${repo}/pulls?state=all&per_page=100&page=${page}`
    );
    const list = ensureArray(pullRequests);
    if (list.length === 0) break;
    out.push(...list);
    if (list.length < 100) break;
  }

  return out;
}

function parseManagedRemediationPrMarker(body) {
  const text = String(body ?? "");
  const match =
    /^<!-- upstream-review-pr:v1 issue=([1-9]\d*) fingerprint=([a-f0-9]{64}) cycle=([a-f0-9]{64}) -->\n/.exec(
      text
    );
  if (!match) {
    if (text.startsWith("<!-- upstream-review-pr:")) {
      throw new Error("Invalid managed remediation PR marker");
    }
    return null;
  }
  return {
    issue_number: validateIssueNumber(
      match[1],
      "managed remediation PR Issue number"
    ),
    finding_fingerprint: match[2],
    remediation_cycle: match[3],
  };
}

function classifyManagedRemediationPullRequests(
  pullRequests,
  {
    repository,
    defaultBranch,
    issueNumber,
    findingFingerprint,
    remediationCycle,
  }
) {
  const trustedRepository = validateRepositorySlug(repository);
  const trustedDefaultBranch = String(defaultBranch ?? "").trim();
  const trustedIssueNumber = validateIssueNumber(issueNumber);
  if (
    !/^[A-Za-z0-9._/-]+$/.test(trustedDefaultBranch) ||
    trustedDefaultBranch.startsWith("/") ||
    trustedDefaultBranch.endsWith("/") ||
    !/^[a-f0-9]{64}$/.test(findingFingerprint) ||
    !/^[a-f0-9]{64}$/.test(remediationCycle)
  ) {
    throw new Error("Invalid managed remediation PR lookup context");
  }
  const branchPrefix =
    `codex/upstream-review-${findingFingerprint.slice(0, 16)}` +
    `-i${trustedIssueNumber}-b`;
  const related = [];

  for (const pullRequest of ensureArray(pullRequests)) {
    if (!isRecord(pullRequest)) continue;
    const marker = parseManagedRemediationPrMarker(pullRequest.body);
    const markerMatches =
      marker?.issue_number === trustedIssueNumber &&
      marker.finding_fingerprint === findingFingerprint &&
      marker.remediation_cycle === remediationCycle;
    const headRef =
      typeof pullRequest.head?.ref === "string"
        ? pullRequest.head.ref
        : "";
    const branchMatches =
      pullRequest.head?.repo?.full_name === trustedRepository &&
      headRef.startsWith(branchPrefix);
    const trustedMarkerCandidate =
      markerMatches && pullRequest.user?.login === GITHUB_ACTIONS_LOGIN;
    if (!branchMatches && !trustedMarkerCandidate) continue;

    const pullRequestNumber = validateIssueNumber(
      pullRequest.number,
      "managed remediation PR number"
    );
    const baseSha =
      typeof pullRequest.base?.sha === "string"
        ? pullRequest.base.sha
        : "";
    const expectedBranch =
      /^[a-f0-9]{40}$/.test(baseSha)
        ? getFixBranch(
            findingFingerprint,
            trustedIssueNumber,
            baseSha
          )
        : "";
    const closed = pullRequest.state === "closed";
    const merged =
      closed &&
      typeof pullRequest.merged_at === "string" &&
      pullRequest.merged_at.length > 0;
    if (
      !markerMatches ||
      pullRequest.user?.login !== GITHUB_ACTIONS_LOGIN ||
      pullRequest.html_url !==
        `https://github.com/${trustedRepository}/pull/${pullRequestNumber}` ||
      pullRequest.base?.repo?.full_name !== trustedRepository ||
      pullRequest.base?.ref !== trustedDefaultBranch ||
      !["open", "closed"].includes(pullRequest.state) ||
      (pullRequest.state === "open" && pullRequest.merged_at != null) ||
      expectedBranch === "" ||
      headRef !== expectedBranch ||
      (
        pullRequest.head?.repo?.full_name !== trustedRepository &&
        !(closed && pullRequest.head?.repo == null)
      )
    ) {
      throw new Error(
        "Conflicting pull request belongs to the managed remediation Issue cycle"
      );
    }
    related.push({
      number: pullRequestNumber,
      url: pullRequest.html_url,
      status: merged
        ? "merged_pr_pending_finalization"
        : closed
          ? "closed_pr_requires_manual_recovery"
          : "active_pr",
    });
  }

  if (related.length > 1) {
    throw new Error(
      "More than one pull request belongs to the managed remediation Issue cycle"
    );
  }
  return related[0] ?? null;
}

function parseRepoSlug(value = process.env.GITHUB_REPOSITORY) {
  const slug = validateRepositorySlug(value);
  const [owner, repo] = slug.split("/");
  return { owner, repo };
}

function validateManagedIssueSnapshot(
  issue,
  {
    repository,
    issueNumber,
    findingFingerprint,
    remediationCycle,
    coverageFingerprint,
    findingKeys,
    markerVersion,
    expectedState = "open",
  }
) {
  const number = validateIssueNumber(issueNumber);
  const marker = parseIssueCycleMarker(issue?.body);
  const normalizedFindingKeys =
    findingKeys == null
      ? null
      : validateFindingKeys(findingKeys, {
          label: "expected managed Issue finding keys",
        });
  if (
    !isRecord(issue) ||
    issue.pull_request ||
    issue.number !== number ||
    issue.html_url !== `https://github.com/${repository}/issues/${number}` ||
    issue.state !== expectedState ||
    issue.user?.login !== GITHUB_ACTIONS_LOGIN ||
    marker?.finding_fingerprint !== findingFingerprint ||
    marker?.remediation_cycle !== remediationCycle ||
    (
      coverageFingerprint != null &&
      marker?.coverage_fingerprint !== coverageFingerprint
    ) ||
    (markerVersion != null && marker?.version !== markerVersion) ||
    (
      normalizedFindingKeys != null &&
      marker?.version === ISSUE_MARKER_VERSION &&
      (
        marker.finding_keys.length !== normalizedFindingKeys.length ||
        marker.finding_keys.some(
          (findingKey, index) => findingKey !== normalizedFindingKeys[index]
        )
      )
    )
  ) {
    throw new Error(
      `GitHub returned an unexpected managed Issue snapshot for #${number}`
    );
  }
  return issue;
}

function getManagedIssueSnapshot(issue, repository) {
  if (
    !isRecord(issue) ||
    issue.pull_request ||
    issue.user?.login !== GITHUB_ACTIONS_LOGIN
  ) {
    return null;
  }
  const issueNumber = validateIssueNumber(
    issue.number,
    "managed Issue number"
  );
  if (
    issue.html_url !==
      `https://github.com/${repository}/issues/${issueNumber}` ||
    !["open", "closed"].includes(issue.state)
  ) {
    throw new Error(
      `GitHub returned an invalid managed Issue snapshot for #${issueNumber}`
    );
  }
  let marker;
  try {
    marker = parseIssueCycleMarker(issue.body);
  } catch (error) {
    if (issue.state === "closed") return null;
    throw error;
  }
  if (!marker) return null;
  return { issue, marker };
}

function buildScopedIssueReport(
  report,
  findings,
  { coveredFindingCount = 0, coveredByIssueNumbers = [], status = "" } = {}
) {
  const detectedFindingCount = getUniqueFindingEntries(
    report.review.findings
  ).length;
  const scopedFindingCount = getUniqueFindingEntries(findings).length;
  const reconciliationSummary =
    coveredFindingCount > 0
      ? ` Reconciliation: ${coveredFindingCount} finding(s) are already tracked by Open managed Issue(s) ${coveredByIssueNumbers
          .map((issueNumber) => `#${issueNumber}`)
          .join(", ")}; ${scopedFindingCount} new finding(s) remain in this cycle.`
      : "";
  const statusSummary = status ? ` ${normalizeWhitespace(status)}` : "";
  return {
    ...report,
    review: {
      ...report.review,
      summary: truncateText(
        `${report.review.summary || `${detectedFindingCount} finding(s) detected.`}${reconciliationSummary}${statusSummary}`,
        MAX_AGENT_SUMMARY_LENGTH
      ),
      findings,
    },
  };
}

async function revalidateCoveringIssues(
  coveringSnapshots,
  { owner, repo, repository, request }
) {
  await Promise.all(
    coveringSnapshots.map(async ({ issue, marker }) => {
      const fresh = await request(
        `/repos/${owner}/${repo}/issues/${issue.number}`
      );
      validateManagedIssueSnapshot(fresh, {
        repository,
        issueNumber: issue.number,
        findingFingerprint: marker.finding_fingerprint,
        remediationCycle: marker.remediation_cycle,
        coverageFingerprint: marker.coverage_fingerprint,
        findingKeys: marker.finding_keys,
        markerVersion: marker.version,
      });
    })
  );
}

async function syncIssue(report, options = {}) {
  const dryRun =
    options.dryRun ??
    parseBoolean(process.env.UPSTREAM_REVIEW_DRY_RUN, false);
  if (dryRun) {
    return {
      action: "dry_run",
      finding_keys: getFindingKeys(report.review.findings),
    };
  }

  if (report.review.findings.length === 0) {
    return {
      action: "noop",
      issue_number: 0,
      issue_url: "",
      finding_fingerprint: getFindingFingerprint([]),
      coverage_fingerprint: getFindingCoverageFingerprint([]),
      finding_keys: [],
      remediation_cycle: "",
      detected_finding_count: 0,
      covered_finding_count: 0,
      new_finding_count: 0,
      covered_by_issue_numbers: [],
      coverage: [],
    };
  }

  const request = options.request ?? githubRequest;
  const repository = validateRepositorySlug(
    options.repository ?? process.env.GITHUB_REPOSITORY
  );
  const { owner, repo } = parseRepoSlug(repository);
  const detectedEntries = getUniqueFindingEntries(report.review.findings);
  const detectedFindings = detectedEntries.map((entry) => entry.finding);
  const detectedFindingFingerprint = getFindingFingerprint(detectedFindings);
  const issues = await listAllRepositoryIssues(owner, repo, request);
  const managedIssues = ensureArray(issues)
    .map((issue) => getManagedIssueSnapshot(issue, repository))
    .filter(Boolean)
    .sort((a, b) => Number(b.issue.number) - Number(a.issue.number));
  const openManagedIssues = managedIssues.filter(
    (snapshot) => snapshot.issue.state === "open"
  );
  const openFingerprints = new Map();
  for (const snapshot of openManagedIssues) {
    const fingerprint = snapshot.marker.finding_fingerprint;
    const existingIssueNumber = openFingerprints.get(fingerprint);
    if (existingIssueNumber != null) {
      throw new Error(
        `More than one open managed Issue matches finding fingerprint ${fingerprint}: #${existingIssueNumber} and #${snapshot.issue.number}`
      );
    }
    openFingerprints.set(fingerprint, snapshot.issue.number);
  }

  const coverageOwnerByKey = new Map();
  const legacyCoverageOwnerByKey = new Map();
  const openCurrentSnapshots = [];
  const openPreviousSnapshots = [];
  const openLegacySnapshots = [];
  const reportIdentityVersion =
    report.schema_version === 3 ? FINDING_IDENTITY_VERSION : 1;
  for (const snapshot of openManagedIssues) {
    if (snapshot.marker.version === LEGACY_ISSUE_MARKER_VERSION) {
      openLegacySnapshots.push(snapshot);
      continue;
    }
    if (
      snapshot.marker.finding_identity_version !== reportIdentityVersion
    ) {
      if (
        reportIdentityVersion === FINDING_IDENTITY_VERSION &&
        snapshot.marker.finding_identity_version === 1
      ) {
        openPreviousSnapshots.push(snapshot);
        for (const findingKey of snapshot.marker.finding_keys) {
          const existingOwner = legacyCoverageOwnerByKey.get(findingKey);
          if (existingOwner != null) {
            throw new Error(
              `Open managed Issues #${existingOwner} and #${snapshot.issue.number} contain overlapping legacy finding coverage`
            );
          }
          legacyCoverageOwnerByKey.set(findingKey, snapshot.issue.number);
        }
        continue;
      }
      throw new Error("Unsupported open managed Issue identity version");
    }
    openCurrentSnapshots.push(snapshot);
    for (const findingKey of snapshot.marker.finding_keys) {
      const existingOwner = coverageOwnerByKey.get(findingKey);
      if (existingOwner != null) {
        throw new Error(
          `Open managed Issues #${existingOwner} and #${snapshot.issue.number} contain overlapping finding coverage`
        );
      }
      coverageOwnerByKey.set(findingKey, snapshot.issue.number);
    }
  }

  const coveredIssueByFindingKey = new Map();
  const matchedLegacyFindingKeys = new Set();
  let uncoveredEntries = [];
  for (const entry of detectedEntries) {
    const legacyFindingKey =
      reportIdentityVersion === FINDING_IDENTITY_VERSION
        ? getLegacyFindingKey(entry.finding)
        : null;
    const coveringIssueNumber =
      coverageOwnerByKey.get(entry.finding_key) ??
      (
        legacyFindingKey != null
          ? legacyCoverageOwnerByKey.get(legacyFindingKey)
          : null
      );
    if (coveringIssueNumber == null) {
      uncoveredEntries.push(entry);
    } else {
      coveredIssueByFindingKey.set(entry.finding_key, coveringIssueNumber);
      if (legacyFindingKey != null && legacyCoverageOwnerByKey.has(legacyFindingKey)) {
        matchedLegacyFindingKeys.add(legacyFindingKey);
      }
    }
  }

  if (uncoveredEntries.length > 0 && openPreviousSnapshots.length > 0) {
    const snapshotsWithUnmatchedLegacyCoverage = openPreviousSnapshots.filter(
      (snapshot) =>
        snapshot.marker.finding_keys.some(
          (findingKey) => !matchedLegacyFindingKeys.has(findingKey)
        )
    );
    if (snapshotsWithUnmatchedLegacyCoverage.length > 0) {
      throw new Error(
        `Cannot safely reconcile new stable-identity findings while legacy identity-v1 Open managed Issue coverage is unmatched: ${snapshotsWithUnmatchedLegacyCoverage
          .map((snapshot) => `#${snapshot.issue.number}`)
          .join(", ")}`
      );
    }
  }

  let legacyCoveringSnapshot = null;
  if (uncoveredEntries.length > 0 && openLegacySnapshots.length > 0) {
    const uncoveredFingerprint = getFindingFingerprint(
      uncoveredEntries.map((entry) => entry.finding)
    );
    const matchingLegacyIssues = openLegacySnapshots.filter(
      (snapshot) =>
        snapshot.marker.finding_fingerprint === uncoveredFingerprint
    );
    if (matchingLegacyIssues.length > 1) {
      throw new Error(
        `More than one legacy Open managed Issue matches finding fingerprint ${uncoveredFingerprint}`
      );
    }
    if (matchingLegacyIssues.length === 0) {
      throw new Error(
        "Cannot safely reconcile new findings while a non-matching legacy Open managed Issue lacks per-finding coverage"
      );
    }
    legacyCoveringSnapshot = matchingLegacyIssues[0];
    for (const entry of uncoveredEntries) {
      coveredIssueByFindingKey.set(
        entry.finding_key,
        legacyCoveringSnapshot.issue.number
      );
    }
    uncoveredEntries = [];
  }

  const coveredByIssueNumbers = [
    ...new Set(coveredIssueByFindingKey.values()),
  ].sort((left, right) => left - right);
  const coveringSnapshotsByNumber = new Map(
    [
      ...openCurrentSnapshots,
      ...openPreviousSnapshots,
      ...openLegacySnapshots,
    ].map((snapshot) => [
      snapshot.issue.number,
      snapshot,
    ])
  );
  const coveringSnapshots = coveredByIssueNumbers.map((issueNumber) => {
    const snapshot = coveringSnapshotsByNumber.get(issueNumber);
    if (!snapshot) {
      throw new Error(
        `Missing trusted snapshot for covering Issue #${issueNumber}`
      );
    }
    return snapshot;
  });
  await revalidateCoveringIssues(coveringSnapshots, {
    owner,
    repo,
    repository,
    request,
  });

  const coverage = [...coveredIssueByFindingKey.entries()]
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([findingKey, issueNumber]) => ({
      finding_key: findingKey,
      issue_number: issueNumber,
    }));
  const uncoveredFindings = uncoveredEntries.map((entry) => entry.finding);
  const findingKeys = uncoveredEntries.map((entry) => entry.finding_key);
  if (uncoveredFindings.length === 0) {
    const detectedFindingKeys = getFindingKeys(detectedFindings);
    const exactCurrentSnapshot =
      report.schema_version === 3 &&
      coveredByIssueNumbers.length === 1
        ? coveringSnapshots.find((snapshot) => {
            const marker = snapshot.marker;
            return (
              marker.version === ISSUE_MARKER_VERSION &&
              marker.finding_identity_version === FINDING_IDENTITY_VERSION &&
              marker.finding_fingerprint === detectedFindingFingerprint &&
              marker.coverage_fingerprint ===
                getFindingCoverageFingerprintFromKeys(
                  detectedFindingKeys,
                  FINDING_IDENTITY_VERSION
                ) &&
              marker.finding_keys.length === detectedFindingKeys.length &&
              marker.finding_keys.every(
                (findingKey, index) =>
                  findingKey === detectedFindingKeys[index]
              )
            );
          })
        : null;
    if (exactCurrentSnapshot) {
      const defaultBranch = String(
        options.defaultBranch ??
          process.env.UPSTREAM_REVIEW_DEFAULT_BRANCH ??
          ""
      ).trim();
      const relatedPullRequest =
        classifyManagedRemediationPullRequests(
          await listAllRepositoryPullRequests(owner, repo, request),
          {
            repository,
            defaultBranch,
            issueNumber: exactCurrentSnapshot.issue.number,
            findingFingerprint: detectedFindingFingerprint,
            remediationCycle:
              exactCurrentSnapshot.marker.remediation_cycle,
          }
        );
      await revalidateCoveringIssues([exactCurrentSnapshot], {
        owner,
        repo,
        repository,
        request,
      });
      if (relatedPullRequest) {
        return {
          action: "covered",
          issue_number: 0,
          issue_url: "",
          finding_fingerprint: getFindingFingerprint([]),
          coverage_fingerprint: getFindingCoverageFingerprint([]),
          finding_keys: [],
          remediation_cycle: "",
          detected_finding_fingerprint: detectedFindingFingerprint,
          detected_finding_count: detectedEntries.length,
          covered_finding_count: coverage.length,
          new_finding_count: 0,
          covered_by_issue_numbers: coveredByIssueNumbers,
          coverage,
          recovery: {
            status: relatedPullRequest.status,
            related_pr_count: 1,
            pull_request_number: relatedPullRequest.number,
            pull_request_url: relatedPullRequest.url,
          },
        };
      }
      return {
        action: "resume_orphan",
        issue_number: exactCurrentSnapshot.issue.number,
        issue_url: exactCurrentSnapshot.issue.html_url,
        finding_fingerprint: detectedFindingFingerprint,
        coverage_fingerprint:
          exactCurrentSnapshot.marker.coverage_fingerprint,
        finding_keys: detectedFindingKeys,
        remediation_cycle:
          exactCurrentSnapshot.marker.remediation_cycle,
        detected_finding_fingerprint: detectedFindingFingerprint,
        detected_finding_count: detectedEntries.length,
        covered_finding_count: coverage.length,
        new_finding_count: 0,
        covered_by_issue_numbers: coveredByIssueNumbers,
        coverage,
        resumed_finding_count: detectedEntries.length,
        recovery: {
          status: "resumed_orphan",
          related_pr_count: 0,
        },
      };
    }
    return {
      action: "covered",
      issue_number: 0,
      issue_url: "",
      finding_fingerprint: getFindingFingerprint([]),
      coverage_fingerprint: getFindingCoverageFingerprint([]),
      finding_keys: [],
      remediation_cycle: "",
      detected_finding_fingerprint: detectedFindingFingerprint,
      detected_finding_count: detectedEntries.length,
      covered_finding_count: coverage.length,
      new_finding_count: 0,
      covered_by_issue_numbers: coveredByIssueNumbers,
      coverage,
    };
  }

  const findingFingerprint = getFindingFingerprint(uncoveredFindings);
  const coverageFingerprint =
    getFindingCoverageFingerprint(uncoveredFindings);
  const regressionByFindingKey = uncoveredEntries
    .map((entry) => {
      const legacyKey = getLegacyFindingKey(entry.finding);
      const matchingSnapshot = managedIssues.find((snapshot) => {
        if (snapshot.issue.state !== "closed") return false;
        if (snapshot.marker.version === LEGACY_ISSUE_MARKER_VERSION) {
          return false;
        }
        if (
          snapshot.marker.finding_identity_version ===
          reportIdentityVersion
        ) {
          return snapshot.marker.finding_keys.includes(entry.finding_key);
        }
        return (
          reportIdentityVersion === FINDING_IDENTITY_VERSION &&
          snapshot.marker.finding_identity_version === 1 &&
          snapshot.marker.finding_keys.includes(legacyKey)
        );
      });
      return matchingSnapshot
        ? {
            finding_key: entry.finding_key,
            issue_number: matchingSnapshot.issue.number,
          }
        : null;
    })
    .filter(Boolean);
  let regressionOfIssueNumbers = [
    ...new Set(
      regressionByFindingKey.map((entry) => entry.issue_number)
    ),
  ].sort((left, right) => left - right);
  if (
    regressionOfIssueNumbers.length === 0 &&
    reportIdentityVersion === 1
  ) {
    const legacyWholeIssue = managedIssues.find(
      (snapshot) =>
        snapshot.issue.state === "closed" &&
        snapshot.marker.version === LEGACY_ISSUE_MARKER_VERSION &&
        snapshot.marker.finding_fingerprint === findingFingerprint
    );
    if (legacyWholeIssue) {
      regressionOfIssueNumbers = [legacyWholeIssue.issue.number];
    }
  }
  const regressionOfIssueNumber =
    regressionOfIssueNumbers.length === 1
      ? regressionOfIssueNumbers[0]
      : null;
  const remediationCycle = createRemediationCycleId(
    repository,
    options.runId ?? process.env.GITHUB_RUN_ID,
    options.runAttempt ?? process.env.GITHUB_RUN_ATTEMPT ?? "1",
    findingFingerprint
  );
  const scopedReport = buildScopedIssueReport(report, uncoveredFindings, {
    coveredFindingCount: coverage.length,
    coveredByIssueNumbers,
  });
  const title = renderIssueTitle(scopedReport, findingFingerprint);
  const body = renderIssueBody(scopedReport, {
    findingFingerprint,
    coverageFingerprint,
    findingKeys,
    remediationCycle,
    regressionOfIssueNumber,
    regressionOfIssueNumbers,
    coveredByIssueNumbers,
  });
  const created = await request(`/repos/${owner}/${repo}/issues`, {
    method: "POST",
    body: JSON.stringify({ title, body }),
  });
  validateManagedIssueSnapshot(created, {
    repository,
    issueNumber: created?.number,
    findingFingerprint,
    remediationCycle,
    coverageFingerprint,
    findingKeys,
    markerVersion: ISSUE_MARKER_VERSION,
  });
  return {
    action: "created",
    issue_number: created.number,
    issue_url: created.html_url,
    finding_fingerprint: findingFingerprint,
    coverage_fingerprint: coverageFingerprint,
    finding_keys: findingKeys,
    remediation_cycle: remediationCycle,
    regression_of_issue_number: regressionOfIssueNumber,
    regression_of_issue_numbers: regressionOfIssueNumbers,
    regression_by_finding_key: regressionByFindingKey,
    detected_finding_fingerprint: detectedFindingFingerprint,
    detected_finding_count: detectedEntries.length,
    covered_finding_count: coverage.length,
    new_finding_count: uncoveredEntries.length,
    covered_by_issue_numbers: coveredByIssueNumbers,
    coverage,
  };
}

async function loadRemediationFixContext(options = {}) {
  const inputPath =
    options.inputPath ??
    process.env.UPSTREAM_REVIEW_FIX_INPUT_PATH?.trim();
  const agentOutputPath =
    options.agentOutputPath ??
    process.env.UPSTREAM_REVIEW_FIX_AGENT_OUTPUT_PATH?.trim();
  const manifestPath =
    options.manifestPath ??
    process.env.UPSTREAM_REVIEW_FIX_MANIFEST_PATH?.trim();
  const patchPath =
    options.patchPath ??
    process.env.UPSTREAM_REVIEW_FIX_PATCH_PATH?.trim();
  const reportPath =
    options.reportPath ??
    process.env.UPSTREAM_REVIEW_REPORT_PATH?.trim();
  const expectedBaseSha =
    options.baseSha ??
    process.env.UPSTREAM_REVIEW_BASE_SHA?.trim() ??
    "";
  const hasDirectContext =
    options.fixInput != null ||
    options.fixAgentOutput != null ||
    options.fixManifest != null ||
    options.fixPatch != null ||
    options.report != null;
  const hasPathContext =
    inputPath || agentOutputPath || manifestPath || patchPath || reportPath;
  if (!hasDirectContext && !hasPathContext) return null;
  if (!/^[a-f0-9]{40}$/.test(expectedBaseSha)) {
    throw new Error("Missing trusted remediation artifact base SHA");
  }

  let fixInput;
  let manifest;
  let patch;
  let agentOutputText;
  let rawReport;
  if (hasDirectContext) {
    if (
      options.fixInput == null ||
      options.fixAgentOutput == null ||
      options.fixManifest == null ||
      options.fixPatch == null ||
      options.report == null
    ) {
      throw new Error("Incomplete direct remediation artifact context");
    }
    fixInput = validateAgenticFixInput(options.fixInput);
    patch = Buffer.isBuffer(options.fixPatch)
      ? options.fixPatch
      : Buffer.from(options.fixPatch);
    manifest = validateFixManifest(
      options.fixManifest,
      fixInput,
      patch,
      expectedBaseSha
    );
    agentOutputText = JSON.stringify(options.fixAgentOutput);
    rawReport = options.report;
  } else {
    if (
      !inputPath ||
      !agentOutputPath ||
      !manifestPath ||
      !patchPath ||
      !reportPath
    ) {
      throw new Error("Incomplete remediation artifact paths");
    }
    ({ fixInput, manifest, patch } = await readAndValidateFixArtifact({
      inputPath,
      manifestPath,
      patchPath,
      expectedBaseSha,
    }));
    const [loadedAgentOutput, reportText] = await Promise.all([
      readTextFile(agentOutputPath, "Codex fix output"),
      readTextFile(reportPath, "agentic review report"),
    ]);
    agentOutputText = loadedAgentOutput;
    rawReport = parseJsonDocument(reportText, "agentic review report");
  }

  const metadata = parseAgentFixOutput(
    agentOutputText,
    fixInput,
    manifest.changed_files
  );
  const report = validateAgenticReviewReport(rawReport);
  const rebuiltFixInput = buildAgenticFixInput(report);
  if (
    sha256(JSON.stringify(rebuiltFixInput)) !==
    sha256(JSON.stringify(fixInput))
  ) {
    throw new Error(
      "Remediation report does not reproduce the verified agentic fix input"
    );
  }
  return { fixInput, manifest, metadata, report };
}

function validateRemediationVerificationResult(result, input) {
  if (
    !isRecord(result) ||
    result.schema_version !== 1 ||
    result.mode !== "remediation_verification_result" ||
    !Array.isArray(result.outcomes)
  ) {
    throw new Error("Invalid remediation verification result");
  }
  const normalized = parseRemediationVerificationOutput(
    JSON.stringify({
      complete: true,
      errors: [],
      input_sha256: result.input_sha256,
      summary: result.summary,
      outcomes: result.outcomes,
    }),
    input
  );
  if (JSON.stringify(normalized) !== JSON.stringify(result)) {
    throw new Error("Remediation verification result is not canonical");
  }
  return normalized;
}

async function loadRemediationVerificationContext(options = {}) {
  if (options.verificationInput && options.verificationResult) {
    const input = validateRemediationVerificationInput(
      options.verificationInput
    );
    return {
      input,
      result: validateRemediationVerificationResult(
        options.verificationResult,
        input
      ),
    };
  }
  const inputPath =
    options.verificationInputPath ??
    process.env.UPSTREAM_REVIEW_REMEDIATION_VERIFY_INPUT_PATH?.trim();
  const resultPath =
    options.verificationResultPath ??
    process.env.UPSTREAM_REVIEW_REMEDIATION_VERIFY_RESULT_PATH?.trim();
  if (!inputPath && !resultPath) return null;
  if (!inputPath || !resultPath) {
    throw new Error("Incomplete remediation verification artifact paths");
  }
  const [inputText, resultText] = await Promise.all([
    readTextFile(inputPath, "remediation verification input"),
    readTextFile(resultPath, "remediation verification result"),
  ]);
  const input = validateRemediationVerificationInput(
    parseJsonDocument(inputText, "remediation verification input")
  );
  return {
    input,
    result: validateRemediationVerificationResult(
      parseJsonDocument(resultText, "remediation verification result"),
      input
    ),
  };
}

async function loadApprovedRemediationFixContext(options = {}) {
  const expectedBaseSha = String(
    options.baseSha ??
      process.env.UPSTREAM_REVIEW_BASE_SHA ??
      ""
  ).trim();
  const hasDirectContext =
    options.approvedFixInput != null ||
    options.approvedFixManifest != null ||
    options.approvedFixPatch != null;
  if (hasDirectContext) {
    if (
      options.approvedFixInput == null ||
      options.approvedFixManifest == null ||
      options.approvedFixPatch == null
    ) {
      throw new Error("Incomplete approved remediation artifact context");
    }
    const fixInput = validateAgenticFixInput(options.approvedFixInput);
    const patch = Buffer.isBuffer(options.approvedFixPatch)
      ? options.approvedFixPatch
      : Buffer.from(options.approvedFixPatch);
    const manifest = validateFixManifest(
      options.approvedFixManifest,
      fixInput,
      patch,
      expectedBaseSha
    );
    return { fixInput, manifest, patch };
  }

  const inputPath =
    options.approvedFixInputPath ??
    process.env.UPSTREAM_REVIEW_APPROVED_FIX_INPUT_PATH?.trim();
  const manifestPath =
    options.approvedFixManifestPath ??
    process.env.UPSTREAM_REVIEW_APPROVED_FIX_MANIFEST_PATH?.trim();
  const patchPath =
    options.approvedFixPatchPath ??
    process.env.UPSTREAM_REVIEW_APPROVED_FIX_PATCH_PATH?.trim();
  if (!inputPath && !manifestPath && !patchPath) return null;
  if (!inputPath || !manifestPath || !patchPath) {
    throw new Error("Incomplete approved remediation artifact paths");
  }
  return readAndValidateFixArtifact({
    inputPath,
    manifestPath,
    patchPath,
    expectedBaseSha,
  });
}

async function finalizeRemediationIssue(options = {}) {
  const request = options.request ?? githubRequest;
  const repository = validateRepositorySlug(
    options.repository ?? process.env.GITHUB_REPOSITORY
  );
  const { owner, repo } = parseRepoSlug(repository);
  const issueNumber = validateIssueNumber(
    options.issueNumber ??
      process.env.UPSTREAM_REVIEW_ISSUE_NUMBER,
    "remediation Issue number"
  );
  const issueUrl = validateIssueUrl(
    options.issueUrl ??
      process.env.UPSTREAM_REVIEW_ISSUE_URL,
    repository,
    issueNumber
  );
  const findingFingerprint = String(
    options.findingFingerprint ??
      process.env.UPSTREAM_REVIEW_FINDING_FINGERPRINT ??
      ""
  ).trim();
  const remediationCycle = String(
    options.remediationCycle ??
      process.env.UPSTREAM_REVIEW_REMEDIATION_CYCLE ??
      ""
  ).trim();
  const pullRequestNumber = validateIssueNumber(
    options.pullRequestNumber ??
      process.env.UPSTREAM_REVIEW_PR_NUMBER,
    "automatic pull request number"
  );
  const pullRequestUrl = String(
    options.pullRequestUrl ??
      process.env.UPSTREAM_REVIEW_PR_URL ??
      ""
  ).trim();
  const expectedPullRequestUrl =
    `https://github.com/${repository}/pull/${pullRequestNumber}`;
  const prBodySha256 = String(
    options.prBodySha256 ??
      process.env.UPSTREAM_REVIEW_PR_BODY_SHA256 ??
      ""
  ).trim();
  const mergeSha = String(
    options.mergeSha ??
      process.env.UPSTREAM_REVIEW_MERGE_SHA ??
      ""
  ).trim();
  const allFindingsAddressedValue =
    options.allFindingsAddressed ??
    process.env.UPSTREAM_REVIEW_ALL_FINDINGS_ADDRESSED;
  if (
    !/^[a-f0-9]{64}$/.test(findingFingerprint) ||
    !/^[a-f0-9]{64}$/.test(remediationCycle) ||
    pullRequestUrl !== expectedPullRequestUrl ||
    !/^[a-f0-9]{64}$/.test(prBodySha256) ||
    !/^[a-f0-9]{40}$/.test(mergeSha) ||
    ![true, false, "true", "false"].includes(allFindingsAddressedValue)
  ) {
    throw new Error("Invalid trusted remediation completion context");
  }
  const allFindingsAddressed =
    allFindingsAddressedValue === true ||
    allFindingsAddressedValue === "true";
  const approvedStage = String(
    options.approvedStage ??
      process.env.UPSTREAM_REVIEW_APPROVED_STAGE ??
      ""
  ).trim();
  const [
    issue,
    pullRequest,
    mergeCommit,
    fixContext,
    approvedFixContext,
    verificationContext,
  ] = await Promise.all([
    request(`/repos/${owner}/${repo}/issues/${issueNumber}`),
    request(`/repos/${owner}/${repo}/pulls/${pullRequestNumber}`),
    request(`/repos/${owner}/${repo}/git/commits/${mergeSha}`),
    loadRemediationFixContext(options),
    loadApprovedRemediationFixContext(options),
    loadRemediationVerificationContext(options),
  ]);
  if (
    !isRecord(pullRequest) ||
    pullRequest.number !== pullRequestNumber ||
    pullRequest.html_url !== pullRequestUrl ||
    pullRequest.state !== "closed" ||
    pullRequest.merged !== true ||
    pullRequest.merge_commit_sha !== mergeSha ||
    pullRequest.user?.login !== GITHUB_ACTIONS_LOGIN ||
    pullRequest.base?.repo?.full_name !== repository ||
    typeof pullRequest.body !== "string" ||
    sha256(Buffer.from(pullRequest.body, "utf8")) !== prBodySha256
  ) {
    throw new Error(
      "Merged automatic PR does not match the trusted remediation snapshot"
    );
  }
  const trustedBaseSha =
    fixContext?.fixInput.source_report.base_sha ??
    approvedFixContext?.fixInput.source_report.base_sha ??
    String(
      options.baseSha ??
        process.env.UPSTREAM_REVIEW_BASE_SHA ??
        ""
    ).trim();
  const trustedResultTree =
    approvedFixContext?.manifest.result_tree ??
    fixContext?.manifest.result_tree ??
    "";
  if (
    !isRecord(mergeCommit) ||
    mergeCommit.sha !== mergeSha ||
    !Array.isArray(mergeCommit.parents) ||
    mergeCommit.parents.length !== 1 ||
    mergeCommit.parents[0]?.sha !== trustedBaseSha ||
    (
      trustedResultTree &&
      mergeCommit.tree?.sha !== trustedResultTree
    )
  ) {
    throw new Error(
      "Merged automatic PR commit does not match the trusted base and result tree"
    );
  }
  if (
    fixContext?.fixInput.schema_version === 3 &&
    (approvedFixContext == null || verificationContext == null)
  ) {
    throw new Error(
      "Missing approved artifact or exact-head verification for a v3 remediation cycle"
    );
  }
  if (verificationContext) {
    const { input: verificationInput, result: verificationResult } =
      verificationContext;
    if (approvedFixContext) {
      validateRemediationVerificationBinding(
        verificationInput,
        approvedFixContext.fixInput,
        approvedFixContext.manifest,
        pullRequest.head?.sha ?? ""
      );
    }
    if (
      verificationResult.status !== "resolved" ||
      verificationInput.base_sha !==
        (fixContext?.fixInput.source_report.base_sha ?? "") ||
      verificationInput.finding_fingerprint !== findingFingerprint ||
      verificationInput.remediation_cycle !== remediationCycle ||
      verificationInput.head_sha !== pullRequest.head?.sha ||
      verificationResult.head_sha !== pullRequest.head?.sha ||
      verificationResult.finding_fingerprint !== findingFingerprint ||
      verificationResult.remediation_cycle !== remediationCycle ||
      verificationResult.patch_sha256 !== verificationInput.patch_sha256 ||
      verificationResult.outcomes.some(
        (outcome) =>
          outcome.status !== "resolved" || outcome.confidence === "low"
      )
    ) {
      throw new Error(
        "Exact-head remediation verification does not match the merged remediation"
      );
    }
  }
  if (
    fixContext?.fixInput.schema_version === 3 &&
    approvedFixContext &&
    !isDeepStrictEqual(
      approvedFixContext.fixInput,
      fixContext.fixInput
    )
  ) {
    throw new Error(
      "Approved remediation artifact does not match the original fix scope"
    );
  }
  const expectedPrMarker =
    `<!-- upstream-review-pr:v1 issue=${issueNumber} fingerprint=${findingFingerprint} cycle=${remediationCycle} -->`;
  const expectedReference = allFindingsAddressed
    ? `Closes #${issueNumber}`
    : `Refs #${issueNumber}`;
  if (
    !pullRequest.body.startsWith(`${expectedPrMarker}\n`) ||
    !pullRequest.body.split("\n").includes(expectedReference)
  ) {
    throw new Error(
      "Merged automatic PR body does not match the remediation cycle"
    );
  }

  const issueMarker = parseIssueCycleMarker(issue?.body);
  if (
    issueMarker?.version === ISSUE_MARKER_VERSION &&
    fixContext == null
  ) {
    throw new Error(
      "Missing verified fix artifacts for a v2 remediation Issue"
    );
  }
  if (
    fixContext != null &&
    issueMarker?.version !== ISSUE_MARKER_VERSION
  ) {
    throw new Error(
      "Verified v2 remediation artifacts require a v2 managed Issue marker"
    );
  }
  let cycleFindingKeys = null;
  let cycleCoverageFingerprint = null;
  let unresolvedFindings = null;
  let unresolvedFindingKeys = null;
  let unresolvedFindingFingerprint = null;
  let unresolvedCoverageFingerprint = null;
  if (fixContext) {
    const { fixInput, manifest, metadata } = fixContext;
    if (
      ![
        "initial-review",
        "rework-round-1",
        "rework-round-2",
        "rework-round-3",
      ].includes(approvedStage)
    ) {
      throw new Error("Invalid trusted remediation approval stage");
    }
    const metadataAllFindingsAddressed = metadata.outcomes.every(
      (outcome) => outcome.status === "fixed"
    );
    if (
      fixInput.source_report.issue_number !== issueNumber ||
      fixInput.source_report.issue_url !== issueUrl ||
      fixInput.source_report.remediation_cycle !== remediationCycle ||
      fixInput.finding_fingerprint !== findingFingerprint ||
      manifest.issue_number !== issueNumber ||
      manifest.remediation_cycle !== remediationCycle ||
      manifest.finding_fingerprint !== findingFingerprint ||
      metadataAllFindingsAddressed !== allFindingsAddressed
    ) {
      throw new Error(
        "Verified fix artifacts do not match the merged remediation cycle"
      );
    }
    const runId = String(
      options.runId ?? process.env.GITHUB_RUN_ID ?? ""
    ).trim();
    const expectedPrBody = renderFixPrBody(metadata, manifest, {
      repository,
      runId,
      patchSha256: manifest.patch_sha256,
      issueUrl,
    });
    if (
      sha256(Buffer.from(expectedPrBody, "utf8")) !== prBodySha256 ||
      expectedPrBody !== pullRequest.body
    ) {
      throw new Error(
        "Verified fix artifacts do not reproduce the merged pull request body"
      );
    }
    cycleFindingKeys = getFindingKeys(fixInput.findings);
    cycleCoverageFingerprint =
      getFindingCoverageFingerprintFromKeys(
        cycleFindingKeys,
        fixInput.schema_version === 3 ? FINDING_IDENTITY_VERSION : 1
      );
    if (!allFindingsAddressed) {
      const outcomesByFindingId = new Map(
        metadata.outcomes.map((outcome) => [
          outcome.finding_id,
          outcome,
        ])
      );
      unresolvedFindings = fixInput.findings.filter(
        (finding) =>
          outcomesByFindingId.get(finding.finding_id)?.status === "not_fixed"
      );
      if (unresolvedFindings.length === 0) {
        throw new Error(
          "Partial remediation metadata does not contain unresolved findings"
        );
      }
      unresolvedFindingKeys = getFindingKeys(unresolvedFindings);
      unresolvedFindingFingerprint =
        getFindingFingerprint(unresolvedFindings);
      unresolvedCoverageFingerprint =
        getFindingCoverageFingerprintFromKeys(
          unresolvedFindingKeys,
          fixInput.schema_version === 3 ? FINDING_IDENTITY_VERSION : 1
        );
    }
  }
  const expectedIssueState =
    issue?.state === "closed" ? "closed" : "open";
  validateManagedIssueSnapshot(issue, {
    repository,
    issueNumber,
    findingFingerprint,
    remediationCycle,
    expectedState: expectedIssueState,
  });
  let coverageAlreadyReduced = false;
  if (
    issueMarker?.version === ISSUE_MARKER_VERSION &&
    cycleFindingKeys != null
  ) {
    const markerHasKeys = (expectedFindingKeys) =>
      issueMarker.finding_keys.length === expectedFindingKeys.length &&
      issueMarker.finding_keys.every(
        (findingKey, index) => findingKey === expectedFindingKeys[index]
      );
    const hasOriginalCoverage =
      issueMarker.coverage_fingerprint === cycleCoverageFingerprint &&
      markerHasKeys(cycleFindingKeys);
    const hasReducedCoverage =
      !allFindingsAddressed &&
      approvedStage === "initial-review" &&
      issueMarker.coverage_fingerprint === unresolvedCoverageFingerprint &&
      markerHasKeys(unresolvedFindingKeys);
    if (!hasOriginalCoverage && !hasReducedCoverage) {
      throw new Error(
        `Managed remediation Issue #${issueNumber} has unexpected v2 coverage`
      );
    }
    coverageAlreadyReduced = hasReducedCoverage;
  }
  const exactHeadVerificationResolved =
    verificationContext?.result.status === "resolved";
  if (!allFindingsAddressed && !exactHeadVerificationResolved) {
    if (issue.state !== "open") {
      throw new Error(
        `Partially addressed remediation Issue #${issueNumber} was closed unexpectedly`
      );
    }
    if (fixContext == null) {
      return {
        action: "left_open",
        issue_number: issueNumber,
        issue_url: issueUrl,
      };
    }
    if (approvedStage !== "initial-review") {
      return {
        action: "left_open_after_rework",
        issue_number: issueNumber,
        issue_url: issueUrl,
        finding_keys: cycleFindingKeys,
        approved_stage: approvedStage,
      };
    }
    if (coverageAlreadyReduced) {
      return {
        action: "already_reduced",
        issue_number: issueNumber,
        issue_url: issueUrl,
        coverage_fingerprint: unresolvedCoverageFingerprint,
        finding_keys: unresolvedFindingKeys,
      };
    }
    const scopedReport = buildScopedIssueReport(
      fixContext.report,
      unresolvedFindings,
      {
        coveredFindingCount:
          fixContext.report.issue?.covered_finding_count ?? 0,
        coveredByIssueNumbers:
          fixContext.report.issue?.covered_by_issue_numbers ?? [],
        status: `Partial remediation PR #${pullRequestNumber} merged; ${unresolvedFindings.length} finding(s) remain unresolved.`,
      }
    );
    const title = renderIssueTitle(
      scopedReport,
      unresolvedFindingFingerprint
    );
    const body = renderIssueBody(scopedReport, {
      findingFingerprint,
      coverageFingerprint: unresolvedCoverageFingerprint,
      findingKeys: unresolvedFindingKeys,
      remediationCycle,
      regressionOfIssueNumber:
        fixContext.report.issue?.regression_of_issue_number ?? null,
      coveredByIssueNumbers:
        fixContext.report.issue?.covered_by_issue_numbers ?? [],
    });
    const updated = await request(
      `/repos/${owner}/${repo}/issues/${issueNumber}`,
      {
        method: "PATCH",
        body: JSON.stringify({ title, body }),
      }
    );
    validateManagedIssueSnapshot(updated, {
      repository,
      issueNumber,
      findingFingerprint,
      remediationCycle,
      coverageFingerprint: unresolvedCoverageFingerprint,
      findingKeys: unresolvedFindingKeys,
      markerVersion: ISSUE_MARKER_VERSION,
    });
    return {
      action: "coverage_reduced",
      issue_number: issueNumber,
      issue_url: issueUrl,
      coverage_fingerprint: unresolvedCoverageFingerprint,
      finding_keys: unresolvedFindingKeys,
    };
  }
  if (issue.state === "closed") {
    if (issue.state_reason !== "completed") {
      throw new Error(
        `Remediation Issue #${issueNumber} was not closed as completed`
      );
    }
    return {
      action: "already_closed",
      issue_number: issueNumber,
      issue_url: issueUrl,
    };
  }

  const updated = await request(`/repos/${owner}/${repo}/issues/${issueNumber}`, {
    method: "PATCH",
    body: JSON.stringify({
      state: "closed",
      state_reason: "completed",
    }),
  });
  validateManagedIssueSnapshot(updated, {
    repository,
    issueNumber,
    findingFingerprint,
    remediationCycle,
    findingKeys: coverageAlreadyReduced
      ? unresolvedFindingKeys
      : cycleFindingKeys,
    expectedState: "closed",
  });
  if (updated.state_reason !== "completed") {
    throw new Error(
      `Remediation Issue #${issueNumber} did not close as completed`
    );
  }
  return {
    action: "closed",
    issue_number: issueNumber,
    issue_url: issueUrl,
  };
}

async function writeReport(report, outputPath, pretty = true) {
  if (!outputPath) return;
  const resolved = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const json = pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report);
  await fs.writeFile(resolved, json + "\n", "utf8");
}

async function writeTextFile(outputPath, content) {
  if (!outputPath) {
    throw new Error("Missing output path");
  }
  const resolved = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, "utf8");
}

async function appendGitHubOutputs(values, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return;
  const lines = Object.entries(values).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid GitHub output name: ${key}`);
    }
    const normalizedValue = String(value ?? "");
    if (/[\r\n]/.test(normalizedValue)) {
      throw new Error(`Invalid multiline GitHub output: ${key}`);
    }
    return `${key}=${normalizedValue}`;
  });
  await fs.appendFile(path.resolve(outputPath), `${lines.join("\n")}\n`, "utf8");
}

async function prepareAgenticFix(options = {}) {
  const reportPath =
    options.reportPath ??
    process.env.UPSTREAM_REVIEW_REPORT_PATH?.trim();
  const outputPath =
    options.outputPath ??
    process.env.UPSTREAM_REVIEW_FIX_INPUT_PATH?.trim();
  const reportText = await readTextFile(reportPath, "agentic review report");
  const report = parseJsonDocument(reportText, "agentic review report");
  const fixInput = buildAgenticFixInput(report);
  await writeReport(fixInput, outputPath, false);

  const hasFindings = fixInput.findings.length > 0;
  await appendGitHubOutputs(
    {
      has_findings: hasFindings,
      finding_count: fixInput.findings.length,
      finding_fingerprint: fixInput.finding_fingerprint,
      fix_branch: fixInput.fix_branch,
      issue_number: fixInput.source_report.issue_number || "",
      issue_url: fixInput.source_report.issue_url,
      remediation_cycle: fixInput.source_report.remediation_cycle,
    },
    options.githubOutputPath
  );
  console.log(
    JSON.stringify({
      mode: fixInput.mode,
      finding_count: fixInput.findings.length,
      target_games: fixInput.target_games,
      output_path: path.resolve(outputPath),
    })
  );
  return fixInput;
}

async function runGit(args, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const encoding = options.encoding === null ? null : "utf8";
  const env = { ...process.env };
  for (const key of [
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_WORK_TREE",
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_EXEC_PATH",
    "GIT_CONFIG_PARAMETERS",
  ]) {
    delete env[key];
  }
  Object.assign(env, {
    PATH: "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "0",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_EXTERNAL_DIFF: "",
    GIT_DIFF_OPTS: "",
  });
  if (options.gitIndexFile) {
    env.GIT_INDEX_FILE = path.resolve(options.gitIndexFile);
  }
  return await execFileAsync("git", ["--no-replace-objects", ...args], {
    cwd,
    encoding,
    env,
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function assertSemanticDiff(cwd, base = "HEAD") {
  try {
    await runGit(["diff", "-w", "--quiet", base, "--"], { cwd });
  } catch (error) {
    if (error && typeof error === "object" && error.code === 1) return;
    throw error;
  }
  throw new Error("Codex produced only whitespace changes");
}

function parseModifiedFileStatus(text) {
  const files = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line) continue;
    const separatorIndex = line.indexOf("\t");
    const status = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    const file = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
    if (status !== "M" || !file) {
      throw new Error(
        `Codex fix may only modify existing regular files; found ${line}`
      );
    }
    files.push(file);
  }
  return normalizeChangedFiles(files);
}

function validateFixManifest(manifest, fixInput, patch, expectedBaseSha = "") {
  if (
    !isRecord(manifest) ||
    manifest.schema_version !== 2 ||
    manifest.mode !== "agentic_fix_manifest" ||
    typeof manifest.base_sha !== "string" ||
    !/^[a-f0-9]{40}$/.test(manifest.base_sha) ||
    typeof manifest.finding_fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.finding_fingerprint) ||
    !Number.isSafeInteger(manifest.issue_number) ||
    manifest.issue_number <= 0 ||
    manifest.issue_number > 2_147_483_647 ||
    typeof manifest.remediation_cycle !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.remediation_cycle) ||
    typeof manifest.fix_branch !== "string" ||
    typeof manifest.patch_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.patch_sha256) ||
    !Number.isInteger(manifest.patch_bytes) ||
    manifest.patch_bytes <= 0 ||
    manifest.patch_bytes > MAX_FIX_PATCH_BYTES ||
    typeof manifest.result_tree !== "string" ||
    !/^[a-f0-9]{40}$/.test(manifest.result_tree) ||
    !Array.isArray(manifest.finding_ids) ||
    !Array.isArray(manifest.target_games) ||
    !Array.isArray(manifest.changed_files)
  ) {
    throw new Error("Invalid agentic fix manifest");
  }
  if (expectedBaseSha && manifest.base_sha !== expectedBaseSha) {
    throw new Error(
      `Agentic fix base SHA mismatch: expected ${expectedBaseSha}, got ${manifest.base_sha}`
    );
  }
  if (manifest.finding_fingerprint !== fixInput.finding_fingerprint) {
    throw new Error("Agentic fix manifest finding fingerprint mismatch");
  }
  if (
    manifest.base_sha !== fixInput.source_report.base_sha ||
    manifest.issue_number !== fixInput.source_report.issue_number ||
    manifest.remediation_cycle !== fixInput.source_report.remediation_cycle ||
    manifest.fix_branch !== fixInput.fix_branch ||
    manifest.fix_branch !==
      getFixBranch(
        manifest.finding_fingerprint,
        manifest.issue_number,
        manifest.base_sha
      )
  ) {
    throw new Error("Agentic fix manifest remediation cycle mismatch");
  }

  const expectedFindingIds = fixInput.findings
    .map((finding) => finding.finding_id)
    .sort();
  const manifestFindingIds = normalizeChangedFiles(manifest.finding_ids);
  assertExactStringSet(
    manifestFindingIds,
    expectedFindingIds,
    "Agentic fix manifest finding_ids"
  );
  const expectedTargetGames = [...fixInput.target_games].sort();
  const manifestTargetGames = normalizeChangedFiles(manifest.target_games);
  assertExactStringSet(
    manifestTargetGames,
    expectedTargetGames,
    "Agentic fix manifest target_games"
  );

  const changedFiles = normalizeChangedFiles(manifest.changed_files);
  if (
    changedFiles.length === 0 ||
    changedFiles.some((file) => !fixInput.allowed_files.includes(file))
  ) {
    throw new Error("Agentic fix manifest contains an invalid changed file");
  }
  if (!Buffer.isBuffer(patch) || patch.length !== manifest.patch_bytes) {
    throw new Error("Agentic fix patch byte count mismatch");
  }
  if (sha256(patch) !== manifest.patch_sha256) {
    throw new Error("Agentic fix patch SHA-256 mismatch");
  }
  return {
    ...manifest,
    finding_ids: manifestFindingIds,
    target_games: manifestTargetGames,
    changed_files: changedFiles,
  };
}

async function readAndValidateFixArtifact(options = {}) {
  const inputPath =
    options.inputPath ??
    process.env.UPSTREAM_REVIEW_FIX_INPUT_PATH?.trim();
  const manifestPath =
    options.manifestPath ??
    process.env.UPSTREAM_REVIEW_FIX_MANIFEST_PATH?.trim();
  const patchPath =
    options.patchPath ??
    process.env.UPSTREAM_REVIEW_FIX_PATCH_PATH?.trim();
  const expectedBaseSha =
    options.expectedBaseSha ??
    process.env.UPSTREAM_REVIEW_BASE_SHA?.trim() ??
    "";
  const [inputText, manifestText, patch] = await Promise.all([
    readTextFile(inputPath, "agentic fix input"),
    readTextFile(manifestPath, "agentic fix manifest"),
    fs.readFile(path.resolve(patchPath)),
  ]);
  const fixInput = validateAgenticFixInput(
    parseJsonDocument(inputText, "agentic fix input")
  );
  const manifest = validateFixManifest(
    parseJsonDocument(manifestText, "agentic fix manifest"),
    fixInput,
    patch,
    expectedBaseSha
  );
  return { fixInput, manifest, patch };
}

async function inspectAgenticFixPatch(patchPath, cwd) {
  const resolvedPatchPath = path.resolve(patchPath);
  const [headResult, numstatResult, summaryResult] = await Promise.all([
    runGit(["rev-parse", "HEAD"], { cwd }),
    runGit(["apply", "--numstat", "-z", "--", resolvedPatchPath], {
      cwd,
      encoding: null,
    }),
    runGit(["apply", "--summary", "--", resolvedPatchPath], { cwd }),
    runGit(["apply", "--check", "--", resolvedPatchPath], { cwd }),
  ]);
  const summary = String(summaryResult.stdout).trim();
  if (summary) {
    throw new Error(
      `Agentic fix patch may only modify existing regular files: ${summary}`
    );
  }

  const changedFiles = [];
  for (const record of Buffer.from(numstatResult.stdout)
    .toString("utf8")
    .split("\0")
    .filter(Boolean)) {
    const fields = record.split("\t");
    if (
      fields.length !== 3 ||
      !fields[2] ||
      (fields[0] === "-" && fields[1] === "-")
    ) {
      throw new Error("Agentic fix artifact contains an invalid or binary patch");
    }
    changedFiles.push(fields[2]);
  }
  return {
    head_sha: String(headResult.stdout).trim(),
    changed_files: normalizeChangedFiles(changedFiles),
  };
}

async function computePatchedTree(baseSha, patch, cwd, label) {
  if (!Buffer.isBuffer(patch) || patch.length === 0) {
    throw new Error(`${label} is empty`);
  }
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "game-cal-rework-index-")
  );
  const indexPath = path.join(tempDir, "index");
  const patchPath = path.join(tempDir, "patch.diff");
  try {
    await fs.writeFile(patchPath, patch);
    await runGit(["read-tree", baseSha], {
      cwd,
      gitIndexFile: indexPath,
    });
    await runGit(["apply", "--cached", "--check", "--", patchPath], {
      cwd,
      gitIndexFile: indexPath,
    });
    await runGit(["apply", "--cached", "--", patchPath], {
      cwd,
      gitIndexFile: indexPath,
    });
    const treeResult = await runGit(["write-tree"], {
      cwd,
      gitIndexFile: indexPath,
    });
    const tree = String(treeResult.stdout).trim();
    if (!/^[a-f0-9]{40}$/.test(tree)) {
      throw new Error(`${label} produced an invalid result tree`);
    }
    return tree;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function inspectPatchBuffer(patch, baseSha, cwd, label) {
  if (!Buffer.isBuffer(patch) || patch.length === 0) {
    throw new Error(`${label} is empty`);
  }
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "game-cal-rework-patch-")
  );
  const patchPath = path.join(tempDir, "patch.diff");
  try {
    await fs.writeFile(patchPath, patch);
    const [numstatResult, summaryResult, resultTree] = await Promise.all([
      runGit(["apply", "--numstat", "-z", "--", patchPath], {
        cwd,
        encoding: null,
      }),
      runGit(["apply", "--summary", "--", patchPath], { cwd }),
      computePatchedTree(baseSha, patch, cwd, label),
    ]);
    const summary = String(summaryResult.stdout).trim();
    if (summary) {
      throw new Error(
        `${label} may only modify existing regular files: ${summary}`
      );
    }
    const changedFiles = [];
    for (const record of Buffer.from(numstatResult.stdout)
      .toString("utf8")
      .split("\0")
      .filter(Boolean)) {
      const fields = record.split("\t");
      if (
        fields.length !== 3 ||
        !fields[2] ||
        (fields[0] === "-" && fields[1] === "-")
      ) {
        throw new Error(`${label} contains an invalid or binary patch`);
      }
      changedFiles.push(fields[2]);
    }
    return {
      changed_files: normalizeChangedFiles(changedFiles),
      result_tree: resultTree,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function verifyAgenticFixArtifact(options = {}) {
  const patchPath =
    options.patchPath ??
    process.env.UPSTREAM_REVIEW_FIX_PATCH_PATH?.trim();
  const cwd = path.resolve(
    options.cwd ??
      process.env.GITHUB_WORKSPACE?.trim() ??
      process.cwd()
  );
  const { fixInput, manifest, patch } =
    await readAndValidateFixArtifact(options);
  const inspection = await inspectAgenticFixPatch(patchPath, cwd);
  if (inspection.head_sha !== manifest.base_sha) {
    throw new Error(
      `Agentic fix checkout mismatch: expected ${manifest.base_sha}, got ${inspection.head_sha}`
    );
  }
  assertExactStringSet(
    inspection.changed_files,
    manifest.changed_files,
    "Agentic fix patch paths"
  );
  const resultTree = await computePatchedTree(
    manifest.base_sha,
    patch,
    cwd,
    "Agentic fix patch"
  );
  if (resultTree !== manifest.result_tree) {
    throw new Error("Agentic fix patch result tree mismatch");
  }
  await appendGitHubOutputs(
    {
      fix_branch: fixInput.fix_branch,
      patch_sha256: manifest.patch_sha256,
      patch_bytes: manifest.patch_bytes,
      result_tree: manifest.result_tree,
    },
    options.githubOutputPath
  );
  console.log(
    JSON.stringify({
      mode: manifest.mode,
      base_sha: manifest.base_sha,
      changed_files: manifest.changed_files,
      patch_sha256: manifest.patch_sha256,
      result_tree: manifest.result_tree,
    })
  );
  return manifest;
}

async function verifyAgenticFixArtifactAtHead(options = {}) {
  const cwd = path.resolve(
    options.cwd ??
      process.env.GITHUB_WORKSPACE?.trim() ??
      process.cwd()
  );
  const expectedHeadSha = String(
    options.headSha ??
      process.env.UPSTREAM_REVIEW_HEAD_SHA ??
      ""
  ).trim();
  if (!/^[a-f0-9]{40}$/.test(expectedHeadSha)) {
    throw new Error(
      `Invalid exact-head fix SHA: ${expectedHeadSha || "(empty)"}`
    );
  }

  const { fixInput, manifest, patch } =
    await readAndValidateFixArtifact(options);
  if (expectedHeadSha === manifest.base_sha) {
    throw new Error("Exact-head fix SHA must differ from the trusted base");
  }
  const [headResult, trackedStatusResult, inspection] = await Promise.all([
    runGit(["rev-parse", "HEAD"], { cwd }),
    runGit(["status", "--porcelain=v1", "--untracked-files=no"], { cwd }),
    inspectPatchBuffer(
      patch,
      manifest.base_sha,
      cwd,
      "Exact-head agentic fix patch"
    ),
  ]);
  const checkoutHead = String(headResult.stdout).trim();
  if (checkoutHead !== expectedHeadSha) {
    throw new Error(
      `Exact-head fix checkout mismatch: expected ${expectedHeadSha}, got ${checkoutHead}`
    );
  }
  if (String(trackedStatusResult.stdout).trim()) {
    throw new Error("Exact-head fix checkout contains tracked worktree changes");
  }
  assertExactStringSet(
    inspection.changed_files,
    manifest.changed_files,
    "Exact-head agentic fix patch paths"
  );
  if (inspection.result_tree !== manifest.result_tree) {
    throw new Error("Exact-head agentic fix patch result tree mismatch");
  }
  await assertSingleParentSnapshot(
    expectedHeadSha,
    manifest.base_sha,
    manifest.result_tree,
    cwd,
    "Exact-head agentic fix commit"
  );
  await appendGitHubOutputs(
    {
      fix_branch: fixInput.fix_branch,
      head_sha: expectedHeadSha,
      patch_sha256: manifest.patch_sha256,
      patch_bytes: manifest.patch_bytes,
      result_tree: manifest.result_tree,
    },
    options.githubOutputPath
  );
  console.log(
    JSON.stringify({
      mode: "agentic_fix_exact_head",
      base_sha: manifest.base_sha,
      head_sha: expectedHeadSha,
      changed_files: manifest.changed_files,
      patch_sha256: manifest.patch_sha256,
      result_tree: manifest.result_tree,
    })
  );
  return manifest;
}

async function finalizeAgenticFix(options = {}) {
  const cwd = path.resolve(
    options.cwd ??
      process.env.GITHUB_WORKSPACE?.trim() ??
      process.cwd()
  );
  const inputPath =
    options.inputPath ??
    process.env.UPSTREAM_REVIEW_FIX_INPUT_PATH?.trim();
  const agentOutputPath =
    options.agentOutputPath ??
    process.env.UPSTREAM_REVIEW_FIX_AGENT_OUTPUT_PATH?.trim();
  const metadataPath =
    options.metadataPath ??
    process.env.UPSTREAM_REVIEW_FIX_METADATA_PATH?.trim();
  const manifestPath =
    options.manifestPath ??
    process.env.UPSTREAM_REVIEW_FIX_MANIFEST_PATH?.trim();
  const patchPath =
    options.patchPath ??
    process.env.UPSTREAM_REVIEW_FIX_PATCH_PATH?.trim();
  const expectedManifestPath =
    options.expectedManifestPath ??
    process.env.UPSTREAM_REVIEW_EXPECTED_FIX_MANIFEST_PATH?.trim();
  const baseSha =
    options.baseSha ??
    process.env.UPSTREAM_REVIEW_BASE_SHA?.trim() ??
    "";

  if (!/^[a-f0-9]{40}$/.test(baseSha)) {
    throw new Error(`Invalid base SHA: ${baseSha || "(empty)"}`);
  }
  const [inputText, agentOutputText, headResult] = await Promise.all([
    readTextFile(inputPath, "agentic fix input"),
    readTextFile(agentOutputPath, "Codex fix output"),
    runGit(["rev-parse", "HEAD"], { cwd }),
  ]);
  const headSha = String(headResult.stdout).trim();
  if (headSha !== baseSha) {
    throw new Error(`Worktree HEAD mismatch: expected ${baseSha}, got ${headSha}`);
  }

  const [statusResult, summaryResult, untrackedResult] = await Promise.all([
    runGit(["diff", "--name-status", "--no-renames", "HEAD", "--"], { cwd }),
    runGit(["diff", "--summary", "--no-renames", "HEAD", "--"], { cwd }),
    runGit(["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd,
      encoding: null,
    }),
  ]);
  if (String(summaryResult.stdout).trim()) {
    throw new Error(
      `Codex changed a file mode or type: ${String(summaryResult.stdout).trim()}`
    );
  }

  const untrackedFiles = Buffer.from(untrackedResult.stdout)
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const unexpectedUntrackedFile = untrackedFiles.find(
    (file) => !FIX_WORKSPACE_ARTIFACTS.has(file)
  );
  if (unexpectedUntrackedFile) {
    throw new Error(
      `Codex created an unexpected untracked file: ${unexpectedUntrackedFile}`
    );
  }

  const changedFiles = parseModifiedFileStatus(statusResult.stdout);
  const fixInput = validateAgenticFixInput(
    parseJsonDocument(inputText, "agentic fix input")
  );
  const metadata = parseAgentFixOutput(
    agentOutputText,
    fixInput,
    changedFiles
  );
  await writeReport(metadata, metadataPath);

  if (!metadata.has_patch) {
    await writeTextFile(patchPath, "");
    await appendGitHubOutputs(
      {
        has_patch: false,
        changed_file_count: 0,
      },
      options.githubOutputPath
    );
    return { metadata, manifest: null };
  }

  const [numstatResult] = await Promise.all([
    runGit(["diff", "--numstat", "HEAD", "--"], { cwd }),
    runGit(["diff", "--check", "HEAD", "--"], { cwd }),
    assertSemanticDiff(cwd),
  ]);
  if (
    String(numstatResult.stdout)
      .split(/\r?\n/)
      .filter(Boolean)
      .some((line) => line.startsWith("-\t-\t"))
  ) {
    throw new Error("Codex produced a binary patch");
  }

  const patchResult = await runGit(
    [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      "HEAD",
      "--",
    ],
    { cwd, encoding: null }
  );
  const patch = Buffer.from(patchResult.stdout);
  if (patch.length === 0 || patch.length > MAX_FIX_PATCH_BYTES) {
    throw new Error(
      `Agentic fix patch is ${patch.length} bytes; expected 1-${MAX_FIX_PATCH_BYTES}`
    );
  }
  const resultTree = await computePatchedTree(
    baseSha,
    patch,
    cwd,
    "Agentic fix patch"
  );

  const manifest = {
    schema_version: 2,
    mode: "agentic_fix_manifest",
    base_sha: baseSha,
    finding_fingerprint: fixInput.finding_fingerprint,
    issue_number: fixInput.source_report.issue_number,
    remediation_cycle: fixInput.source_report.remediation_cycle,
    fix_branch: fixInput.fix_branch,
    finding_ids: fixInput.findings.map((finding) => finding.finding_id),
    target_games: fixInput.target_games,
    changed_files: metadata.changed_files,
    patch_sha256: sha256(patch),
    patch_bytes: patch.length,
    result_tree: resultTree,
  };
  validateFixManifest(manifest, fixInput, patch, baseSha);

  if (expectedManifestPath) {
    const expectedManifestText = await readTextFile(
      expectedManifestPath,
      "expected agentic fix manifest"
    );
    const expectedManifest = validateFixManifest(
      parseJsonDocument(expectedManifestText, "expected agentic fix manifest"),
      fixInput,
      patch,
      baseSha
    );
    for (const field of [
      "finding_fingerprint",
      "issue_number",
      "remediation_cycle",
      "fix_branch",
      "patch_sha256",
      "patch_bytes",
      "result_tree",
    ]) {
      if (manifest[field] !== expectedManifest[field]) {
        throw new Error(`Verified agentic fix ${field} mismatch`);
      }
    }
    assertExactStringSet(
      [...manifest.changed_files].sort(),
      [...expectedManifest.changed_files].sort(),
      "Verified agentic fix changed_files"
    );
  }

  await fs.mkdir(path.dirname(path.resolve(patchPath)), { recursive: true });
  await fs.writeFile(path.resolve(patchPath), patch);
  await writeReport(manifest, manifestPath);
  await appendGitHubOutputs(
    {
      has_patch: true,
      changed_file_count: metadata.changed_files.length,
      patch_sha256: manifest.patch_sha256,
      result_tree: manifest.result_tree,
    },
    options.githubOutputPath
  );
  console.log(
    JSON.stringify({
      mode: metadata.mode,
      changed_files: metadata.changed_files,
      patch_sha256: manifest.patch_sha256,
      patch_bytes: manifest.patch_bytes,
      result_tree: manifest.result_tree,
    })
  );
  return { metadata, manifest };
}

function renderFixPrBody(metadata, manifest, options = {}) {
  if (
    !isRecord(metadata) ||
    metadata.mode !== "agentic_fix_result" ||
    !Array.isArray(metadata.findings) ||
    !Array.isArray(metadata.outcomes)
  ) {
    throw new Error("Invalid agentic fix metadata for PR rendering");
  }
  const repository = String(options.repository ?? "").trim();
  const runId = String(options.runId ?? "").trim();
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !/^\d+$/.test(runId)
  ) {
    throw new Error("Invalid trusted GitHub context for PR rendering");
  }
  if (
    manifest.patch_sha256 !== options.patchSha256 ||
    manifest.changed_files.length === 0 ||
    manifest.schema_version !== 2 ||
    manifest.mode !== "agentic_fix_manifest"
  ) {
    throw new Error("Invalid verified patch context for PR rendering");
  }
  const issueNumber = validateIssueNumber(
    manifest.issue_number,
    "automatic fix Issue number"
  );
  const issueUrl = validateIssueUrl(
    options.issueUrl,
    repository,
    issueNumber
  );
  if (
    typeof manifest.finding_fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.finding_fingerprint) ||
    typeof manifest.remediation_cycle !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.remediation_cycle) ||
    manifest.fix_branch !==
      getFixBranch(
        manifest.finding_fingerprint,
        issueNumber,
        manifest.base_sha
      )
  ) {
    throw new Error("Invalid remediation cycle context for PR rendering");
  }

  const findingsById = new Map(
    metadata.findings.map((finding) => [finding.finding_id, finding])
  );
  if (
    metadata.outcomes.length !== findingsById.size ||
    metadata.outcomes.length === 0
  ) {
    throw new Error("Invalid finding outcomes for PR rendering");
  }
  const allFindingsAddressed = metadata.outcomes.every(
    (outcome) => outcome.status === "fixed"
  );
  const issueReference = allFindingsAddressed ? "Closes" : "Refs";
  const lines = [
    `<!-- upstream-review-pr:v1 issue=${issueNumber} fingerprint=${manifest.finding_fingerprint} cycle=${manifest.remediation_cycle} -->`,
    "",
    "## Summary",
    "",
    "Codex generated a candidate fix for the latest upstream-review findings. This PR remains draft while independent review and any bounded rework run.",
    "",
    "## Findings",
    "",
  ];
  for (const outcome of metadata.outcomes) {
    const finding = findingsById.get(outcome.finding_id);
    if (!finding) {
      throw new Error(`Missing PR finding metadata for ${outcome.finding_id}`);
    }
    const title =
      finding.api_title || finding.raw_title || finding.title || "(untitled)";
    lines.push(
      `- ${outcome.status === "fixed" ? "Addressed" : "Not addressed"} · \`${escapeIssueCode(outcome.finding_id)}\` · ${escapeIssueText(finding.game)} / ${escapeIssueText(finding.kind)} · \`${escapeIssueCode(title)}\``
    );
  }

  lines.push("", "## Changed files", "");
  for (const file of manifest.changed_files) {
    lines.push(`- \`${escapeIssueCode(file)}\``);
  }
  lines.push(
    "",
    "## Validation",
    "",
    "- `pnpm test:upstream-review`",
    "- `pnpm test:game-parsers`",
    "- `pnpm typecheck`",
    "- `pnpm build`",
    "",
    `Source: [workflow run](https://github.com/${repository}/actions/runs/${runId}) · [remediation Issue #${issueNumber}](${issueUrl})`,
    "",
    `${issueReference} #${issueNumber}`,
    "",
    `Verified patch SHA-256: \`${manifest.patch_sha256}\``,
    "",
    "_This PR is generated as a draft, then marked ready and squash-merged automatically only after an exact-head independent approval._",
    ""
  );
  const body = lines.join("\n").trimEnd();
  if (Buffer.byteLength(body, "utf8") > MAX_ISSUE_BODY_BYTES) {
    throw new Error("Rendered automatic fix PR body exceeds the safety limit");
  }
  return body;
}

async function renderAgenticFixPr(options = {}) {
  const metadataPath =
    options.metadataPath ??
    process.env.UPSTREAM_REVIEW_FIX_METADATA_PATH?.trim();
  const repository =
    options.repository ??
    process.env.GITHUB_REPOSITORY?.trim();
  const runId =
    options.runId ??
    process.env.GITHUB_RUN_ID?.trim();
  const outputPath =
    options.outputPath ??
    process.env.UPSTREAM_REVIEW_PR_BODY_PATH?.trim();
  const { fixInput, manifest } = await readAndValidateFixArtifact(options);
  const metadataText = await readTextFile(
    metadataPath,
    "agentic fix metadata"
  );
  const metadata = parseAgentFixOutput(
    metadataText,
    fixInput,
    manifest.changed_files
  );
  const body = renderFixPrBody(metadata, manifest, {
    repository,
    runId,
    patchSha256: manifest.patch_sha256,
    issueUrl: fixInput.source_report.issue_url,
  });
  await writeTextFile(outputPath, body);
  const allFindingsAddressed = metadata.outcomes.every(
    (outcome) => outcome.status === "fixed"
  );
  await appendGitHubOutputs(
    {
      all_findings_addressed: allFindingsAddressed,
      issue_reference: allFindingsAddressed ? "closes" : "refs",
      pr_body_sha256: sha256(Buffer.from(body, "utf8")),
    },
    options.githubOutputPath
  );
  console.log(
    JSON.stringify({
      output_path: path.resolve(outputPath),
      body_bytes: Buffer.byteLength(body, "utf8"),
    })
  );
  return body;
}

function assertExactObjectFields(value, expectedFields, label) {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actualFields = Object.keys(value).sort();
  const sortedExpectedFields = [...expectedFields].sort();
  if (
    actualFields.length !== sortedExpectedFields.length ||
    actualFields.some(
      (field, index) => field !== sortedExpectedFields[index]
    )
  ) {
    throw new Error(`${label} contains unexpected or missing fields`);
  }
}

function validatePrReviewUrl(value, pullRequestNumber) {
  if (
    typeof value !== "string" ||
    Array.from(value).length === 0 ||
    Array.from(value).length > MAX_PR_REVIEW_URL_LENGTH
  ) {
    throw new Error("Invalid agentic PR review pull request URL");
  }
  const match =
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/([1-9]\d*)$/.exec(
      value
    );
  if (!match || Number(match[1]) !== pullRequestNumber) {
    throw new Error("Agentic PR review URL does not match the pull request number");
  }
  return value;
}

function normalizePrReviewContext(rawContext) {
  if (!isRecord(rawContext)) {
    throw new Error("Invalid agentic PR review context");
  }
  const baseSha = rawContext.base_sha;
  const headSha = rawContext.head_sha;
  const patchSha256 = rawContext.patch_sha256;
  const findingFingerprint = rawContext.finding_fingerprint;
  const issueNumber = validateIssueNumber(
    rawContext.issue_number,
    "agentic PR review Issue number"
  );
  const remediationCycle = rawContext.remediation_cycle;
  const fixBranch = rawContext.fix_branch;
  if (
    typeof baseSha !== "string" ||
    typeof headSha !== "string" ||
    !/^[a-f0-9]{40}$/.test(baseSha) ||
    !/^[a-f0-9]{40}$/.test(headSha) ||
    baseSha === headSha
  ) {
    throw new Error("Invalid agentic PR review base or head SHA");
  }
  if (
    typeof patchSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(patchSha256) ||
    typeof findingFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(findingFingerprint) ||
    typeof remediationCycle !== "string" ||
    !/^[a-f0-9]{64}$/.test(remediationCycle) ||
    fixBranch !== getFixBranch(findingFingerprint, issueNumber, baseSha)
  ) {
    throw new Error(
      "Invalid agentic PR review patch, finding, or remediation cycle context"
    );
  }

  const pullRequest = rawContext.pull_request;
  assertExactObjectFields(
    pullRequest,
    ["number", "url"],
    "Agentic PR review pull_request"
  );
  if (
    !Number.isSafeInteger(pullRequest.number) ||
    pullRequest.number <= 0 ||
    pullRequest.number > 2_147_483_647
  ) {
    throw new Error("Invalid agentic PR review pull request number");
  }
  const pullRequestUrl = validatePrReviewUrl(
    pullRequest.url,
    pullRequest.number
  );

  const changedFiles = normalizeChangedFiles(rawContext.changed_files);
  if (
    changedFiles.length === 0 ||
    changedFiles.length > MAX_PR_REVIEW_CHANGED_FILES ||
    changedFiles.some(
      (file) => Array.from(file).length > MAX_PR_REVIEW_PATH_LENGTH
    )
  ) {
    throw new Error("Invalid agentic PR review changed_files");
  }
  if (
    rawContext.changed_files.length !== changedFiles.length ||
    rawContext.changed_files.some(
      (file, index) => file !== changedFiles[index]
    )
  ) {
    throw new Error(
      "Agentic PR review changed_files must use canonical order"
    );
  }

  return {
    base_sha: baseSha,
    head_sha: headSha,
    patch_sha256: patchSha256,
    finding_fingerprint: findingFingerprint,
    issue_number: issueNumber,
    remediation_cycle: remediationCycle,
    fix_branch: fixBranch,
    pull_request: {
      number: pullRequest.number,
      url: pullRequestUrl,
    },
    changed_files: changedFiles,
  };
}

function buildAgenticPrReviewInput(rawContext) {
  const context = normalizePrReviewContext(rawContext);
  return {
    schema_version: 2,
    mode: "agentic_pr_review",
    ...context,
    context_sha256: sha256(JSON.stringify(context)),
  };
}

function validateAgenticPrReviewInput(input, expectedContext = null) {
  assertExactObjectFields(
    input,
    [
      "schema_version",
      "mode",
      "base_sha",
      "head_sha",
      "patch_sha256",
      "finding_fingerprint",
      "issue_number",
      "remediation_cycle",
      "fix_branch",
      "pull_request",
      "changed_files",
      "context_sha256",
    ],
    "Agentic PR review input"
  );
  if (
    input.schema_version !== 2 ||
    input.mode !== "agentic_pr_review"
  ) {
    throw new Error("Invalid agentic PR review input");
  }
  const context = normalizePrReviewContext(input);
  const contextSha256 = sha256(JSON.stringify(context));
  if (
    typeof input.context_sha256 !== "string" ||
    input.context_sha256 !== contextSha256
  ) {
    throw new Error("Agentic PR review context SHA-256 mismatch");
  }

  if (expectedContext != null) {
    const expected = normalizePrReviewContext(expectedContext);
    if (JSON.stringify(context) !== JSON.stringify(expected)) {
      throw new Error(
        "Agentic PR review input does not match the trusted PR context"
      );
    }
  }

  return {
    ...input,
    ...context,
    context_sha256: contextSha256,
  };
}

function validateBoundedPrReviewString(
  value,
  label,
  maxLength,
  options = {}
) {
  if (
    typeof value !== "string" ||
    Array.from(value).length > maxLength
  ) {
    throw new Error(
      `Invalid Codex PR review ${label}: expected a string up to ${maxLength} characters`
    );
  }
  const normalized = normalizeWhitespace(value);
  if (options.required !== false && !normalized) {
    throw new Error(`Invalid Codex PR review ${label}: value is required`);
  }
  return normalized;
}

function comparePrReviewFindings(a, b) {
  const severityOrder = { P1: 1, P2: 2, P3: 3 };
  return (
    severityOrder[a.severity] - severityOrder[b.severity] ||
    compareCodePoints(a.path, b.path) ||
    a.line - b.line ||
    compareCodePoints(a.title, b.title) ||
    compareCodePoints(a.body, b.body)
  );
}

function parseAgentPrReviewOutput(text, rawInput) {
  const input = validateAgenticPrReviewInput(rawInput);
  const parsed = parseJsonDocument(text, "Codex PR review output");
  assertExactObjectFields(
    parsed,
    [
      "complete",
      "errors",
      "context_sha256",
      "verdict",
      "summary",
      "findings",
    ],
    "Codex PR review output"
  );
  if (
    !Array.isArray(parsed.errors) ||
    parsed.errors.length > 20 ||
    parsed.errors.some(
      (error) =>
        typeof error !== "string" ||
        Array.from(error).length > MAX_AGENT_ERROR_LENGTH
    )
  ) {
    throw new Error(
      "Invalid Codex PR review errors: expected at most 20 bounded strings"
    );
  }
  const errors = parsed.errors
    .map((error) => normalizeWhitespace(error))
    .filter(Boolean);
  if (
    parsed.complete !== true ||
    parsed.errors.length > 0
  ) {
    const detail = errors.length > 0 ? `: ${errors.join("; ")}` : "";
    throw new Error(`Codex reported an incomplete PR review${detail}`);
  }
  if (parsed.context_sha256 !== input.context_sha256) {
    throw new Error("Codex PR review output context does not match the PR");
  }
  if (!["approve", "request_changes"].includes(parsed.verdict)) {
    throw new Error("Invalid Codex PR review verdict");
  }
  const summary = validateBoundedPrReviewString(
    parsed.summary,
    "summary",
    MAX_PR_REVIEW_SUMMARY_LENGTH
  );
  if (
    !Array.isArray(parsed.findings) ||
    parsed.findings.length > MAX_PR_REVIEW_FINDINGS
  ) {
    throw new Error(
      `Invalid Codex PR review findings: expected at most ${MAX_PR_REVIEW_FINDINGS}`
    );
  }

  const changedFileSet = new Set(input.changed_files);
  const seenFindings = new Set();
  const findings = parsed.findings.map((finding, index) => {
    assertExactObjectFields(
      finding,
      ["severity", "path", "line", "title", "body"],
      `Codex PR review finding at index ${index}`
    );
    if (!["P1", "P2", "P3"].includes(finding.severity)) {
      throw new Error(
        `Invalid Codex PR review finding severity at index ${index}`
      );
    }
    if (
      typeof finding.path !== "string" ||
      Array.from(finding.path).length === 0 ||
      Array.from(finding.path).length > MAX_PR_REVIEW_PATH_LENGTH
    ) {
      throw new Error(
        `Invalid Codex PR review finding path at index ${index}`
      );
    }
    const normalizedPath = normalizeChangedFiles([finding.path])[0];
    if (
      normalizedPath !== finding.path ||
      !changedFileSet.has(normalizedPath)
    ) {
      throw new Error(
        `Codex PR review finding path is outside changed_files at index ${index}`
      );
    }
    if (
      !Number.isSafeInteger(finding.line) ||
      finding.line <= 0 ||
      finding.line > MAX_PR_REVIEW_LINE
    ) {
      throw new Error(
        `Invalid Codex PR review finding line at index ${index}`
      );
    }
    const normalizedFinding = {
      severity: finding.severity,
      path: normalizedPath,
      line: finding.line,
      title: validateBoundedPrReviewString(
        finding.title,
        `finding title at index ${index}`,
        MAX_PR_REVIEW_TITLE_LENGTH
      ),
      body: validateBoundedPrReviewString(
        finding.body,
        `finding body at index ${index}`,
        MAX_PR_REVIEW_BODY_LENGTH
      ),
    };
    const findingKey = JSON.stringify(normalizedFinding);
    if (seenFindings.has(findingKey)) {
      throw new Error(`Duplicate Codex PR review finding at index ${index}`);
    }
    seenFindings.add(findingKey);
    return normalizedFinding;
  });
  findings.sort(comparePrReviewFindings);

  const hasBlockingFinding = findings.some(
    (finding) => finding.severity === "P1" || finding.severity === "P2"
  );
  if (parsed.verdict === "approve" && hasBlockingFinding) {
    throw new Error(
      "Codex PR review cannot approve with P1 or P2 findings"
    );
  }
  if (parsed.verdict === "request_changes" && !hasBlockingFinding) {
    throw new Error(
      "Codex PR review must include a P1 or P2 finding when requesting changes"
    );
  }

  return {
    schema_version: 1,
    mode: "agentic_pr_review_result",
    context_sha256: input.context_sha256,
    verdict: parsed.verdict,
    summary,
    findings,
  };
}

function validateAgenticPrReviewResult(result, rawInput) {
  assertExactObjectFields(
    result,
    [
      "schema_version",
      "mode",
      "context_sha256",
      "verdict",
      "summary",
      "findings",
    ],
    "Agentic PR review result"
  );
  if (
    result.schema_version !== 1 ||
    result.mode !== "agentic_pr_review_result"
  ) {
    throw new Error("Invalid agentic PR review result");
  }
  const normalized = parseAgentPrReviewOutput(
    JSON.stringify({
      complete: true,
      errors: [],
      context_sha256: result.context_sha256,
      verdict: result.verdict,
      summary: result.summary,
      findings: result.findings,
    }),
    rawInput
  );
  if (JSON.stringify(normalized) !== JSON.stringify(result)) {
    throw new Error("Agentic PR review result is not canonical");
  }
  return normalized;
}

function escapePrReviewText(value) {
  return normalizeWhitespace(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]#|])/g, "\\$1")
    .replace(/@/g, "@\u200b");
}

function renderPrReviewBody(review, rawInput) {
  const input = validateAgenticPrReviewInput(rawInput);
  if (
    !isRecord(review) ||
    review.mode !== "agentic_pr_review_result" ||
    review.schema_version !== 1 ||
    review.context_sha256 !== input.context_sha256 ||
    !["approve", "request_changes"].includes(review.verdict) ||
    typeof review.summary !== "string" ||
    !Array.isArray(review.findings)
  ) {
    throw new Error("Invalid trusted Codex PR review result");
  }

  const lines = [
    "## Automated Codex review",
    "",
    `**Verdict:** ${
      review.verdict === "approve" ? "Approve" : "Request changes"
    }`,
    "",
    escapePrReviewText(review.summary),
    "",
    "## Findings",
    "",
  ];
  if (review.findings.length === 0) {
    lines.push("No findings.");
  } else {
    for (const [index, finding] of review.findings.entries()) {
      lines.push(
        `${index + 1}. **${finding.severity}** · \`${escapeIssueCode(
          `${finding.path}:${finding.line}`
        )}\` · ${escapePrReviewText(finding.title)}`,
        `   ${escapePrReviewText(finding.body)}`
      );
    }
  }
  lines.push(
    "",
    "## Verified context",
    "",
    `- Commit: \`${input.head_sha}\``,
    `- Patch SHA-256: \`${input.patch_sha256}\``,
    `- Finding fingerprint: \`${input.finding_fingerprint}\``,
    `- Remediation Issue: \`#${input.issue_number}\``,
    `- Remediation cycle: \`${input.remediation_cycle}\``,
    `- Fix branch: \`${input.fix_branch}\``,
    `- Context SHA-256: \`${input.context_sha256}\``,
    "",
    "_This review was generated automatically from the exact commit and patch context above._",
    ""
  );
  const body = lines.join("\n");
  if (Buffer.byteLength(body, "utf8") > MAX_PR_REVIEW_BODY_BYTES) {
    throw new Error("Rendered automatic PR review body exceeds the safety limit");
  }
  return body;
}

function renderPrReviewRequest(review, rawInput) {
  const input = validateAgenticPrReviewInput(rawInput);
  const body = renderPrReviewBody(review, input);
  return {
    body,
    event:
      review.verdict === "approve" ? "APPROVE" : "REQUEST_CHANGES",
    commit_id: input.head_sha,
  };
}

function getPrReviewContextFromManifest(manifest, options = {}) {
  return {
    base_sha: manifest.base_sha,
    head_sha:
      options.headSha ??
      process.env.UPSTREAM_REVIEW_HEAD_SHA?.trim() ??
      "",
    patch_sha256: manifest.patch_sha256,
    finding_fingerprint: manifest.finding_fingerprint,
    issue_number: manifest.issue_number,
    remediation_cycle: manifest.remediation_cycle,
    fix_branch: manifest.fix_branch,
    pull_request: {
      number: Number(
        options.pullRequestNumber ??
          process.env.UPSTREAM_REVIEW_PR_NUMBER?.trim() ??
          ""
      ),
      url:
        options.pullRequestUrl ??
        process.env.UPSTREAM_REVIEW_PR_URL?.trim() ??
        "",
    },
    changed_files: manifest.changed_files,
  };
}

async function prepareAgenticPrReview(options = {}) {
  const cwd = path.resolve(
    options.cwd ??
      process.env.GITHUB_WORKSPACE?.trim() ??
      process.cwd()
  );
  const outputPath =
    options.outputPath ??
    process.env.UPSTREAM_REVIEW_PR_REVIEW_INPUT_PATH?.trim();
  const { manifest } = await readAndValidateFixArtifact(options);
  const input = buildAgenticPrReviewInput(
    getPrReviewContextFromManifest(manifest, options)
  );
  const headResult = await runGit(["rev-parse", "HEAD"], { cwd });
  const checkoutHead = String(headResult.stdout).trim();
  if (checkoutHead !== input.head_sha) {
    throw new Error(
      `PR review checkout mismatch: expected ${input.head_sha}, got ${checkoutHead}`
    );
  }
  await writeReport(input, outputPath, false);
  await appendGitHubOutputs(
    {
      review_context_sha256: input.context_sha256,
    },
    options.githubOutputPath
  );
  console.log(
    JSON.stringify({
      mode: input.mode,
      pull_request_number: input.pull_request.number,
      head_sha: input.head_sha,
      context_sha256: input.context_sha256,
    })
  );
  return input;
}

async function finalizeAgenticPrReview(options = {}) {
  const cwd = path.resolve(
    options.cwd ??
      process.env.GITHUB_WORKSPACE?.trim() ??
      process.cwd()
  );
  const prReviewInputPath =
    options.prReviewInputPath ??
    process.env.UPSTREAM_REVIEW_PR_REVIEW_INPUT_PATH?.trim();
  const agentOutputJson =
    options.agentOutputJson ??
    process.env.UPSTREAM_REVIEW_PR_REVIEW_AGENT_OUTPUT_JSON;
  const agentOutputPath =
    options.agentOutputPath ??
    process.env.UPSTREAM_REVIEW_PR_REVIEW_AGENT_OUTPUT_PATH?.trim();
  const bodyPath =
    options.bodyPath ??
    process.env.UPSTREAM_REVIEW_PR_REVIEW_BODY_PATH?.trim();
  const requestPath =
    options.requestPath ??
    process.env.UPSTREAM_REVIEW_PR_REVIEW_REQUEST_PATH?.trim();
  const resultPath =
    options.resultPath ??
    process.env.UPSTREAM_REVIEW_PR_REVIEW_RESULT_PATH?.trim();
  const [inputText, artifact, headResult] = await Promise.all([
    readTextFile(prReviewInputPath, "agentic PR review input"),
    readAndValidateFixArtifact(options),
    runGit(["rev-parse", "HEAD"], { cwd }),
  ]);
  const expectedContext = getPrReviewContextFromManifest(
    artifact.manifest,
    options
  );
  const input = validateAgenticPrReviewInput(
    parseJsonDocument(inputText, "agentic PR review input"),
    expectedContext
  );
  const checkoutHead = String(headResult.stdout).trim();
  if (checkoutHead !== input.head_sha) {
    throw new Error(
      `PR review checkout mismatch: expected ${input.head_sha}, got ${checkoutHead}`
    );
  }

  let outputText;
  if (typeof agentOutputJson === "string" && agentOutputJson.trim()) {
    outputText = agentOutputJson;
  } else if (agentOutputPath) {
    outputText = await readTextFile(
      agentOutputPath,
      "Codex PR review output"
    );
  } else {
    throw new Error("Missing Codex PR review output");
  }
  const review = parseAgentPrReviewOutput(outputText, input);
  const request = renderPrReviewRequest(review, input);
  const requestText = `${JSON.stringify(request)}\n`;
  const requestSha256 = sha256(Buffer.from(requestText, "utf8"));
  const resultText = `${JSON.stringify(review)}\n`;
  const resultSha256 = sha256(Buffer.from(resultText, "utf8"));
  const blockingFindingCount = review.findings.filter(
    (finding) => finding.severity === "P1" || finding.severity === "P2"
  ).length;
  if (bodyPath) {
    await writeTextFile(bodyPath, request.body);
  }
  if (resultPath) {
    await writeTextFile(resultPath, resultText);
  }
  await writeTextFile(requestPath, requestText);
  await appendGitHubOutputs(
    {
      review_event: request.event,
      review_verdict: review.verdict,
      review_context_sha256: input.context_sha256,
      blocking_finding_count: blockingFindingCount,
      review_result_sha256: resultSha256,
      review_request_sha256: requestSha256,
    },
    options.githubOutputPath
  );
  console.log(
    JSON.stringify({
      mode: review.mode,
      verdict: review.verdict,
      finding_count: review.findings.length,
      blocking_finding_count: blockingFindingCount,
      review_event: request.event,
      review_result_sha256: resultSha256,
      review_request_sha256: requestSha256,
    })
  );
  return {
    input,
    review,
    request,
    result_sha256: resultSha256,
    request_sha256: requestSha256,
  };
}

function parsePrReworkRound(value, label = "PR rework round") {
  const number = Number(value);
  if (
    !Number.isSafeInteger(number) ||
    number < 1 ||
    number > MAX_PR_REWORK_ROUNDS
  ) {
    throw new Error(
      `Invalid ${label}: expected an integer from 1 to ${MAX_PR_REWORK_ROUNDS}`
    );
  }
  return number;
}

function getAgenticPrReworkContext(input) {
  return {
    round: input.round,
    max_rounds: input.max_rounds,
    base_sha: input.base_sha,
    reviewed_head_sha: input.reviewed_head_sha,
    finding_fingerprint: input.finding_fingerprint,
    issue_number: input.issue_number,
    remediation_cycle: input.remediation_cycle,
    fix_branch: input.fix_branch,
    pull_request: input.pull_request,
    fix_input_sha256: input.fix_input_sha256,
    previous_manifest_sha256: input.previous_manifest_sha256,
    previous_patch_sha256: input.previous_patch_sha256,
    review_context_sha256: input.review_context_sha256,
    review_result_sha256: input.review_result_sha256,
    allowed_files: input.allowed_files,
    changed_files: input.changed_files,
    blocking_findings: input.blocking_findings,
  };
}

function normalizeAgenticPrReworkContext(rawContext) {
  if (!isRecord(rawContext)) {
    throw new Error("Invalid agentic PR rework context");
  }
  const round = parsePrReworkRound(rawContext.round);
  if (rawContext.max_rounds !== MAX_PR_REWORK_ROUNDS) {
    throw new Error(
      `Invalid PR rework max_rounds: expected ${MAX_PR_REWORK_ROUNDS}`
    );
  }
  for (const [field, value, pattern] of [
    ["base_sha", rawContext.base_sha, /^[a-f0-9]{40}$/],
    ["reviewed_head_sha", rawContext.reviewed_head_sha, /^[a-f0-9]{40}$/],
    [
      "finding_fingerprint",
      rawContext.finding_fingerprint,
      /^[a-f0-9]{64}$/,
    ],
    [
      "remediation_cycle",
      rawContext.remediation_cycle,
      /^[a-f0-9]{64}$/,
    ],
    ["fix_input_sha256", rawContext.fix_input_sha256, /^[a-f0-9]{64}$/],
    [
      "previous_manifest_sha256",
      rawContext.previous_manifest_sha256,
      /^[a-f0-9]{64}$/,
    ],
    [
      "previous_patch_sha256",
      rawContext.previous_patch_sha256,
      /^[a-f0-9]{64}$/,
    ],
    [
      "review_context_sha256",
      rawContext.review_context_sha256,
      /^[a-f0-9]{64}$/,
    ],
    [
      "review_result_sha256",
      rawContext.review_result_sha256,
      /^[a-f0-9]{64}$/,
    ],
  ]) {
    if (typeof value !== "string" || !pattern.test(value)) {
      throw new Error(`Invalid agentic PR rework ${field}`);
    }
  }
  if (rawContext.base_sha === rawContext.reviewed_head_sha) {
    throw new Error("Agentic PR rework base and reviewed head must differ");
  }

  const issueNumber = validateIssueNumber(
    rawContext.issue_number,
    "agentic PR rework Issue number"
  );
  const expectedFixBranch = getFixBranch(
    rawContext.finding_fingerprint,
    issueNumber,
    rawContext.base_sha
  );
  if (rawContext.fix_branch !== expectedFixBranch) {
    throw new Error("Agentic PR rework branch does not match the fingerprint");
  }

  assertExactObjectFields(
    rawContext.pull_request,
    ["number", "url"],
    "Agentic PR rework pull_request"
  );
  if (
    !Number.isSafeInteger(rawContext.pull_request.number) ||
    rawContext.pull_request.number <= 0 ||
    rawContext.pull_request.number > 2_147_483_647
  ) {
    throw new Error("Invalid agentic PR rework pull request number");
  }
  const pullRequestUrl = validatePrReviewUrl(
    rawContext.pull_request.url,
    rawContext.pull_request.number
  );

  if (
    !Array.isArray(rawContext.allowed_files) ||
    rawContext.allowed_files.length === 0 ||
    rawContext.allowed_files.length > DEFAULT_GAMES.length + 1 ||
    new Set(rawContext.allowed_files).size !== rawContext.allowed_files.length ||
    rawContext.allowed_files.includes(TRUSTED_PARSER_REGRESSION_TEST_FILE)
  ) {
    throw new Error("Invalid agentic PR rework allowed_files");
  }
  const allowedGames = DEFAULT_GAMES.filter((game) =>
    rawContext.allowed_files.includes(GAME_SOURCE_FILES[game])
  );
  const expectedAllowedFiles = rawContext.allowed_files.includes(
    AGENT_PARSER_REGRESSION_TEST_FILE
  )
    ? getAllowedFixFiles(allowedGames)
    : allowedGames.map((game) => GAME_SOURCE_FILES[game]);
  if (
    expectedAllowedFiles.length !== rawContext.allowed_files.length ||
    rawContext.allowed_files.some(
      (file, index) => file !== expectedAllowedFiles[index]
    )
  ) {
    throw new Error(
      "Agentic PR rework allowed_files must use the static canonical order"
    );
  }

  const changedFiles = normalizeChangedFiles(rawContext.changed_files);
  if (
    changedFiles.length === 0 ||
    changedFiles.length > MAX_PR_REVIEW_CHANGED_FILES ||
    rawContext.changed_files.some(
      (file, index) => file !== changedFiles[index]
    ) ||
    changedFiles.some((file) => !rawContext.allowed_files.includes(file))
  ) {
    throw new Error("Invalid agentic PR rework changed_files");
  }

  if (
    !Array.isArray(rawContext.blocking_findings) ||
    rawContext.blocking_findings.length === 0 ||
    rawContext.blocking_findings.length > MAX_PR_REVIEW_FINDINGS
  ) {
    throw new Error("Invalid agentic PR rework blocking_findings");
  }
  const blockingFindings = rawContext.blocking_findings.map(
    (finding, index) => {
      assertExactObjectFields(
        finding,
        ["finding_id", "severity", "path", "line", "title", "body"],
        `Agentic PR rework blocking finding at index ${index}`
      );
      if (
        finding.finding_id !==
        `review-finding-${String(index + 1).padStart(3, "0")}`
      ) {
        throw new Error(
          `Invalid agentic PR rework finding_id at index ${index}`
        );
      }
      if (!["P1", "P2"].includes(finding.severity)) {
        throw new Error(
          `Agentic PR rework finding at index ${index} is not blocking`
        );
      }
      if (
        typeof finding.path !== "string" ||
        !changedFiles.includes(finding.path)
      ) {
        throw new Error(
          `Agentic PR rework finding path is outside changed_files at index ${index}`
        );
      }
      if (
        !Number.isSafeInteger(finding.line) ||
        finding.line <= 0 ||
        finding.line > MAX_PR_REVIEW_LINE
      ) {
        throw new Error(
          `Invalid agentic PR rework finding line at index ${index}`
        );
      }
      return {
        finding_id: finding.finding_id,
        severity: finding.severity,
        path: finding.path,
        line: finding.line,
        title: validateBoundedPrReviewString(
          finding.title,
          `rework finding title at index ${index}`,
          MAX_PR_REVIEW_TITLE_LENGTH
        ),
        body: validateBoundedPrReviewString(
          finding.body,
          `rework finding body at index ${index}`,
          MAX_PR_REVIEW_BODY_LENGTH
        ),
      };
    }
  );
  for (let index = 1; index < blockingFindings.length; index += 1) {
    if (
      comparePrReviewFindings(
        blockingFindings[index - 1],
        blockingFindings[index]
      ) > 0
    ) {
      throw new Error(
        "Agentic PR rework blocking_findings must use canonical order"
      );
    }
  }

  return {
    round,
    max_rounds: MAX_PR_REWORK_ROUNDS,
    base_sha: rawContext.base_sha,
    reviewed_head_sha: rawContext.reviewed_head_sha,
    finding_fingerprint: rawContext.finding_fingerprint,
    issue_number: issueNumber,
    remediation_cycle: rawContext.remediation_cycle,
    fix_branch: expectedFixBranch,
    pull_request: {
      number: rawContext.pull_request.number,
      url: pullRequestUrl,
    },
    fix_input_sha256: rawContext.fix_input_sha256,
    previous_manifest_sha256: rawContext.previous_manifest_sha256,
    previous_patch_sha256: rawContext.previous_patch_sha256,
    review_context_sha256: rawContext.review_context_sha256,
    review_result_sha256: rawContext.review_result_sha256,
    allowed_files: [...rawContext.allowed_files],
    changed_files: changedFiles,
    blocking_findings: blockingFindings,
  };
}

function buildAgenticPrReworkInput(rawContext) {
  const context = normalizeAgenticPrReworkContext(rawContext);
  return {
    schema_version: 2,
    mode: "agentic_pr_rework",
    ...context,
    context_sha256: sha256(JSON.stringify(context)),
  };
}

function validateAgenticPrReworkInput(input, expectedContext = null) {
  assertExactObjectFields(
    input,
    [
      "schema_version",
      "mode",
      "round",
      "max_rounds",
      "base_sha",
      "reviewed_head_sha",
      "finding_fingerprint",
      "issue_number",
      "remediation_cycle",
      "fix_branch",
      "pull_request",
      "fix_input_sha256",
      "previous_manifest_sha256",
      "previous_patch_sha256",
      "review_context_sha256",
      "review_result_sha256",
      "allowed_files",
      "changed_files",
      "blocking_findings",
      "context_sha256",
    ],
    "Agentic PR rework input"
  );
  if (
    input.schema_version !== 2 ||
    input.mode !== "agentic_pr_rework"
  ) {
    throw new Error("Invalid agentic PR rework input");
  }
  const context = normalizeAgenticPrReworkContext(input);
  const contextSha256 = sha256(JSON.stringify(context));
  if (input.context_sha256 !== contextSha256) {
    throw new Error("Agentic PR rework context SHA-256 mismatch");
  }
  if (expectedContext != null) {
    const expected = normalizeAgenticPrReworkContext(expectedContext);
    if (JSON.stringify(context) !== JSON.stringify(expected)) {
      throw new Error(
        "Agentic PR rework input does not match the trusted context"
      );
    }
  }
  return {
    ...input,
    ...context,
    context_sha256: contextSha256,
  };
}

async function prepareAgenticPrRework(options = {}) {
  const fixInputPath =
    options.inputPath ??
    process.env.UPSTREAM_REVIEW_FIX_INPUT_PATH?.trim();
  const fixManifestPath =
    options.manifestPath ??
    process.env.UPSTREAM_REVIEW_FIX_MANIFEST_PATH?.trim();
  const fixPatchPath =
    options.patchPath ??
    process.env.UPSTREAM_REVIEW_FIX_PATCH_PATH?.trim();
  const reviewInputPath =
    options.prReviewInputPath ??
    process.env.UPSTREAM_REVIEW_PR_REVIEW_INPUT_PATH?.trim();
  const reviewResultPath =
    options.prReviewResultPath ??
    process.env.UPSTREAM_REVIEW_PR_REVIEW_RESULT_PATH?.trim();
  const outputPath =
    options.outputPath ??
    process.env.UPSTREAM_REVIEW_PR_REWORK_INPUT_PATH?.trim();
  const baseSha =
    options.baseSha ??
    process.env.UPSTREAM_REVIEW_BASE_SHA?.trim() ??
    "";
  const reviewedHeadSha =
    options.headSha ??
    process.env.UPSTREAM_REVIEW_HEAD_SHA?.trim() ??
    "";
  const pullRequestNumber = Number(
    options.pullRequestNumber ??
      process.env.UPSTREAM_REVIEW_PR_NUMBER?.trim() ??
      ""
  );
  const pullRequestUrl =
    options.pullRequestUrl ??
    process.env.UPSTREAM_REVIEW_PR_URL?.trim() ??
    "";
  const round = parsePrReworkRound(
    options.round ??
      process.env.UPSTREAM_REVIEW_PR_REWORK_ROUND?.trim()
  );
  const configuredMaxRounds = Number(
    options.maxRounds ??
      process.env.UPSTREAM_REVIEW_PR_REWORK_MAX_ROUNDS?.trim() ??
      MAX_PR_REWORK_ROUNDS
  );
  if (configuredMaxRounds !== MAX_PR_REWORK_ROUNDS) {
    throw new Error(
      `Invalid PR rework max rounds: expected ${MAX_PR_REWORK_ROUNDS}`
    );
  }

  const [
    fixInputText,
    fixManifestText,
    fixPatch,
    reviewInputText,
    reviewResultText,
  ] = await Promise.all([
    readTextFile(fixInputPath, "agentic fix input"),
    readTextFile(fixManifestPath, "agentic fix manifest"),
    fs.readFile(path.resolve(fixPatchPath)),
    readTextFile(reviewInputPath, "agentic PR review input"),
    readTextFile(reviewResultPath, "agentic PR review result"),
  ]);
  const fixInput = validateAgenticFixInput(
    parseJsonDocument(fixInputText, "agentic fix input")
  );
  const fixManifest = validateFixManifest(
    parseJsonDocument(fixManifestText, "agentic fix manifest"),
    fixInput,
    fixPatch,
    baseSha
  );
  const reviewInput = validateAgenticPrReviewInput(
    parseJsonDocument(reviewInputText, "agentic PR review input"),
    getPrReviewContextFromManifest(fixManifest, {
      headSha: reviewedHeadSha,
      pullRequestNumber,
      pullRequestUrl,
    })
  );
  const reviewResult = validateAgenticPrReviewResult(
    parseJsonDocument(reviewResultText, "agentic PR review result"),
    reviewInput
  );
  const canonicalReviewResultText = `${JSON.stringify(reviewResult)}\n`;
  if (reviewResultText !== canonicalReviewResultText) {
    throw new Error("Agentic PR review result file is not canonical");
  }
  if (reviewResult.verdict !== "request_changes") {
    throw new Error("PR rework requires a request_changes review");
  }
  const blockingFindings = reviewResult.findings
    .filter(
      (finding) => finding.severity === "P1" || finding.severity === "P2"
    )
    .map((finding, index) => ({
      finding_id: `review-finding-${String(index + 1).padStart(3, "0")}`,
      ...finding,
    }));
  if (blockingFindings.length === 0) {
    throw new Error("PR rework requires at least one blocking finding");
  }

  const expectedFixBranch = getFixBranch(
    fixInput.finding_fingerprint,
    fixInput.source_report.issue_number,
    fixInput.source_report.base_sha
  );
  const configuredFixBranch =
    options.fixBranch ??
    process.env.UPSTREAM_REVIEW_FIX_BRANCH?.trim() ??
    expectedFixBranch;
  if (configuredFixBranch !== expectedFixBranch) {
    throw new Error("PR rework branch does not match the fix fingerprint");
  }
  const input = buildAgenticPrReworkInput({
    round,
    max_rounds: MAX_PR_REWORK_ROUNDS,
    base_sha: baseSha,
    reviewed_head_sha: reviewedHeadSha,
    finding_fingerprint: fixInput.finding_fingerprint,
    issue_number: fixInput.source_report.issue_number,
    remediation_cycle: fixInput.source_report.remediation_cycle,
    fix_branch: expectedFixBranch,
    pull_request: {
      number: pullRequestNumber,
      url: pullRequestUrl,
    },
    fix_input_sha256: sha256(Buffer.from(fixInputText, "utf8")),
    previous_manifest_sha256: sha256(
      Buffer.from(fixManifestText, "utf8")
    ),
    previous_patch_sha256: fixManifest.patch_sha256,
    review_context_sha256: reviewInput.context_sha256,
    review_result_sha256: sha256(
      Buffer.from(canonicalReviewResultText, "utf8")
    ),
    allowed_files: fixInput.allowed_files,
    changed_files: fixManifest.changed_files,
    blocking_findings: blockingFindings,
  });
  await writeReport(input, outputPath, false);
  await appendGitHubOutputs(
    {
      should_rework: true,
      round,
      max_rounds: MAX_PR_REWORK_ROUNDS,
      blocking_finding_count: blockingFindings.length,
      rework_context_sha256: input.context_sha256,
    },
    options.githubOutputPath
  );
  console.log(
    JSON.stringify({
      mode: input.mode,
      round,
      pull_request_number: pullRequestNumber,
      reviewed_head_sha: reviewedHeadSha,
      blocking_finding_count: blockingFindings.length,
      context_sha256: input.context_sha256,
    })
  );
  return input;
}

function parseAgentPrReworkOutput(text, rawInput, actualChangedFiles) {
  const input = validateAgenticPrReworkInput(rawInput);
  const parsed = parseJsonDocument(text, "Codex PR rework output");
  assertExactObjectFields(
    parsed,
    [
      "complete",
      "errors",
      "context_sha256",
      "summary",
      "changed_files",
      "outcomes",
    ],
    "Codex PR rework output"
  );
  if (
    !Array.isArray(parsed.errors) ||
    parsed.errors.length > 20 ||
    parsed.errors.some(
      (error) =>
        typeof error !== "string" ||
        Array.from(error).length > MAX_AGENT_ERROR_LENGTH
    )
  ) {
    throw new Error(
      "Invalid Codex PR rework errors: expected at most 20 bounded strings"
    );
  }
  const errors = parsed.errors
    .map((error) => normalizeWhitespace(error))
    .filter(Boolean);
  if (parsed.complete !== true || parsed.errors.length > 0) {
    const detail = errors.length > 0 ? `: ${errors.join("; ")}` : "";
    throw new Error(`Codex reported an incomplete PR rework${detail}`);
  }
  if (parsed.context_sha256 !== input.context_sha256) {
    throw new Error("Codex PR rework output context does not match the input");
  }
  const summary = validateBoundedPrReviewString(
    parsed.summary,
    "rework summary",
    MAX_AGENT_SUMMARY_LENGTH
  );

  const claimedChangedFiles = normalizeChangedFiles(parsed.changed_files);
  const changedFiles = normalizeChangedFiles(actualChangedFiles);
  assertExactStringSet(
    claimedChangedFiles,
    changedFiles,
    "Codex PR rework changed_files"
  );
  const disallowedFile = changedFiles.find(
    (file) => !input.allowed_files.includes(file)
  );
  if (disallowedFile) {
    throw new Error(
      `Codex PR rework changed a file outside the allowlist: ${disallowedFile}`
    );
  }
  const changedParserFile = changedFiles.some((file) =>
    Object.values(GAME_SOURCE_FILES).includes(file)
  );
  if (
    input.allowed_files.includes(AGENT_PARSER_REGRESSION_TEST_FILE) &&
    changedParserFile &&
    !changedFiles.includes(AGENT_PARSER_REGRESSION_TEST_FILE)
  ) {
    throw new Error(
      "Codex PR rework parser changes must update the regression test"
    );
  }

  if (!Array.isArray(parsed.outcomes)) {
    throw new Error("Invalid Codex PR rework outcomes");
  }
  const findingsById = new Map(
    input.blocking_findings.map((finding) => [
      finding.finding_id,
      finding,
    ])
  );
  const seenFindingIds = new Set();
  const outcomes = parsed.outcomes.map((outcome, index) => {
    assertExactObjectFields(
      outcome,
      ["finding_id", "status", "reason"],
      `Codex PR rework outcome at index ${index}`
    );
    if (
      typeof outcome.finding_id !== "string" ||
      !["fixed", "not_fixed"].includes(outcome.status) ||
      typeof outcome.reason !== "string"
    ) {
      throw new Error(`Invalid Codex PR rework outcome at index ${index}`);
    }
    if (!findingsById.has(outcome.finding_id)) {
      throw new Error(`Unknown PR rework finding: ${outcome.finding_id}`);
    }
    if (seenFindingIds.has(outcome.finding_id)) {
      throw new Error(`Duplicate PR rework finding: ${outcome.finding_id}`);
    }
    seenFindingIds.add(outcome.finding_id);
    const reason = validateBoundedPrReviewString(
      outcome.reason,
      `rework outcome reason at index ${index}`,
      MAX_AGENT_REASON_LENGTH
    );
    return {
      finding_id: outcome.finding_id,
      status: outcome.status,
      reason,
    };
  });
  if (
    outcomes.length !== input.blocking_findings.length ||
    input.blocking_findings.some(
      (finding) => !seenFindingIds.has(finding.finding_id)
    )
  ) {
    throw new Error(
      "Codex PR rework outcomes must cover every blocking finding exactly once"
    );
  }

  const fixedPaths = new Set(
    outcomes
      .filter((outcome) => outcome.status === "fixed")
      .map((outcome) => findingsById.get(outcome.finding_id).path)
  );
  const changedFileSet = new Set(changedFiles);
  const companionTestFiles = new Set(
    changedParserFile &&
      changedFileSet.has(AGENT_PARSER_REGRESSION_TEST_FILE)
      ? [AGENT_PARSER_REGRESSION_TEST_FILE]
      : []
  );
  if (
    [...fixedPaths].some((file) => !changedFileSet.has(file)) ||
    [...changedFileSet].some(
      (file) => !fixedPaths.has(file) && !companionTestFiles.has(file)
    )
  ) {
    throw new Error(
      "Codex PR rework fixed outcomes and changed files do not match"
    );
  }

  return {
    schema_version: 1,
    mode: "agentic_pr_rework_result",
    context_sha256: input.context_sha256,
    round: input.round,
    summary,
    allowed_files: input.allowed_files,
    changed_files: changedFiles,
    has_patch: changedFiles.length > 0,
    blocking_findings: input.blocking_findings,
    outcomes,
  };
}

async function readAndValidatePrReworkSources(options = {}) {
  const fixInputPath =
    options.inputPath ??
    process.env.UPSTREAM_REVIEW_FIX_INPUT_PATH?.trim();
  const fixManifestPath =
    options.manifestPath ??
    process.env.UPSTREAM_REVIEW_FIX_MANIFEST_PATH?.trim();
  const fixPatchPath =
    options.patchPath ??
    process.env.UPSTREAM_REVIEW_FIX_PATCH_PATH?.trim();
  const reworkInputPath =
    options.reworkInputPath ??
    process.env.UPSTREAM_REVIEW_PR_REWORK_INPUT_PATH?.trim();
  const baseSha =
    options.baseSha ??
    process.env.UPSTREAM_REVIEW_BASE_SHA?.trim() ??
    "";
  const reviewedHeadSha =
    options.headSha ??
    process.env.UPSTREAM_REVIEW_HEAD_SHA?.trim() ??
    "";
  const round = parsePrReworkRound(
    options.round ??
      process.env.UPSTREAM_REVIEW_PR_REWORK_ROUND?.trim()
  );
  const [
    fixInputText,
    fixManifestText,
    fixPatch,
    reworkInputText,
  ] = await Promise.all([
    readTextFile(fixInputPath, "agentic fix input"),
    readTextFile(fixManifestPath, "agentic fix manifest"),
    fs.readFile(path.resolve(fixPatchPath)),
    readTextFile(reworkInputPath, "agentic PR rework input"),
  ]);
  const fixInput = validateAgenticFixInput(
    parseJsonDocument(fixInputText, "agentic fix input")
  );
  const fixManifest = validateFixManifest(
    parseJsonDocument(fixManifestText, "agentic fix manifest"),
    fixInput,
    fixPatch,
    baseSha
  );
  const reworkInput = validateAgenticPrReworkInput(
    parseJsonDocument(reworkInputText, "agentic PR rework input")
  );
  const expectedFixBranch = getFixBranch(
    fixInput.finding_fingerprint,
    fixInput.source_report.issue_number,
    fixInput.source_report.base_sha
  );
  const configuredFixBranch =
    options.fixBranch ??
    process.env.UPSTREAM_REVIEW_FIX_BRANCH?.trim() ??
    expectedFixBranch;
  const pullRequestNumber = Number(
    options.pullRequestNumber ??
      process.env.UPSTREAM_REVIEW_PR_NUMBER?.trim() ??
      reworkInput.pull_request.number
  );
  const pullRequestUrl =
    options.pullRequestUrl ??
    process.env.UPSTREAM_REVIEW_PR_URL?.trim() ??
    reworkInput.pull_request.url;
  const expectedContext = {
    ...getAgenticPrReworkContext(reworkInput),
    round,
    max_rounds: MAX_PR_REWORK_ROUNDS,
    base_sha: baseSha,
    reviewed_head_sha: reviewedHeadSha,
    finding_fingerprint: fixInput.finding_fingerprint,
    issue_number: fixInput.source_report.issue_number,
    remediation_cycle: fixInput.source_report.remediation_cycle,
    fix_branch: configuredFixBranch,
    pull_request: {
      number: pullRequestNumber,
      url: pullRequestUrl,
    },
    fix_input_sha256: sha256(Buffer.from(fixInputText, "utf8")),
    previous_manifest_sha256: sha256(
      Buffer.from(fixManifestText, "utf8")
    ),
    previous_patch_sha256: fixManifest.patch_sha256,
    allowed_files: fixInput.allowed_files,
    changed_files: fixManifest.changed_files,
  };
  validateAgenticPrReworkInput(reworkInput, expectedContext);
  return {
    fixInput,
    fixInputText,
    fixManifest,
    fixManifestText,
    fixPatch,
    reworkInput,
    reworkInputText,
    baseSha,
    reviewedHeadSha,
    round,
    fixBranch: expectedFixBranch,
  };
}

async function assertSingleParentSnapshot(
  commitSha,
  baseSha,
  expectedTree,
  cwd,
  label
) {
  const [lineResult, treeResult] = await Promise.all([
    runGit(["rev-list", "--parents", "-n", "1", commitSha], { cwd }),
    runGit(["rev-parse", `${commitSha}^{tree}`], { cwd }),
  ]);
  const fields = String(lineResult.stdout).trim().split(/\s+/);
  if (
    fields.length !== 2 ||
    fields[0] !== commitSha ||
    fields[1] !== baseSha
  ) {
    throw new Error(`${label} is not a single-parent commit on the trusted base`);
  }
  const tree = String(treeResult.stdout).trim();
  if (tree !== expectedTree) {
    throw new Error(`${label} tree does not match the trusted patch`);
  }
  return tree;
}

function validatePrReworkManifest(
  manifest,
  reworkInput,
  incrementalPatch,
  cumulativeManifest,
  cumulativePatch,
  fixInput
) {
  assertExactObjectFields(
    manifest,
    [
      "schema_version",
      "mode",
      "round",
      "max_rounds",
      "base_sha",
      "parent_sha",
      "finding_fingerprint",
      "issue_number",
      "remediation_cycle",
      "fix_branch",
      "rework_context_sha256",
      "review_context_sha256",
      "review_result_sha256",
      "previous_patch_sha256",
      "incremental_patch_sha256",
      "incremental_patch_bytes",
      "incremental_changed_files",
      "patch_sha256",
      "patch_bytes",
      "changed_files",
      "result_tree",
    ],
    "Agentic PR rework manifest"
  );
  const input = validateAgenticPrReworkInput(reworkInput);
  const validatedCumulativeManifest = validateFixManifest(
    cumulativeManifest,
    fixInput,
    cumulativePatch,
    input.base_sha
  );
  if (
    manifest.schema_version !== 2 ||
    manifest.mode !== "agentic_pr_rework_manifest" ||
    manifest.round !== input.round ||
    manifest.max_rounds !== input.max_rounds ||
    manifest.base_sha !== input.base_sha ||
    manifest.parent_sha !== input.reviewed_head_sha ||
    manifest.finding_fingerprint !== input.finding_fingerprint ||
    manifest.issue_number !== input.issue_number ||
    manifest.remediation_cycle !== input.remediation_cycle ||
    manifest.fix_branch !== input.fix_branch ||
    manifest.rework_context_sha256 !== input.context_sha256 ||
    manifest.review_context_sha256 !== input.review_context_sha256 ||
    manifest.review_result_sha256 !== input.review_result_sha256 ||
    manifest.previous_patch_sha256 !== input.previous_patch_sha256
  ) {
    throw new Error("Agentic PR rework manifest context mismatch");
  }
  if (
    !Buffer.isBuffer(incrementalPatch) ||
    incrementalPatch.length === 0 ||
    incrementalPatch.length > MAX_PR_REWORK_PATCH_BYTES ||
    manifest.incremental_patch_bytes !== incrementalPatch.length ||
    manifest.incremental_patch_sha256 !== sha256(incrementalPatch)
  ) {
    throw new Error("Agentic PR rework incremental patch mismatch");
  }
  if (
    !Buffer.isBuffer(cumulativePatch) ||
    cumulativePatch.length === 0 ||
    cumulativePatch.length > MAX_PR_REWORK_PATCH_BYTES ||
    manifest.patch_bytes !== cumulativePatch.length ||
    manifest.patch_sha256 !== sha256(cumulativePatch) ||
    manifest.patch_sha256 !== validatedCumulativeManifest.patch_sha256 ||
    manifest.patch_bytes !== validatedCumulativeManifest.patch_bytes
  ) {
    throw new Error("Agentic PR rework cumulative patch mismatch");
  }
  const incrementalChangedFiles = normalizeChangedFiles(
    manifest.incremental_changed_files
  );
  if (
    manifest.incremental_changed_files.some(
      (file, index) => file !== incrementalChangedFiles[index]
    ) ||
    incrementalChangedFiles.length === 0 ||
    incrementalChangedFiles.some(
      (file) => !input.allowed_files.includes(file)
    )
  ) {
    throw new Error(
      "Agentic PR rework manifest has invalid incremental changed files"
    );
  }
  const changedFiles = normalizeChangedFiles(manifest.changed_files);
  if (
    manifest.changed_files.some(
      (file, index) => file !== changedFiles[index]
    ) ||
    changedFiles.length === 0 ||
    changedFiles.some((file) => !input.allowed_files.includes(file))
  ) {
    throw new Error("Agentic PR rework manifest has invalid changed files");
  }
  const removedPreviousFile = input.changed_files.find(
    (file) => !changedFiles.includes(file)
  );
  if (removedPreviousFile) {
    throw new Error(
      `Agentic PR rework removed a previously changed file from the cumulative patch: ${removedPreviousFile}`
    );
  }
  assertExactStringSet(
    changedFiles,
    validatedCumulativeManifest.changed_files,
    "Agentic PR rework cumulative changed_files"
  );
  if (
    manifest.result_tree !== validatedCumulativeManifest.result_tree ||
    typeof manifest.result_tree !== "string" ||
    !/^[a-f0-9]{40}$/.test(manifest.result_tree)
  ) {
    throw new Error("Agentic PR rework manifest result tree mismatch");
  }
  return {
    ...manifest,
    incremental_changed_files: incrementalChangedFiles,
    changed_files: changedFiles,
  };
}

async function writeBufferFile(outputPath, content) {
  if (!outputPath) {
    throw new Error("Missing output path");
  }
  const resolved = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content);
}

async function finalizeAgenticPrRework(options = {}) {
  const cwd = path.resolve(
    options.cwd ??
      process.env.GITHUB_WORKSPACE?.trim() ??
      process.cwd()
  );
  const agentOutputPath =
    options.agentOutputPath ??
    process.env.UPSTREAM_REVIEW_PR_REWORK_AGENT_OUTPUT_PATH?.trim();
  const metadataPath =
    options.metadataPath ??
    process.env.UPSTREAM_REVIEW_PR_REWORK_METADATA_PATH?.trim();
  const reworkManifestPath =
    options.reworkManifestPath ??
    process.env.UPSTREAM_REVIEW_PR_REWORK_MANIFEST_PATH?.trim();
  const incrementalPatchPath =
    options.incrementalPatchPath ??
    process.env.UPSTREAM_REVIEW_PR_REWORK_PATCH_PATH?.trim();
  const cumulativeManifestPath =
    options.cumulativeManifestPath ??
    process.env.UPSTREAM_REVIEW_PR_REWORK_FIX_MANIFEST_PATH?.trim();
  const cumulativePatchPath =
    options.cumulativePatchPath ??
    process.env.UPSTREAM_REVIEW_PR_REWORK_FIX_PATCH_PATH?.trim();
  const expectedReworkManifestPath =
    options.expectedReworkManifestPath ??
    process.env.UPSTREAM_REVIEW_EXPECTED_PR_REWORK_MANIFEST_PATH?.trim();
  const sources = await readAndValidatePrReworkSources(options);
  const [
    agentOutputText,
    headResult,
    statusResult,
    summaryResult,
    untrackedResult,
  ] = await Promise.all([
    readTextFile(agentOutputPath, "Codex PR rework output"),
    runGit(["rev-parse", "HEAD"], { cwd }),
    runGit(["diff", "--name-status", "--no-renames", "HEAD", "--"], {
      cwd,
    }),
    runGit(["diff", "--summary", "--no-renames", "HEAD", "--"], { cwd }),
    runGit(["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd,
      encoding: null,
    }),
  ]);
  const checkoutHead = String(headResult.stdout).trim();
  if (checkoutHead !== sources.reviewedHeadSha) {
    throw new Error(
      `PR rework checkout mismatch: expected ${sources.reviewedHeadSha}, got ${checkoutHead}`
    );
  }
  if (String(summaryResult.stdout).trim()) {
    throw new Error(
      `Codex PR rework changed a file mode or type: ${String(
        summaryResult.stdout
      ).trim()}`
    );
  }
  const untrackedFiles = Buffer.from(untrackedResult.stdout)
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const unexpectedUntrackedFile = untrackedFiles.find(
    (file) => !PR_REWORK_WORKSPACE_ARTIFACTS.has(file)
  );
  if (unexpectedUntrackedFile) {
    throw new Error(
      `Codex PR rework created an unexpected untracked file: ${unexpectedUntrackedFile}`
    );
  }

  const previousInspection = await inspectPatchBuffer(
    sources.fixPatch,
    sources.baseSha,
    cwd,
    "Previous cumulative fix patch"
  );
  assertExactStringSet(
    previousInspection.changed_files,
    sources.fixManifest.changed_files,
    "Previous cumulative fix patch paths"
  );
  if (previousInspection.result_tree !== sources.fixManifest.result_tree) {
    throw new Error("Previous cumulative fix patch result tree mismatch");
  }
  await assertSingleParentSnapshot(
    sources.reviewedHeadSha,
    sources.baseSha,
    sources.fixManifest.result_tree,
    cwd,
    "Reviewed PR head"
  );

  const incrementalChangedFiles = parseModifiedFileStatus(
    statusResult.stdout
  );
  const parsedMetadata = parseAgentPrReworkOutput(
    agentOutputText,
    sources.reworkInput,
    incrementalChangedFiles
  );
  if (!parsedMetadata.has_patch) {
    await writeReport(parsedMetadata, metadataPath);
    await Promise.all([
      writeBufferFile(incrementalPatchPath, Buffer.alloc(0)),
      writeBufferFile(cumulativePatchPath, Buffer.alloc(0)),
    ]);
    await appendGitHubOutputs(
      {
        has_patch: false,
        changed_file_count: 0,
        patch_sha256: "",
        incremental_patch_sha256: "",
        result_tree: previousInspection.result_tree,
      },
      options.githubOutputPath
    );
    return {
      metadata: parsedMetadata,
      rework_manifest: null,
      fix_manifest: null,
    };
  }

  const cumulativeStatusResult = await runGit(
    [
      "diff",
      "--name-status",
      "--no-renames",
      sources.baseSha,
      "--",
    ],
    { cwd }
  );
  const cumulativeChangedFiles = parseModifiedFileStatus(
    cumulativeStatusResult.stdout
  );
  const disallowedCumulativeFile = cumulativeChangedFiles.find(
    (file) => !sources.fixInput.allowed_files.includes(file)
  );
  if (disallowedCumulativeFile) {
    throw new Error(
      `PR rework cumulative patch contains a file outside the allowlist: ${disallowedCumulativeFile}`
    );
  }

  const [
    incrementalNumstat,
    cumulativeNumstat,
    incrementalPatchResult,
    cumulativePatchResult,
  ] = await Promise.all([
    runGit(["diff", "--numstat", "HEAD", "--"], { cwd }),
    runGit(["diff", "--numstat", sources.baseSha, "--"], { cwd }),
    runGit(
      [
        "diff",
        "--binary",
        "--full-index",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "HEAD",
        "--",
      ],
      { cwd, encoding: null }
    ),
    runGit(
      [
        "diff",
        "--binary",
        "--full-index",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        sources.baseSha,
        "--",
      ],
      { cwd, encoding: null }
    ),
    runGit(["diff", "--check", "HEAD", "--"], { cwd }),
    runGit(["diff", "--check", sources.baseSha, "--"], { cwd }),
    assertSemanticDiff(cwd, "HEAD"),
  ]);
  for (const [label, result] of [
    ["incremental", incrementalNumstat],
    ["cumulative", cumulativeNumstat],
  ]) {
    if (
      String(result.stdout)
        .split(/\r?\n/)
        .filter(Boolean)
        .some((line) => line.startsWith("-\t-\t"))
    ) {
      throw new Error(`Codex PR rework produced a binary ${label} patch`);
    }
  }
  const incrementalPatch = Buffer.from(incrementalPatchResult.stdout);
  const cumulativePatch = Buffer.from(cumulativePatchResult.stdout);
  for (const [label, patch] of [
    ["incremental", incrementalPatch],
    ["cumulative", cumulativePatch],
  ]) {
    if (
      patch.length === 0 ||
      patch.length > MAX_PR_REWORK_PATCH_BYTES
    ) {
      throw new Error(
        `PR rework ${label} patch is ${patch.length} bytes; expected 1-${MAX_PR_REWORK_PATCH_BYTES}`
      );
    }
  }

  const [incrementalInspection, cumulativeInspection] = await Promise.all([
    inspectPatchBuffer(
      incrementalPatch,
      sources.reviewedHeadSha,
      cwd,
      "PR rework incremental patch"
    ),
    inspectPatchBuffer(
      cumulativePatch,
      sources.baseSha,
      cwd,
      "PR rework cumulative patch"
    ),
  ]);
  assertExactStringSet(
    incrementalInspection.changed_files,
    incrementalChangedFiles,
    "PR rework incremental patch paths"
  );
  assertExactStringSet(
    cumulativeInspection.changed_files,
    cumulativeChangedFiles,
    "PR rework cumulative patch paths"
  );
  if (
    incrementalInspection.result_tree !== cumulativeInspection.result_tree
  ) {
    throw new Error(
      "PR rework incremental and cumulative patches produce different trees"
    );
  }

  const cumulativeManifest = {
    schema_version: 2,
    mode: "agentic_fix_manifest",
    base_sha: sources.baseSha,
    finding_fingerprint: sources.fixInput.finding_fingerprint,
    issue_number: sources.fixInput.source_report.issue_number,
    remediation_cycle: sources.fixInput.source_report.remediation_cycle,
    fix_branch: sources.fixInput.fix_branch,
    finding_ids: sources.fixInput.findings.map(
      (finding) => finding.finding_id
    ),
    target_games: sources.fixInput.target_games,
    changed_files: cumulativeChangedFiles,
    patch_sha256: sha256(cumulativePatch),
    patch_bytes: cumulativePatch.length,
    result_tree: cumulativeInspection.result_tree,
  };
  validateFixManifest(
    cumulativeManifest,
    sources.fixInput,
    cumulativePatch,
    sources.baseSha
  );
  const reworkManifest = {
    schema_version: 2,
    mode: "agentic_pr_rework_manifest",
    round: sources.round,
    max_rounds: MAX_PR_REWORK_ROUNDS,
    base_sha: sources.baseSha,
    parent_sha: sources.reviewedHeadSha,
    finding_fingerprint: sources.fixInput.finding_fingerprint,
    issue_number: sources.fixInput.source_report.issue_number,
    remediation_cycle: sources.fixInput.source_report.remediation_cycle,
    fix_branch: sources.fixBranch,
    rework_context_sha256: sources.reworkInput.context_sha256,
    review_context_sha256: sources.reworkInput.review_context_sha256,
    review_result_sha256: sources.reworkInput.review_result_sha256,
    previous_patch_sha256: sources.fixManifest.patch_sha256,
    incremental_patch_sha256: sha256(incrementalPatch),
    incremental_patch_bytes: incrementalPatch.length,
    incremental_changed_files: incrementalChangedFiles,
    patch_sha256: cumulativeManifest.patch_sha256,
    patch_bytes: cumulativeManifest.patch_bytes,
    changed_files: cumulativeChangedFiles,
    result_tree: cumulativeInspection.result_tree,
  };
  validatePrReworkManifest(
    reworkManifest,
    sources.reworkInput,
    incrementalPatch,
    cumulativeManifest,
    cumulativePatch,
    sources.fixInput
  );

  if (expectedReworkManifestPath) {
    const expectedManifestText = await readTextFile(
      expectedReworkManifestPath,
      "expected PR rework manifest"
    );
    const expectedManifest = validatePrReworkManifest(
      parseJsonDocument(
        expectedManifestText,
        "expected PR rework manifest"
      ),
      sources.reworkInput,
      incrementalPatch,
      cumulativeManifest,
      cumulativePatch,
      sources.fixInput
    );
    if (JSON.stringify(expectedManifest) !== JSON.stringify(reworkManifest)) {
      throw new Error("Verified PR rework manifest mismatch");
    }
  }

  const metadata = {
    ...parsedMetadata,
    cumulative_changed_files: cumulativeChangedFiles,
    incremental_patch_sha256: reworkManifest.incremental_patch_sha256,
    patch_sha256: reworkManifest.patch_sha256,
    result_tree: reworkManifest.result_tree,
  };
  await Promise.all([
    writeReport(metadata, metadataPath),
    writeReport(reworkManifest, reworkManifestPath),
    writeBufferFile(incrementalPatchPath, incrementalPatch),
    writeReport(cumulativeManifest, cumulativeManifestPath),
    writeBufferFile(cumulativePatchPath, cumulativePatch),
  ]);
  await appendGitHubOutputs(
    {
      has_patch: true,
      changed_file_count: incrementalChangedFiles.length,
      patch_sha256: reworkManifest.patch_sha256,
      incremental_patch_sha256:
        reworkManifest.incremental_patch_sha256,
      result_tree: reworkManifest.result_tree,
    },
    options.githubOutputPath
  );
  console.log(
    JSON.stringify({
      mode: reworkManifest.mode,
      round: reworkManifest.round,
      parent_sha: reworkManifest.parent_sha,
      incremental_changed_files: incrementalChangedFiles,
      changed_files: cumulativeChangedFiles,
      incremental_patch_sha256:
        reworkManifest.incremental_patch_sha256,
      patch_sha256: reworkManifest.patch_sha256,
      result_tree: reworkManifest.result_tree,
    })
  );
  return {
    metadata,
    rework_manifest: reworkManifest,
    fix_manifest: cumulativeManifest,
  };
}

async function verifyAgenticPrReworkArtifact(options = {}) {
  const cwd = path.resolve(
    options.cwd ??
      process.env.GITHUB_WORKSPACE?.trim() ??
      process.cwd()
  );
  const reworkManifestPath =
    options.reworkManifestPath ??
    process.env.UPSTREAM_REVIEW_PR_REWORK_MANIFEST_PATH?.trim();
  const incrementalPatchPath =
    options.incrementalPatchPath ??
    process.env.UPSTREAM_REVIEW_PR_REWORK_PATCH_PATH?.trim();
  const cumulativeManifestPath =
    options.cumulativeManifestPath ??
    process.env.UPSTREAM_REVIEW_PR_REWORK_FIX_MANIFEST_PATH?.trim();
  const cumulativePatchPath =
    options.cumulativePatchPath ??
    process.env.UPSTREAM_REVIEW_PR_REWORK_FIX_PATCH_PATH?.trim();
  const sources = await readAndValidatePrReworkSources(options);
  const [
    reworkManifestText,
    incrementalPatch,
    cumulativeManifestText,
    cumulativePatch,
    checkoutResult,
  ] = await Promise.all([
    readTextFile(reworkManifestPath, "agentic PR rework manifest"),
    fs.readFile(path.resolve(incrementalPatchPath)),
    readTextFile(
      cumulativeManifestPath,
      "agentic PR rework cumulative fix manifest"
    ),
    fs.readFile(path.resolve(cumulativePatchPath)),
    runGit(["rev-parse", "HEAD"], { cwd }),
  ]);
  const checkoutHead = String(checkoutResult.stdout).trim();
  if (checkoutHead !== sources.baseSha) {
    throw new Error(
      `PR rework verification checkout mismatch: expected ${sources.baseSha}, got ${checkoutHead}`
    );
  }
  const cumulativeManifest = validateFixManifest(
    parseJsonDocument(
      cumulativeManifestText,
      "agentic PR rework cumulative fix manifest"
    ),
    sources.fixInput,
    cumulativePatch,
    sources.baseSha
  );
  const reworkManifest = validatePrReworkManifest(
    parseJsonDocument(reworkManifestText, "agentic PR rework manifest"),
    sources.reworkInput,
    incrementalPatch,
    cumulativeManifest,
    cumulativePatch,
    sources.fixInput
  );

  const previousInspection = await inspectPatchBuffer(
    sources.fixPatch,
    sources.baseSha,
    cwd,
    "Previous cumulative fix patch"
  );
  assertExactStringSet(
    previousInspection.changed_files,
    sources.fixManifest.changed_files,
    "Previous cumulative fix patch paths"
  );
  if (previousInspection.result_tree !== sources.fixManifest.result_tree) {
    throw new Error("Previous cumulative fix patch result tree mismatch");
  }
  await assertSingleParentSnapshot(
    sources.reviewedHeadSha,
    sources.baseSha,
    sources.fixManifest.result_tree,
    cwd,
    "Reviewed PR head"
  );
  const [incrementalInspection, cumulativeInspection] = await Promise.all([
    inspectPatchBuffer(
      incrementalPatch,
      sources.reviewedHeadSha,
      cwd,
      "PR rework incremental patch"
    ),
    inspectPatchBuffer(
      cumulativePatch,
      sources.baseSha,
      cwd,
      "PR rework cumulative patch"
    ),
  ]);
  assertExactStringSet(
    incrementalInspection.changed_files,
    reworkManifest.incremental_changed_files,
    "PR rework incremental patch paths"
  );
  assertExactStringSet(
    cumulativeInspection.changed_files,
    reworkManifest.changed_files,
    "PR rework cumulative patch paths"
  );
  if (
    incrementalInspection.result_tree !== reworkManifest.result_tree ||
    cumulativeInspection.result_tree !== reworkManifest.result_tree
  ) {
    throw new Error("PR rework patch result tree mismatch");
  }

  await appendGitHubOutputs(
    {
      round: reworkManifest.round,
      fix_branch: reworkManifest.fix_branch,
      patch_sha256: reworkManifest.patch_sha256,
      incremental_patch_sha256:
        reworkManifest.incremental_patch_sha256,
      result_tree: reworkManifest.result_tree,
    },
    options.githubOutputPath
  );
  console.log(
    JSON.stringify({
      mode: reworkManifest.mode,
      round: reworkManifest.round,
      base_sha: reworkManifest.base_sha,
      parent_sha: reworkManifest.parent_sha,
      changed_files: reworkManifest.changed_files,
      patch_sha256: reworkManifest.patch_sha256,
      result_tree: reworkManifest.result_tree,
    })
  );
  return {
    rework_manifest: reworkManifest,
    fix_manifest: cumulativeManifest,
  };
}

async function readAgentGameReviews(
  agentOutputDir,
  legacyAgentOutputPath,
  options = {}
) {
  const expectedGames = options.expectedGames ?? DEFAULT_GAMES;
  if (
    !Array.isArray(expectedGames) ||
    expectedGames.length === 0 ||
    new Set(expectedGames).size !== expectedGames.length ||
    expectedGames.some((game) => !SUPPORTED_GAMES.has(game))
  ) {
    throw new Error("Invalid expected agent review games");
  }
  if (agentOutputDir) {
    return await Promise.all(
      expectedGames.map(async (game) => {
        const outputPath = path.join(
          path.resolve(agentOutputDir),
          `upstream-review-agent-${game}.json`
        );
        const outputText = await readTextFile(
          outputPath,
          `Codex ${game} review output`
        );
        const review = parseAgentReview(
          outputText,
          [game],
          MAX_AGENT_FINDINGS_PER_GAME,
          options
        );
        return { game, ...review };
      })
    );
  }

  const outputText = await readTextFile(
    legacyAgentOutputPath,
    "Codex review output"
  );
  const review = parseAgentReview(
    outputText,
    expectedGames,
    MAX_AGENT_FINDINGS,
    options
  );
  return expectedGames.map((game) => ({
    game,
    summary: review.summary,
    findings: review.findings.filter((finding) => finding.game === game),
  }));
}

function buildReviewDraft(
  input,
  agentGameReviews,
  suppressions,
  suppressionsPath,
  baseSha
) {
  const availableGames = getReviewableGamesForSchema(
    input,
    "collected review input"
  );
  assertCanonicalGameCoverage(
    agentGameReviews.map((review) => review.game),
    availableGames,
    "Agent game reviews"
  );
  const agentFindings = agentGameReviews.flatMap((review) => review.findings);
  if (agentFindings.length > MAX_AGENT_FINDINGS) {
    throw new Error(
      `Invalid combined agent review: ${agentFindings.length} findings exceeds the ${MAX_AGENT_FINDINGS} limit`
    );
  }
  const datasetsByGame = new Map(
    input.review_datasets.map((dataset) => [dataset.game, dataset])
  );
  const materializedFindings = agentFindings.map((finding, index) =>
    materializeFindingEvidence(
      finding,
      datasetsByGame.get(finding.game),
      index
    )
  );
  const agentSummary = truncateText(
    agentGameReviews
      .map(
        (review) =>
          `${review.game}: ${review.summary || "No clear findings."}`
      )
      .join(" "),
    MAX_AGENT_SUMMARY_LENGTH
  );
  const { filteredFindings, suppressedFindings } = applySuppressions(
    materializedFindings,
    suppressions
  );
  const uniqueFindings = getUniqueFindingEntries(filteredFindings)
    .map((entry) => entry.finding)
    .sort(compareFixFindings);
  if (uniqueFindings.length > 0 && !/^[a-f0-9]{40}$/.test(baseSha)) {
    throw new Error("Missing or invalid remediation base SHA");
  }
  const modelLabel = "Codex via Responses API";
  return {
    schema_version: 3,
    mode: "agentic_review",
    finding_identity_version: FINDING_IDENTITY_VERSION,
    generated_at: input.generated_at,
    finalized_at: "",
    base_sha: baseSha,
    api_base_url: input.api_base_url,
    collection: input.collection,
    datasets: input.datasets,
    review_datasets: input.review_datasets,
    suppressions: {
      ...input.suppressions,
      path: suppressionsPath,
      count: suppressions.length,
    },
    review: {
      engine: "codex",
      transport: "responses",
      model: modelLabel,
      raw_summary: agentSummary,
      game_reviews: agentGameReviews.map((review) => ({
        game: review.game,
        model: modelLabel,
        raw_summary: review.summary,
        raw_finding_count: review.findings.length,
      })),
      summary: summarizeFilteredReview(
        agentSummary,
        uniqueFindings.length,
        suppressedFindings.length
      ),
      findings: uniqueFindings,
      suppressed_findings: suppressedFindings,
    },
  };
}

function buildFindingConfirmationInput(game, candidates, draftReport) {
  const dataset = draftReport.review_datasets.find(
    (entry) => entry.game === game
  );
  if (!dataset) {
    throw new Error(`Missing trusted confirmation dataset for ${game}`);
  }
  const rawByRef = new Map(
    dataset.raw_notices.map((item) => [item.review_ref, item])
  );
  const apiByRef = new Map(
    dataset.api_events.map((item) => [item.review_ref, item])
  );
  const context = {
    schema_version: 1,
    mode: "confirm_findings",
    generated_at: draftReport.generated_at,
    target_game: game,
    notes: dataset.notes,
    candidates: candidates.map((candidate) => ({
      finding_id: candidate.finding_id,
      finding_key: candidate.finding_key,
      finding: candidate.finding,
      raw_evidence: candidate.finding.raw_refs.map((ref) => rawByRef.get(ref)),
      api_evidence: candidate.finding.api_refs.map((ref) => apiByRef.get(ref)),
    })),
  };
  return {
    ...context,
    input_sha256: sha256(JSON.stringify(context)),
  };
}

function buildFindingConfirmationCandidates(draftReport) {
  return getUniqueFindingEntries(draftReport.review.findings).map(
    (entry, index) => ({
      finding_id: `finding-${String(index + 1).padStart(3, "0")}`,
      ...entry,
    })
  );
}

function buildFindingConfirmationGamePlans(candidates, draftReport) {
  const availableGames = getReviewableGamesForSchema(
    draftReport,
    "agentic review report"
  );
  return availableGames.filter((game) =>
    candidates.some((candidate) => candidate.finding.game === game)
  ).map((game) => {
    const gameCandidates = candidates.filter(
      (candidate) => candidate.finding.game === game
    );
    const input = buildFindingConfirmationInput(
      game,
      gameCandidates,
      draftReport
    );
    return {
      input,
      metadata: {
        game,
        filename: `upstream-review-confirm-input-${game}.json`,
        input_sha256: input.input_sha256,
        finding_ids: gameCandidates.map((candidate) => candidate.finding_id),
      },
    };
  });
}

function validateFindingConfirmationInput(input) {
  if (
    !isRecord(input) ||
    input.schema_version !== 1 ||
    input.mode !== "confirm_findings" ||
    !SUPPORTED_GAMES.has(input.target_game) ||
    typeof input.generated_at !== "string" ||
    typeof input.notes !== "string" ||
    !Array.isArray(input.candidates) ||
    input.candidates.length === 0 ||
    input.candidates.length > MAX_AGENT_FINDINGS_PER_GAME
  ) {
    throw new Error("Invalid finding confirmation input");
  }
  const context = {
    schema_version: input.schema_version,
    mode: input.mode,
    generated_at: input.generated_at,
    target_game: input.target_game,
    notes: input.notes,
    candidates: input.candidates,
  };
  if (
    typeof input.input_sha256 !== "string" ||
    input.input_sha256 !== sha256(JSON.stringify(context))
  ) {
    throw new Error("Finding confirmation input SHA-256 mismatch");
  }
  const seenIds = new Set();
  for (const [index, candidate] of input.candidates.entries()) {
    if (
      !isRecord(candidate) ||
      !/^finding-[0-9]{3}$/.test(candidate.finding_id) ||
      !/^[a-f0-9]{64}$/.test(candidate.finding_key) ||
      !isRecord(candidate.finding) ||
      candidate.finding.game !== input.target_game ||
      getFindingKey(candidate.finding) !== candidate.finding_key ||
      !Array.isArray(candidate.raw_evidence) ||
      !Array.isArray(candidate.api_evidence) ||
      seenIds.has(candidate.finding_id)
    ) {
      throw new Error(
        `Invalid finding confirmation candidate at index ${index}`
      );
    }
    seenIds.add(candidate.finding_id);
    const rawRefs = candidate.raw_evidence.map((item) => item?.review_ref);
    const apiRefs = candidate.api_evidence.map((item) => item?.review_ref);
    if (
      JSON.stringify(rawRefs) !== JSON.stringify(candidate.finding.raw_refs) ||
      JSON.stringify(apiRefs) !== JSON.stringify(candidate.finding.api_refs)
    ) {
      throw new Error(
        `Finding confirmation evidence mismatch at index ${index}`
      );
    }
  }
  return input;
}

function parseFindingConfirmationOutput(text, rawInput) {
  const input = validateFindingConfirmationInput(rawInput);
  const parsed = parseJsonDocument(text, "Codex finding confirmation output");
  assertExactObjectFields(
    parsed,
    ["complete", "errors", "input_sha256", "decisions"],
    "Codex finding confirmation output"
  );
  if (
    parsed.complete !== true ||
    !Array.isArray(parsed.errors) ||
    parsed.errors.length > 0 ||
    parsed.errors.some((error) => typeof error !== "string") ||
    parsed.input_sha256 !== input.input_sha256 ||
    !Array.isArray(parsed.decisions) ||
    parsed.decisions.length !== input.candidates.length
  ) {
    throw new Error("Codex finding confirmation output is incomplete");
  }
  return parsed.decisions.map((decision, index) => {
    assertExactObjectFields(
      decision,
      ["finding_id", "verdict", "confidence", "reason"],
      `Codex finding confirmation decision at index ${index}`
    );
    const expected = input.candidates[index];
    if (
      decision.finding_id !== expected.finding_id ||
      !["confirmed", "rejected", "ambiguous"].includes(decision.verdict) ||
      !["high", "medium", "low"].includes(decision.confidence) ||
      typeof decision.reason !== "string" ||
      !normalizeWhitespace(decision.reason)
    ) {
      throw new Error(
        `Invalid Codex finding confirmation decision at index ${index}`
      );
    }
    return {
      finding_id: decision.finding_id,
      verdict: decision.verdict,
      confidence: decision.confidence,
      reason: truncateText(
        normalizeWhitespace(decision.reason),
        MAX_AGENT_REASON_LENGTH
      ),
    };
  });
}

async function prepareFindingConfirmation(options = {}) {
  const inputPath =
    options.inputPath ??
    process.env.UPSTREAM_REVIEW_INPUT_PATH?.trim();
  const agentOutputDir =
    options.agentOutputDir ??
    process.env.UPSTREAM_REVIEW_AGENT_OUTPUT_DIR?.trim();
  const agentOutputPath =
    options.agentOutputPath ??
    process.env.UPSTREAM_REVIEW_AGENT_OUTPUT_PATH?.trim();
  const planPath =
    options.planPath ??
    process.env.UPSTREAM_REVIEW_CONFIRMATION_PLAN_PATH?.trim();
  const outputDir = path.resolve(
    options.outputDir ??
      process.env.UPSTREAM_REVIEW_CONFIRMATION_INPUT_DIR?.trim() ??
      path.dirname(path.resolve(planPath))
  );
  const inputText = await readTextFile(inputPath, "collected review input");
  const input = validateCollectedReviewInput(
    parseJsonDocument(inputText, "collected review input")
  );
  if (input.schema_version !== 3) {
    throw new Error("Finding confirmation requires collected input schema v3");
  }
  const agentGameReviews = await readAgentGameReviews(
    agentOutputDir,
    agentOutputPath,
    {
      requireEvidenceRefs: true,
      expectedGames: input.collection.available_games,
    }
  );
  const suppressionsPath =
    options.suppressionsPath ??
    (process.env.UPSTREAM_REVIEW_SUPPRESSIONS_PATH?.trim() ||
    input.suppressions?.path ||
    DEFAULT_SUPPRESSIONS_PATH);
  const suppressions = await loadSuppressions(suppressionsPath);
  const baseSha = String(
    options.baseSha ??
      process.env.UPSTREAM_REVIEW_BASE_SHA ??
      process.env.GITHUB_SHA ??
      ""
  ).trim();
  const draftReport = buildReviewDraft(
    input,
    agentGameReviews,
    suppressions,
    suppressionsPath,
    baseSha
  );
  const candidates = buildFindingConfirmationCandidates(draftReport);
  const gamePlans = buildFindingConfirmationGamePlans(candidates, draftReport);
  const games = gamePlans.map(({ metadata }) => metadata.game);
  await fs.mkdir(outputDir, { recursive: true });
  for (const { input: confirmationInput, metadata } of gamePlans) {
    await writeReport(
      confirmationInput,
      path.join(outputDir, metadata.filename),
      false
    );
  }
  const planWithoutHash = {
    schema_version: 1,
    mode: "finding_confirmation_plan",
    draft_report: draftReport,
    candidates,
    games: gamePlans.map(({ metadata }) => metadata),
  };
  const plan = {
    ...planWithoutHash,
    plan_sha256: sha256(JSON.stringify(planWithoutHash)),
  };
  await writeReport(plan, planPath, false);
  await appendGitHubOutputs(
    {
      has_candidates: candidates.length > 0,
      candidate_count: candidates.length,
      matrix: JSON.stringify(games),
      plan_sha256: plan.plan_sha256,
    },
    options.githubOutputPath
  );
  console.log(
    JSON.stringify({
      mode: plan.mode,
      candidate_count: candidates.length,
      games,
      plan_sha256: plan.plan_sha256,
    })
  );
  return plan;
}

function validateFindingConfirmationPlan(plan) {
  if (
    !isRecord(plan) ||
    plan.schema_version !== 1 ||
    plan.mode !== "finding_confirmation_plan" ||
    !isRecord(plan.draft_report) ||
    !Array.isArray(plan.candidates) ||
    !Array.isArray(plan.games)
  ) {
    throw new Error("Invalid finding confirmation plan");
  }
  assertExactObjectFields(
    plan,
    [
      "schema_version",
      "mode",
      "draft_report",
      "candidates",
      "games",
      "plan_sha256",
    ],
    "Finding confirmation plan"
  );
  const planWithoutHash = {
    schema_version: plan.schema_version,
    mode: plan.mode,
    draft_report: plan.draft_report,
    candidates: plan.candidates,
    games: plan.games,
  };
  if (plan.plan_sha256 !== sha256(JSON.stringify(planWithoutHash))) {
    throw new Error("Finding confirmation plan SHA-256 mismatch");
  }
  const draftReport = validateAgenticReviewReport(plan.draft_report);
  if (!isDeepStrictEqual(plan.draft_report, draftReport)) {
    throw new Error("Finding confirmation draft report is not canonical");
  }
  const expectedCandidates = buildFindingConfirmationCandidates(draftReport);
  if (!isDeepStrictEqual(plan.candidates, expectedCandidates)) {
    throw new Error(
      "Finding confirmation plan candidates do not match the draft report"
    );
  }
  const expectedGames = buildFindingConfirmationGamePlans(
    expectedCandidates,
    draftReport
  ).map(({ metadata }) => metadata);
  if (!isDeepStrictEqual(plan.games, expectedGames)) {
    throw new Error(
      "Finding confirmation plan games do not match the draft candidates"
    );
  }
  return plan;
}

async function finalizeFindingConfirmation(options = {}) {
  const planPath =
    options.planPath ??
    process.env.UPSTREAM_REVIEW_CONFIRMATION_PLAN_PATH?.trim();
  const outputDir = path.resolve(
    options.outputDir ??
      process.env.UPSTREAM_REVIEW_CONFIRMATION_OUTPUT_DIR?.trim() ??
      ""
  );
  const reportPath =
    options.reportPath ??
    process.env.UPSTREAM_REVIEW_REPORT_PATH?.trim() ??
    "";
  const plan = validateFindingConfirmationPlan(
    parseJsonDocument(
      await readTextFile(planPath, "finding confirmation plan"),
      "finding confirmation plan"
    )
  );
  const decisionsById = new Map();
  for (const gameEntry of plan.games) {
    const expectedCandidates = plan.candidates.filter(
      (candidate) => candidate.finding.game === gameEntry.game
    );
    const expectedInput = buildFindingConfirmationInput(
      gameEntry.game,
      expectedCandidates,
      plan.draft_report
    );
    const input = validateFindingConfirmationInput(
      parseJsonDocument(
        await readTextFile(
          path.join(
            path.dirname(path.resolve(planPath)),
            gameEntry.filename
          ),
          `${gameEntry.game} finding confirmation input`
        ),
        `${gameEntry.game} finding confirmation input`
      )
    );
    if (
      input.input_sha256 !== gameEntry.input_sha256 ||
      !isDeepStrictEqual(
        input.candidates.map((candidate) => candidate.finding_id),
        gameEntry.finding_ids
      ) ||
      !isDeepStrictEqual(input, expectedInput)
    ) {
      throw new Error(
        `${gameEntry.game} finding confirmation input does not match its trusted plan`
      );
    }
    const outputText = await readTextFile(
      path.join(
        outputDir,
        `upstream-review-confirm-agent-${gameEntry.game}.json`
      ),
      `${gameEntry.game} Codex finding confirmation output`
    );
    const decisions = parseFindingConfirmationOutput(outputText, input);
    for (const decision of decisions) {
      if (decisionsById.has(decision.finding_id)) {
        throw new Error(`Duplicate confirmation for ${decision.finding_id}`);
      }
      decisionsById.set(decision.finding_id, decision);
    }
  }
  if (
    decisionsById.size !== plan.candidates.length ||
    plan.candidates.some(
      (candidate) => !decisionsById.has(candidate.finding_id)
    )
  ) {
    throw new Error("Confirmations must cover every candidate exactly once");
  }

  const confirmed = [];
  const rejected = [];
  const deferred = [];
  for (const candidate of plan.candidates) {
    const decision = decisionsById.get(candidate.finding_id);
    const auditEntry = {
      finding_id: candidate.finding_id,
      finding_key: candidate.finding_key,
      finding: candidate.finding,
      decision,
    };
    if (
      decision.verdict === "confirmed" &&
      decision.confidence !== "low" &&
      candidate.finding.confidence !== "low"
    ) {
      confirmed.push(candidate.finding);
    } else if (
      decision.verdict === "rejected" &&
      decision.confidence !== "low"
    ) {
      rejected.push(auditEntry);
    } else {
      deferred.push(auditEntry);
    }
  }
  const report = {
    ...plan.draft_report,
    finalized_at: new Date().toISOString(),
    review: {
      ...plan.draft_report.review,
      summary: summarizeFilteredReview(
        plan.draft_report.review.raw_summary,
        confirmed.length,
        plan.draft_report.review.suppressed_findings.length
      ),
      findings: confirmed,
      initial_findings: plan.candidates.map((candidate) => candidate.finding),
      confirmation: {
        plan_sha256: plan.plan_sha256,
        candidate_count: plan.candidates.length,
        confirmed_count: confirmed.length,
        rejected_count: rejected.length,
        deferred_count: deferred.length,
        decisions: plan.candidates.map((candidate) => ({
          finding_id: candidate.finding_id,
          finding_key: candidate.finding_key,
          ...decisionsById.get(candidate.finding_id),
        })),
      },
      rejected_findings: rejected,
      deferred_findings: deferred,
    },
  };
  const issue = await syncIssue(report).catch((error) => ({
    action: "failed",
    error: getErrorMessage(error),
  }));
  report.issue = issue;
  await writeReport(report, reportPath);
  console.log(JSON.stringify(report, null, 2));
  if (issue.action === "failed") {
    throw new Error(issue.error);
  }
  return report;
}

function stripEvidenceRuntimeRefs(item) {
  if (!isRecord(item)) return item;
  const { review_ref: _reviewRef, identity_ref: _identityRef, ...rest } = item;
  return rest;
}

function validateRemediationVerificationInput(input) {
  if (
    !isRecord(input) ||
    input.schema_version !== 1 ||
    input.mode !== "verify_remediation" ||
    !/^[a-f0-9]{40}$/.test(input.base_sha) ||
    !/^[a-f0-9]{40}$/.test(input.head_sha) ||
    input.base_sha === input.head_sha ||
    !/^[a-f0-9]{64}$/.test(input.finding_fingerprint) ||
    !/^[a-f0-9]{64}$/.test(input.remediation_cycle) ||
    !/^[a-f0-9]{64}$/.test(input.patch_sha256) ||
    !/^[a-f0-9]{64}$/.test(input.fix_input_sha256) ||
    !/^[a-f0-9]{64}$/.test(input.fix_manifest_sha256) ||
    !Array.isArray(input.findings) ||
    input.findings.length === 0 ||
    input.findings.length > MAX_AGENT_FINDINGS ||
    !Array.isArray(input.evidence) ||
    input.evidence.length !== input.findings.length ||
    !Array.isArray(input.patched_api_snapshots)
  ) {
    throw new Error("Invalid remediation verification input");
  }
  assertExactObjectFields(
    input,
    [
      "schema_version",
      "mode",
      "base_sha",
      "head_sha",
      "finding_fingerprint",
      "remediation_cycle",
      "patch_sha256",
      "fix_input_sha256",
      "fix_manifest_sha256",
      "findings",
      "evidence",
      "patched_api_snapshots",
      "input_sha256",
    ],
    "Remediation verification input"
  );
  const context = {
    schema_version: input.schema_version,
    mode: input.mode,
    base_sha: input.base_sha,
    head_sha: input.head_sha,
    finding_fingerprint: input.finding_fingerprint,
    remediation_cycle: input.remediation_cycle,
    patch_sha256: input.patch_sha256,
    fix_input_sha256: input.fix_input_sha256,
    fix_manifest_sha256: input.fix_manifest_sha256,
    findings: input.findings,
    evidence: input.evidence,
    patched_api_snapshots: input.patched_api_snapshots,
  };
  if (input.input_sha256 !== sha256(JSON.stringify(context))) {
    throw new Error("Remediation verification input SHA-256 mismatch");
  }
  if (getFindingFingerprint(input.findings) !== input.finding_fingerprint) {
    throw new Error(
      "Remediation verification findings do not match their fingerprint"
    );
  }
  const findingIds = new Set();
  const expectedSnapshotGames = DEFAULT_GAMES.filter((game) =>
    input.findings.some((finding) => finding.game === game)
  );
  if (
    input.patched_api_snapshots.length !== expectedSnapshotGames.length
  ) {
    throw new Error("Invalid remediation patched API snapshots");
  }
  for (const [index, snapshot] of input.patched_api_snapshots.entries()) {
    const expectedGame = expectedSnapshotGames[index];
    if (!isRecord(snapshot)) {
      throw new Error(
        `Invalid remediation patched API snapshot at index ${index}`
      );
    }
    assertExactObjectFields(
      snapshot,
      ["game", "status", "api_event_count", "api_events"],
      `Remediation patched API snapshot at index ${index}`
    );
    if (
      snapshot.game !== expectedGame ||
      !["complete", "truncated"].includes(snapshot.status) ||
      !Number.isInteger(snapshot.api_event_count) ||
      snapshot.api_event_count < 0 ||
      !Array.isArray(snapshot.api_events) ||
      snapshot.api_events.length > 60 ||
      snapshot.api_events.length > snapshot.api_event_count ||
      (
        snapshot.status === "complete" &&
        snapshot.api_events.length !== snapshot.api_event_count
      ) ||
      (
        snapshot.status === "truncated" &&
        snapshot.api_events.length >= snapshot.api_event_count
      ) ||
      snapshot.api_events.some(
        (item) =>
          !isRecord(item) ||
          typeof item.review_ref !== "string" ||
          typeof item.identity_ref !== "string" ||
          !new RegExp(
            `^api:${expectedGame}:[a-f0-9]{32}$`
          ).test(item.review_ref) ||
          !new RegExp(
            `^api:${expectedGame}:[a-f0-9]{32}$`
          ).test(item.identity_ref)
      ) ||
      new Set(
        snapshot.api_events.map((item) => item.review_ref)
      ).size !== snapshot.api_events.length
    ) {
      throw new Error(
        `Invalid remediation patched API snapshot at index ${index}`
      );
    }
  }
  for (const [index, finding] of input.findings.entries()) {
    if (
      !isRecord(finding) ||
      finding.finding_id !==
        `finding-${String(index + 1).padStart(3, "0")}` ||
      findingIds.has(finding.finding_id)
    ) {
      throw new Error(
        `Invalid remediation verification finding at index ${index}`
      );
    }
    findingIds.add(finding.finding_id);
    const evidence = input.evidence[index];
    if (
      !isRecord(evidence) ||
      evidence.finding_id !== finding.finding_id ||
      evidence.game !== finding.game ||
      !Array.isArray(evidence.raw_before) ||
      !Array.isArray(evidence.raw_current) ||
      !Array.isArray(evidence.api_before) ||
      !Array.isArray(evidence.api_patched) ||
      !["unchanged", "drifted", "not_applicable"].includes(
        evidence.raw_snapshot_status
      )
    ) {
      throw new Error(
        `Invalid remediation verification evidence at index ${index}`
      );
    }
  }
  return input;
}

function getRemediationFixArtifactDigests(fixInput, manifest) {
  return {
    fix_input_sha256: sha256(JSON.stringify(fixInput)),
    fix_manifest_sha256: sha256(JSON.stringify(manifest)),
  };
}

function validateRemediationVerificationBinding(
  rawInput,
  rawFixInput,
  rawManifest,
  expectedHeadSha = ""
) {
  const input = validateRemediationVerificationInput(rawInput);
  const fixInput = validateAgenticFixInput(rawFixInput);
  if (fixInput.schema_version !== 3) {
    throw new Error("Runtime remediation verification requires fix input v3");
  }
  if (!isRecord(rawManifest)) {
    throw new Error("Invalid remediation verification fix manifest");
  }
  const digests = getRemediationFixArtifactDigests(fixInput, rawManifest);
  if (
    input.base_sha !== rawManifest.base_sha ||
    input.finding_fingerprint !== fixInput.finding_fingerprint ||
    input.remediation_cycle !== fixInput.source_report.remediation_cycle ||
    input.patch_sha256 !== rawManifest.patch_sha256 ||
    input.fix_input_sha256 !== digests.fix_input_sha256 ||
    input.fix_manifest_sha256 !== digests.fix_manifest_sha256 ||
    !isDeepStrictEqual(input.findings, fixInput.findings)
  ) {
    throw new Error(
      "Remediation verification input is not bound to the trusted fix artifact"
    );
  }
  const sourceEvidenceByGame = new Map(
    fixInput.evidence.map((entry) => [entry.game, entry])
  );
  const patchedApiSnapshotByGame = new Map(
    input.patched_api_snapshots.map((entry) => [entry.game, entry])
  );
  for (const [index, finding] of fixInput.findings.entries()) {
    const source = sourceEvidenceByGame.get(finding.game);
    const evidence = input.evidence[index];
    const rawRefs = new Set(finding.raw_refs ?? []);
    const apiRefs = new Set(finding.api_refs ?? []);
    const expectedRawBefore = source?.matching_raw_notices.filter((item) =>
      rawRefs.has(item.review_ref)
    ) ?? [];
    const expectedApiBefore = source?.matching_api_events.filter((item) =>
      apiRefs.has(item.review_ref)
    ) ?? [];
    const patchedApiRefs = new Set(
      patchedApiSnapshotByGame
        .get(finding.game)
        ?.api_events.map((item) => item.review_ref) ?? []
    );
    const expectedRawIdentities = new Set(
      expectedRawBefore.map((item) => item.identity_ref)
    );
    const rawCurrentHasUnexpectedSubject = evidence.raw_current.some(
      (item) => !expectedRawIdentities.has(item?.identity_ref)
    );
    let expectedRawSnapshotStatus = "not_applicable";
    if (expectedRawBefore.length > 0) {
      const currentByIdentity = new Map();
      for (const item of evidence.raw_current) {
        const list = currentByIdentity.get(item.identity_ref) ?? [];
        list.push(item);
        currentByIdentity.set(item.identity_ref, list);
      }
      const everyAnchorUnchanged = expectedRawBefore.every((beforeItem) => {
        const matches = currentByIdentity.get(beforeItem.identity_ref) ?? [];
        return (
          matches.length === 1 &&
          JSON.stringify(stripEvidenceRuntimeRefs(matches[0])) ===
            JSON.stringify(stripEvidenceRuntimeRefs(beforeItem))
        );
      });
      expectedRawSnapshotStatus =
        everyAnchorUnchanged && !rawCurrentHasUnexpectedSubject
          ? "unchanged"
          : "drifted";
    }
    if (
      evidence.finding_id !== finding.finding_id ||
      evidence.game !== finding.game ||
      evidence.notes !== getDatasetNotes(finding.game) ||
      !isDeepStrictEqual(evidence.raw_before, expectedRawBefore) ||
      !isDeepStrictEqual(evidence.api_before, expectedApiBefore) ||
      evidence.api_patched.some(
        (item) => !patchedApiRefs.has(item?.review_ref)
      ) ||
      evidence.raw_snapshot_status !== expectedRawSnapshotStatus
    ) {
      throw new Error(
        `Remediation verification evidence is not bound to ${finding.finding_id}`
      );
    }
  }
  if (
    expectedHeadSha &&
    (!/^[a-f0-9]{40}$/.test(expectedHeadSha) ||
      input.head_sha !== expectedHeadSha)
  ) {
    throw new Error(
      "Remediation verification input does not match the approved head"
    );
  }
  return input;
}

async function readAndValidateRemediationFixArtifact(options = {}) {
  return readAndValidateFixArtifact({
    inputPath: options.fixInputPath,
    manifestPath: options.fixManifestPath,
    patchPath: options.fixPatchPath,
    expectedBaseSha: options.expectedBaseSha,
  });
}

function buildRemediationVerificationInput(
  fixInput,
  manifest,
  headSha,
  currentDatasets
) {
  const currentByGame = new Map(
    currentDatasets.map((dataset) => [dataset.game, dataset])
  );
  const originalEvidenceByGame = new Map(
    fixInput.evidence.map((entry) => [entry.game, entry])
  );
  const patchedApiSnapshots = fixInput.target_games.map((game) => {
    const current = currentByGame.get(game);
    if (!current) {
      throw new Error(
        `Missing remediation verification API snapshot for ${game}`
      );
    }
    return {
      game,
      status:
        current.api_event_count === current.api_events.length
          ? "complete"
          : "truncated",
      api_event_count: current.api_event_count,
      api_events: current.api_events,
    };
  });
  const evidence = fixInput.findings.map((finding) => {
    const original = originalEvidenceByGame.get(finding.game);
    const current = currentByGame.get(finding.game);
    if (!original || !current) {
      throw new Error(
        `Missing remediation verification evidence for ${finding.game}`
      );
    }
    const rawRefs = new Set(finding.raw_refs ?? []);
    const apiRefs = new Set(finding.api_refs ?? []);
    const rawBefore = original.matching_raw_notices.filter((item) =>
      rawRefs.has(item.review_ref)
    );
    const apiBefore = original.matching_api_events.filter((item) =>
      apiRefs.has(item.review_ref)
    );
    const currentRawByIdentity = new Map();
    for (const item of current.raw_notices) {
      const list = currentRawByIdentity.get(item.identity_ref) ?? [];
      list.push(item);
      currentRawByIdentity.set(item.identity_ref, list);
    }
    const rawCurrent = rawBefore.flatMap(
      (item) => currentRawByIdentity.get(item.identity_ref) ?? []
    );
    let rawSnapshotStatus = "not_applicable";
    if (rawBefore.length > 0) {
      const everyAnchorUnchanged = rawBefore.every((beforeItem) => {
        const matches = currentRawByIdentity.get(beforeItem.identity_ref) ?? [];
        return (
          matches.length === 1 &&
          JSON.stringify(stripEvidenceRuntimeRefs(matches[0])) ===
            JSON.stringify(stripEvidenceRuntimeRefs(beforeItem))
        );
      });
      rawSnapshotStatus = everyAnchorUnchanged ? "unchanged" : "drifted";
    }
    const apiIdentityRefs = new Set(
      apiBefore.map((item) => item.identity_ref).filter(Boolean)
    );
    const apiTitles = [
      finding.api_title,
      finding.raw_title,
      finding.title,
      ...apiBefore.flatMap(getEvidenceTitles),
      ...rawBefore.flatMap(getEvidenceTitles),
    ].filter(Boolean);
    const apiPatched = current.api_events
      .filter(
        (item) =>
          apiIdentityRefs.has(item.identity_ref) ||
          getEvidenceTitles(item).some((itemTitle) =>
            apiTitles.some((title) =>
              evidenceTitleMatches(itemTitle, normalizeWhitespace(title))
            )
          )
      )
      .slice(0, MAX_FIX_EVIDENCE_ITEMS);
    return {
      finding_id: finding.finding_id,
      game: finding.game,
      notes: current.notes,
      raw_snapshot_status: rawSnapshotStatus,
      raw_before: rawBefore,
      raw_current: rawCurrent,
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
    ...getRemediationFixArtifactDigests(fixInput, manifest),
    findings: fixInput.findings,
    evidence,
    patched_api_snapshots: patchedApiSnapshots,
  };
  return {
    ...context,
    input_sha256: sha256(JSON.stringify(context)),
  };
}

async function prepareRemediationVerification(options = {}) {
  const cwd = path.resolve(
    options.cwd ??
      process.env.GITHUB_WORKSPACE?.trim() ??
      process.cwd()
  );
  const apiBaseUrl = trimTrailingSlash(
    options.apiBaseUrl ??
      process.env.UPSTREAM_REVIEW_API_BASE_URL?.trim() ??
      DEFAULT_API_BASE_URL
  );
  const outputPath =
    options.outputPath ??
    process.env.UPSTREAM_REVIEW_REMEDIATION_VERIFY_INPUT_PATH?.trim();
  const expectedHeadSha = String(
    options.headSha ??
      process.env.UPSTREAM_REVIEW_HEAD_SHA ??
      ""
  ).trim();
  const { fixInput, manifest } = await readAndValidateFixArtifact(options);
  if (fixInput.schema_version !== 3) {
    throw new Error("Runtime remediation verification requires fix input v3");
  }
  const [headResult, treeResult, commitResult] = await Promise.all([
    runGit(["rev-parse", "HEAD"], { cwd }),
    runGit(["rev-parse", "HEAD^{tree}"], { cwd }),
    runGit(["rev-list", "--parents", "-n", "1", "HEAD"], { cwd }),
  ]);
  const checkoutHead = String(headResult.stdout).trim();
  const checkoutTree = String(treeResult.stdout).trim();
  const commitParts = String(commitResult.stdout).trim().split(/\s+/);
  if (
    checkoutHead !== expectedHeadSha ||
    checkoutTree !== manifest.result_tree ||
    commitParts.length !== 2 ||
    commitParts[0] !== expectedHeadSha ||
    commitParts[1] !== manifest.base_sha
  ) {
    throw new Error(
      "Remediation verification checkout does not match the exact verified head"
    );
  }
  const currentDatasets = await Promise.all(
    fixInput.target_games.map((game) =>
      withRetry(`remediation verification collection for ${game}`, async () => {
        const [rawNotices, apiEvents] = await Promise.all([
          fetchRawNotices(game),
          fetchApiEvents(apiBaseUrl, game),
        ]);
        return buildGameDataset(game, rawNotices, apiEvents, 60);
      })
    )
  );
  const input = buildRemediationVerificationInput(
    fixInput,
    manifest,
    expectedHeadSha,
    currentDatasets
  );
  validateRemediationVerificationBinding(
    input,
    fixInput,
    manifest,
    expectedHeadSha
  );
  await writeReport(input, outputPath, false);
  await appendGitHubOutputs(
    {
      verification_input_sha256: input.input_sha256,
      raw_snapshot_status: input.evidence.some(
        (entry) => entry.raw_snapshot_status === "drifted"
      )
        ? "drifted"
        : "unchanged",
    },
    options.githubOutputPath
  );
  console.log(
    JSON.stringify({
      mode: input.mode,
      head_sha: input.head_sha,
      finding_count: input.findings.length,
      input_sha256: input.input_sha256,
    })
  );
  return input;
}

async function validateRemediationVerificationArtifactInput(options = {}) {
  const inputPath =
    options.verificationInputPath ??
    process.env.UPSTREAM_REVIEW_REMEDIATION_VERIFY_INPUT_PATH?.trim();
  const expectedHeadSha = String(
    options.headSha ??
      process.env.UPSTREAM_REVIEW_HEAD_SHA ??
      ""
  ).trim();
  const [inputText, artifact] = await Promise.all([
    readTextFile(inputPath, "remediation verification input"),
    readAndValidateRemediationFixArtifact(options),
  ]);
  const input = validateRemediationVerificationBinding(
    parseJsonDocument(inputText, "remediation verification input"),
    artifact.fixInput,
    artifact.manifest,
    expectedHeadSha
  );
  await appendGitHubOutputs(
    {
      verified_head_sha: input.head_sha,
      verification_input_sha256: input.input_sha256,
      patch_sha256: input.patch_sha256,
    },
    options.githubOutputPath
  );
  console.log(
    JSON.stringify({
      mode: "remediation_verification_input",
      head_sha: input.head_sha,
      finding_count: input.findings.length,
      input_sha256: input.input_sha256,
      patch_sha256: input.patch_sha256,
    })
  );
  return { input, ...artifact };
}

function parseRemediationVerificationOutput(text, rawInput) {
  const input = validateRemediationVerificationInput(rawInput);
  const parsed = parseJsonDocument(
    text,
    "Codex remediation verification output"
  );
  assertExactObjectFields(
    parsed,
    ["complete", "errors", "input_sha256", "summary", "outcomes"],
    "Codex remediation verification output"
  );
  if (
    parsed.complete !== true ||
    !Array.isArray(parsed.errors) ||
    parsed.errors.length > 0 ||
    parsed.errors.some((error) => typeof error !== "string") ||
    parsed.input_sha256 !== input.input_sha256 ||
    typeof parsed.summary !== "string" ||
    !normalizeWhitespace(parsed.summary) ||
    !Array.isArray(parsed.outcomes) ||
    parsed.outcomes.length !== input.findings.length
  ) {
    throw new Error("Codex remediation verification output is incomplete");
  }
  const outcomes = parsed.outcomes.map((outcome, index) => {
    assertExactObjectFields(
      outcome,
      ["finding_id", "status", "confidence", "reason"],
      `Codex remediation verification outcome at index ${index}`
    );
    const expected = input.findings[index];
    if (
      outcome.finding_id !== expected.finding_id ||
      !["resolved", "unresolved", "indeterminate"].includes(outcome.status) ||
      !["high", "medium", "low"].includes(outcome.confidence) ||
      typeof outcome.reason !== "string" ||
      !normalizeWhitespace(outcome.reason)
    ) {
      throw new Error(
        `Invalid Codex remediation verification outcome at index ${index}`
      );
    }
    const evidence = input.evidence[index];
    const patchedApiSnapshot = input.patched_api_snapshots.find(
      (snapshot) => snapshot.game === expected.game
    );
    if (
      evidence.raw_snapshot_status === "drifted" &&
      outcome.status !== "indeterminate"
    ) {
      throw new Error(
        `Drifted raw evidence must be indeterminate for ${outcome.finding_id}`
      );
    }
    if (
      outcome.status === "resolved" &&
      evidence.raw_before.length > 0 &&
      evidence.raw_snapshot_status !== "unchanged"
    ) {
      throw new Error(
        `Resolved raw-backed finding lacks an unchanged snapshot for ${outcome.finding_id}`
      );
    }
    if (
      outcome.status === "resolved" &&
      ["missing_event", "wrong_time_window"].includes(expected.kind) &&
      evidence.api_patched.length === 0
    ) {
      throw new Error(
        `Resolved ${expected.kind} lacks patched API evidence for ${outcome.finding_id}`
      );
    }
    if (
      outcome.status === "resolved" &&
      (
        ["non_event_included", "duplicate_event"].includes(expected.kind) ||
        (
          evidence.raw_before.length === 0 &&
          evidence.api_before.length > 0
        )
      ) &&
      patchedApiSnapshot?.status !== "complete"
    ) {
      throw new Error(
        `Resolved API-only finding lacks a complete patched API snapshot for ${outcome.finding_id}`
      );
    }
    return {
      finding_id: outcome.finding_id,
      status: outcome.status,
      confidence: outcome.confidence,
      reason: truncateText(
        normalizeWhitespace(outcome.reason),
        MAX_AGENT_REASON_LENGTH
      ),
    };
  });
  return {
    schema_version: 1,
    mode: "remediation_verification_result",
    input_sha256: input.input_sha256,
    base_sha: input.base_sha,
    head_sha: input.head_sha,
    finding_fingerprint: input.finding_fingerprint,
    remediation_cycle: input.remediation_cycle,
    patch_sha256: input.patch_sha256,
    summary: truncateText(
      normalizeWhitespace(parsed.summary),
      MAX_AGENT_SUMMARY_LENGTH
    ),
    status: outcomes.every(
      (outcome) =>
        outcome.status === "resolved" && outcome.confidence !== "low"
    )
      ? "resolved"
      : outcomes.some((outcome) => outcome.status === "unresolved")
        ? "unresolved"
        : "indeterminate",
    outcomes,
  };
}

async function finalizeRemediationVerification(options = {}) {
  const inputPath =
    options.inputPath ??
    process.env.UPSTREAM_REVIEW_REMEDIATION_VERIFY_INPUT_PATH?.trim();
  const agentOutputPath =
    options.agentOutputPath ??
    process.env.UPSTREAM_REVIEW_REMEDIATION_VERIFY_AGENT_OUTPUT_PATH?.trim();
  const resultPath =
    options.resultPath ??
    process.env.UPSTREAM_REVIEW_REMEDIATION_VERIFY_RESULT_PATH?.trim();
  const expectedHeadSha = String(
    options.headSha ??
      process.env.UPSTREAM_REVIEW_HEAD_SHA ??
      ""
  ).trim();
  const [inputText, outputText, artifact] = await Promise.all([
    readTextFile(inputPath, "remediation verification input"),
    readTextFile(agentOutputPath, "Codex remediation verification output"),
    readAndValidateRemediationFixArtifact(options),
  ]);
  const input = validateRemediationVerificationBinding(
    parseJsonDocument(inputText, "remediation verification input"),
    artifact.fixInput,
    artifact.manifest,
    expectedHeadSha
  );
  const result = parseRemediationVerificationOutput(outputText, input);
  const resultText = `${JSON.stringify(result)}\n`;
  await writeTextFile(resultPath, resultText);
  await appendGitHubOutputs(
    {
      verification_status: result.status,
      verified_head_sha: result.head_sha,
      verification_input_sha256: result.input_sha256,
      verification_result_sha256: sha256(Buffer.from(resultText, "utf8")),
    },
    options.githubOutputPath
  );
  console.log(
    JSON.stringify({
      mode: result.mode,
      status: result.status,
      head_sha: result.head_sha,
      finding_count: result.outcomes.length,
    })
  );
  if (result.status !== "resolved") {
    throw new Error(
      `Remediation verification did not resolve every finding: ${result.status}`
    );
  }
  return result;
}

async function finalizeAgenticReview() {
  const inputPath = process.env.UPSTREAM_REVIEW_INPUT_PATH?.trim();
  const agentOutputDir = process.env.UPSTREAM_REVIEW_AGENT_OUTPUT_DIR?.trim();
  const agentOutputPath = process.env.UPSTREAM_REVIEW_AGENT_OUTPUT_PATH?.trim();
  const reportPath = process.env.UPSTREAM_REVIEW_REPORT_PATH?.trim() || "";

  const [inputText, agentGameReviews] = await Promise.all([
    readTextFile(inputPath, "collected review input"),
    readAgentGameReviews(agentOutputDir, agentOutputPath),
  ]);

  let collectedInput;
  try {
    collectedInput = JSON.parse(inputText);
  } catch (error) {
    throw new Error(`Failed to parse collected review input: ${getErrorMessage(error)}`);
  }

  const input = validateCollectedReviewInput(collectedInput);
  if (input.schema_version === 3) {
    throw new Error(
      "Collected input schema v3 requires --prepare-confirmation and --finalize-confirmation"
    );
  }
  const agentFindings = agentGameReviews.flatMap((review) => review.findings);
  if (agentFindings.length > MAX_AGENT_FINDINGS) {
    throw new Error(
      `Invalid combined agent review: ${agentFindings.length} findings exceeds the ${MAX_AGENT_FINDINGS} limit`
    );
  }
  const agentSummary = truncateText(
    agentGameReviews
      .map(
        (review) =>
          `${review.game}: ${review.summary || "No clear findings."}`
      )
      .join(" "),
    MAX_AGENT_SUMMARY_LENGTH
  );
  const suppressionsPath =
    process.env.UPSTREAM_REVIEW_SUPPRESSIONS_PATH?.trim() ||
    input.suppressions?.path ||
    DEFAULT_SUPPRESSIONS_PATH;
  const suppressions = await loadSuppressions(suppressionsPath);
  const { filteredFindings, suppressedFindings } = applySuppressions(
    agentFindings,
    suppressions
  );
  const modelLabel = "Codex via Responses API";
  const gameReviews = agentGameReviews.map((review) => {
    return {
      game: review.game,
      model: modelLabel,
      raw_summary: review.summary,
      raw_finding_count: review.findings.length,
    };
  });
  const baseSha = (
    process.env.UPSTREAM_REVIEW_BASE_SHA ??
    process.env.GITHUB_SHA ??
    ""
  ).trim();
  if (
    filteredFindings.length > 0 &&
    !/^[a-f0-9]{40}$/.test(baseSha)
  ) {
    throw new Error("Missing or invalid remediation base SHA");
  }

  const report = {
    schema_version: 2,
    mode: "agentic_review",
    generated_at: input.generated_at,
    finalized_at: new Date().toISOString(),
    base_sha: baseSha,
    api_base_url: input.api_base_url,
    datasets: input.datasets,
    review_datasets: input.review_datasets,
    suppressions: {
      ...input.suppressions,
      path: suppressionsPath,
      count: suppressions.length,
    },
    review: {
      engine: "codex",
      transport: "responses",
      model: modelLabel,
      raw_summary: agentSummary,
      game_reviews: gameReviews,
      summary: summarizeFilteredReview(
        agentSummary,
        filteredFindings.length,
        suppressedFindings.length
      ),
      findings: filteredFindings,
      suppressed_findings: suppressedFindings,
    },
  };

  const issue = await syncIssue(report).catch((error) => ({
    action: "failed",
    error: getErrorMessage(error),
  }));
  report.issue = issue;

  await writeReport(report, reportPath);
  console.log(JSON.stringify(report, null, 2));

  if (issue.action === "failed") {
    throw new Error(issue.error);
  }
}

async function collectUpstreamReview(options = {}) {
  const apiBaseUrl = trimTrailingSlash(
    String(
      options.apiBaseUrl ??
        process.env.UPSTREAM_REVIEW_API_BASE_URL ??
        DEFAULT_API_BASE_URL
    ).trim() || DEFAULT_API_BASE_URL
  );
  const suppressionsPath =
    String(
      options.suppressionsPath ??
        process.env.UPSTREAM_REVIEW_SUPPRESSIONS_PATH ??
        DEFAULT_SUPPRESSIONS_PATH
    ).trim() || DEFAULT_SUPPRESSIONS_PATH;
  const maxItems =
    options.maxItems ??
    parseMaxItems(process.env.UPSTREAM_REVIEW_MAX_ITEMS, 60);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const retryCount = options.retryCount ?? RETRY_COUNT;
  if (!Number.isInteger(maxItems) || maxItems <= 0) {
    throw new Error("Invalid collection max_items");
  }
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("Invalid collection generated_at");
  }
  if (!Number.isInteger(retryCount) || retryCount < 0) {
    throw new Error("Invalid collection retry count");
  }

  const loadCollectionSuppressions =
    options.loadSuppressions ?? loadSuppressions;
  const collectRawNotices =
    options.fetchRawNotices ?? fetchRawNotices;
  const collectApiEvents =
    options.fetchApiEvents ?? fetchApiEvents;
  const suppressions =
    options.suppressions ??
    (await loadCollectionSuppressions(suppressionsPath));
  if (!Array.isArray(suppressions)) {
    throw new Error("Invalid collection suppressions");
  }

  const settledResults = await Promise.allSettled(
    DEFAULT_GAMES.map(async (game) => {
      let rawNotices;
      try {
        rawNotices = await withRetry(
          `raw upstream collection for ${game}`,
          () => collectRawNotices(game),
          retryCount
        );
      } catch (error) {
        const reasonCode = classifyRawCollectionFailure(error);
        if (!reasonCode) throw error;
        return {
          game,
          unavailable: {
            game,
            reason_code: reasonCode,
          },
        };
      }

      const apiEvents = await withRetry(
        `local API collection for ${game}`,
        () => collectApiEvents(apiBaseUrl, game),
        retryCount
      );
      return { game, rawNotices, apiEvents };
    })
  );
  const failedResult = settledResults.find(
    (result) => result.status === "rejected"
  );
  if (failedResult) throw failedResult.reason;
  const results = settledResults.map((result) => result.value);

  const unavailableGames = results
    .filter((result) => result.unavailable)
    .map((result) => result.unavailable);
  if (unavailableGames.length > 1) {
    throw new Error(
      "Initial collection cannot degrade more than one raw upstream game"
    );
  }
  const availableResults = results.filter(
    (result) => !result.unavailable
  );
  const availableGames = availableResults.map((result) => result.game);
  const collection = {
    policy_version: COLLECTION_POLICY_VERSION,
    status: unavailableGames.length === 0 ? "complete" : "degraded",
    available_games: availableGames,
    unavailable_games: unavailableGames,
  };
  validateCollectionMetadata(collection);

  const datasets = availableResults.map(
    ({ game, rawNotices, apiEvents }) =>
      buildGameDataset(game, rawNotices, apiEvents, maxItems)
  );
  const reviewInputs = availableResults.map(
    ({ game, rawNotices, apiEvents }) => {
      const reviewRawNotices = filterRawNoticesForReviewer(
        game,
        rawNotices,
        suppressions
      );
      const reviewApiEvents = filterApiEventsForReviewer(
        game,
        apiEvents,
        suppressions,
        generatedAt
      );
      return {
        game,
        rawNotices: reviewRawNotices,
        apiEvents: reviewApiEvents,
        excluded_raw_notice_count:
          rawNotices.length - reviewRawNotices.length,
        excluded_api_event_count:
          apiEvents.length - reviewApiEvents.length,
      };
    }
  );
  const reviewDatasets = reviewInputs.map(
    ({ game, rawNotices, apiEvents }) =>
      buildGameDataset(game, rawNotices, apiEvents, maxItems)
  );

  const collectedReport = {
    schema_version: 3,
    mode: "collect_only",
    generated_at: generatedAt,
    api_base_url: apiBaseUrl,
    max_items: maxItems,
    collection,
    datasets,
    review_datasets: reviewDatasets,
    suppressions: {
      path: suppressionsPath,
      count: suppressions.length,
      review_input_exclusions: reviewInputs.map((input) => ({
        game: input.game,
        raw_notices: input.excluded_raw_notice_count,
        api_events: input.excluded_api_event_count,
      })),
    },
  };
  validateCollectedReviewInput(collectedReport);

  const inputPath =
    options.inputPath ??
    (process.env.UPSTREAM_REVIEW_INPUT_PATH?.trim() ||
      process.env.UPSTREAM_REVIEW_REPORT_PATH?.trim() ||
      "");
  await writeReport(collectedReport, inputPath);
  await appendGitHubOutputs(
    {
      collection_status: collection.status,
      review_matrix: JSON.stringify(availableGames),
      reviewable_game_count: availableGames.length,
      unavailable_games: JSON.stringify(
        unavailableGames.map((entry) => entry.game)
      ),
    },
    options.githubOutputPath
  );
  console.log(JSON.stringify(collectedReport, null, 2));
  return collectedReport;
}

async function main() {
  const collectOnly =
    process.argv.includes("--collect-only") ||
    parseBoolean(process.env.UPSTREAM_REVIEW_COLLECT_ONLY, false);
  const finalize =
    process.argv.includes("--finalize") ||
    parseBoolean(process.env.UPSTREAM_REVIEW_FINALIZE, false);
  const prepareConfirmation =
    process.argv.includes("--prepare-confirmation") ||
    parseBoolean(
      process.env.UPSTREAM_REVIEW_PREPARE_CONFIRMATION,
      false
    );
  const finalizeConfirmation =
    process.argv.includes("--finalize-confirmation") ||
    parseBoolean(
      process.env.UPSTREAM_REVIEW_FINALIZE_CONFIRMATION,
      false
    );
  const prepareRemediationVerify =
    process.argv.includes("--prepare-remediation-verification") ||
    parseBoolean(
      process.env.UPSTREAM_REVIEW_PREPARE_REMEDIATION_VERIFICATION,
      false
    );
  const validateRemediationVerifyInput =
    process.argv.includes("--validate-remediation-verification-input") ||
    parseBoolean(
      process.env.UPSTREAM_REVIEW_VALIDATE_REMEDIATION_VERIFICATION_INPUT,
      false
    );
  const finalizeRemediationVerify =
    process.argv.includes("--finalize-remediation-verification") ||
    parseBoolean(
      process.env.UPSTREAM_REVIEW_FINALIZE_REMEDIATION_VERIFICATION,
      false
    );
  const extractGame =
    process.argv.includes("--extract-game") ||
    parseBoolean(process.env.UPSTREAM_REVIEW_EXTRACT_GAME, false);
  const prepareFix =
    process.argv.includes("--prepare-fix") ||
    parseBoolean(process.env.UPSTREAM_REVIEW_PREPARE_FIX, false);
  const finalizeFix =
    process.argv.includes("--finalize-fix") ||
    parseBoolean(process.env.UPSTREAM_REVIEW_FINALIZE_FIX, false);
  const verifyFixArtifact =
    process.argv.includes("--verify-fix-artifact") ||
    parseBoolean(process.env.UPSTREAM_REVIEW_VERIFY_FIX_ARTIFACT, false);
  const verifyFixArtifactAtHead =
    process.argv.includes("--verify-fix-artifact-at-head") ||
    parseBoolean(
      process.env.UPSTREAM_REVIEW_VERIFY_FIX_ARTIFACT_AT_HEAD,
      false
    );
  const renderFixPr =
    process.argv.includes("--render-fix-pr") ||
    parseBoolean(process.env.UPSTREAM_REVIEW_RENDER_FIX_PR, false);
  const preparePrReview =
    process.argv.includes("--prepare-pr-review") ||
    parseBoolean(process.env.UPSTREAM_REVIEW_PREPARE_PR_REVIEW, false);
  const finalizePrReview =
    process.argv.includes("--finalize-pr-review") ||
    parseBoolean(process.env.UPSTREAM_REVIEW_FINALIZE_PR_REVIEW, false);
  const preparePrRework =
    process.argv.includes("--prepare-pr-rework") ||
    parseBoolean(process.env.UPSTREAM_REVIEW_PREPARE_PR_REWORK, false);
  const finalizePrRework =
    process.argv.includes("--finalize-pr-rework") ||
    parseBoolean(process.env.UPSTREAM_REVIEW_FINALIZE_PR_REWORK, false);
  const verifyPrReworkArtifact =
    process.argv.includes("--verify-pr-rework-artifact") ||
    parseBoolean(
      process.env.UPSTREAM_REVIEW_VERIFY_PR_REWORK_ARTIFACT,
      false
    );
  const finalizeRemediation =
    process.argv.includes("--finalize-remediation-issue") ||
    parseBoolean(
      process.env.UPSTREAM_REVIEW_FINALIZE_REMEDIATION_ISSUE,
      false
    );

  if (
    [
      collectOnly,
      finalize,
      prepareConfirmation,
      finalizeConfirmation,
      prepareRemediationVerify,
      validateRemediationVerifyInput,
      finalizeRemediationVerify,
      extractGame,
      prepareFix,
      finalizeFix,
      verifyFixArtifact,
      verifyFixArtifactAtHead,
      renderFixPr,
      preparePrReview,
      finalizePrReview,
      preparePrRework,
      finalizePrRework,
      verifyPrReworkArtifact,
      finalizeRemediation,
    ].filter(Boolean).length > 1
  ) {
    throw new Error("Upstream review command modes are mutually exclusive");
  }
  if (finalize) {
    await finalizeAgenticReview();
    return;
  }
  if (prepareConfirmation) {
    await prepareFindingConfirmation();
    return;
  }
  if (finalizeConfirmation) {
    await finalizeFindingConfirmation();
    return;
  }
  if (prepareRemediationVerify) {
    await prepareRemediationVerification();
    return;
  }
  if (validateRemediationVerifyInput) {
    await validateRemediationVerificationArtifactInput();
    return;
  }
  if (finalizeRemediationVerify) {
    await finalizeRemediationVerification();
    return;
  }
  if (extractGame) {
    await extractGameReviewInput(process.env.UPSTREAM_REVIEW_GAME);
    return;
  }
  if (prepareFix) {
    await prepareAgenticFix();
    return;
  }
  if (finalizeFix) {
    await finalizeAgenticFix();
    return;
  }
  if (verifyFixArtifact) {
    await verifyAgenticFixArtifact();
    return;
  }
  if (verifyFixArtifactAtHead) {
    await verifyAgenticFixArtifactAtHead();
    return;
  }
  if (renderFixPr) {
    await renderAgenticFixPr();
    return;
  }
  if (preparePrReview) {
    await prepareAgenticPrReview();
    return;
  }
  if (finalizePrReview) {
    await finalizeAgenticPrReview();
    return;
  }
  if (preparePrRework) {
    await prepareAgenticPrRework();
    return;
  }
  if (finalizePrRework) {
    await finalizeAgenticPrRework();
    return;
  }
  if (verifyPrReworkArtifact) {
    await verifyAgenticPrReworkArtifact();
    return;
  }
  if (finalizeRemediation) {
    const result = await finalizeRemediationIssue();
    console.log(JSON.stringify(result));
    return;
  }

  await collectUpstreamReview();
}

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}

export {
  UpstreamRequestError,
  buildAgenticFixInput,
  buildAgenticPrReviewInput,
  buildAgenticPrReworkInput,
  buildGameDataset,
  buildRemediationVerificationInput,
  classifyRawCollectionFailure,
  collectUpstreamReview,
  extractGameReviewInput,
  finalizeAgenticFix,
  finalizeAgenticPrReview,
  finalizeAgenticPrRework,
  finalizeAgenticReview,
  finalizeFindingConfirmation,
  finalizeRemediationIssue,
  finalizeRemediationVerification,
  fetchZzzRawNotices,
  getFixBranch,
  getFindingFingerprint,
  getFindingKey,
  parseAgentReview,
  parseFindingConfirmationOutput,
  parseAgentFixOutput,
  parseAgentPrReviewOutput,
  parseAgentPrReworkOutput,
  parseRemediationVerificationOutput,
  parseStarRailRawNotices,
  prepareAgenticFix,
  prepareFindingConfirmation,
  prepareAgenticPrReview,
  prepareAgenticPrRework,
  prepareRemediationVerification,
  renderFixPrBody,
  renderIssueBody,
  renderPrReviewBody,
  renderPrReviewRequest,
  syncIssue,
  validateAgenticFixInput,
  validateAgenticPrReviewInput,
  validateAgenticPrReviewResult,
  validateAgenticPrReworkInput,
  validateCollectedReviewInput,
  validateFindingConfirmationInput,
  validateFindingConfirmationPlan,
  validateRemediationVerificationArtifactInput,
  validateRemediationVerificationBinding,
  validateRemediationVerificationInput,
  validateFixManifest,
  validatePrReworkManifest,
  verifyAgenticFixArtifact,
  verifyAgenticFixArtifactAtHead,
  verifyAgenticPrReworkArtifact,
};
