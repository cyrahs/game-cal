import { fetchJson } from "../lib/fetch.js";
import { toIsoWithSourceOffset, unixSecondsToIsoWithSourceOffset } from "../lib/time.js";
import type { RuntimeEnv } from "../lib/runtimeEnv.js";
import type { CalendarEvent, GameVersionInfo } from "../types.js";
import { isGachaEventTitle } from "./gacha.js";

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

type ParsedTimeRange = {
  startIso: string | null;
  endIso: string | null;
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

function normalizeDateTimeCandidate(input: string | undefined): string | null {
  const source = (input ?? "").replace(/\s+/g, "").trim();
  if (!source) return null;

  const m = /^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(source);
  if (!m) return null;

  const yyyy = m[1]!;
  const mo = String(Number(m[2]!)).padStart(2, "0");
  const dd = String(Number(m[3]!)).padStart(2, "0");
  const hh = String(Number(m[4]!)).padStart(2, "0");
  const mi = m[5]!;
  const ss = m[6] ? m[6] : "00";
  return `${yyyy}-${mo}-${dd} ${hh}:${mi}:${ss}`;
}

function extractTimeRangeFromContentHtml(html: string): ParsedTimeRange {
  const text = stripHtml(html);
  if (!text) return { startIso: null, endIso: null };

  const range =
    /(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}\s*\d{1,2}:\d{2}(?::\d{2})?)\s*(?:-|~|～|至|到|—|–|\u2013|\u2014)\s*(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}\s*\d{1,2}:\d{2}(?::\d{2})?)/.exec(
      text
    );
  if (range) {
    const start = normalizeDateTimeCandidate(range[1]);
    const end = normalizeDateTimeCandidate(range[2]);
    return {
      startIso: start ? toIsoWithSourceOffset(start, ZZZ_SOURCE_TZ_OFFSET) : null,
      endIso: end ? toIsoWithSourceOffset(end, ZZZ_SOURCE_TZ_OFFSET) : null,
    };
  }

  const all: string[] = [];
  const seen = new Set<string>();
  const re = /(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}\s*\d{1,2}:\d{2}(?::\d{2})?)/g;
  for (const m of text.matchAll(re)) {
    const v = normalizeDateTimeCandidate(m[1]);
    if (!v || seen.has(v)) continue;
    seen.add(v);
    all.push(v);
  }
  if (all.length === 0) return { startIso: null, endIso: null };
  if (all.length === 1) {
    return {
      startIso: null,
      endIso: toIsoWithSourceOffset(all[0]!, ZZZ_SOURCE_TZ_OFFSET),
    };
  }

  return {
    startIso: toIsoWithSourceOffset(all[0]!, ZZZ_SOURCE_TZ_OFFSET),
    endIso: toIsoWithSourceOffset(all[1]!, ZZZ_SOURCE_TZ_OFFSET),
  };
}

function parseGachaEventsFromAnnContent(
  items: MihoyoNapAnnContentItem[],
  opts: { fallbackStartIso: string | null }
): CalendarEvent[] {
  const out = new Map<string, CalendarEvent>();

  for (const it of items) {
    const title = stripHtml(it.title);
    if (!isGachaEventTitle("zzz", title)) continue;

    const { startIso, endIso } = extractTimeRangeFromContentHtml(it.content ?? "");
    const resolvedStart = startIso ?? opts.fallbackStartIso;
    if (!resolvedStart || !endIso) continue;

    const sMs = Date.parse(resolvedStart);
    const eMs = Date.parse(endIso);
    if (!Number.isFinite(sMs) || !Number.isFinite(eMs) || eMs <= sMs) continue;

    const id = `zzz-gacha:${it.ann_id ?? normalizeTitleKey(title)}`;
    const prev = out.get(id);
    const next: CalendarEvent = {
      id,
      title,
      start_time: resolvedStart,
      end_time: endIso,
      is_gacha: true,
      banner: (it.banner?.trim() || it.img?.trim() || undefined) ?? undefined,
      content: it.content,
    };
    if (!prev) {
      out.set(id, next);
      continue;
    }
    out.set(id, {
      ...prev,
      banner: prev.banner ?? next.banner,
      content: prev.content ?? next.content,
      start_time: Date.parse(prev.start_time) <= Date.parse(next.start_time) ? prev.start_time : next.start_time,
      end_time: Date.parse(prev.end_time) >= Date.parse(next.end_time) ? prev.end_time : next.end_time,
    });
  }

  return [...out.values()];
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
  const listApiUrl = env.ZZZ_API_URL ?? ZZZ_DEFAULT_LIST_API;

  const [activityRes, contentRes, listRes] = await Promise.all([
    fetchJson<MihoyoNapActivityListResponse>(activityApiUrl, {
      timeoutMs: 12_000,
    }),
    fetchJson<MihoyoNapAnnContentResponse>(contentApiUrl, {
      timeoutMs: 12_000,
    }).catch(() => null),
    fetchJson<MihoyoNapAnnListResponse>(listApiUrl, {
      timeoutMs: 12_000,
    }).catch(() => null),
  ]);

  const categories = listRes?.data?.list ?? [];
  const noticeCategory =
    categories.find((c) => c.type_id === 3) ??
    categories.find((c) => c.type_label.includes("游戏公告"));
  const versionNotice = pickCurrentVersionNotice(noticeCategory?.list ?? []);
  const fallbackStartIso = versionNotice?.startIso ?? null;

  const candidates: ContentCandidate[] = [];
  const contentItems: MihoyoNapAnnContentItem[] = [];
  if (contentRes) {
    const items: MihoyoNapAnnContentItem[] = [
      ...(contentRes.data?.list ?? []),
      ...(contentRes.data?.pic_list ?? []),
    ];
    contentItems.push(...items);

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
  const normalEvents = list
    .filter((a) => Boolean(a?.name) && Boolean(a?.start_time) && Boolean(a?.end_time))
    .flatMap((a): CalendarEvent[] => {
      const s = Number(a.start_time);
      const e = Number(a.end_time);
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return [];

      const id = a.activity_id ?? `${a.name}:${a.start_time}`;
      const title = a.name!;
      const matched = candidates.length > 0 ? pickBestCandidate(a.name!, candidates) : null;
      return [
        {
          id,
          title,
          start_time: unixSecondsToIsoWithSourceOffset(a.start_time!, ZZZ_SOURCE_TZ_OFFSET),
          end_time: unixSecondsToIsoWithSourceOffset(a.end_time!, ZZZ_SOURCE_TZ_OFFSET),
          is_gacha: isGachaEventTitle("zzz", title),
          banner: matched?.banner,
          content: matched?.content,
        },
      ];
    });

  const gachaEvents = parseGachaEventsFromAnnContent(contentItems, { fallbackStartIso });

  const merged = new Map<string, CalendarEvent>();
  for (const event of [...normalEvents, ...gachaEvents]) {
    merged.set(String(event.id), event);
  }

  return [...merged.values()].sort((a, b) => {
    const sDiff = Date.parse(a.start_time) - Date.parse(b.start_time);
    if (sDiff !== 0) return sDiff;
    const eDiff = Date.parse(a.end_time) - Date.parse(b.end_time);
    if (eDiff !== 0) return eDiff;
    return String(a.id).localeCompare(String(b.id), "zh-Hans-CN");
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
