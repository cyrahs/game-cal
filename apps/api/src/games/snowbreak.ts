import { fetchJson } from "../lib/fetch.js";
import {
  toIsoWithSourceOffset,
  unixSecondsToIsoWithSourceOffset,
} from "../lib/time.js";
import type { RuntimeEnv } from "../lib/runtimeEnv.js";
import type { CalendarEvent } from "../types.js";

type SnowbreakAnnItem = {
  id?: number | string;
  title?: string;
  left_title?: string;
  content?: string;
  start_time?: number | string;
  end_time?: number | string;
  type?: number;
};

type SnowbreakAnnResponse = {
  announce?: SnowbreakAnnItem[];
};

type SnowbreakDatePoint = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

type ParsedBlock = {
  title: string;
  banner?: string;
  lines: string[];
};

const SNOWBREAK_DEFAULT_ANNOUNCE_API =
  "https://cbjq-content.xoyocdn.com/ob202307/webfile/mainland/announce/config/pc_jinshan-pc_jinshan.json";
const SNOWBREAK_SOURCE_TZ_OFFSET = "+08:00";

const SNOWBREAK_ACTIVITY_INCLUDE_WORDS = [
  "玩法",
  "关卡",
  "任务",
  "活动商店",
  "活动开启",
  "限时活动",
  "主线",
  "挑战",
  "联机",
  "签到活动",
];

const SNOWBREAK_ACTIVITY_EXCLUDE_WORDS = [
  "角色共鸣",
  "武器共鸣",
  "定向共鸣",
  "共鸣限时开放",
  "时装",
  "武器外观",
  "限时上架",
  "特别物资补给",
  "凭证",
  "复刻",
  "入队",
  "共鸣活动",
];

function parseLocalizedText(input: unknown): string {
  if (typeof input !== "string") return "";
  const raw = input.trim();
  if (!raw) return "";

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      const preferred = ["default", "zh-cn", "zh_cn", "zh", "cn"];
      for (const key of preferred) {
        const v = parsed[key];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      for (const v of Object.values(parsed)) {
        if (typeof v === "string" && v.trim()) return v.trim();
      }
    }
  } catch {
    // Not JSON-wrapped localized text; use raw value.
  }

  return raw;
}

