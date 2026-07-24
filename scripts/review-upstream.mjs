import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
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
  "https://announcement-api.mihoyo.com/common/nap_cn/announcement/api/getActivityList?uid=11111111&game=nap&game_biz=nap_cn&lang=zh-cn&bundle_id=nap_cn&channel_id=1&level=60&platform=pc&region=prod_gf_cn";

const ZZZ_LIST_API =
  "https://announcement-api.mihoyo.com/common/nap_cn/announcement/api/getAnnList?uid=11111111&game=nap&game_biz=nap_cn&lang=zh-cn&bundle_id=nap_cn&channel_id=1&level=60&platform=pc&region=prod_gf_cn";

const ZZZ_CONTENT_API =
  "https://announcement-api.mihoyo.com/common/nap_cn/announcement/api/getAnnContent?uid=11111111&game=nap&game_biz=nap_cn&lang=zh-cn&bundle_id=nap_cn&channel_id=1&level=60&platform=pc&region=prod_gf_cn";

const SNOWBREAK_ANNOUNCE_API =
  "https://cbjq-content.xoyocdn.com/ob202307/webfile/mainland/announce/config/pc_jinshan-pc_jinshan.json";

const ENDFIELD_WEBVIEW_URL =
  "https://ef-webview.hypergryph.com/page/game_bulletin?target=IOS";

const ENDFIELD_AGGREGATE_API =
  "https://game-hub.hypergryph.com/bulletin/v2/aggregate";

const ENDFIELD_CODE_FALLBACK = "endfield_5SD9TN";
const DEFAULT_API_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_ISSUE_TITLE = "Upstream Review Alerts";
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
const MAX_AGENT_FINDINGS = 50;
const MAX_AGENT_FINDINGS_PER_GAME = 8;
const MAX_AGENT_ERROR_LENGTH = 1_000;
const MAX_AGENT_SUMMARY_LENGTH = 2_000;
const MAX_AGENT_TITLE_LENGTH = 500;
const MAX_AGENT_TIME_LENGTH = 100;
const MAX_AGENT_REASON_LENGTH = 1_000;
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
          `${label} failed after ${totalAttempts} attempt(s): ${getErrorMessage(error)}`
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

