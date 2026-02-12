import { fetchJson } from "../lib/fetch.js";
import { toIsoWithSourceOffset, unixSecondsToIsoWithSourceOffset } from "../lib/time.js";
import type { RuntimeEnv } from "../lib/runtimeEnv.js";
import type { CalendarEvent, GameVersionInfo } from "../types.js";

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

type MihoyoNapAnnItem = {
  ann_id?: number;
  title?: string;
  subtitle?: string;
  start_time?: string;
  end_time?: string;
};

type MihoyoNapAnnCategory = {
  type_id: number;
  type_label: string;
  list: MihoyoNapAnnItem[];
};

type MihoyoNapAnnListResponse = {
  retcode: number;
  message: string;
  data?: {
    list?: MihoyoNapAnnCategory[];
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

const ZZZ_DEFAULT_LIST_API =
  "https://announcement-api.mihoyo.com/common/nap_cn/announcement/api/getAnnList?uid=11111111&game=nap&game_biz=nap_cn&lang=zh-cn&bundle_id=nap_cn&channel_id=1&level=60&platform=pc&region=prod_gf_cn";

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

type ZzzVersionNotice = {
  item: MihoyoNapAnnItem;
  startIso: string;
  endIso: string;
  startMs: number;
  endMs: number;
};

function isVersionNoticeText(input: string): boolean {
  const text = stripHtml(input);
  if (!text) return false;
  if (text.includes("维护预告")) return false;
  return text.includes("版本更新说明") || text.includes("版本更新公告");
}

function pickCurrentVersionNotice(items: MihoyoNapAnnItem[]): ZzzVersionNotice | null {
  const candidates = items
    .filter((item) => isVersionNoticeText(item.title ?? "") || isVersionNoticeText(item.subtitle ?? ""))
    .map((item) => {
      if (!item.start_time || !item.end_time) return null;
      const startIso = toIsoWithSourceOffset(item.start_time, ZZZ_SOURCE_TZ_OFFSET);
      const endIso = toIsoWithSourceOffset(item.end_time, ZZZ_SOURCE_TZ_OFFSET);
      const startMs = Date.parse(startIso);
      const endMs = Date.parse(endIso);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
      return { item, startIso, endIso, startMs, endMs };
    })
    .filter((x): x is ZzzVersionNotice => x != null);

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
  const raw = stripHtml(input);
  if (!raw) return null;

  const quoted = /[「“"]([^「」”"]+)[」”"]\s*(?:版本)?(?:更新说明|更新公告)/.exec(raw);
  if (quoted?.[1]) return `「${quoted[1].trim()}」`;

  const fromVersionWord = /(\d+(?:\.\d+)+)\s*版本/.exec(raw);
  if (fromVersionWord?.[1]) return fromVersionWord[1];

  const fromVPrefix = /\bV(\d+(?:\.\d+)+)\b/i.exec(raw);
  if (fromVPrefix?.[1]) return fromVPrefix[1];

  return null;
}

function extractVersionLabel(item: MihoyoNapAnnItem): string | null {
  const fromTitle = extractVersionLabelFromText(item.title ?? "");
  if (fromTitle) return fromTitle;

  const fromSubtitle = extractVersionLabelFromText(item.subtitle ?? "");
  if (fromSubtitle) return fromSubtitle;

  return null;
}

async function fetchZzzAnnouncementCategories(env: RuntimeEnv): Promise<MihoyoNapAnnCategory[]> {
  const listApiUrl = env.ZZZ_API_URL ?? ZZZ_DEFAULT_LIST_API;
  const listRes = await fetchJson<MihoyoNapAnnListResponse>(listApiUrl, {
    timeoutMs: 12_000,
  });
  return listRes.data?.list ?? [];
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

export async function fetchZzzCurrentVersion(env: RuntimeEnv = {}): Promise<GameVersionInfo | null> {
  const categories = await fetchZzzAnnouncementCategories(env);
  const noticeCategory =
    categories.find((c) => c.type_id === 3) ??
    categories.find((c) => c.type_label.includes("游戏公告"));
  const notice = pickCurrentVersionNotice(noticeCategory?.list ?? []);
  if (!notice) return null;

  const version = extractVersionLabel(notice.item);
  if (!version) return null;

  const info: GameVersionInfo = {
    game: "zzz",
    version,
    start_time: notice.startIso,
    end_time: notice.endIso,
    title: stripHtml(notice.item.title),
  };
  if (typeof notice.item.ann_id === "number") {
    info.ann_id = notice.item.ann_id;
  }
  return info;
}