function normalizeTitle(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function extractFirstImgSrc(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const m = /<img[^>]+src=['"]([^'"]+)['"]/i.exec(html);
  return m?.[1]?.trim() || undefined;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'");
}

function tokenizeAnnouncementLines(html: string): string[] {
  const normalized = decodeHtmlEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<img[^>]*src=['"]([^'"]+)['"][^>]*>/gi, "\n@@IMG@@$1\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r/g, "");

  return normalized
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function parseBlockHeading(line: string): string | null {
  const s = normalizeTitle(line);
  if (!s) return null;
  if (s.startsWith("✧")) return normalizeTitle(s.slice(1));
  if (/^[一二三四五六七八九十]+、/.test(s)) return s;
  if (/^【[^】]+】$/.test(s)) return s;
  return null;
}

function parseBlocks(lines: string[]): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  let current: ParsedBlock | null = null;
  let pendingBanner: string | undefined;

  for (const line of lines) {
    if (line.startsWith("@@IMG@@")) {
      pendingBanner = line.slice("@@IMG@@".length).trim() || undefined;
      continue;
    }

    const heading = parseBlockHeading(line);
    if (heading) {
      if (current) blocks.push(current);
      current = { title: heading, banner: pendingBanner, lines: [] };
      pendingBanner = undefined;
      continue;
    }

    if (!current) continue;
    current.lines.push(line);
  }

  if (current) blocks.push(current);
  return blocks;
}

function inferYear(month: number, anchorYear: number, anchorMonth: number): number {
  if (!Number.isFinite(month) || month < 1 || month > 12) return anchorYear;

  // Keep month/day around the current announcement season and handle year boundaries.
  if (Math.abs(month - anchorMonth) >= 6) {
    return month < anchorMonth ? anchorYear + 1 : anchorYear - 1;
  }
  return anchorYear;
}

function isValidDatePoint(input: SnowbreakDatePoint): boolean {
  const d = new Date(
    Date.UTC(
      input.year,
      input.month - 1,
      input.day,
      input.hour,
      input.minute,
      input.second
    )
  );

  return (
    d.getUTCFullYear() === input.year &&
    d.getUTCMonth() + 1 === input.month &&
    d.getUTCDate() === input.day &&
    d.getUTCHours() === input.hour &&
    d.getUTCMinutes() === input.minute &&
    d.getUTCSeconds() === input.second
  );
}

function parseDatePoint(
  raw: string,
  opts: { anchorYear: number; anchorMonth: number; anchorDay: number }
): SnowbreakDatePoint | null {
  const source = raw.replace(/\s+/g, "").trim();
  if (!source) return null;
  if (source.includes("常驻")) return null;

  let year: number | null = null;
  let month: number | null = null;
  let day: number | null = null;
  let rest = source;

  const cnDate = /(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日?/.exec(source);
  if (cnDate) {
    month = Number(cnDate[2]);
    day = Number(cnDate[3]);
    year = cnDate[1]
      ? Number(cnDate[1])
      : inferYear(month, opts.anchorYear, opts.anchorMonth);
    rest = source.slice((cnDate.index ?? 0) + cnDate[0].length);
  } else {
    const slashDate = /(?:(\d{4})[./-])?(\d{1,2})[./-](\d{1,2})/.exec(source);
    if (slashDate) {
      month = Number(slashDate[2]);
      day = Number(slashDate[3]);
      year = slashDate[1]
        ? Number(slashDate[1])
        : inferYear(month, opts.anchorYear, opts.anchorMonth);
      rest = source.slice((slashDate.index ?? 0) + slashDate[0].length);
    }
  }

  if (year === null || month === null || day === null) {
    if (source.includes("维护后")) {
      return {
        year: opts.anchorYear,
        month: opts.anchorMonth,
        day: opts.anchorDay,
        hour: 4,
        minute: 0,
        second: 0,
      };
    }
    return null;
  }

  let hour = source.includes("维护后") ? 4 : 0;
  let minute = 0;
  let second = 0;

  const hms = /(\d{1,2})[:：](\d{1,2})(?:[:：](\d{1,2}))?/.exec(rest);
  if (hms) {
    hour = Number(hms[1]);
    minute = Number(hms[2]);
    second = Number(hms[3] ?? "0");
  } else {
    const dot = /(\d{1,2})点(?:(\d{1,2})分?)?/.exec(rest);
    if (dot) {
      hour = Number(dot[1]);
      minute = Number(dot[2] ?? "0");
      second = 0;
    }
  }

  const parsed: SnowbreakDatePoint = { year, month, day, hour, minute, second };
  if (!isValidDatePoint(parsed)) return null;
  return parsed;
}

function formatNaiveDateTime(input: SnowbreakDatePoint): string {
  const yyyy = String(input.year);
  const mo = String(input.month).padStart(2, "0");
  const dd = String(input.day).padStart(2, "0");
  const hh = String(input.hour).padStart(2, "0");
  const mi = String(input.minute).padStart(2, "0");
  const ss = String(input.second).padStart(2, "0");
  return `${yyyy}-${mo}-${dd} ${hh}:${mi}:${ss}`;
}

function parseTimeRange(raw: string): { startRaw: string; endRaw: string } | null {
  const m = /(.+?)\s*(?:-|~|～|至|到|—|–|\u2013|\u2014)\s*(.+)/.exec(raw);
  if (!m) return null;
  return { startRaw: m[1].trim(), endRaw: m[2].trim() };
}

function normalizeSectionTitle(input: string): string {
  return normalizeTitle(input.replace(/^[一二三四五六七八九十]+、\s*/, ""));
}

function normalizeTimePrefix(input: string): string {
  return normalizeTitle(input.replace(/[：:]/g, ""));
}

function buildEventTitle(baseTitle: string, prefix: string): string {
  const base = normalizeSectionTitle(baseTitle);
  const p = normalizeTimePrefix(prefix);
  if (!p || p === "活动") return base;
  if (p === "上半期" || p === "下半期") return `${base}（${p}）`;
  if (base.includes(p)) return base;
  return `${base}·${p}`;
}

function isWantedSnowbreakActivityTitle(title: string): boolean {
  if (!title) return false;
  if (SNOWBREAK_ACTIVITY_EXCLUDE_WORDS.some((w) => title.includes(w))) return false;
  return SNOWBREAK_ACTIVITY_INCLUDE_WORDS.some((w) => title.includes(w));
}

function stableHash64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;

  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }

  return hash.toString(16).padStart(16, "0");
}