async function fetchStarRailRawNotices() {
  const contentUrl = process.env.STARRAIL_CONTENT_API_URL?.trim() || STARRAIL_CONTENT_API;
  const [json, contentJson] = await Promise.all([
    requestJson(STARRAIL_LIST_API),
    requestJson(contentUrl).catch(() => null),
  ]);
  const categories = [];
  collectStarRailCategories(json?.data ?? null, categories);
  const items = getStarRailSelectedItems(categories);
  const contentById = new Map();
  collectStarRailContentItems(contentJson?.data ?? null, contentById);

  return items.map((item) => {
    const content = pickStarRailContentItem(contentById, item)?.content ?? "";
    return {
      ann_id: item.ann_id,
      title: normalizeWhitespace(item.title || item.subtitle || ""),
      subtitle: normalizeWhitespace(item.subtitle || ""),
      start_time: String(item.start_time ?? ""),
      end_time: String(item.end_time ?? ""),
      type: item.type,
      type_label: item.type_label,
      content_time_candidates: extractTimeCandidates(content),
      snippet: stripHtml(content).slice(0, 220),
    };
  });
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

async function fetchZzzRawNotices() {
  const activityUrl = process.env.ZZZ_ACTIVITY_API_URL?.trim() || ZZZ_ACTIVITY_API;
  const listUrl = process.env.ZZZ_API_URL?.trim() || ZZZ_LIST_API;
  const contentUrl = process.env.ZZZ_CONTENT_API_URL?.trim() || ZZZ_CONTENT_API;
  const [activityJson, listJson, contentJson] = await Promise.all([
    requestJson(activityUrl),
    requestJson(listUrl).catch(() => null),
    requestJson(contentUrl).catch(() => null),
  ]);

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

function buildGameDataset(game, rawNotices, apiEvents, maxItems) {
  return {
    game,
    game_label: GAME_LABELS[game] ?? game,
    notes: getDatasetNotes(game),
    raw_notice_count: rawNotices.length,
    api_event_count: apiEvents.length,
    raw_notices: rawNotices.slice(0, maxItems),
    api_events: apiEvents.slice(0, maxItems),
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
  };
}

function validateAgentFinding(raw, index) {
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

  return finding;
}

function parseAgentReview(
  text,
  expectedGames = DEFAULT_GAMES,
  maxFindings = MAX_AGENT_FINDINGS
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
    validateAgentFinding(finding, index)
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

function validateCollectedDataset(dataset, index, label, maxItems) {
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
  }

  return game;
}

function validateCollectedReviewInput(input) {
  if (!isRecord(input) || input.mode !== "collect_only") {
    throw new Error("Invalid collected review input: expected mode=collect_only");
  }
  if (input.schema_version !== 2) {
    throw new Error("Invalid collected review input: unsupported schema_version");
  }
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

  const snapshotGames = input.datasets.map((dataset, index) =>
    validateCollectedDataset(dataset, index, "datasets", input.max_items)
  );
  const games = input.review_datasets.map((dataset, index) =>
    validateCollectedDataset(dataset, index, "review_datasets", input.max_items)
  );

  if (new Set(games).size !== games.length) {
    throw new Error("Invalid collected review input: duplicate game datasets");
  }
  const expectedGames = [...DEFAULT_GAMES].sort();
  if (
    games.length !== DEFAULT_GAMES.length ||
    games.slice().sort().some((game, index) => game !== expectedGames[index])
  ) {
    throw new Error("Invalid collected review input: expected all six game datasets");
  }

  if (
    snapshotGames.length !== DEFAULT_GAMES.length ||
    new Set(snapshotGames).size !== DEFAULT_GAMES.length ||
    snapshotGames.slice().sort().some((game, index) => game !== expectedGames[index])
  ) {
    throw new Error("Invalid collected review input: snapshots must cover all six games");
  }

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
  if (
    exclusionGames.length !== DEFAULT_GAMES.length ||
    new Set(exclusionGames).size !== DEFAULT_GAMES.length ||
    exclusionGames.slice().sort().some((game, index) => game !== expectedGames[index])
  ) {
    throw new Error(
      "Invalid collected review input: exclusion metadata must cover all six games"
    );
  }

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
  if (!isRecord(report) || report.mode !== "agentic_review" || report.schema_version !== 2) {
    throw new Error("Invalid agentic review report");
  }
  if (!isRecord(report.review) || !Array.isArray(report.review.findings)) {
    throw new Error("Invalid agentic review report: missing findings");
  }
  if (report.review.findings.length > MAX_AGENT_FINDINGS) {
    throw new Error(
      `Invalid agentic review report: ${report.review.findings.length} findings exceeds the ${MAX_AGENT_FINDINGS} limit`
    );
  }

  const findings = report.review.findings.map((finding, index) =>
    validateAgentFinding(finding, index)
  );
  const reviewDatasets = report.review_datasets;
  if (!Array.isArray(reviewDatasets)) {
    throw new Error("Invalid agentic review report: missing review_datasets");
  }

  const datasetGames = reviewDatasets.map((dataset, index) => {
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
        `Invalid agentic review report: review_datasets[${index}] is invalid`
      );
    }
    return dataset.game;
  });

  if (
    datasetGames.length !== DEFAULT_GAMES.length ||
    new Set(datasetGames).size !== DEFAULT_GAMES.length ||
    datasetGames
      .slice()
      .sort()
      .some((game, index) => game !== [...DEFAULT_GAMES].sort()[index])
  ) {
    throw new Error(
      "Invalid agentic review report: review_datasets must cover all six games"
    );
  }

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

function getFindingFingerprint(findings) {
  const canonicalFindings = findings
    .map((finding) => ({
      game: finding.game,
      kind: finding.kind,
      raw_title: normalizeWhitespace(finding.raw_title),
      api_title: normalizeWhitespace(finding.api_title),
      start_time: normalizeWhitespace(finding.start_time),
      end_time: normalizeWhitespace(finding.end_time),
    }))
    .sort((a, b) => compareCodePoints(JSON.stringify(a), JSON.stringify(b)));
  return sha256(JSON.stringify(canonicalFindings));
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
  const findings = [...report.review.findings]
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
    return {
      game,
      notes: dataset.notes,
      matching_raw_notices: selectFindingEvidence(dataset.raw_notices, rawTitles),
      matching_api_events: selectFindingEvidence(dataset.api_events, apiTitles),
    };
  });

  return {
    schema_version: 1,
    mode: "agentic_fix",
    source_report: {
      generated_at: normalizeWhitespace(report.generated_at || ""),
      finalized_at: normalizeWhitespace(report.finalized_at || ""),
      issue_url: truncateText(
        normalizeWhitespace(report.issue?.issue_url || ""),
        MAX_AGENT_TITLE_LENGTH
      ),
    },
    finding_fingerprint: getFindingFingerprint(findings),
    target_games: targetGames,
    allowed_files: targetGames.map((game) => GAME_SOURCE_FILES[game]),
    findings,
    evidence,
  };
}

