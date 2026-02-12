import { fetchJson, fetchText } from "../lib/fetch.js";
import type { RuntimeEnv } from "../lib/runtimeEnv.js";
import { toIsoWithSourceOffset, unixSecondsToIsoWithSourceOffset } from "../lib/time.js";
import type { CalendarEvent } from "../types.js";
import { isGachaEventTitle } from "./gacha.js";

type HypergryphAggregateItem = {
  cid?: string;
  tab?: string;
  title?: string;
  startAt?: number;
  data?: {
    html?: string;
  };
};

type HypergryphAggregateResponse = {
  code: number;
  msg?: string;
  data?: {
    list?: HypergryphAggregateItem[];
  };
};

const ENDFIELD_WEBVIEW_DEFAULT =
  "https://ef-webview.hypergryph.com/page/game_bulletin?target=IOS";

const ENDFIELD_AGGREGATE_API_DEFAULT =
  "https://game-hub.hypergryph.com/bulletin/v2/aggregate";
const ENDFIELD_SOURCE_TZ_OFFSET = "+08:00";

// Fallback: known working code observed from the webview bundle.
// This value may change upstream, so we try to auto-discover it first.
const ENDFIELD_CODE_FALLBACK = "endfield_5SD9TN";

const CODE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
let cachedCode: { value: string; expiresAt: number } | null = null;

function normalizeTitle(input: string | undefined): string {
  return (input ?? "")
    .replace(/\\[rnt]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFirstImgSrc(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const m = /<img[^>]+src=['"]([^'"]+)['"]/i.exec(html);
  return m?.[1]?.trim() || undefined;
}

function normalizeDateTimeCandidate(input: string | undefined): string | null {
  const s = (input ?? "").trim();
  if (!s) return null;

  const m =
    /^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(
      s
    );
  if (!m) return null;

  const yyyy = m[1]!;
  const mo = String(Number(m[2]!)).padStart(2, "0");
  const dd = String(Number(m[3]!)).padStart(2, "0");
  const hh = String(Number(m[4]!)).padStart(2, "0");
  const mi = m[5]!;
  const ss = m[6] ? m[6] : null;

  return ss
    ? `${yyyy}-${mo}-${dd} ${hh}:${mi}:${ss}`
    : `${yyyy}-${mo}-${dd} ${hh}:${mi}`;
}

function extractTimeRangeFromHtml(
  html: string
): { start: string | null; end: string | null } {
  const text = stripHtml(html);

  // Prefer a clear "start - end" (or "~", "至") range.
  const range =
    /(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}\s*\d{1,2}:\d{2}(?::\d{2})?)\s*(?:-|~|～|至|到|—|–|\u2013|\u2014)\s*(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}\s*\d{1,2}:\d{2}(?::\d{2})?)/.exec(
      text
    );
  if (range) {
    return {
      start: normalizeDateTimeCandidate(range[1]),
      end: normalizeDateTimeCandidate(range[2]),
    };
  }

  // Sometimes the start is fuzzy (e.g. "公测开启") but the end is explicit.
  // In that case we still keep the end and let the caller fall back to startAt.
  const endFromRangeWithFuzzyStart =
    /(?:开放时间|活动时间|开启时间|开始时间)[^0-9]{0,80}(?:-|~|～|至|到|—|–|\u2013|\u2014)\s*(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}\s*\d{1,2}:\d{2}(?::\d{2})?)/.exec(
      text
    );

  // Fallback: try to find explicit start/end markers.
  const startKw =
    /(?:开放时间|活动时间|开启时间|开始时间)[^0-9]{0,40}(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}\s*\d{1,2}:\d{2}(?::\d{2})?)/.exec(
      text
    );
  const endKw =
    /(?:结束时间|截止时间|截至|截止)[^0-9]{0,40}(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}\s*\d{1,2}:\d{2}(?::\d{2})?)/.exec(
      text
    );

  return {
    start: normalizeDateTimeCandidate(startKw?.[1]),
    end: normalizeDateTimeCandidate(endKw?.[1] ?? endFromRangeWithFuzzyStart?.[1]),
  };
}

