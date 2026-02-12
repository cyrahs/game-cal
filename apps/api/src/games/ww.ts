import { fetchJson } from "../lib/fetch.js";
import { unixSecondsToIsoWithSourceOffset } from "../lib/time.js";
import type { RuntimeEnv } from "../lib/runtimeEnv.js";
import type { CalendarEvent, GameVersionInfo } from "../types.js";

type WwOfficialNoticeItem = {
  id?: string | number;
  tabTitle?: string;
  startTimeMs?: string | number;
  endTimeMs?: string | number;
  category?: string | number;
  tag?: string | number;
  permanent?: string | number;
  tabBanner?: string | null;
  foldBanner?: string | null;
  content?: string;
};

type WwOfficialNoticeResponse = {
  game?: WwOfficialNoticeItem[];
  activity?: WwOfficialNoticeItem[];
  recommend?: WwOfficialNoticeItem[];
};

const WW_NOTICE_DEFAULT =
  "https://aki-gm-resources-back.aki-game.com/gamenotice/G152/76402e5b20be2c39f095a152090afddc/zh-Hans.json";
const WW_SOURCE_TZ_OFFSET = "+08:00";
const WW_INCLUDED_CATEGORIES = new Set<number>([2, 3]);

const WW_IGNORE_TITLE_WORDS = [
  "回归系统",
  "回馈系统",
  "快速体验",
  "签到工具",
  "版本活动笔记",
  "版本内容说明",
  "已知问题",
  "更新说明",
  "调整公告",
  "反馈",
  "防沉迷",
  "公平运营",
  "社区资讯",
];

const WW_PROMOTION_TITLE_WORDS = [
  "限时上架",
  "折扣上架",
  "商城礼包",
  "礼包",
  "周度演算卡",
  "先约电台",
];

const WW_VERSION_NOTICE_INCLUDE_WORDS = [
  "版本内容说明",
  "版本更新说明",
  "版本更新公告",
];

const WW_VERSION_NOTICE_EXCLUDE_WORDS = [
  "版本活动笔记",
  "已知问题",
  "维护预告",
];

function stableHash64(input: string): string {
  // FNV-1a 64-bit. Fast, deterministic, and works in both Node and Workers.
  // (Avoids importing Node builtins, since this file is typechecked in the worker package too.)
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;

  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }

  return hash.toString(16).padStart(16, "0");
}

function stableEventIdFromTitleAndStartTime(title: string, startTime: string): string {
  return stableHash64(`${title}|${startTime}`);
}

