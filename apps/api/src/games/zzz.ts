import { fetchJson } from "../lib/fetch.js";
import { unixSecondsToIsoWithSourceOffset } from "../lib/time.js";
import type { RuntimeEnv } from "../lib/runtimeEnv.js";
import type { CalendarEvent } from "../types.js";

type MihoyoNapActivity = {
  activity_id?: string;
  name?: string;
  start_time?: string;
  end_time?: string;
};

type MihoyoNapActivityListResponse = {
  retcode: number;
  message: string;
  data?: {
    activity_list?: MihoyoNapActivity[];
  };
};

type MihoyoNapAnnContentItem = {
  ann_id?: number;
  title?: string;
  subtitle?: string;
  banner?: string;
  img?: string; // pic_list uses img
  content?: string;
  lang?: string;
  remind_text?: string;
  href?: string;
  href_type?: number;
};

type MihoyoNapAnnContentResponse = {
  retcode: number;
  message: string;
  data?: {
    list?: MihoyoNapAnnContentItem[];
    pic_list?: MihoyoNapAnnContentItem[];
  };
};

const ZZZ_DEFAULT_ACTIVITY_API =
  "https://announcement-api.mihoyo.com/common/nap_cn/announcement/api/getActivityList?uid=11111111&game=nap&game_biz=nap_cn&lang=zh-cn&bundle_id=nap_cn&channel_id=1&level=60&platform=pc&region=prod_gf_cn";

const ZZZ_DEFAULT_CONTENT_API =
  "https://announcement-api.mihoyo.com/common/nap_cn/announcement/api/getAnnContent?uid=11111111&game=nap&game_biz=nap_cn&lang=zh-cn&bundle_id=nap_cn&channel_id=1&level=60&platform=pc&region=prod_gf_cn";
const ZZZ_SOURCE_TZ_OFFSET = "+08:00";

function stripHtml(input: string | undefined): string {
  // Titles are frequently wrapped in <p ...>...</p>. Strip tags for matching.
  return (input ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitleKey(input: string | undefined): string {
  // Make a matching key resilient to different quote styles / spacing.
  return stripHtml(input)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[「」『』“”"'’‘]/g, "");
}

type ContentCandidate = {
  titleText: string;
  key: string;
  banner?: string;
  content?: string;
};

function pickBestCandidate(
  activityTitle: string,
  candidates: ContentCandidate[]
): ContentCandidate | null {
  const aKey = normalizeTitleKey(activityTitle);
  if (!aKey) return null;

  let best: ContentCandidate | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const c of candidates) {
    if (!c.key) continue;

    // Lower score wins.
    let score: number | null = null;

    if (c.key === aKey) {
      score = 0;
    } else if (c.key.includes(aKey)) {
      score = 10 + (c.key.length - aKey.length);
    } else if (aKey.includes(c.key)) {
      score = 30 + (aKey.length - c.key.length);
    } else {
      continue;
    }

    // Prefer candidates that actually have detail content/banner.
    const contentLen = (c.content ?? "").trim().length;
    if (contentLen === 0) score += 1000;
    if (!c.banner) score += 100;

    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }

  return best;
}

export async function fetchZzzEvents(env: RuntimeEnv = {}): Promise<CalendarEvent[]> {
  const activityApiUrl =
    env.ZZZ_ACTIVITY_API_URL ?? ZZZ_DEFAULT_ACTIVITY_API;
  const contentApiUrl = env.ZZZ_CONTENT_API_URL ?? ZZZ_DEFAULT_CONTENT_API;

  const [activityRes, contentRes] = await Promise.all([
    fetchJson<MihoyoNapActivityListResponse>(activityApiUrl, {
      timeoutMs: 12_000,
    }),
    fetchJson<MihoyoNapAnnContentResponse>(contentApiUrl, {
      timeoutMs: 12_000,
    }).catch(() => null),
  ]);

  const candidates: ContentCandidate[] = [];
  if (contentRes) {
    const items: MihoyoNapAnnContentItem[] = [
      ...(contentRes.data?.list ?? []),
      ...(contentRes.data?.pic_list ?? []),
    ];

    for (const it of items) {
      const titleText = stripHtml(it.title);
      const key = normalizeTitleKey(titleText);
      if (!key) continue;

      const banner =
        (it.banner?.trim() || it.img?.trim() || undefined) ?? undefined;

      candidates.push({
        titleText,
        key,
        banner,
        content: it.content,
      });
    }
  }

  const list = activityRes.data?.activity_list ?? [];

  return list
    .filter((a) => Boolean(a?.name) && Boolean(a?.start_time) && Boolean(a?.end_time))
    .flatMap((a): CalendarEvent[] => {
      const s = Number(a.start_time);
      const e = Number(a.end_time);
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return [];

      const id = a.activity_id ?? `${a.name}:${a.start_time}`;
      const matched = candidates.length > 0 ? pickBestCandidate(a.name!, candidates) : null;
      return [
        {
          id,
          title: a.name!,
          start_time: unixSecondsToIsoWithSourceOffset(a.start_time!, ZZZ_SOURCE_TZ_OFFSET),
          end_time: unixSecondsToIsoWithSourceOffset(a.end_time!, ZZZ_SOURCE_TZ_OFFSET),
          banner: matched?.banner,
          content: matched?.content,
        },
      ];
    });
}
