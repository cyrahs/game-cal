import { fetchJson, fetchText } from "../lib/fetch.js";
import type { RuntimeEnv } from "../lib/runtimeEnv.js";
import { toIsoWithSourceOffset, unixSecondsToIsoWithSourceOffset } from "../lib/time.js";
import type { CalendarEvent, GameVersionInfo } from "../types.js";
import { isGachaEventTitle } from "./gacha.js";

type HypergryphAggregateItem = {
  cid?: string;
  tab?: string;
  title?: string;
  header?: string;
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

type EndfieldVersionNotice = {
  item: HypergryphAggregateItem;
  version: string;
  maintenanceEndNaive: string;
  maintenanceStartIso: string;
  maintenanceEndIso: string;
};

const ENDFIELD_WEBVIEW_DEFAULT =
  "https://ef-webview.hypergryph.com/page/game_bulletin?target=IOS";

const ENDFIELD_AGGREGATE_API_DEFAULT =
  "https://game-hub.hypergryph.com/bulletin/v2/aggregate";
const ENDFIELD_SOURCE_TZ_OFFSET = "+08:00";
const ENDFIELD_MAINTENANCE_AFTER_RESET_MS = 2 * 60 * 60 * 1000;

// Fallback: known working code observed from the webview bundle.
// This value may change upstream, so we try to auto-discover it first.
const ENDFIELD_CODE_FALLBACK = "endfield_5SD9TN";

function normalizeTitle(input: string | undefined): string {
  return (input ?? "")
    .replace(/\\[rnt]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitleKey(input: string | undefined): string {
  return normalizeTitle(input)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[「」『』“”"'’‘]/g, "")
    .replace(
      /(?:常驻活动|签到活动|引入活动|供给活动|减耗活动|趣味活动|挑战活动|限时挑战活动|叙事活动|内容更新|开放)$/u,
      ""
    );
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
    /(?:开放时间|活动时间|开启时间|开始时间)\s*(?:[:：])?\s*(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}\s*\d{1,2}:\d{2}(?::\d{2})?)/.exec(
      text
    );
  const endKw =
    /(?:结束时间|截止时间|截至|截止)\s*(?:[:：])?\s*(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}\s*\d{1,2}:\d{2}(?::\d{2})?)/.exec(
      text
    );

  return {
    start: normalizeDateTimeCandidate(startKw?.[1]),
    end: normalizeDateTimeCandidate(endKw?.[1] ?? endFromRangeWithFuzzyStart?.[1]),
  };
}

function tokenizeHtmlLines(input: string | undefined): string[] {
  return (input ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h\d|li|tr)>/gi, "\n")
    .replace(/<(p|div|h\d|li|tr)[^>]*>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function parseExplicitDateRanges(input: string): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = [];
  const re =
    /(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}\s*\d{1,2}:\d{2}(?::\d{2})?)\s*(?:-|~|～|至|到|—|–|\u2013|\u2014)\s*(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}\s*\d{1,2}:\d{2}(?::\d{2})?)/g;

  for (const match of input.matchAll(re)) {
    const start = normalizeDateTimeCandidate(match[1]);
    const end = normalizeDateTimeCandidate(match[2]);
    if (!start || !end) continue;
    out.push({ start, end });
  }

  return out;
}

function extractMaintenanceTimeRangeFromNoticeHtml(
  html: string | undefined
): { start: string | null; end: string | null } {
  const lines = tokenizeHtmlLines(html);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.includes("维护时间")) continue;
    const next = lines[i + 1] ?? "";
    const ranges = parseExplicitDateRanges(`${line} ${next}`);
    if (ranges.length === 0) continue;
    return ranges[0]!;
  }
  return { start: null, end: null };
}

function toEndfieldIso(input: string): string {
  return toIsoWithSourceOffset(input, ENDFIELD_SOURCE_TZ_OFFSET);
}

function addMsToEndfieldIso(input: string, msToAdd: number): string | null {
  const ms = Date.parse(input);
  if (!Number.isFinite(ms)) return null;
  return unixSecondsToIsoWithSourceOffset(
    Math.floor((ms + msToAdd) / 1000),
    ENDFIELD_SOURCE_TZ_OFFSET
  );
}

function inferMaintenanceStartIsoFromScheduleEnd(endNaive: string): string | null {
  const endIso = toEndfieldIso(endNaive);
  if (!Number.isFinite(Date.parse(endIso))) return null;

  if (/\s04:00(?::00)?$/.test(endNaive)) {
    return addMsToEndfieldIso(endIso, ENDFIELD_MAINTENANCE_AFTER_RESET_MS);
  }

  return endIso;
}