function stableEventId(title: string, startTime: string, endTime: string): string {
  return stableHash64(`${title}|${startTime}|${endTime}`);
}

function extractEventsFromBlocks(
  blocks: ParsedBlock[],
  opts: {
    anchorYear: number;
    anchorMonth: number;
    anchorDay: number;
    sourceTzOffset: string;
  }
): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    const blockContent = [block.title, ...block.lines].join("<br>");

    for (const line of block.lines) {
      const timeLine = /^([^:：]{0,24}?)活动时间[:：]\s*(.+)$/.exec(line);
      if (!timeLine) continue;

      const range = parseTimeRange(timeLine[2] ?? "");
      if (!range) continue;

      const startPoint = parseDatePoint(range.startRaw, opts);
      const endPoint = parseDatePoint(range.endRaw, opts);
      if (!startPoint || !endPoint) continue;

      const startNaive = formatNaiveDateTime(startPoint);
      const endNaive = formatNaiveDateTime(endPoint);
      const startIso = toIsoWithSourceOffset(startNaive, opts.sourceTzOffset);
      const endIso = toIsoWithSourceOffset(endNaive, opts.sourceTzOffset);

      const sMs = Date.parse(startIso);
      const eMs = Date.parse(endIso);
      if (!Number.isFinite(sMs) || !Number.isFinite(eMs) || eMs <= sMs) continue;

      const title = buildEventTitle(block.title, timeLine[1] ?? "");
      if (!isWantedSnowbreakActivityTitle(title)) continue;

      const dedupeKey = `${title}|${startIso}|${endIso}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      out.push({
        id: stableEventId(title, startIso, endIso),
        title,
        start_time: startIso,
        end_time: endIso,
        banner: block.banner,
        content: blockContent,
      });
    }
  }

  out.sort((a, b) => {
    const sa = Date.parse(a.start_time);
    const sb = Date.parse(b.start_time);
    if (sa !== sb) return sa - sb;
    return String(a.title).localeCompare(String(b.title), "zh-Hans-CN");
  });

  return out;
}

export async function fetchSnowbreakEvents(
  env: RuntimeEnv = {}
): Promise<CalendarEvent[]> {
  const announceApiUrl =
    env.SNOWBREAK_ANNOUNCE_API_URL ?? SNOWBREAK_DEFAULT_ANNOUNCE_API;
  const res = await fetchJson<SnowbreakAnnResponse>(announceApiUrl, {
    timeoutMs: 12_000,
  });

  const list = Array.isArray(res.announce) ? res.announce : [];
  if (list.length === 0) return [];

  const target = list
    .map((it) => ({
      item: it,
      title: normalizeTitle(parseLocalizedText(it.title)),
    }))
    .filter((x) => x.title.endsWith("限时活动公告"))
    .sort((a, b) => Number(b.item.start_time ?? 0) - Number(a.item.start_time ?? 0))[0];

  if (!target) return [];

  const contentHtml = parseLocalizedText(target.item.content);
  if (!contentHtml) return [];

  const anchorSeconds =
    Number(target.item.end_time) > 0
      ? Number(target.item.end_time)
      : Number(target.item.start_time) > 0
        ? Number(target.item.start_time)
        : Math.trunc(Date.now() / 1000);
  const anchorDate = new Date(anchorSeconds * 1000);

  const lines = tokenizeAnnouncementLines(contentHtml);
  const blocks = parseBlocks(lines);
  const events = extractEventsFromBlocks(blocks, {
    anchorYear: anchorDate.getUTCFullYear(),
    anchorMonth: anchorDate.getUTCMonth() + 1,
    anchorDay: anchorDate.getUTCDate(),
    sourceTzOffset: SNOWBREAK_SOURCE_TZ_OFFSET,
  });

  const start = Number(target.item.start_time);
  const end = Number(target.item.end_time);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return events;
  }

  const announcementEvent: CalendarEvent = {
    id: `snowbreak-ann:${target.item.id ?? `${start}:${end}`}`,
    title: target.title || "限时活动公告",
    start_time: unixSecondsToIsoWithSourceOffset(start, SNOWBREAK_SOURCE_TZ_OFFSET),
    end_time: unixSecondsToIsoWithSourceOffset(end, SNOWBREAK_SOURCE_TZ_OFFSET),
    banner: extractFirstImgSrc(contentHtml),
    content: contentHtml,
  };

  return [...events, announcementEvent];
}
