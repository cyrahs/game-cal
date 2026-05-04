import { fetchJson } from "../lib/fetch.js";
import { toIsoWithSourceOffset, unixSecondsToIsoWithSourceOffset } from "../lib/time.js";
import type { RuntimeEnv } from "../lib/runtimeEnv.js";
import type { CalendarEvent, GameVersionInfo } from "../types.js";
import { classifyGachaEvent, combineGachaKinds, isGachaEventTitle } from "./gacha.js";

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
const ZZZ_DATE_TIME_PATTERN = String.raw`\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}\s*\d{1,2}:\d{2}(?::\d{2})?`;
const ZZZ_RANGE_SEPARATOR_PATTERN = String.raw`(?:-|~|～|至|到|—|–|\u2013|\u2014)`;

function parseEventEndMs(event: CalendarEvent): number {
  return event.end_time ? Date.parse(event.end_time) : Number.POSITIVE_INFINITY;
}

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

function normalizeAnnouncementEventTitle(input: string | undefined): string {
  let title = stripHtml(input).replace(/\s*活动说明\s*$/, "").trim();
  const outerQuoted =
    /^「(.+)」$/.exec(title) ??
    /^『(.+)』$/.exec(title) ??
    /^“(.+)”$/.exec(title) ??
    /^"(.+)"$/.exec(title);
  if (outerQuoted?.[1]) title = outerQuoted[1].trim();
  return title;
}