function validateAgenticFixInput(input) {
  if (!isRecord(input) || input.mode !== "agentic_fix" || input.schema_version !== 1) {
    throw new Error("Invalid agentic fix input");
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
    typeof input.source_report.issue_url !== "string" ||
    typeof input.finding_fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.finding_fingerprint)
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

  const expectedAllowedFiles = expectedTargetGames.map(
    (game) => GAME_SOURCE_FILES[game]
  );
  if (
    !Array.isArray(input.allowed_files) ||
    input.allowed_files.length !== expectedAllowedFiles.length ||
    input.allowed_files.some((file, index) => file !== expectedAllowedFiles[index])
  ) {
    throw new Error("Invalid agentic fix input: allowed_files does not match target_games");
  }
  if (!Array.isArray(input.findings) || input.findings.length > MAX_AGENT_FINDINGS) {
    throw new Error("Invalid agentic fix input: findings is invalid");
  }

  const findingIds = new Set();
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
    const validatedFinding = validateAgentFinding(finding, index);
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
    changedFiles.map((file) => gameBySourceFile.get(file))
  );
  if (
    [...fixedGames].some((game) => !changedGames.has(game)) ||
    [...changedGames].some((game) => !fixedGames.has(game))
  ) {
    throw new Error(
      "Codex fixed outcomes and changed game parser files do not match"
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
    schema_version: 2,
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

function renderIssueBody(report) {
  const lines = [
    "# Upstream Review Alerts",
    "",
    `Last run: \`${escapeIssueCode(report.generated_at)}\``,
    `API base: \`${escapeIssueCode(report.api_base_url)}\``,
    `Model: \`${escapeIssueCode(report.review.model)}\``,
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
  const configuredIssueNumberValue = process.env.UPSTREAM_REVIEW_ISSUE_NUMBER?.trim() || "";
  const configuredIssueNumber = Number(configuredIssueNumberValue);
  let existing;

  if (configuredIssueNumberValue) {
    if (!Number.isInteger(configuredIssueNumber) || configuredIssueNumber <= 0) {
      throw new Error(
        `Invalid UPSTREAM_REVIEW_ISSUE_NUMBER: ${configuredIssueNumberValue}`
      );
    }
    existing = await githubRequest(
      `/repos/${owner}/${repo}/issues/${configuredIssueNumber}`
    );
    if (existing?.pull_request) {
      throw new Error(`Configured issue #${configuredIssueNumber} is a pull request`);
    }
    if (existing?.title !== title) {
      throw new Error(
        `Configured issue #${configuredIssueNumber} has unexpected title: ${existing?.title || "(empty)"}`
      );
    }
  } else {
    const issues = await listAllRepositoryIssues(owner, repo);
    existing = ensureArray(issues).find(
      (issue) => !issue?.pull_request && issue?.title === title
    );
  }

  const openExisting = existing?.state === "open" ? existing : null;

  if (report.review.findings.length === 0) {
    if (!openExisting) return { action: "noop" };

    const updated = await githubRequest(`/repos/${owner}/${repo}/issues/${openExisting.number}`, {
      method: "PATCH",
      body: JSON.stringify({
        title,
        body: renderIssueBody(report),
        state: "closed",
        state_reason: "completed",
      }),
    });
    return {
      action: "closed",
      issue_number: updated.number,
      issue_url: updated.html_url,
    };
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
  const fixBranch = hasFindings
    ? `codex/upstream-review-${fixInput.finding_fingerprint.slice(0, 16)}`
    : "";
  await appendGitHubOutputs(
    {
      has_findings: hasFindings,
      finding_count: fixInput.findings.length,
      finding_fingerprint: fixInput.finding_fingerprint,
      fix_branch: fixBranch,
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
    manifest.schema_version !== 1 ||
    manifest.mode !== "agentic_fix_manifest" ||
    typeof manifest.base_sha !== "string" ||
    !/^[a-f0-9]{40}$/.test(manifest.base_sha) ||
    typeof manifest.finding_fingerprint !== "string" ||
    typeof manifest.patch_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.patch_sha256) ||
    !Number.isInteger(manifest.patch_bytes) ||
    manifest.patch_bytes <= 0 ||
    manifest.patch_bytes > MAX_FIX_PATCH_BYTES ||
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
  const { manifest } = await readAndValidateFixArtifact(options);
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
  const fixBranch = `codex/upstream-review-${manifest.finding_fingerprint.slice(0, 16)}`;
  await appendGitHubOutputs(
    {
      fix_branch: fixBranch,
      patch_sha256: manifest.patch_sha256,
      patch_bytes: manifest.patch_bytes,
    },
    options.githubOutputPath
  );
  console.log(
    JSON.stringify({
      mode: manifest.mode,
      base_sha: manifest.base_sha,
      changed_files: manifest.changed_files,
      patch_sha256: manifest.patch_sha256,
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

  const manifest = {
    schema_version: 1,
    mode: "agentic_fix_manifest",
    base_sha: baseSha,
    finding_fingerprint: fixInput.finding_fingerprint,
    finding_ids: fixInput.findings.map((finding) => finding.finding_id),
    target_games: fixInput.target_games,
    changed_files: metadata.changed_files,
    patch_sha256: sha256(patch),
    patch_bytes: patch.length,
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
      "patch_sha256",
      "patch_bytes",
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
    },
    options.githubOutputPath
  );
  console.log(
    JSON.stringify({
      mode: metadata.mode,
      changed_files: metadata.changed_files,
      patch_sha256: manifest.patch_sha256,
      patch_bytes: manifest.patch_bytes,
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
    manifest.changed_files.length === 0
  ) {
    throw new Error("Invalid verified patch context for PR rendering");
  }

  const findingsById = new Map(
    metadata.findings.map((finding) => [finding.finding_id, finding])
  );
  const lines = [
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
    "- `pnpm typecheck`",
    "- `pnpm build`",
    "",
    `Source: [workflow run](https://github.com/${repository}/actions/runs/${runId}) · [Upstream Review Alerts](https://github.com/${repository}/issues/1)`,
    "",
    `Verified patch SHA-256: \`${manifest.patch_sha256}\``,
    "",
    "_This PR is generated as a draft, then marked ready and squash-merged automatically only after an exact-head independent approval._",
    ""
  );
  const body = lines.join("\n");
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
  const { manifest } = await readAndValidateFixArtifact(options);
  const metadataText = await readTextFile(
    metadataPath,
    "agentic fix metadata"
  );
  const metadata = parseJsonDocument(metadataText, "agentic fix metadata");
  const body = renderFixPrBody(metadata, manifest, {
    repository,
    runId,
    patchSha256: manifest.patch_sha256,
  });
  await writeTextFile(outputPath, body);
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
    !/^[a-f0-9]{64}$/.test(findingFingerprint)
  ) {
    throw new Error("Invalid agentic PR review patch or finding digest");
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
    schema_version: 1,
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
      "pull_request",
      "changed_files",
      "context_sha256",
    ],
    "Agentic PR review input"
  );
  if (
    input.schema_version !== 1 ||
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

function getFixBranch(findingFingerprint) {
  return `codex/upstream-review-${findingFingerprint.slice(0, 16)}`;
}

function getAgenticPrReworkContext(input) {
  return {
    round: input.round,
    max_rounds: input.max_rounds,
    base_sha: input.base_sha,
    reviewed_head_sha: input.reviewed_head_sha,
    finding_fingerprint: input.finding_fingerprint,
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

  const expectedFixBranch = getFixBranch(rawContext.finding_fingerprint);
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
    rawContext.allowed_files.length > DEFAULT_GAMES.length ||
    new Set(rawContext.allowed_files).size !== rawContext.allowed_files.length
  ) {
    throw new Error("Invalid agentic PR rework allowed_files");
  }
  const expectedAllowedFiles = DEFAULT_GAMES.filter((game) =>
    rawContext.allowed_files.includes(GAME_SOURCE_FILES[game])
  ).map((game) => GAME_SOURCE_FILES[game]);
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
    schema_version: 1,
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
    input.schema_version !== 1 ||
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

  const expectedFixBranch = getFixBranch(fixInput.finding_fingerprint);
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
  if (
    [...fixedPaths].some((file) => !changedFileSet.has(file)) ||
    [...changedFileSet].some((file) => !fixedPaths.has(file))
  ) {
    throw new Error(
      "Codex PR rework fixed outcomes and changed parser files do not match"
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
  const expectedFixBranch = getFixBranch(fixInput.finding_fingerprint);
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
    manifest.schema_version !== 1 ||
    manifest.mode !== "agentic_pr_rework_manifest" ||
    manifest.round !== input.round ||
    manifest.max_rounds !== input.max_rounds ||
    manifest.base_sha !== input.base_sha ||
    manifest.parent_sha !== input.reviewed_head_sha ||
    manifest.finding_fingerprint !== input.finding_fingerprint ||
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
    typeof manifest.result_tree !== "string" ||
    !/^[a-f0-9]{40}$/.test(manifest.result_tree)
  ) {
    throw new Error("Agentic PR rework manifest has an invalid result tree");
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
  await assertSingleParentSnapshot(
    sources.reviewedHeadSha,
    sources.baseSha,
    previousInspection.result_tree,
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
    schema_version: 1,
    mode: "agentic_fix_manifest",
    base_sha: sources.baseSha,
    finding_fingerprint: sources.fixInput.finding_fingerprint,
    finding_ids: sources.fixInput.findings.map(
      (finding) => finding.finding_id
    ),
    target_games: sources.fixInput.target_games,
    changed_files: cumulativeChangedFiles,
    patch_sha256: sha256(cumulativePatch),
    patch_bytes: cumulativePatch.length,
  };
  validateFixManifest(
    cumulativeManifest,
    sources.fixInput,
    cumulativePatch,
    sources.baseSha
  );
  const reworkManifest = {
    schema_version: 1,
    mode: "agentic_pr_rework_manifest",
    round: sources.round,
    max_rounds: MAX_PR_REWORK_ROUNDS,
    base_sha: sources.baseSha,
    parent_sha: sources.reviewedHeadSha,
    finding_fingerprint: sources.fixInput.finding_fingerprint,
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
  await assertSingleParentSnapshot(
    sources.reviewedHeadSha,
    sources.baseSha,
    previousInspection.result_tree,
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

async function readAgentGameReviews(agentOutputDir, legacyAgentOutputPath) {
  if (agentOutputDir) {
    return await Promise.all(
      DEFAULT_GAMES.map(async (game) => {
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
          MAX_AGENT_FINDINGS_PER_GAME
        );
        return { game, ...review };
      })
    );
  }

  const outputText = await readTextFile(
    legacyAgentOutputPath,
    "Codex review output"
  );
  const review = parseAgentReview(outputText);
  return DEFAULT_GAMES.map((game) => ({
    game,
    summary: review.summary,
    findings: review.findings.filter((finding) => finding.game === game),
  }));
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

  const report = {
    schema_version: 2,
    mode: "agentic_review",
    generated_at: input.generated_at,
    finalized_at: new Date().toISOString(),
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

async function main() {
  const collectOnly =
    process.argv.includes("--collect-only") ||
    parseBoolean(process.env.UPSTREAM_REVIEW_COLLECT_ONLY, false);
  const finalize =
    process.argv.includes("--finalize") ||
    parseBoolean(process.env.UPSTREAM_REVIEW_FINALIZE, false);
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

  if (
    [
      collectOnly,
      finalize,
      extractGame,
      prepareFix,
      finalizeFix,
      verifyFixArtifact,
      renderFixPr,
      preparePrReview,
      finalizePrReview,
      preparePrRework,
      finalizePrRework,
      verifyPrReworkArtifact,
    ].filter(Boolean).length > 1
  ) {
    throw new Error("Upstream review command modes are mutually exclusive");
  }
  if (finalize) {
    await finalizeAgenticReview();
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

  const apiBaseUrl = trimTrailingSlash(
    process.env.UPSTREAM_REVIEW_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL
  );
  const suppressionsPath =
    process.env.UPSTREAM_REVIEW_SUPPRESSIONS_PATH?.trim() || DEFAULT_SUPPRESSIONS_PATH;
  const games = [...DEFAULT_GAMES];
  const maxItems = parseMaxItems(process.env.UPSTREAM_REVIEW_MAX_ITEMS, 60);
  const generatedAt = new Date().toISOString();
  const suppressions = await loadSuppressions(suppressionsPath);

  const collectedDatasets = await Promise.all(
    games.map((game) =>
      withRetry(`dataset collection for ${game}`, async () => {
        const [rawNotices, apiEvents] = await Promise.all([
          fetchRawNotices(game),
          fetchApiEvents(apiBaseUrl, game),
        ]);
        return { game, rawNotices, apiEvents };
      })
    )
  );

  const datasets = collectedDatasets.map(({ game, rawNotices, apiEvents }) =>
    buildGameDataset(game, rawNotices, apiEvents, maxItems)
  );
  const reviewInputs = collectedDatasets.map(({ game, rawNotices, apiEvents }) => {
    const reviewRawNotices = filterRawNoticesForReviewer(game, rawNotices, suppressions);
    const reviewApiEvents = filterApiEventsForReviewer(game, apiEvents, suppressions, generatedAt);
    return {
      game,
      rawNotices: reviewRawNotices,
      apiEvents: reviewApiEvents,
      excluded_raw_notice_count: rawNotices.length - reviewRawNotices.length,
      excluded_api_event_count: apiEvents.length - reviewApiEvents.length,
    };
  });
  const reviewDatasets = reviewInputs.map(({ game, rawNotices, apiEvents }) =>
    buildGameDataset(game, rawNotices, apiEvents, maxItems)
  );

  const collectedReport = {
    schema_version: 2,
    mode: "collect_only",
    generated_at: generatedAt,
    api_base_url: apiBaseUrl,
    max_items: maxItems,
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
  const inputPath =
    process.env.UPSTREAM_REVIEW_INPUT_PATH?.trim() ||
    process.env.UPSTREAM_REVIEW_REPORT_PATH?.trim() ||
    "";
  await writeReport(collectedReport, inputPath);
  console.log(JSON.stringify(collectedReport, null, 2));
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
  prepareAgenticFix,
  prepareAgenticPrReview,
  prepareAgenticPrRework,
  renderFixPrBody,
  renderIssueBody,
  renderPrReviewBody,
  renderPrReviewRequest,
  validateAgenticPrReviewInput,
  validateAgenticPrReviewResult,
  validateAgenticPrReworkInput,
  validateCollectedReviewInput,
  validateFixManifest,
  validatePrReworkManifest,
  verifyAgenticFixArtifact,
  verifyAgenticPrReworkArtifact,
};
