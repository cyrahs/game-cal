import { fetchJson } from "../lib/fetch.js";
import { toIsoWithSourceOffset } from "../lib/time.js";
import type { RuntimeEnv } from "../lib/runtimeEnv.js";
import type { CalendarEvent, GameVersionInfo } from "../types.js";

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

const GENSHIN_DEFAULT_LIST_API =
  "https://hk4e-api.mihoyo.com/common/hk4e_cn/announcement/api/getAnnList?game=hk4e&game_biz=hk4e_cn&lang=zh-cn&bundle_id=hk4e_cn&platform=pc&region=cn_gf01&level=55&uid=100000000";

const GENSHIN_DEFAULT_CONTENT_API =
  "https://hk4e-api.mihoyo.com/common/hk4e_cn/announcement/api/getAnnContent?game=hk4e&game_biz=hk4e_cn&lang=zh-cn&bundle_id=hk4e_cn&platform=pc&region=cn_gf01&level=55&uid=100000000";
const GENSHIN_SOURCE_TZ_OFFSET = "+08:00";
const VERSION_UPDATE_NOTICE_KEYWORD = "版本更新说明";

// Keep this conservative: filter obvious non-event notices.
const IGNORE_ANN_IDS = new Set<number>([
  495, 1263, 423, 422, 762, 20835,
]);

const IGNORE_WORDS = [
  "修复",
  "内容专题页",
  "米游社",
  "调研",
  "防沉迷",
  "问卷",
  "公平运营",
  "纪行",
  "有奖活动",
  "反馈功能",
];

type GenshinVersionNotice = {
  item: MihoyoAnnItem;
  startIso: string;
  endIso: string;
  startMs: number;
  endMs: number;
};

function pickCurrentVersionNotice(items: MihoyoAnnItem[]): GenshinVersionNotice | null {
  const candidates = items
    .filter((item) => {
      const title = item.title ?? "";
      const subtitle = item.subtitle ?? "";
      return title.includes(VERSION_UPDATE_NOTICE_KEYWORD) || subtitle.includes(VERSION_UPDATE_NOTICE_KEYWORD);
    })
    .map((item) => {
      if (!item.start_time || !item.end_time) return null;
      const startIso = toIsoWithSourceOffset(item.start_time, GENSHIN_SOURCE_TZ_OFFSET);
      const endIso = toIsoWithSourceOffset(item.end_time, GENSHIN_SOURCE_TZ_OFFSET);
      const startMs = Date.parse(startIso);
      const endMs = Date.parse(endIso);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
      return { item, startIso, endIso, startMs, endMs };
    })
    .filter((x): x is GenshinVersionNotice => x != null);

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

function extractVersionLabelFromText(text: string): string | null {
  const raw = text.trim();
  if (!raw) return null;

  const quoted = /[「“"]([^「」”"]+)[」”"]\s*(?:版本)?(?:更新说明|更新公告)/.exec(raw);
  if (quoted?.[1]) return `「${quoted[1].trim()}」`;

  const numeric = /(\d+(?:\.\d+)+)\s*版本(?:更新说明)?/.exec(raw);
  if (numeric?.[1]) return numeric[1];

  const loose = /([^\s，。,；;：:]{1,24})\s*版本(?:更新说明)?/.exec(raw);
  if (loose?.[1]) return loose[1];

  return null;
}

function extractVersionLabel(item: MihoyoAnnItem): string | null {
  const fromTitle = extractVersionLabelFromText(item.title ?? "");
  if (fromTitle) return fromTitle;

  const fromSubtitle = extractVersionLabelFromText(item.subtitle ?? "");
  if (fromSubtitle) return fromSubtitle;

  const subtitleText = (item.subtitle ?? "")
    .replace(VERSION_UPDATE_NOTICE_KEYWORD, "")
    .trim();
  if (subtitleText) return subtitleText;

  return null;
}

async function fetchGenshinAnnouncementCategories(env: RuntimeEnv): Promise<MihoyoAnnCategory[]> {
  const listApiUrl = env.GENSHIN_API_URL ?? GENSHIN_DEFAULT_LIST_API;
  const listRes = await fetchJson<MihoyoAnnListResponse>(listApiUrl, {
    timeoutMs: 12_000,
  });
  return listRes.data?.list ?? [];
}

export async function fetchGenshinEvents(env: RuntimeEnv = {}): Promise<CalendarEvent[]> {
  const contentApiUrl =
    env.GENSHIN_CONTENT_API_URL ?? GENSHIN_DEFAULT_CONTENT_API;

  const categories = await fetchGenshinAnnouncementCategories(env);
  const eventCategory = categories.find((c) => c.type_id === 1); // 活动公告
  const list = eventCategory?.list ?? [];

  const filtered = list
    .filter((item) => item.start_time && item.end_time)
    .filter((item) => !IGNORE_ANN_IDS.has(item.ann_id))
    .filter((item) => IGNORE_WORDS.every((w) => !item.title.includes(w)));

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
    return {
      id: item.ann_id,
      title: item.title,
      start_time: toIsoWithSourceOffset(item.start_time!, GENSHIN_SOURCE_TZ_OFFSET),
      end_time: toIsoWithSourceOffset(item.end_time!, GENSHIN_SOURCE_TZ_OFFSET),
      banner: item.banner ?? contentItem?.banner,
      content: contentItem?.content ?? item.content,
    };
  });
}

export async function fetchGenshinCurrentVersion(env: RuntimeEnv = {}): Promise<GameVersionInfo | null> {
  const categories = await fetchGenshinAnnouncementCategories(env);
  const noticeCategory =
    categories.find((c) => c.type_id === 2) ??
    categories.find((c) => c.type_label.includes("游戏公告"));
  const notice = pickCurrentVersionNotice(noticeCategory?.list ?? []);
  if (!notice) return null;

  const version = extractVersionLabel(notice.item);
  if (!version) return null;

  return {
    game: "genshin",
    version,
    start_time: notice.startIso,
    end_time: notice.endIso,
    ann_id: notice.item.ann_id,
    title: notice.item.title,
  };
}
