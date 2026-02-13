import { fetchJson } from "../lib/fetch.js";
import { toIsoWithSourceOffset } from "../lib/time.js";
import type { RuntimeEnv } from "../lib/runtimeEnv.js";
import type { CalendarEvent, GameVersionInfo } from "../types.js";
import { isGachaEventTitle } from "./gacha.js";

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

function extractItemsFromRawList(list: unknown[]): MihoyoAnnItem[] {
  const items = new Map<number, MihoyoAnnItem>();
  for (const it of list) {
    const parsed = parseAnnItem(it);
    if (parsed) {
      items.set(parsed.ann_id, parsed);
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

function collectContentItemsFromNode(node: unknown, out: Map<number, MihoyoAnnContentItem>): void {
  if (!isRecord(node)) return;

  const direct = parseContentItem(node);
  if (direct) {
    if (!out.has(direct.ann_id)) out.set(direct.ann_id, direct);
    return;
  }

  const list = node.list;
  if (Array.isArray(list)) {
    for (const item of list) {
      const parsed = parseContentItem(item);
      if (parsed) {
        if (!out.has(parsed.ann_id)) out.set(parsed.ann_id, parsed);
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

function extractVersionLabel(item: MihoyoAnnItem): string | null {
  const fromTitle = extractVersionLabelFromText(item.title ?? "");
  if (fromTitle) return fromTitle;

  const fromSubtitle = extractVersionLabelFromText(item.subtitle ?? "");
  if (fromSubtitle) return fromSubtitle;

  return null;
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
  const byId = new Map<number, MihoyoAnnItem>();
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
        byId.set(item.ann_id, item);
      }
    }
  }

  return [...byId.values()];
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
      if (!title) return false;

      if (isGachaEventTitle("starrail", title)) return true;
      if (IGNORE_ANN_IDS.has(item.ann_id)) return false;
      // Allowlist wins over broad ignore rules.
      if (INCLUDE_WORDS.some((w) => title.includes(w))) return true;
      if (IGNORE_WORDS.some((w) => title.includes(w))) return false;
      // Default: hide announcements ending with "说明" plus version suffix (e.g., "说明 V4.0"),
      // except explicit "活动说明".
      if (!title.includes("活动说明") && EXPLANATION_VERSION_SUFFIX_PATTERN.test(title)) return false;
      if (IGNORE_SUFFIXES.some((s) => title.endsWith(s))) return false;
      return true;
    });

  // getAnnContent includes the full (HTML) announcement body but does not include
  // reliable structured start/end fields, so we merge it with getAnnList by ann_id.
  const contentById = new Map<number, MihoyoAnnContentItem>();
  try {
    const contentRes = await fetchJson<MihoyoAnnContentResponse>(contentApiUrl, {
      timeoutMs: 12_000,
    });
    collectContentItemsFromNode(contentRes.data ?? null, contentById);
  } catch {
    // If content fetch fails, still return the event list based on getAnnList.
  }

  return filtered.map((item) => {
    const contentItem = contentById.get(item.ann_id);
    const title = item.title?.trim() || item.subtitle?.trim() || "";
    return {
      id: item.ann_id,
      title,
      start_time: toIsoWithSourceOffset(item.start_time!, STARRAIL_SOURCE_TZ_OFFSET),
      end_time: toIsoWithSourceOffset(item.end_time!, STARRAIL_SOURCE_TZ_OFFSET),
      is_gacha: isGachaEventTitle("starrail", title),
      banner: item.banner ?? contentItem?.banner ?? contentItem?.img,
      content: contentItem?.content ?? item.content,
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