function inferEndfieldVersionEndIsoFromSchedule(
  item: HypergryphAggregateItem,
  currentVersionStartIso: string
): string | null {
  const lines = tokenizeHtmlLines(item.data?.html);
  let isInStaminaSupplySection = false;
  const candidates: Array<{ endIso: string; endMs: number }> = [];

  for (const line of lines) {
    const numberedTitle = /^\d+\.\s*(.+)$/.exec(line);
    if (numberedTitle?.[1]) {
      isInStaminaSupplySection = numberedTitle[1].includes("理智补给");
      continue;
    }

    if (!isInStaminaSupplySection) continue;

    for (const range of parseExplicitDateRanges(line)) {
      const endIso = inferMaintenanceStartIsoFromScheduleEnd(range.end);
      if (!endIso) continue;
      const endMs = Date.parse(endIso);
      if (Number.isFinite(endMs)) candidates.push({ endIso, endMs });
    }
  }

  const scheduleEnds = candidates
    .filter((x) => x.endMs > Date.parse(currentVersionStartIso))
    .sort((a, b) => b.endMs - a.endMs);

  const latest = scheduleEnds[0];
  return latest?.endIso ?? null;
}

function extractVersionRelativeEnd(input: string): string | null {
  const dates = [...input.matchAll(/(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}\s*\d{1,2}:\d{2}(?::\d{2})?)/g)]
    .map((match) => normalizeDateTimeCandidate(match[1]))
    .filter((value): value is string => value != null);
  return dates[dates.length - 1] ?? null;
}

function extractVersionRelativeRanges(
  input: string,
  versionStartNaive: string | null
): Array<{ start: string; end: string }> {
  if (!versionStartNaive) return [];
  if (!/版本(?:开启后|更新后(?:开启)?)/.test(input)) return [];

  const end = extractVersionRelativeEnd(input);
  if (!end) return [];
  return [{ start: versionStartNaive, end }];
}

function isEndfieldVersionNotice(item: HypergryphAggregateItem): boolean {
  const title = `${item.header ?? ""} ${item.title ?? ""}`;
  return title.includes("版本更新说明");
}

function isEndfieldVersionMaintenancePreview(item: HypergryphAggregateItem): boolean {
  const title = `${item.header ?? ""} ${item.title ?? ""}`;
  return title.includes("版本更新维护预告");
}

function extractEndfieldVersionLabel(item: HypergryphAggregateItem): string | null {
  const combinedTitle = normalizeTitle(`${item.header ?? ""} ${item.title ?? ""}`);
  const titleMatch = /「([^」]+)」版本/.exec(combinedTitle);
  if (titleMatch?.[1]) return `「${normalizeTitle(titleMatch[1])}」`;

  const text = stripHtml(item.data?.html ?? "");
  const welcomeMatch = /欢迎来到全新版本「([^」]+)」/.exec(text);
  if (welcomeMatch?.[1]) return `「${normalizeTitle(welcomeMatch[1])}」`;

  const updateMatch = /更新至全新版本「([^」]+)」/.exec(text);
  if (updateMatch?.[1]) return `「${normalizeTitle(updateMatch[1])}」`;

  return null;
}

function toEndfieldVersionNotice(item: HypergryphAggregateItem): EndfieldVersionNotice | null {
  if (!isEndfieldVersionNotice(item) && !isEndfieldVersionMaintenancePreview(item)) {
    return null;
  }

  const version = extractEndfieldVersionLabel(item);
  if (!version) return null;

  const maintenance = extractMaintenanceTimeRangeFromNoticeHtml(item.data?.html);
  if (!maintenance.start || !maintenance.end) return null;

  return {
    item,
    version,
    maintenanceEndNaive: maintenance.end,
    maintenanceStartIso: toIsoWithSourceOffset(maintenance.start, ENDFIELD_SOURCE_TZ_OFFSET),
    maintenanceEndIso: toIsoWithSourceOffset(maintenance.end, ENDFIELD_SOURCE_TZ_OFFSET),
  };
}

