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

const GENSHIN_DEFAULT_LIST_API =
  "https://hk4e-api.mihoyo.com/common/hk4e_cn/announcement/api/getAnnList?game=hk4e&game_biz=hk4e_cn&lang=zh-cn&bundle_id=hk4e_cn&platform=pc&region=cn_gf01&level=55&uid=100000000";

const GENSHIN_DEFAULT_CONTENT_API =
  "https://hk4e-api.mihoyo.com/common/hk4e_cn/announcement/api/getAnnContent?game=hk4e&game_biz=hk4e_cn&lang=zh-cn&bundle_id=hk4e_cn&platform=pc&region=cn_gf01&level=55&uid=100000000";
const GENSHIN_SOURCE_TZ_OFFSET = "+08:00";

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

export async function fetchGenshinEvents(env: RuntimeEnv = {}): Promise<CalendarEvent[]> {
  const listApiUrl = env.GENSHIN_API_URL ?? GENSHIN_DEFAULT_LIST_API;
  const contentApiUrl =
    env.GENSHIN_CONTENT_API_URL ?? GENSHIN_DEFAULT_CONTENT_API;

  const listRes = await fetchJson<MihoyoAnnListResponse>(listApiUrl, {
    timeoutMs: 12_000,
  });

  const categories = listRes.data?.list ?? [];
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
