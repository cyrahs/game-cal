import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const GENSHIN_LIST_API =
  "https://hk4e-api.mihoyo.com/common/hk4e_cn/announcement/api/getAnnList?game=hk4e&game_biz=hk4e_cn&lang=zh-cn&bundle_id=hk4e_cn&platform=pc&region=cn_gf01&level=55&uid=100000000";

const STARRAIL_LIST_API =
  "https://hkrpg-api-static.mihoyo.com/common/hkrpg_cn/announcement/api/getAnnList?game=hkrpg&game_biz=hkrpg_cn&lang=zh-cn&bundle_id=hkrpg_cn&platform=pc&region=prod_gf_cn&level=30&uid=11111111";

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
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_MODEL = "gpt-5-mini";
const DEFAULT_ISSUE_TITLE = "Upstream Review Alerts";
const DEFAULT_SUPPRESSIONS_PATH = ".github/upstream-review-suppressions.json";
const DEFAULT_GAMES = ["genshin", "starrail", "ww", "zzz", "snowbreak", "endfield"];
const SUPPORTED_GAMES = new Set(DEFAULT_GAMES);
const GITHUB_API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 30_000;
const MODEL_TIMEOUT_MS = 300_000;
const CHINA_TZ_OFFSET = "+08:00";
const RETRY_COUNT = 3;
const RETRY_BASE_DELAY_MS = 1_000;

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

function getReviewerSuppressedApiEventTitles(game, suppressions) {
  const titles = new Set();
  for (const suppression of suppressions) {
    if (suppression.kind && suppression.kind !== "non_event_included") continue;
    if (suppression.game && suppression.game !== game) continue;
    for (const title of suppression.titles) {
      titles.add(title);
    }
  }
  return titles;
}

function filterApiEventsForReviewer(game, apiEvents, suppressions, generatedAt) {
  const suppressedTitles = getReviewerSuppressedApiEventTitles(game, suppressions);
  const generatedAtMs = Date.parse(generatedAt);

  return apiEvents.filter((event) => {
    const title = normalizeWhitespace(event?.title || "");
    if (title && suppressedTitles.has(title)) {
      return false;
    }

    const endTimeMs = Date.parse(String(event?.end_time ?? ""));
    if (Number.isFinite(generatedAtMs) && Number.isFinite(endTimeMs) && endTimeMs <= generatedAtMs) {
      return false;
    }

    return true;
  });
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
  const base = summary || `${unsuppressedCount} unsuppressed finding(s) detected.`;
  if (suppressedCount === 0) return base;
  if (unsuppressedCount === 0) {
    return `${base} No unsuppressed findings. ${suppressedCount} finding(s) matched suppression rules.`;
  }
  return `${base} ${unsuppressedCount} unsuppressed finding(s) detected. ${suppressedCount} finding(s) matched suppression rules.`;
}

function summarizeGameReviews(gameReviews) {
  if (gameReviews.length === 0) return "No games reviewed.";
  return gameReviews
    .map((review) => {
      const label = GAME_LABELS[review.game] ?? review.game;
      const summary = review.summary || `${review.findings.length} finding(s) detected.`;
      return `${label}: ${summary}`;
    })
    .join(" ");
}

async function reviewGameWithOpenAi(payload) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const openAiBaseUrl = trimTrailingSlash(
    process.env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL
  );
  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
  const reasoningEffort = process.env.OPENAI_REASONING_EFFORT?.trim();
  const dataset = payload.dataset;
  const prompt = {
    current_time: payload.generated_at,
    game: dataset.game,
    game_label: dataset.game_label,
    instructions: [
      "Review the upstream notice snapshots against the current API event output.",
      "This request contains exactly one game dataset. Every Finding.game must match the dataset game.",
      "Only report issues that are likely real. Be conservative.",
      "Focus on: non-event notices incorrectly included, real events incorrectly filtered out, duplicate events, and clearly wrong time windows.",
      "Ignore pure style or wording preferences.",
      "For Endfield, API events may come from version-note extraction, so lack of a standalone raw notice is not enough to flag an issue.",
      "Return JSON only with shape { summary: string, findings: Finding[] }.",
      "Each Finding must include game, severity, confidence, kind, title, raw_title, api_title, start_time, end_time, reason.",
      "Use findings: [] when there is nothing clearly wrong.",
    ],
    dataset,
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
  const findings = ensureArray(parsed?.findings).map((finding) =>
    normalizeFinding(finding, dataset.game)
  );
  return {
    game: dataset.game,
    model,
    summary: normalizeWhitespace(parsed?.summary || ""),
    findings,
    raw_response: content,
  };
}

async function reviewWithOpenAi(payload) {
  const gameReviews = await Promise.all(
    payload.datasets.map((dataset) =>
      withRetry(`LLM review for ${dataset.game}`, () =>
        reviewGameWithOpenAi({
          generated_at: payload.generated_at,
          dataset,
        })
      )
    )
  );

  return {
    model: gameReviews[0]?.model ?? process.env.OPENAI_MODEL?.trim() ?? DEFAULT_OPENAI_MODEL,
    summary: summarizeGameReviews(gameReviews),
    findings: gameReviews.flatMap((review) => review.findings),
    game_reviews: gameReviews,
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
  const reviewDatasets = collectedDatasets.map(({ game, rawNotices, apiEvents }) =>
    buildGameDataset(
      game,
      rawNotices,
      filterApiEventsForReviewer(game, apiEvents, suppressions, generatedAt),
      maxItems
    )
  );

  const review = await reviewWithOpenAi({ generated_at: generatedAt, datasets: reviewDatasets });
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
      game_reviews: review.game_reviews.map((gameReview) => ({
        game: gameReview.game,
        model: gameReview.model,
        raw_summary: gameReview.summary,
        raw_finding_count: gameReview.findings.length,
      })),
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