function isSupplementalActivityNotice(item: MihoyoNapAnnItem): boolean {
  const title = stripHtml(item.title || item.subtitle);
  if (!title.endsWith("活动说明")) return false;
  if (isGachaEventTitle("zzz", title)) return false;
  return true;
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

function toSourceIsoFromDateTimeCandidate(input: string | undefined): string | null {
  const normalized = normalizeDateTimeCandidate(input);
  return normalized ? toIsoWithSourceOffset(normalized, ZZZ_SOURCE_TZ_OFFSET) : null;
}

function addHoursToSourceIso(input: string, hours: number): string | null {
  const startMs = Date.parse(input);
  if (!Number.isFinite(startMs) || !Number.isFinite(hours) || hours <= 0) return null;

  return unixSecondsToIsoWithSourceOffset(
    Math.round((startMs + hours * 60 * 60 * 1000) / 1000),
    ZZZ_SOURCE_TZ_OFFSET
  );
}

function extractMaintenanceEndIsoFromVersionContent(content: string | undefined): string | null {
  const text = stripHtml(content);
  if (!text) return null;

  const rangeRe = new RegExp(
    `(?:更新维护时间|维护时间)[^\\d]{0,80}(${ZZZ_DATE_TIME_PATTERN})\\s*${ZZZ_RANGE_SEPARATOR_PATTERN}\\s*(${ZZZ_DATE_TIME_PATTERN})`
  );
  const range = rangeRe.exec(text);
  const rangeEndIso = toSourceIsoFromDateTimeCandidate(range?.[2]);
  if (rangeEndIso) return rangeEndIso;

  const startRe = new RegExp(
    `(?:版本更新时间|更新开始时间|维护开始时间|停服更新时间|更新维护开始时间)[^\\d]{0,80}(${ZZZ_DATE_TIME_PATTERN})`
  );
  const start = startRe.exec(text);
  if (!start?.[1]) return null;

  const duration = /预计\s*(?:需要\s*)?([0-9]+(?:\.[0-9]+)?)\s*(?:个)?\s*小时\s*(?:完成|结束)?/.exec(
    text.slice(start.index)
  );
  const durationHours = Number(duration?.[1]);
  if (!Number.isFinite(durationHours) || durationHours <= 0 || durationHours > 24) return null;

  const startIso = toSourceIsoFromDateTimeCandidate(start[1]);
  return startIso ? addHoursToSourceIso(startIso, durationHours) : null;
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

function extractRelativeVersionLabel(input: string | undefined): string | null {
  const text = stripHtml(input);
  if (!text || !/版本更新后/.test(text)) return null;

  const numeric = /(\d+(?:\.\d+)+)\s*版本更新后/.exec(text);
  if (numeric?.[1]) return numeric[1];

  const vPrefix = /\bV(\d+(?:\.\d+)+)\s*版本更新后/i.exec(text);
  if (vPrefix?.[1]) return vPrefix[1];

  return null;
}

function resolveVersionRelativeStartIso(
  content: string | undefined,
  opts: {
    versionMaintenanceEndByLabel: Map<string, string>;
    fallbackStartIso: string | null;
  }
): string | null {
  const text = stripHtml(content);
  if (!text || !/版本更新后/.test(text)) return null;

  const versionLabel = extractRelativeVersionLabel(text);
  if (versionLabel) {
    return opts.versionMaintenanceEndByLabel.get(versionLabel) ?? null;
  }

  return opts.fallbackStartIso;
}

function parseGachaEventsFromAnnContent(
  items: MihoyoNapAnnContentItem[],
  opts: {
    fallbackStartIso: string | null;
    versionMaintenanceEndByLabel: Map<string, string>;
  }
): CalendarEvent[] {
  const out = new Map<string, CalendarEvent>();

  for (const it of items) {
    const title = stripHtml(it.title);
    if (!isGachaEventTitle("zzz", title)) continue;

    const { startIso, endIso } = extractTimeRangeFromContentHtml(it.content ?? "");
    const resolvedStart =
      startIso ??
      resolveVersionRelativeStartIso(it.content, {
        versionMaintenanceEndByLabel: opts.versionMaintenanceEndByLabel,
        fallbackStartIso: opts.fallbackStartIso,
      });
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
      gacha_kind: classifyGachaEvent("zzz", title, it.content),
      banner: (it.banner?.trim() || it.img?.trim() || undefined) ?? undefined,
      content: it.content,
    };
    if (!prev) {
      out.set(id, next);
      continue;
    }
    out.set(id, {
      ...prev,
      gacha_kind: combineGachaKinds(prev.gacha_kind, next.gacha_kind),
      banner: prev.banner ?? next.banner,
      content: prev.content ?? next.content,
      start_time: Date.parse(prev.start_time) <= Date.parse(next.start_time) ? prev.start_time : next.start_time,
      end_time: parseEventEndMs(prev) >= parseEventEndMs(next) ? prev.end_time : next.end_time,
    });
  }

  return [...out.values()];
}

function addContentItemByAnnId(
  out: Map<number, MihoyoNapAnnContentItem[]>,
  item: MihoyoNapAnnContentItem
): void {
  if (typeof item.ann_id !== "number") return;
  const list = out.get(item.ann_id);
  if (!list) {
    out.set(item.ann_id, [item]);
    return;
  }
  list.push(item);
}

function pickContentItemForNotice(
  item: MihoyoNapAnnItem,
  contentItemsByAnnId: Map<number, MihoyoNapAnnContentItem[]>
): MihoyoNapAnnContentItem | undefined {
  if (typeof item.ann_id !== "number") return undefined;
  const items = contentItemsByAnnId.get(item.ann_id);
  if (!items || items.length === 0) return undefined;
  if (items.length === 1) return items[0];

  const targetKeys = [item.title, item.subtitle]
    .map((value) => normalizeTitleKey(value))
    .filter(Boolean);
  for (const targetKey of targetKeys) {
    const match = items.find(
      (x) => normalizeTitleKey(x.title) === targetKey || normalizeTitleKey(x.subtitle) === targetKey
    );
    if (match) return match;
  }

  return items.find((x) => Boolean(x.content?.trim())) ?? items[0];
}

function parseSupplementalActivityEventsFromAnnContent(
  items: MihoyoNapAnnItem[],
  contentItemsByAnnId: Map<number, MihoyoNapAnnContentItem[]>,
  opts: {
    fallbackStartIso: string | null;
    versionMaintenanceEndByLabel: Map<string, string>;
    existingTitleKeys: Set<string>;
  }
): CalendarEvent[] {
  const out = new Map<string, CalendarEvent>();

  for (const item of items) {
    if (!isSupplementalActivityNotice(item)) continue;

    const title = normalizeAnnouncementEventTitle(item.title || item.subtitle);
    const titleKey = normalizeTitleKey(title);
    if (!title || !titleKey || opts.existingTitleKeys.has(titleKey)) continue;

    const contentItem = pickContentItemForNotice(item, contentItemsByAnnId);
    const { startIso, endIso } = extractTimeRangeFromContentHtml(contentItem?.content ?? "");
    const resolvedStart =
      startIso ??
      resolveVersionRelativeStartIso(contentItem?.content, {
        versionMaintenanceEndByLabel: opts.versionMaintenanceEndByLabel,
        fallbackStartIso: opts.fallbackStartIso,
      });
    if (!resolvedStart || !endIso) continue;

    const sMs = Date.parse(resolvedStart);
    const eMs = Date.parse(endIso);
    if (!Number.isFinite(sMs) || !Number.isFinite(eMs) || eMs <= sMs) continue;

    const id = `zzz-ann:${item.ann_id ?? titleKey}`;
    out.set(id, {
      id,
      title,
      start_time: resolvedStart,
      end_time: endIso,
      is_gacha: false,
      banner: (contentItem?.banner?.trim() || contentItem?.img?.trim() || undefined) ?? undefined,
      content: contentItem?.content,
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

function extractVersionLabelsFromText(input: string): string[] {
  const raw = stripHtml(input);
  if (!raw) return [];

  const out = new Set<string>();
  for (const match of raw.matchAll(/(\d+(?:\.\d+)+)\s*版本/g)) {
    if (match[1]) out.add(match[1]);
  }
  for (const match of raw.matchAll(/\bV(\d+(?:\.\d+)+)\b/gi)) {
    if (match[1]) out.add(match[1]);
  }

  const primary = extractVersionLabelFromText(raw);
  if (primary) out.add(primary);

  return [...out];
}

function extractVersionLabel(item: MihoyoNapAnnItem): string | null {
  const fromTitle = extractVersionLabelFromText(item.title ?? "");
  if (fromTitle) return fromTitle;

  const fromSubtitle = extractVersionLabelFromText(item.subtitle ?? "");
  if (fromSubtitle) return fromSubtitle;

  return null;
}

function extractVersionLabels(item: MihoyoNapAnnItem): string[] {
  const out = new Set<string>();
  for (const label of extractVersionLabelsFromText(item.title ?? "")) out.add(label);
  for (const label of extractVersionLabelsFromText(item.subtitle ?? "")) out.add(label);

  const primary = extractVersionLabel(item);
  if (primary) out.add(primary);

  return [...out];
}

function buildVersionMaintenanceEndByLabel(
  items: MihoyoNapAnnItem[],
  contentItemsByAnnId: Map<number, MihoyoNapAnnContentItem[]>
): Map<string, string> {
  const out = new Map<string, string>();

  for (const item of items) {
    const labels = extractVersionLabels(item);
    if (labels.length === 0) continue;

    const contentItem = pickContentItemForNotice(item, contentItemsByAnnId);
    const maintenanceEndIso = extractMaintenanceEndIsoFromVersionContent(contentItem?.content);
    if (!maintenanceEndIso) continue;

    for (const label of labels) out.set(label, maintenanceEndIso);
  }

  return out;
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

  const candidates: ContentCandidate[] = [];
  const contentItems: MihoyoNapAnnContentItem[] = [];
  const contentItemsByAnnId = new Map<number, MihoyoNapAnnContentItem[]>();
  if (contentRes) {
    const items: MihoyoNapAnnContentItem[] = [
      ...(contentRes.data?.list ?? []),
      ...(contentRes.data?.pic_list ?? []),
    ];
    contentItems.push(...items);

    for (const it of items) {
      addContentItemByAnnId(contentItemsByAnnId, it);

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

  const versionContentItem = versionNotice
    ? pickContentItemForNotice(versionNotice.item, contentItemsByAnnId)
    : undefined;
  const fallbackStartIso =
    extractMaintenanceEndIsoFromVersionContent(versionContentItem?.content) ??
    versionNotice?.startIso ??
    null;
  const versionMaintenanceEndByLabel = buildVersionMaintenanceEndByLabel(
    categories.flatMap((category) => category.list ?? []),
    contentItemsByAnnId
  );

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
      const gachaKind = classifyGachaEvent("zzz", title, matched?.content);
      const isGacha = isGachaEventTitle("zzz", title) || gachaKind !== "other";
      return [
        {
          id,
          title,
          start_time: unixSecondsToIsoWithSourceOffset(a.start_time!, ZZZ_SOURCE_TZ_OFFSET),
          end_time: unixSecondsToIsoWithSourceOffset(a.end_time!, ZZZ_SOURCE_TZ_OFFSET),
          is_gacha: isGacha,
          gacha_kind: isGacha ? gachaKind : undefined,
          banner: matched?.banner,
          content: matched?.content,
        },
      ];
    });

  const gachaEvents = parseGachaEventsFromAnnContent(contentItems, {
    fallbackStartIso,
    versionMaintenanceEndByLabel,
  });
  const supplementalEvents = parseSupplementalActivityEventsFromAnnContent(
    noticeCategory?.list ?? [],
    contentItemsByAnnId,
    {
      fallbackStartIso,
      versionMaintenanceEndByLabel,
      existingTitleKeys: new Set(normalEvents.map((event) => normalizeTitleKey(event.title))),
    }
  );

  const merged = new Map<string, CalendarEvent>();
  for (const event of [...normalEvents, ...supplementalEvents, ...gachaEvents]) {
    merged.set(String(event.id), event);
  }

  return [...merged.values()].sort((a, b) => {
    const sDiff = Date.parse(a.start_time) - Date.parse(b.start_time);
    if (sDiff !== 0) return sDiff;
    const eDiff = parseEventEndMs(a) - parseEventEndMs(b);
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