function parseMs(input: string | number | undefined): number | null {
  if (input == null) return null;
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

function parseIntLike(input: string | number | undefined): number | null {
  if (input == null) return null;
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function msToIsoWithSourceOffset(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return unixSecondsToIsoWithSourceOffset(seconds, WW_SOURCE_TZ_OFFSET);
}

function pickBanner(item: WwOfficialNoticeItem): string | undefined {
  const tab = item.tabBanner?.trim();
  if (tab) return tab;
  const fold = item.foldBanner?.trim();
  if (fold) return fold;
  return undefined;
}

function normalizeTitle(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function shouldIgnoreWwItem(
  item: WwOfficialNoticeItem,
  opts: { title: string }
): boolean {
  const category = parseIntLike(item.category);
  if (category == null || !WW_INCLUDED_CATEGORIES.has(category)) return true;

  const permanent = parseIntLike(item.permanent);
  if (permanent === 1) return true;

  const normalizedTitle = normalizeTitle(opts.title);
  if (WW_IGNORE_TITLE_WORDS.some((w) => normalizedTitle.includes(w))) return true;
  if (WW_PROMOTION_TITLE_WORDS.some((w) => normalizedTitle.includes(w))) return true;

  return false;
}

function isWwVersionNoticeTitle(title: string): boolean {
  const normalized = normalizeTitle(title);
  if (!normalized) return false;
  if (WW_VERSION_NOTICE_EXCLUDE_WORDS.some((w) => normalized.includes(w))) return false;
  return WW_VERSION_NOTICE_INCLUDE_WORDS.some((w) => normalized.includes(w));
}

function extractWwVersionLabel(title: string): string | null {
  const normalized = normalizeTitle(title);
  if (!normalized) return null;

  const quoted = /[「“"]([^「」”"]+)[」”"]/.exec(normalized);
  if (quoted?.[1]) return `「${quoted[1].trim()}」`;

  const numeric = /(\d+(?:\.\d+)+)\s*版本/.exec(normalized);
  if (numeric?.[1]) return numeric[1];

  const fromVPrefix = /\bV(\d+(?:\.\d+)+)\b/i.exec(normalized);
  if (fromVPrefix?.[1]) return fromVPrefix[1];

  return null;
}

type WwVersionNotice = {
  item: WwOfficialNoticeItem;
  title: string;
  startMs: number;
  endMs: number;
  startIso: string;
  endIso: string;
};

function pickCurrentWwVersionNotice(items: WwVersionNotice[]): WwVersionNotice | null {
  if (items.length === 0) return null;

  const nowMs = Date.now();
  const active = items
    .filter((x) => x.startMs <= nowMs && nowMs < x.endMs)
    .sort((a, b) => b.startMs - a.startMs);
  if (active.length > 0) return active[0]!;

  const upcoming = items
    .filter((x) => x.startMs > nowMs)
    .sort((a, b) => a.startMs - b.startMs);
  if (upcoming.length > 0) return upcoming[0]!;

  const recentPast = items.sort((a, b) => b.endMs - a.endMs);
  return recentPast[0] ?? null;
}

export async function fetchWwEvents(
  env: RuntimeEnv = {}
): Promise<CalendarEvent[]> {
  const url = env.WW_NOTICE_API_URL ?? WW_NOTICE_DEFAULT;
  const res = await fetchJson<WwOfficialNoticeResponse>(url, {
    timeoutMs: 12_000,
  });

  const merged = [
    ...(res.game ?? []),
    ...(res.activity ?? []),
    ...(res.recommend ?? []),
  ];

  const deduped = new Map<string, CalendarEvent>();

  for (const item of merged) {
    const title = item.tabTitle?.trim();
    if (!title) continue;

    const startMs = parseMs(item.startTimeMs);
    const endMs = parseMs(item.endTimeMs);
    if (startMs == null || endMs == null || endMs <= startMs) continue;
    if (shouldIgnoreWwItem(item, { title })) continue;

    const idText = String(item.id ?? "").trim();
    const fallbackId = stableEventIdFromTitleAndStartTime(title, String(startMs));
    const id = idText || fallbackId;

    const event: CalendarEvent = {
      id,
      title,
      start_time: msToIsoWithSourceOffset(startMs),
      end_time: msToIsoWithSourceOffset(endMs),
      banner: pickBanner(item),
      content: item.content,
    };

    const prev = deduped.get(id);
    if (!prev) {
      deduped.set(id, event);
      continue;
    }

    // Prefer richer entries when the same id appears in multiple sections.
    deduped.set(id, {
      ...prev,
      banner: prev.banner ?? event.banner,
      content: prev.content ?? event.content,
    });
  }

  return [...deduped.values()];
}

export async function fetchWwCurrentVersion(env: RuntimeEnv = {}): Promise<GameVersionInfo | null> {
  const url = env.WW_NOTICE_API_URL ?? WW_NOTICE_DEFAULT;
  const res = await fetchJson<WwOfficialNoticeResponse>(url, {
    timeoutMs: 12_000,
  });

  const merged = [
    ...(res.game ?? []),
    ...(res.activity ?? []),
    ...(res.recommend ?? []),
  ];

  const deduped = new Map<string, WwVersionNotice>();
  for (const item of merged) {
    const rawTitle = item.tabTitle?.trim();
    if (!rawTitle) continue;

    const title = normalizeTitle(rawTitle);
    if (!isWwVersionNoticeTitle(title)) continue;

    const startMs = parseMs(item.startTimeMs);
    const endMs = parseMs(item.endTimeMs);
    if (startMs == null || endMs == null || endMs <= startMs) continue;

    const idText = String(item.id ?? "").trim();
    const key = idText || `${title}|${startMs}|${endMs}`;

    deduped.set(key, {
      item,
      title,
      startMs,
      endMs,
      startIso: msToIsoWithSourceOffset(startMs),
      endIso: msToIsoWithSourceOffset(endMs),
    });
  }

  const notice = pickCurrentWwVersionNotice([...deduped.values()]);
  if (!notice) return null;

  const version = extractWwVersionLabel(notice.title);
  if (!version) return null;

  const idNum = parseIntLike(notice.item.id);
  const info: GameVersionInfo = {
    game: "ww",
    version,
    start_time: notice.startIso,
    end_time: notice.endIso,
    title: notice.title,
  };
  if (idNum != null && idNum > 0) {
    info.ann_id = idNum;
  }
  return info;
}