function pickCurrentEndfieldVersionNotice(items: HypergryphAggregateItem[]): EndfieldVersionNotice | null {
  const nowMs = Date.now();
  const notices = items
    .filter(isEndfieldVersionNotice)
    .map(toEndfieldVersionNotice)
    .filter((notice): notice is EndfieldVersionNotice => notice != null)
    .sort((a, b) => Date.parse(b.maintenanceEndIso) - Date.parse(a.maintenanceEndIso));

  return (
    notices.find((notice) => Date.parse(notice.maintenanceEndIso) <= nowMs) ??
    notices[0] ??
    null
  );
}

function parseVersionNoticeTimeRanges(
  input: string,
  versionStartNaive: string | null
): Array<{ start: string; end: string }> {
  const explicit = parseExplicitDateRanges(input);
  if (explicit.length > 0) return explicit;
  return extractVersionRelativeRanges(input, versionStartNaive);
}

function buildEndfieldEvent(
  opts: {
    id: string;
    title: string;
    startNaive: string;
    endNaive: string;
    banner?: string;
    content?: string;
  }
): CalendarEvent | null {
  const startIso = toIsoWithSourceOffset(opts.startNaive, ENDFIELD_SOURCE_TZ_OFFSET);
  const endIso = toIsoWithSourceOffset(opts.endNaive, ENDFIELD_SOURCE_TZ_OFFSET);
  const sMs = Date.parse(startIso);
  const eMs = Date.parse(endIso);
  if (!Number.isFinite(sMs) || !Number.isFinite(eMs) || eMs <= sMs) return null;

  return {
    id: opts.id,
    title: opts.title,
    start_time: startIso,
    end_time: endIso,
    is_gacha: isGachaEventTitle("endfield", opts.title),
    banner: opts.banner,
    content: opts.content,
  };
}

function parseVersionNoticeEvents(
  item: HypergryphAggregateItem,
  versionStartNaive: string | null
): CalendarEvent[] {
  const html = item.data?.html;
  if (!html) return [];

  const lines = tokenizeHtmlLines(html);
  const out = new Map<string, CalendarEvent>();
  const banner = extractFirstImgSrc(html);
  let inEventSection = false;
  let currentTitle: string | null = null;

  for (const line of lines) {
    if (line.startsWith("■ ")) {
      const section = line.slice(2).trim();
      inEventSection = section === "全新活动" || section === "活动及玩法更新";
      currentTitle = null;
      continue;
    }

    if (!inEventSection) continue;

    const numberedTitle = /^\d+\.\s*(.+)$/.exec(line);
    if (numberedTitle?.[1]) {
      currentTitle = normalizeTitle(numberedTitle[1]);
      continue;
    }

    if (line.startsWith("同时，将同步开放")) {
      currentTitle = normalizeTitle(line.replace(/^同时，将同步开放/, ""));
      continue;
    }

    if (!currentTitle) continue;

    const timeLine = /^·\s*([^:：]{0,48}?)(?:[:：])\s*(.+)$/.exec(line);
    if (!timeLine) continue;

    const label = normalizeTitle(timeLine[1]);
    if (!label.includes("时间")) continue;

    const ranges = parseVersionNoticeTimeRanges(timeLine[2] ?? "", versionStartNaive);
    if (ranges.length === 0) continue;

    for (let idx = 0; idx < ranges.length; idx += 1) {
      const range = ranges[idx]!;
      const event = buildEndfieldEvent({
        id: `${item.cid ?? "version"}:${normalizeTitleKey(currentTitle)}:${range.start}:${range.end}:${idx}`,
        title: currentTitle,
        startNaive: range.start,
        endNaive: range.end,
        banner,
      });
      if (!event) continue;
      const dedupeKey = `${normalizeTitleKey(event.title)}|${event.start_time}|${event.end_time}`;
      if (!out.has(dedupeKey)) out.set(dedupeKey, event);
    }
  }

  return [...out.values()];
}

function resolveEndfieldStartNaive(
  item: HypergryphAggregateItem,
  parsedStart: string | null,
  html: string,
  versionStartNaive: string | null
): string | null {
  if (parsedStart) return parsedStart;

  const text = stripHtml(html);
  if (/版本(?:开启后|更新后(?:开启)?)/.test(text)) {
    return versionStartNaive;
  }

  if (item.startAt != null) {
    const iso = unixSecondsToIsoWithSourceOffset(item.startAt, ENDFIELD_SOURCE_TZ_OFFSET);
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) {
      return iso.slice(0, 19).replace("T", " ");
    }
  }

  return null;
}

