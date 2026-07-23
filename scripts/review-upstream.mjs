import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

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

const GAME_LABELS = {
  genshin: "原神",
  starrail: "崩坏：星穹铁道",
  ww: "鸣潮",
  zzz: "绝区零",
  snowbreak: "尘白禁区",
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

  if ([collectOnly, finalize, extractGame].filter(Boolean).length > 1) {
    throw new Error("Collect-only, extract-game, and finalize modes are mutually exclusive");
  }
  if (finalize) {
    await finalizeAgenticReview();
    return;
  }
  if (extractGame) {
    await extractGameReviewInput(process.env.UPSTREAM_REVIEW_GAME);
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
  extractGameReviewInput,
  finalizeAgenticReview,
  parseAgentReview,
  renderIssueBody,
  validateCollectedReviewInput,
};
