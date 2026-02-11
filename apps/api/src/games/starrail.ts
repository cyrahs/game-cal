import { fetchJson } from "../lib/fetch.js";
import { toIsoWithSourceOffset } from "../lib/time.js";
import type { RuntimeEnv } from "../lib/runtimeEnv.js";
import type { CalendarEvent } from "../types.js";

type MihoyoAnnItem = {
  ann_id: number;
  title: string;
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

export async function fetchStarRailEvents(env: RuntimeEnv = {}): Promise<CalendarEvent[]> {
  const listApiUrl = env.STARRAIL_API_URL ?? STARRAIL_DEFAULT_LIST_API;
  const contentApiUrl =
    env.STARRAIL_CONTENT_API_URL ?? STARRAIL_DEFAULT_CONTENT_API;

  const listRes = await fetchJson<MihoyoAnnListResponse>(listApiUrl, { timeoutMs: 12_000 });

  const categories = listRes.data?.list ?? [];
  const category = categories.find((c) => c.type_id === 4) ?? categories[0];
  const list = category?.list ?? [];

  const filtered = list
    .filter((item) => item.start_time && item.end_time)
    .filter((item) => !IGNORE_ANN_IDS.has(item.ann_id))
    .filter((item) => {
      // Allowlist wins over broad ignore rules.
      if (INCLUDE_WORDS.some((w) => item.title.includes(w))) return true;
      if (IGNORE_WORDS.some((w) => item.title.includes(w))) return false;
      if (IGNORE_SUFFIXES.some((s) => item.title.endsWith(s))) return false;
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
    return {
      id: item.ann_id,
      title: item.title,
      start_time: toIsoWithSourceOffset(item.start_time!, STARRAIL_SOURCE_TZ_OFFSET),
      end_time: toIsoWithSourceOffset(item.end_time!, STARRAIL_SOURCE_TZ_OFFSET),
      banner: item.banner ?? contentItem?.banner,
      content: contentItem?.content ?? item.content,
    };
  });
}