function mergeEvents(events: CalendarEvent[]): CalendarEvent[] {
  const merged = new Map<string, CalendarEvent>();

  for (const event of events) {
    const key = `${normalizeTitleKey(event.title)}|${event.start_time}|${event.end_time}`;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, event);
      continue;
    }

    merged.set(key, {
      ...prev,
      is_gacha: prev.is_gacha || event.is_gacha,
      banner: prev.banner ?? event.banner,
      content: prev.content ?? event.content,
    });
  }

  return [...merged.values()].sort((a, b) => {
    const sa = Date.parse(a.start_time);
    const sb = Date.parse(b.start_time);
    if (sa !== sb) return sa - sb;
    return a.title.localeCompare(b.title, "zh-Hans-CN");
  });
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

  const webviewUrl = env.ENDFIELD_WEBVIEW_URL ?? ENDFIELD_WEBVIEW_DEFAULT;

  try {
    const html = await fetchText(webviewUrl, { timeoutMs: 12_000 });
    const commonsUrl = extractCommonsJsUrl(html);
    if (!commonsUrl) throw new Error("Failed to find commons.*.js in webview HTML");

    const commonsJs = await fetchText(commonsUrl, { timeoutMs: 12_000 });
    const code = extractEndfieldCodeFromCommonsJs(commonsJs);
    if (!code) throw new Error("Failed to discover Endfield bulletin code");
    return code;
  } catch {
    // Best-effort only: keep a known working fallback for resilience.
    return ENDFIELD_CODE_FALLBACK;
  }
}

async function fetchEndfieldAggregateItems(
  env: RuntimeEnv = {}
): Promise<HypergryphAggregateItem[]> {
  const aggregateBase = env.ENDFIELD_AGGREGATE_API_URL ?? ENDFIELD_AGGREGATE_API_DEFAULT;
  const code = await getEndfieldCode(env);

  const url = new URL(aggregateBase);
  url.searchParams.set("type", "0");
  url.searchParams.set("code", code);
  url.searchParams.set("hideDetail", "0");

  const res = await fetchJson<HypergryphAggregateResponse>(url.toString(), { timeoutMs: 12_000 });
  return res.data?.list ?? [];
}

export async function fetchEndfieldEvents(env: RuntimeEnv = {}): Promise<CalendarEvent[]> {
  const items = await fetchEndfieldAggregateItems(env);
  const versionNotice = pickCurrentEndfieldVersionNotice(items);
  const versionStartNaive = versionNotice?.maintenanceEndNaive ?? null;

  const tabEvents = items
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

      const startNaive = resolveEndfieldStartNaive(it, start, html, versionStartNaive);
      if (!startNaive) return [];

      const title = normalizeTitle(it.title) || it.cid || "活动";
      const event = buildEndfieldEvent({
        id: it.cid ?? `${normalizeTitle(it.title)}:${it.startAt ?? startNaive}`,
        title,
        startNaive,
        endNaive: end,
        banner: extractFirstImgSrc(html),
        content: html,
      });
      return event ? [event] : [];
    });

  const versionEvents = versionNotice
    ? parseVersionNoticeEvents(versionNotice.item, versionStartNaive)
    : [];

  return mergeEvents([...tabEvents, ...versionEvents]);
}

export async function fetchEndfieldCurrentVersion(
  env: RuntimeEnv = {}
): Promise<GameVersionInfo | null> {
  const items = await fetchEndfieldAggregateItems(env);
  const currentNotice = pickCurrentEndfieldVersionNotice(items);
  if (!currentNotice) return null;

  const nextMaintenance = items
    .map(toEndfieldVersionNotice)
    .filter((notice): notice is EndfieldVersionNotice => notice != null)
    .filter(
      (notice) =>
        Date.parse(notice.maintenanceStartIso) > Date.parse(currentNotice.maintenanceEndIso)
    )
    .sort((a, b) => Date.parse(a.maintenanceStartIso) - Date.parse(b.maintenanceStartIso))[0];

  const endTime =
    nextMaintenance?.maintenanceStartIso ??
    inferEndfieldVersionEndIsoFromSchedule(currentNotice.item, currentNotice.maintenanceEndIso);
  if (!endTime) return null;

  const info: GameVersionInfo = {
    game: "endfield",
    version: currentNotice.version,
    start_time: currentNotice.maintenanceEndIso,
    end_time: endTime,
    title: normalizeTitle(currentNotice.item.header) || normalizeTitle(currentNotice.item.title),
  };

  const annId = Number(currentNotice.item.cid);
  if (Number.isInteger(annId) && annId > 0) {
    info.ann_id = annId;
  }

  return info;
}
