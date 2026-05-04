import { fetchJson } from "../lib/fetch.js";
import { toIsoWithSourceOffset, unixSecondsToIsoWithSourceOffset } from "../lib/time.js";
import type { RuntimeEnv } from "../lib/runtimeEnv.js";
import type { CalendarEvent, GameVersionInfo } from "../types.js";
import { classifyGachaEvent, isGachaEventTitle } from "./gacha.js";

type MihoyoAnnItem = {
  ann_id: number;
  title: string;
  subtitle?: string;
  banner?: string;
  content?: string;
  start_time?: string;
  end_time?: string;
  type?: number;
  type_label?: string;
};

type JsonObject = Record<string, unknown>;

type MihoyoAnnCategory = {
  type_id: number;
  type_label: string;
  list: MihoyoAnnItem[];
};

type MihoyoAnnListResponse = {
  retcode: number;
  message: string;
  data?: {
    list?: MihoyoAnnCategory[];
    pic_list?: unknown[];
  };
};

type MihoyoAnnContentItem = {
  ann_id: number;
  title: string;
  subtitle?: string;
  banner?: string;
  content?: string;
  img?: string;
  lang?: string;
  remind_text?: string;
};

type MihoyoAnnContentResponse = {
  retcode: number;
  message: string;
  data?: {
    list?: MihoyoAnnContentItem[];
    pic_list?: unknown[];
  };
};

const STARRAIL_DEFAULT_LIST_API =
  "https://hkrpg-api-static.mihoyo.com/common/hkrpg_cn/announcement/api/getAnnList?game=hkrpg&game_biz=hkrpg_cn&lang=zh-cn&bundle_id=hkrpg_cn&platform=pc&region=prod_gf_cn&level=30&uid=11111111";

const STARRAIL_DEFAULT_CONTENT_API =
  "https://hkrpg-api-static.mihoyo.com/common/hkrpg_cn/announcement/api/getAnnContent?game=hkrpg&game_biz=hkrpg_cn&lang=zh-cn&bundle_id=hkrpg_cn&platform=pc&region=prod_gf_cn&level=30&uid=11111111";
const STARRAIL_SOURCE_TZ_OFFSET = "+08:00";
const STARRAIL_DATE_TIME_PATTERN =
  String.raw`\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}\s*\d{1,2}:\d{2}(?::\d{2})?`;
const RANGE_SEPARATOR_PATTERN = String.raw`(?:-|~|～|至|到|—|–|\u2013|\u2014)`;

const IGNORE_ANN_IDS = new Set<number>([
  194, 183, 171, 187, 185, 203, 505,
]);

const IGNORE_WORDS = [
  "绘画征集",
  "内容专题页",
  "调研",
  "防沉迷",
  "米游社",
  "专项意见",
  "问卷调查",
  "版本更新通知",
  "预下载功能",
  "周边限时",
  "周边上新",
  "角色演示",
  "上新",
  "同行任务",
  "无名勋礼",
  "工具更新",
  "激励计划",
  "攻略征集",
  "更新概览",
  "有奖问卷",
  "角色PV",
  "动画短片",
  "周边优惠",
  "新品首发",
  "新增关卡",
  "获得加强",
  "全新课题重磅更新",
];

// Allowlist titles that would otherwise be removed by broad filters.
// Star Rail announcements sometimes use "...活动说明", which we want to keep.
const INCLUDE_WORDS = [
  "活动说明",
];

const IGNORE_SUFFIXES = [
  "说明",
];

const EXPLANATION_VERSION_SUFFIX_PATTERN = /\u8bf4\u660e\s*[vV]\d+(?:\.\d+)+$/;
const IGNORE_TITLE_PATTERNS = [
  /\bPV\b/i,
];

