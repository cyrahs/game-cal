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
};

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
  };
};

type MihoyoAnnContentItem = {
  ann_id: number;
  title: string;
  subtitle?: string;
  banner?: string;
  content?: string;
  lang?: string;
  remind_text?: string;
};

type MihoyoAnnContentResponse = {
  retcode: number;
  message: string;
  data?: {
    list?: MihoyoAnnContentItem[];
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
];

// Allowlist titles that would otherwise be removed by broad filters.
// Star Rail announcements sometimes use "...活动说明", which we want to keep.
const INCLUDE_WORDS = [
  "活动说明",
];

const IGNORE_SUFFIXES = [
  "说明",
];

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
  return listRes.data?.list ?? [];
}

export async function fetchStarRailEvents(env: RuntimeEnv = {}): Promise<CalendarEvent[]> {
  const contentApiUrl =
    env.STARRAIL_CONTENT_API_URL ?? STARRAIL_DEFAULT_CONTENT_API;

  const categories = await fetchStarRailAnnouncementCategories(env);
  const category = categories.find((c) => c.type_id === 4) ?? categories[0];
  const list = category?.list ?? [];

  const filtered = list
    .filter((item) => item.start_time && item.end_time)
    .filter((item) => {
      const title = item.title ?? "";
      if (isGachaEventTitle("starrail", title)) return true;
      if (IGNORE_ANN_IDS.has(item.ann_id)) return false;
      // Allowlist wins over broad ignore rules.
      if (INCLUDE_WORDS.some((w) => title.includes(w))) return true;
      if (IGNORE_WORDS.some((w) => title.includes(w))) return false;
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
    const contentList = contentRes.data?.list ?? [];
    for (const it of contentList) {
      if (typeof it?.ann_id === "number") {
        contentById.set(it.ann_id, it);
      }
    }
  } catch {
    // If content fetch fails, still return the event list based on getAnnList.
  }

  return filtered.map((item) => {
    const contentItem = contentById.get(item.ann_id);
    const title = item.title ?? "";
    return {
      id: item.ann_id,
      title,
      start_time: toIsoWithSourceOffset(item.start_time!, STARRAIL_SOURCE_TZ_OFFSET),
      end_time: toIsoWithSourceOffset(item.end_time!, STARRAIL_SOURCE_TZ_OFFSET),
      is_gacha: isGachaEventTitle("starrail", title),
      banner: item.banner ?? contentItem?.banner,
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