function extractCommonsJsUrl(html: string): string | null {
  const m = /<script[^>]+src="([^"]+\/commons\.[^"]+\.js)"/i.exec(html);
  if (m?.[1]) return m[1];
  const m2 = /https?:\/\/[^\s"'<>]+\/commons\.[^\s"'<>]+\.js/i.exec(html);
  return m2?.[0] ?? null;
}

function scoreCodeCandidate(code: string): number {
  const suffix = code.slice("endfield_".length);
  let score = suffix.length;
  if (/[0-9]/.test(suffix)) score += 10;
  if (/[A-Z]/.test(suffix)) score += 5;
  return score;
}

function extractEndfieldCodeFromCommonsJs(js: string): string | null {
  // Prefer the exact "code","endfield_XXXXXX" pattern.
  const direct = /"code","(endfield_[A-Za-z0-9]+)"/.exec(js);
  if (direct?.[1]) return direct[1];

  // Fallback: pick the best-looking endfield_* token.
  const matches = js.match(/endfield_[A-Za-z0-9]+/g) ?? [];
  const candidates = matches.filter((x) => x !== "endfield_webview");
  candidates.sort((a, b) => scoreCodeCandidate(b) - scoreCodeCandidate(a));
  return candidates[0] ?? null;
}

async function getEndfieldCode(env: RuntimeEnv): Promise<string> {
  const override = (env.ENDFIELD_CODE ?? "").trim();
  if (override) return override;

  const now = Date.now();
  if (cachedCode && cachedCode.expiresAt > now) return cachedCode.value;

  const webviewUrl = env.ENDFIELD_WEBVIEW_URL ?? ENDFIELD_WEBVIEW_DEFAULT;

  try {
    const html = await fetchText(webviewUrl, { timeoutMs: 12_000 });
    const commonsUrl = extractCommonsJsUrl(html);
    if (!commonsUrl) throw new Error("Failed to find commons.*.js in webview HTML");

    const commonsJs = await fetchText(commonsUrl, { timeoutMs: 12_000 });
    const code = extractEndfieldCodeFromCommonsJs(commonsJs);
    if (!code) throw new Error("Failed to discover Endfield bulletin code");

    cachedCode = { value: code, expiresAt: Date.now() + CODE_CACHE_TTL_MS };
    return code;
  } catch {
    // Best-effort only: keep a known working fallback for resilience.
    return ENDFIELD_CODE_FALLBACK;
  }
}

export async function fetchEndfieldEvents(env: RuntimeEnv = {}): Promise<CalendarEvent[]> {
  const aggregateBase = env.ENDFIELD_AGGREGATE_API_URL ?? ENDFIELD_AGGREGATE_API_DEFAULT;
  const code = await getEndfieldCode(env);

  const url = new URL(aggregateBase);
  url.searchParams.set("type", "0");
  url.searchParams.set("code", code);
  url.searchParams.set("hideDetail", "0");

  const res = await fetchJson<HypergryphAggregateResponse>(url.toString(), { timeoutMs: 12_000 });
  const items = res.data?.list ?? [];

  return items
    .filter((it) => {
      const tab = String(it.tab ?? "").toLowerCase();
      return tab === "events" || tab === "event";
    })
    .flatMap((it): CalendarEvent[] => {
      const html = it.data?.html;
      if (!html) return [];

      const { start, end } = extractTimeRangeFromHtml(html);
      if (!end) {
        // End time is missing or fuzzy -> treat as long-term and hide.
        return [];
      }

      const startIso = start
        ? toIsoWithSourceOffset(start, ENDFIELD_SOURCE_TZ_OFFSET)
        : it.startAt != null
          ? unixSecondsToIsoWithSourceOffset(it.startAt, ENDFIELD_SOURCE_TZ_OFFSET)
          : null;

      if (!startIso) return [];

      const endIso = toIsoWithSourceOffset(end, ENDFIELD_SOURCE_TZ_OFFSET);

      const sMs = Date.parse(startIso);
      const eMs = Date.parse(endIso);
      if (!Number.isFinite(sMs) || !Number.isFinite(eMs) || eMs <= sMs) return [];
      const title = normalizeTitle(it.title) || it.cid || "活动";

      return [
        {
          id: it.cid ?? `${normalizeTitle(it.title)}:${it.startAt ?? startIso}`,
          title,
          start_time: startIso,
          end_time: endIso,
          is_gacha: isGachaEventTitle("endfield", title),
          banner: extractFirstImgSrc(html),
          content: html,
        },
      ];
    });
}