function shouldIgnoreStarRailTitle(title: string): boolean {
  if (IGNORE_WORDS.some((w) => title.includes(w))) return true;
  if (IGNORE_TITLE_PATTERNS.some((pattern) => pattern.test(title))) return true;
  if (!title.includes("活动说明") && EXPLANATION_VERSION_SUFFIX_PATTERN.test(title)) return true;
  if (IGNORE_SUFFIXES.some((s) => title.endsWith(s))) return true;
  return false;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripHtml(input: string | undefined): string {
  return decodeHtmlEntities(input ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h\d|li|tr)>/gi, "\n")
    .replace(/<(p|div|h\d|li|tr)[^>]*>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function normalizeDateTimeCandidate(input: string | undefined): string | null {
  const source = (input ?? "").replace(/\s+/g, "").trim();
  if (!source) return null;

  const m =
    /^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(
      source
    );
  if (!m) return null;

  const yyyy = m[1]!;
  const mo = String(Number(m[2]!)).padStart(2, "0");
  const dd = String(Number(m[3]!)).padStart(2, "0");
  const hh = String(Number(m[4]!)).padStart(2, "0");
  const mi = m[5]!;
  const ss = m[6] ? m[6] : "00";
  return `${yyyy}-${mo}-${dd} ${hh}:${mi}:${ss}`;
}

function toStarRailSourceIso(input: string | undefined): string | null {
  const normalized = normalizeDateTimeCandidate(input);
  return normalized ? toIsoWithSourceOffset(normalized, STARRAIL_SOURCE_TZ_OFFSET) : null;
}

function addHoursToSourceIso(input: string, hours: number): string | null {
  const startMs = Date.parse(input);
  if (!Number.isFinite(startMs) || !Number.isFinite(hours) || hours <= 0 || hours > 24) return null;

  return unixSecondsToIsoWithSourceOffset(
    Math.round((startMs + hours * 60 * 60 * 1000) / 1000),
    STARRAIL_SOURCE_TZ_OFFSET
  );
}

function sameSourceMinute(a: string, b: string): boolean {
  return a.slice(0, 16) === b.slice(0, 16);
}

function preserveStructuredEndSeconds(parsedEndIso: string, listEndIso: string): string {
  if (!sameSourceMinute(parsedEndIso, listEndIso)) return parsedEndIso;

  const parsedMs = Date.parse(parsedEndIso);
  const listMs = Date.parse(listEndIso);
  if (!Number.isFinite(parsedMs) || !Number.isFinite(listMs)) return parsedEndIso;
  return listMs >= parsedMs && listMs - parsedMs < 60_000 ? listEndIso : parsedEndIso;
}

function collectDateTimeCandidates(input: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(`(${STARRAIL_DATE_TIME_PATTERN})`, "g");
  for (const match of input.matchAll(re)) {
    const normalized = normalizeDateTimeCandidate(match[1]);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function extractRelativeVersionLabel(input: string): string | null {
  const numeric = /(\d+(?:\.\d+)+)\s*版本(?:更新后|开启后|期间)/.exec(input);
  if (numeric?.[1]) return numeric[1];

  const vPrefix = /\bV(\d+(?:\.\d+)+)\s*版本(?:更新后|开启后|期间)/i.exec(input);
  if (vPrefix?.[1]) return vPrefix[1];

  const quoted = /([「“"][^」”"]+[」”"])\s*版本(?:更新后|开启后|期间)/.exec(input);
  if (quoted?.[1]) {
    return quoted[1]
      .replace(/^“/, "「")
      .replace(/”$/, "」")
      .replace(/^"/, "「")
      .replace(/"$/, "」");
  }

  return null;
}

function resolveRelativeVersionStartIso(
  input: string,
  opts: {
    versionMaintenanceEndByLabel: Map<string, string>;
    singleVersionMaintenanceEndIso: string | null;
  }
): string | null {
  const relativeVersionLabel = extractRelativeVersionLabel(input);
  if (relativeVersionLabel) {
    return opts.versionMaintenanceEndByLabel.get(relativeVersionLabel) ?? null;
  }

  return /版本(?:更新后|开启后|期间)/.test(input)
    ? opts.singleVersionMaintenanceEndIso
    : null;
}

function extractMaintenanceEndIsoFromVersionContent(content: string | undefined): string | null {
  const text = stripHtml(content);
  if (!text) return null;

  const rangeRe = new RegExp(
    `(?:更新时间|更新维护时间|维护时间)[^\\d]{0,80}(${STARRAIL_DATE_TIME_PATTERN})\\s*${RANGE_SEPARATOR_PATTERN}\\s*(${STARRAIL_DATE_TIME_PATTERN})`
  );
  const range = rangeRe.exec(text);
  const rangeEndIso = toStarRailSourceIso(range?.[2]);
  if (rangeEndIso) return rangeEndIso;

  const startRe = new RegExp(
    `(?:更新时间|更新维护时间|维护时间)[^\\d]{0,80}(${STARRAIL_DATE_TIME_PATTERN})\\s*开始`
  );
  const start = startRe.exec(text);
  if (!start?.[1]) return null;

  const duration = /预计\s*([0-9]+(?:\.[0-9]+)?)\s*(?:个)?\s*小时\s*(?:完成|结束)?/.exec(
    text.slice(start.index)
  );
  const durationHours = Number(duration?.[1]);
  const startIso = toStarRailSourceIso(start[1]);
  return startIso ? addHoursToSourceIso(startIso, durationHours) : null;
}

function normalizeSectionBoundary(line: string): string {
  return line
    .replace(/^[■▌●◆◇#\s]+/, "")
    .replace(/[：:]\s*$/, "")
    .trim();
}

function isStarRailSectionBoundary(line: string): boolean {
  const normalized = normalizeSectionBoundary(line);
  return [
    "参与条件",
    "活动奖励",
    "活动说明",
    "特别奖励",
    "特别说明",
    "相关说明",
    "注意事项",
    "玩法说明",
    "跃迁说明",
  ].some((boundary) => (
    normalized === boundary ||
    normalized.startsWith(`${boundary}：`) ||
    normalized.startsWith(`${boundary}:`)
  ));
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isStarRailTimeLabelLine(line: string, label: string): boolean {
  const normalized = normalizeSectionBoundary(line);
  return new RegExp(
    `^(?:本期)?${escapeRegExp(label)}(?:$|\\s*[：:为]|\\s+(?=${STARRAIL_DATE_TIME_PATTERN}))`
  ).test(normalized);
}

function isAnyStarRailTimeLabelLine(line: string, labels: string[]): boolean {
  return labels.some((label) => isStarRailTimeLabelLine(line, label));
}

function extractStarRailTimeSection(content: string | undefined): string | null {
  const text = stripHtml(content);
  const lines = text.split("\n");
  const labels = [
    "活动跃迁时间",
    "限时活动期",
    "活动时间",
    "开放时间",
    "开启时间",
    "领取时间",
    "跃迁时间",
  ];

  for (const label of labels) {
    const startIdx = lines.findIndex((line) => isStarRailTimeLabelLine(line, label));
    if (startIdx < 0) continue;

    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i += 1) {
      if (isStarRailSectionBoundary(lines[i]!) || isAnyStarRailTimeLabelLine(lines[i]!, labels)) {
        endIdx = i;
        break;
      }
    }

    return lines.slice(startIdx, endIdx).join("\n");
  }

  const longTermIdx = lines.findIndex(
    (line) =>
      new RegExp(STARRAIL_DATE_TIME_PATTERN).test(line) &&
      /(?:后开启|后长期开放|长期开放|永久开放|持续开放)/.test(line)
  );
  if (longTermIdx >= 0) {
    return lines[longTermIdx]!;
  }

  return null;
}

function extractStarRailTimeRangeFromContent(
  content: string | undefined,
  opts: {
    versionMaintenanceEndByLabel: Map<string, string>;
    singleVersionMaintenanceEndIso: string | null;
    listEndIso: string;
  }
): { startIso: string | null; endIso: string | null } {
  const section = extractStarRailTimeSection(content);
  if (!section) return { startIso: null, endIso: null };

  const dates = collectDateTimeCandidates(section);
  const relativeStartIso = resolveRelativeVersionStartIso(section, opts);

  if (/版本(?:更新后|开启后|期间)/.test(section) && dates.length > 0) {
    if (!relativeStartIso) return { startIso: null, endIso: null };

    const rawEndIso = toIsoWithSourceOffset(dates[0]!, STARRAIL_SOURCE_TZ_OFFSET);
    return {
      startIso: relativeStartIso,
      endIso: preserveStructuredEndSeconds(rawEndIso, opts.listEndIso),
    };
  }

  if (/版本(?:更新后|开启后|期间)/.test(section) && dates.length === 0) {
    return {
      startIso: relativeStartIso,
      endIso: relativeStartIso ? opts.listEndIso : null,
    };
  }

  if (dates.length >= 2) {
    const rawEndIso = toIsoWithSourceOffset(dates[1]!, STARRAIL_SOURCE_TZ_OFFSET);
    return {
      startIso: toIsoWithSourceOffset(dates[0]!, STARRAIL_SOURCE_TZ_OFFSET),
      endIso: preserveStructuredEndSeconds(rawEndIso, opts.listEndIso),
    };
  }

  if (dates.length === 1 && /(?:后开启|后长期开放|长期开放|永久开放|持续开放)/.test(section)) {
    return {
      startIso: toIsoWithSourceOffset(dates[0]!, STARRAIL_SOURCE_TZ_OFFSET),
      endIso: opts.listEndIso,
    };
  }

  return { startIso: null, endIso: null };
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseAnnItem(raw: unknown): MihoyoAnnItem | null {
  if (!isRecord(raw)) return null;
  const ann_id = raw.ann_id;
  if (typeof ann_id !== "number") return null;

  return {
    ann_id,
    title: typeof raw.title === "string" ? raw.title : "",
    subtitle: toStringOrUndefined(raw.subtitle),
    banner: toStringOrUndefined(raw.banner),
    content: toStringOrUndefined(raw.content),
    start_time: toStringOrUndefined(raw.start_time),
    end_time: toStringOrUndefined(raw.end_time),
    type: typeof raw.type === "number" ? raw.type : undefined,
    type_label: toStringOrUndefined(raw.type_label),
  };
}

function makeAnnItemKey(item: MihoyoAnnItem): string {
  // Upstream sometimes returns multiple records that share the same ann_id but
  // differ in title/time window. Using ann_id alone will cause collisions.
  const title = item.title?.trim() || item.subtitle?.trim() || "";
  return [
    item.ann_id,
    title,
    item.start_time ?? "",
    item.end_time ?? "",
    item.type ?? "",
    item.type_label ?? "",
  ].join("|");
}

function extractItemsFromRawList(list: unknown[]): MihoyoAnnItem[] {
  const items = new Map<string, MihoyoAnnItem>();
  for (const it of list) {
    const parsed = parseAnnItem(it);
    if (parsed) {
      items.set(makeAnnItemKey(parsed), parsed);
    }
  }
  return [...items.values()];
}

function parseCategory(raw: unknown): MihoyoAnnCategory | null {
  if (!isRecord(raw)) return null;
  const type_id = raw.type_id;
  const list = raw.list;
  if (typeof type_id !== "number" || !Array.isArray(list)) return null;

  const items = extractItemsFromRawList(list);

  return {
    type_id,
    type_label: toStringOrUndefined(raw.type_label) ?? "",
    list: [...items.values()],
  };
}

function collectCategoriesFromNode(node: unknown, out: MihoyoAnnCategory[]): void {
  if (!isRecord(node)) return;

  const list = node.list;

  const category = parseCategory(node);
  if (category) {
    out.push(category);
  } else if (Array.isArray(list)) {
    const fallbackItems = extractItemsFromRawList(list);
    if (fallbackItems.length > 0) {
      out.push({
        type_id: 0,
        type_label: toStringOrUndefined(node.type_label) ?? "",
        list: fallbackItems,
      });
    }
  }

  if (Array.isArray(list)) {
    for (const item of list) collectCategoriesFromNode(item, out);
  }

  const typeList = node.type_list;
  if (Array.isArray(typeList)) {
    for (const item of typeList) collectCategoriesFromNode(item, out);
  }

  const picList = node.pic_list;
  if (Array.isArray(picList)) {
    for (const item of picList) collectCategoriesFromNode(item, out);
  }
}

function parseContentItem(raw: unknown): MihoyoAnnContentItem | null {
  if (!isRecord(raw)) return null;
  const ann_id = raw.ann_id;
  if (typeof ann_id !== "number") return null;

  return {
    ann_id,
    title: typeof raw.title === "string" ? raw.title : "",
    subtitle: toStringOrUndefined(raw.subtitle),
    banner: toStringOrUndefined(raw.banner),
    content: toStringOrUndefined(raw.content),
    img: toStringOrUndefined(raw.img),
    lang: toStringOrUndefined(raw.lang),
    remind_text: toStringOrUndefined(raw.remind_text),
  };
}

function addContentItem(out: Map<number, MihoyoAnnContentItem[]>, item: MihoyoAnnContentItem): void {
  const list = out.get(item.ann_id);
  const titleKey = `${item.title?.trim() ?? ""}|${item.subtitle?.trim() ?? ""}`;
  if (!list) {
    out.set(item.ann_id, [item]);
    return;
  }
  // Keep stable insertion order, but avoid exact title duplicates.
  if (!list.some((x) => `${x.title?.trim() ?? ""}|${x.subtitle?.trim() ?? ""}` === titleKey)) {
    list.push(item);
  }
}

function collectContentItemsFromNode(node: unknown, out: Map<number, MihoyoAnnContentItem[]>): void {
  if (!isRecord(node)) return;

  const direct = parseContentItem(node);
  if (direct) {
    addContentItem(out, direct);
    return;
  }

  const list = node.list;
  if (Array.isArray(list)) {
    for (const item of list) {
      const parsed = parseContentItem(item);
      if (parsed) {
        addContentItem(out, parsed);
        continue;
      }
      collectContentItemsFromNode(item, out);
    }
  }

  const typeList = node.type_list;
  if (Array.isArray(typeList)) {
    for (const item of typeList) collectContentItemsFromNode(item, out);
  }

  const picList = node.pic_list;
  if (Array.isArray(picList)) {
    for (const item of picList) collectContentItemsFromNode(item, out);
  }
}

type StarRailVersionNotice = {
  item: MihoyoAnnItem;
  startIso: string;
  endIso: string;
  startMs: number;
  endMs: number;
};

function isVersionNoticeText(input: string): boolean {
  const text = input.trim();
  if (!text) return false;
  if (text.includes("维护预告")) return false;
  return text.includes("版本更新说明") || text.includes("版本更新公告");
}

function pickCurrentVersionNotice(items: MihoyoAnnItem[]): StarRailVersionNotice | null {
  const candidates = items
    .filter((item) => isVersionNoticeText(item.title ?? "") || isVersionNoticeText(item.subtitle ?? ""))
    .map((item) => {
      if (!item.start_time || !item.end_time) return null;
      const startIso = toIsoWithSourceOffset(item.start_time, STARRAIL_SOURCE_TZ_OFFSET);
      const endIso = toIsoWithSourceOffset(item.end_time, STARRAIL_SOURCE_TZ_OFFSET);
      const startMs = Date.parse(startIso);
      const endMs = Date.parse(endIso);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
      return { item, startIso, endIso, startMs, endMs };
    })
    .filter((x): x is StarRailVersionNotice => x != null);

  if (candidates.length === 0) return null;

  const nowMs = Date.now();
  const active = candidates
    .filter((x) => x.startMs <= nowMs && nowMs < x.endMs)
    .sort((a, b) => b.startMs - a.startMs);
  if (active.length > 0) return active[0]!;

  const upcoming = candidates
    .filter((x) => x.startMs > nowMs)
    .sort((a, b) => a.startMs - b.startMs);
  if (upcoming.length > 0) return upcoming[0]!;

  const recentPast = candidates.sort((a, b) => b.endMs - a.endMs);
  return recentPast[0] ?? null;
}

function extractVersionLabelFromText(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  const quoted = /[「“"]([^「」”"]+)[」”"]\s*(?:版本)?(?:更新说明|更新公告)/.exec(raw);
  if (quoted?.[1]) return `「${quoted[1].trim()}」`;

  const fromVersionWord = /(\d+(?:\.\d+)+)\s*版本/.exec(raw);
  if (fromVersionWord?.[1]) return fromVersionWord[1];

  const fromVPrefix = /\bV(\d+(?:\.\d+)+)\b/i.exec(raw);
  if (fromVPrefix?.[1]) return fromVPrefix[1];

  return null;
}

function extractVersionLabelsFromText(input: string): string[] {
  const raw = input.trim();
  if (!raw) return [];

  const labels = new Set<string>();
  for (const match of raw.matchAll(/(\d+(?:\.\d+)+)\s*版本/g)) {
    if (match[1]) labels.add(match[1]);
  }
  for (const match of raw.matchAll(/\bV(\d+(?:\.\d+)+)\b/gi)) {
    if (match[1]) labels.add(match[1]);
  }
  for (const match of raw.matchAll(/[「“"]([^「」”"]+)[」”"]\s*(?:版本)?(?:更新说明|更新公告)/g)) {
    if (match[1]) labels.add(`「${match[1].trim()}」`);
  }

  return [...labels];
}

function extractVersionLabel(item: MihoyoAnnItem): string | null {
  const fromTitle = extractVersionLabelFromText(item.title ?? "");
  if (fromTitle) return fromTitle;

  const fromSubtitle = extractVersionLabelFromText(item.subtitle ?? "");
  if (fromSubtitle) return fromSubtitle;

  return null;
}

function extractVersionLabels(item: MihoyoAnnItem): string[] {
  const labels = new Set<string>();
  for (const label of extractVersionLabelsFromText(item.title ?? "")) labels.add(label);
  for (const label of extractVersionLabelsFromText(item.subtitle ?? "")) labels.add(label);

  const primary = extractVersionLabel(item);
  if (primary) labels.add(primary);

  return [...labels];
}

async function fetchStarRailAnnouncementCategories(env: RuntimeEnv): Promise<MihoyoAnnCategory[]> {
  const listApiUrl = env.STARRAIL_API_URL ?? STARRAIL_DEFAULT_LIST_API;
  const listRes = await fetchJson<MihoyoAnnListResponse>(listApiUrl, { timeoutMs: 12_000 });
  const categories: MihoyoAnnCategory[] = [];
  collectCategoriesFromNode(listRes.data ?? null, categories);

  if (categories.length > 0) return categories;
  return listRes.data?.list ?? [];
}

function getStarRailEventItems(categories: MihoyoAnnCategory[]): MihoyoAnnItem[] {
  const byKey = new Map<string, MihoyoAnnItem>();
  const isCategorySelected = (category: MihoyoAnnCategory): boolean => {
    if (category.type_id === 3 || category.type_id === 4) return true;
    const label = category.type_label ?? "";
    return label.includes("公告") || label.includes("资讯");
  };
  const isItemSelected = (item: MihoyoAnnItem): boolean => {
    if (item.type === 3 || item.type === 4) return true;
    const label = item.type_label ?? "";
    return label.includes("公告") || label.includes("资讯");
  };

  for (const category of categories) {
    const categorySelected = isCategorySelected(category);
    for (const item of category.list ?? []) {
      if (categorySelected || isItemSelected(item)) {
        byKey.set(makeAnnItemKey(item), item);
      }
    }
  }

  return [...byKey.values()];
}

function shouldKeepStarRailEventTitle(title: string): boolean {
  if (!title) return false;
  if (isGachaEventTitle("starrail", title)) return true;
  if (INCLUDE_WORDS.some((w) => title.includes(w))) return true;
  return !shouldIgnoreStarRailTitle(title);
}

function isValidTimeRange(range: { startIso: string | null; endIso: string | null }): range is {
  startIso: string;
  endIso: string;
} {
  if (!range.startIso || !range.endIso) return false;
  const sMs = Date.parse(range.startIso);
  const eMs = Date.parse(range.endIso);
  return Number.isFinite(sMs) && Number.isFinite(eMs) && eMs > sMs;
}

export async function fetchStarRailEvents(env: RuntimeEnv = {}): Promise<CalendarEvent[]> {
  const contentApiUrl =
    env.STARRAIL_CONTENT_API_URL ?? STARRAIL_DEFAULT_CONTENT_API;

  const categories = await fetchStarRailAnnouncementCategories(env);
  const list = getStarRailEventItems(categories);

  const filtered = list
    .filter((item) => item.start_time && item.end_time)
    .filter((item) => {
      const title = item.title?.trim() || item.subtitle?.trim() || "";
      if (IGNORE_ANN_IDS.has(item.ann_id)) return false;
      return shouldKeepStarRailEventTitle(title);
    });

  // getAnnContent includes the full (HTML) announcement body but does not include
  // reliable structured start/end fields, so we merge it with getAnnList by ann_id.
  const contentById = new Map<number, MihoyoAnnContentItem[]>();
  try {
    const contentRes = await fetchJson<MihoyoAnnContentResponse>(contentApiUrl, {
      timeoutMs: 12_000,
    });
    collectContentItemsFromNode(contentRes.data ?? null, contentById);
  } catch {
    // If content fetch fails, still return the event list based on getAnnList.
  }

  const normalizeTitle = (input: string): string => input.replace(/\s+/g, " ").trim();
  const pickBestContentItem = (
    items: MihoyoAnnContentItem[] | undefined,
    listTitle: string,
    listSubtitle: string | undefined,
  ): MihoyoAnnContentItem | undefined => {
    if (!items || items.length === 0) return undefined;
    if (items.length === 1) return items[0];

    const targets = [listTitle, listSubtitle].filter(Boolean).map((t) => normalizeTitle(String(t)));
    for (const target of targets) {
      const match = items.find((x) => normalizeTitle(x.title ?? "") === target || normalizeTitle(x.subtitle ?? "") === target);
      if (match) return match;
    }

    return items[0];
  };

  const versionMaintenanceEndByLabel = new Map<string, string>();
  for (const noticeItem of list) {
    if (!isVersionNoticeText(noticeItem.title ?? "") && !isVersionNoticeText(noticeItem.subtitle ?? "")) {
      continue;
    }

    const noticeTitle = noticeItem.title?.trim() || noticeItem.subtitle?.trim() || "";
    const noticeContentItem = pickBestContentItem(
      contentById.get(noticeItem.ann_id),
      noticeTitle,
      noticeItem.subtitle
    );
    const noticeContent = noticeContentItem?.content ?? noticeItem.content;
    const maintenanceEndIso = extractMaintenanceEndIsoFromVersionContent(noticeContent);
    if (maintenanceEndIso) {
      for (const versionLabel of extractVersionLabels(noticeItem)) {
        versionMaintenanceEndByLabel.set(versionLabel, maintenanceEndIso);
      }
    }
  }
  const versionMaintenanceEnds = [...new Set(versionMaintenanceEndByLabel.values())];
  const singleVersionMaintenanceEndIso =
    versionMaintenanceEnds.length === 1 ? versionMaintenanceEnds[0]! : null;

  const filteredKeys = new Set(
    filtered.map((item) => `${item.ann_id}|${normalizeTitle(item.title?.trim() || item.subtitle?.trim() || "")}`)
  );
  const contentOnlyItems: MihoyoAnnItem[] = [];
  for (const contentItems of contentById.values()) {
    for (const contentItem of contentItems) {
      const title = contentItem.title?.trim() || contentItem.subtitle?.trim() || "";
      if (!title) continue;
      if (IGNORE_ANN_IDS.has(contentItem.ann_id)) continue;
      if (!shouldKeepStarRailEventTitle(title)) continue;

      const key = `${contentItem.ann_id}|${normalizeTitle(title)}`;
      if (filteredKeys.has(key)) continue;

      const parsed = extractStarRailTimeRangeFromContent(contentItem.content, {
        versionMaintenanceEndByLabel,
        singleVersionMaintenanceEndIso,
        listEndIso: "9999-12-31T23:59:59+08:00",
      });
      if (!isValidTimeRange(parsed)) continue;

      contentOnlyItems.push({
        ann_id: contentItem.ann_id,
        title,
        subtitle: contentItem.subtitle,
        banner: contentItem.banner ?? contentItem.img,
        content: contentItem.content,
        start_time: parsed.startIso,
        end_time: parsed.endIso,
        type: 0,
        type_label: "content",
      });
      filteredKeys.add(key);
    }
  }

  return [...filtered, ...contentOnlyItems].map((item) => {
    const title = item.title?.trim() || item.subtitle?.trim() || "";
    const contentItem = pickBestContentItem(contentById.get(item.ann_id), title, item.subtitle);
    const content = contentItem?.content ?? item.content;
    const gachaKind = classifyGachaEvent("starrail", title, content);
    const isGacha = isGachaEventTitle("starrail", title) || gachaKind !== "other";
    const listStartIso = toIsoWithSourceOffset(item.start_time!, STARRAIL_SOURCE_TZ_OFFSET);
    const listEndIso = toIsoWithSourceOffset(item.end_time!, STARRAIL_SOURCE_TZ_OFFSET);
    const contentRange = extractStarRailTimeRangeFromContent(content, {
      versionMaintenanceEndByLabel,
      singleVersionMaintenanceEndIso,
      listEndIso,
    });
    const resolvedStartIso = contentRange.startIso ?? listStartIso;
    const resolvedEndIso = contentRange.endIso ?? listEndIso;
    const sMs = Date.parse(resolvedStartIso);
    const eMs = Date.parse(resolvedEndIso);
    const hasValidContentRange = Number.isFinite(sMs) && Number.isFinite(eMs) && eMs > sMs;

    return {
      id: `starrail:${makeAnnItemKey(item)}`,
      title,
      start_time: hasValidContentRange ? resolvedStartIso : listStartIso,
      end_time: hasValidContentRange ? resolvedEndIso : listEndIso,
      is_gacha: isGacha,
      gacha_kind: isGacha ? gachaKind : undefined,
      banner: item.banner ?? contentItem?.banner ?? contentItem?.img,
      content,
    };
  });
}

export async function fetchStarRailCurrentVersion(env: RuntimeEnv = {}): Promise<GameVersionInfo | null> {
  const categories = await fetchStarRailAnnouncementCategories(env);
  const noticeCategory =
    categories.find((c) => c.type_id === 4) ??
    categories.find((c) => c.type_label.includes("公告"));
  const notice = pickCurrentVersionNotice(noticeCategory?.list ?? []);
  if (!notice) return null;

  const version = extractVersionLabel(notice.item);
  if (!version) return null;

  return {
    game: "starrail",
    version,
    start_time: notice.startIso,
    end_time: notice.endIso,
    ann_id: notice.item.ann_id,
    title: notice.item.title,
  };
}
