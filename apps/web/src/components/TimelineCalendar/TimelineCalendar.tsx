import clsx from "clsx";
import DOMPurify from "dompurify";
import dayjs, { type Dayjs } from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import isoWeek from "dayjs/plugin/isoWeek";
import utc from "dayjs/plugin/utc";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CalendarEvent, GameId } from "../../api/types";
import { useTheme } from "../../context/theme";
import {
  type RecurringActivity,
  type RecurringRule,
  usePrefs,
} from "../../context/prefs";

import genshinIcon from "../../assets/genshin.png";
import starrailIcon from "../../assets/starrail.png";
import wwIcon from "../../assets/wutheringwave.png";
import zzzIcon from "../../assets/zzz.png";
import endfieldIcon from "../../assets/endfield.png";
import snowbreakIcon from "../../assets/snowbreak.png";

dayjs.extend(customParseFormat);
dayjs.extend(isoWeek);
dayjs.extend(utc);

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const UPSTREAM_URGENT_WINDOW_MS = 3 * DAY_MS;
const RECURRING_URGENT_WINDOW_MS = DAY_MS;
const TIMELINE_BAR_GRADIENTS = [
  ["#73869B", "#8193A6"],
  ["#71ADDC", "#83B9E2"],
  ["#83ACBB", "#94B9C6"],
  ["#B4D27C", "#C1DB93"],
  ["#DEAC7C", "#E6BC93"],
  ["#AB5548", "#BC6A5F"],
  ["#83ACBB", "#71ADDC"],
  ["#73869B", "#83ACBB"],
  ["#B4D27C", "#DEAC7C"],
  ["#DEAC7C", "#C98363"],
] as const;

type ParsedEvent = CalendarEvent & { _s: Dayjs; _e: Dayjs };
type ParsedUpstreamEvent = ParsedEvent & { kind: "upstream" };
type ParsedRecurringEvent = ParsedEvent & {
  kind: "recurring";
  recurringActivityId: string;
  cycleKey: string;
};
type AnyParsedEvent = ParsedUpstreamEvent | ParsedRecurringEvent;
const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;
const RECURRING_TZ_OFFSET_MINUTES_BY_GAME: Record<GameId, number> = {
  genshin: 8 * 60,
  starrail: 8 * 60,
  zzz: 8 * 60,
  ww: 8 * 60,
  snowbreak: 8 * 60,
  endfield: 8 * 60,
};

function getRecurringTzOffsetMinutes(gameId: GameId): number {
  return RECURRING_TZ_OFFSET_MINUTES_BY_GAME[gameId] ?? 8 * 60;
}

export function isUrgentByRemainingMs(kind: "upstream" | "recurring", remainingMs: number): boolean {
  if (remainingMs <= 0) return false;
  const threshold = kind === "recurring" ? RECURRING_URGENT_WINDOW_MS : UPSTREAM_URGENT_WINDOW_MS;
  return remainingMs <= threshold;
}

function toIsoWithOffset(d: Dayjs): string {
  return d.format("YYYY-MM-DDTHH:mm:ssZ");
}

function formatFixedUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(Math.trunc(offsetMinutes));
  const hh = Math.floor(abs / 60);
  const mm = abs % 60;
  if (mm === 0) return `UTC${sign}${hh}`;
  return `UTC${sign}${hh}:${String(mm).padStart(2, "0")}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function detectUniformStep(values: number[], min: number, max: number): { start: number; step: number } | null {
  if (values.length < 2) return null;
  const start = values[0]!;
  const step = values[1]! - values[0]!;
  if (step <= 1) return null;
  if (start < min || values[values.length - 1]! > max) return null;
  for (let i = 1; i < values.length; i++) {
    if (values[i]! - values[i - 1]! !== step) return null;
  }
  // Ensure this is a full stepped sequence to range end, not an arbitrary subset.
  if (values[values.length - 1]! + step <= max) return null;
  return { start, step };
}

function formatCronHumanReadable(expression: string): string {
  const { parsed } = validateCronExpression(expression);
  if (!parsed) return `Cron：${expression}`;

  if (parsed.hour.values.length !== 1 || parsed.minute.values.length !== 1) {
    return `Cron：${expression}`;
  }

  const hh = pad2(parsed.hour.values[0]!);
  const mm = pad2(parsed.minute.values[0]!);
  const time = `${hh}:${mm}`;

  const dom = parsed.dayOfMonth.values;
  const month = parsed.month.values;
  const dow = parsed.dayOfWeek.values;

  const domAny = parsed.dayOfMonth.wildcard;
  const monthAny = parsed.month.wildcard;
  const dowAny = parsed.dayOfWeek.wildcard;

  const domText = dom.join("、");
  const monthText = month.join("、");
  const dowText = dow.map((d) => WEEKDAY_NAMES[d] ?? `周${d}`).join("、");

  const monthLabel = (() => {
    if (monthAny) return "";
    if (month.length === 1) return `每年${month[0]}月`;
    const stepped = detectUniformStep(month, 1, 12);
    if (stepped) {
      if (stepped.start === 1) return `每${stepped.step}个月`;
      return `每${stepped.step}个月（从${stepped.start}月开始）`;
    }
    return `每年${monthText}月`;
  })();

  if (monthAny) {
    if (domAny && dowAny) return `每天 ${time}`;
    if (!domAny && dowAny) return `每月${domText}日 ${time}`;
    if (domAny && !dowAny) return `每${dowText} ${time}`;
    return `每月${domText}日 或 每${dowText} ${time}`;
  }

  if (domAny && dowAny) return `${monthLabel} 每天 ${time}`;
  if (!domAny && dowAny) return `${monthLabel}${domText}日 ${time}`;
  if (domAny && !dowAny) return `${monthLabel} 每${dowText} ${time}`;
  return `${monthLabel}${domText}日 或 每${dowText} ${time}`;
}

function formatRecurringRule(gameId: GameId, rule: RecurringRule, durationDays?: number): string {
  const tzLabel = formatFixedUtcOffset(getRecurringTzOffsetMinutes(gameId));
  let base: string;
  if (rule.kind === "cron") {
    base = `${formatCronHumanReadable(rule.expression)}（${tzLabel}）`;
  } else if (rule.kind === "monthly") {
    const hh = String(rule.hour).padStart(2, "0");
    const mm = String(rule.minute).padStart(2, "0");
    base = `每月${rule.day}日 ${hh}:${mm} 刷新（${tzLabel}）`;
  } else if (rule.kind === "weekly") {
    const hh = String(rule.hour).padStart(2, "0");
    const mm = String(rule.minute).padStart(2, "0");
    const wd = WEEKDAY_NAMES[rule.weekday] ?? `周${rule.weekday}`;
    base = `每${wd} ${hh}:${mm} 刷新（${tzLabel}）`;
  } else if (rule.kind === "interval") {
    const hh = String(rule.hour).padStart(2, "0");
    const mm = String(rule.minute).padStart(2, "0");
    base = `自 ${rule.startDate} 起每 ${rule.everyDays} 天 ${hh}:${mm} 刷新（${tzLabel}）`;
  } else {
    base = `未知循环规则（${tzLabel}）`;
  }
  const safeDurationDays =
    Number.isFinite(durationDays) && durationDays != null
      ? Math.max(1, Math.trunc(durationDays))
      : null;
  if (safeDurationDays == null) return base;
  return `${base}，持续 ${safeDurationDays} 天`;
}

function clampDayOfMonth(d: Dayjs, day: number): number {
  return Math.min(Math.max(1, day), d.daysInMonth());
}

type CronField = {
  values: number[];
  valueSet: Set<number>;
  wildcard: boolean;
};

type ParsedCronExpression = {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
};

const CRON_MAX_SEARCH_MINUTES = 5 * 366 * 24 * 60;

function parseCronField(
  raw: string,
  min: number,
  max: number,
  opts?: { dayOfWeek?: boolean }
): { field: CronField | null; error: string | null } {
  const isDow = opts?.dayOfWeek ?? false;
  const source = raw.trim();
  if (!source) return { field: null, error: "Cron 字段为空" };

  const wildcard = source === "*";
  const set = new Set<number>();

  const normalize = (value: number): number => {
    if (!isDow) return value;
    return value === 7 ? 0 : value;
  };

  const addValue = (value: number) => {
    const n = normalize(value);
    if (n < min || n > max) return;
    set.add(n);
  };

  const addRange = (startRaw: number, endRaw: number, stepRaw: number) => {
    const step = Math.trunc(stepRaw);
    if (!Number.isFinite(step) || step <= 0) return false;
    const start = Math.trunc(startRaw);
    const end = Math.trunc(endRaw);
    if (start > end) return false;
    for (let v = start; v <= end; v += step) addValue(v);
    return true;
  };

  const rawMin = isDow ? 0 : min;
  const rawMax = isDow ? 7 : max;

  for (const part of source.split(",")) {
    const token = part.trim();
    if (!token) return { field: null, error: `Cron 字段包含空片段：${raw}` };

    let matched = false;

    if (token === "*") {
      if (!addRange(rawMin, rawMax, 1)) return { field: null, error: `Cron 字段无效：${raw}` };
      matched = true;
    }

    if (!matched) {
      const m = token.match(/^\*\/(\d+)$/);
      if (m) {
        const step = Number(m[1]);
        if (!addRange(rawMin, rawMax, step)) return { field: null, error: `Cron 步长无效：${token}` };
        matched = true;
      }
    }

    if (!matched) {
      const m = token.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
      if (m) {
        const start = Number(m[1]);
        const end = Number(m[2]);
        const step = m[3] ? Number(m[3]) : 1;
        if (!addRange(start, end, step)) return { field: null, error: `Cron 范围无效：${token}` };
        matched = true;
      }
    }

    if (!matched) {
      const m = token.match(/^(\d+)\/(\d+)$/);
      if (m) {
        const start = Number(m[1]);
        const step = Number(m[2]);
        if (!addRange(start, rawMax, step)) return { field: null, error: `Cron 递增无效：${token}` };
        matched = true;
      }
    }

    if (!matched) {
      const m = token.match(/^(\d+)$/);
      if (m) {
        addValue(Number(m[1]));
        matched = true;
      }
    }

    if (!matched) return { field: null, error: `Cron 语法不支持：${token}` };
  }

  const values = [...set].sort((a, b) => a - b);
  if (values.length === 0) return { field: null, error: `Cron 数值超出范围：${raw}` };
  return { field: { values, valueSet: set, wildcard }, error: null };
}

function parseCronExpression(expression: string): { parsed: ParsedCronExpression | null; error: string | null } {
  const raw = expression.trim();
  const parts = raw.split(/\s+/);
  if (parts.length !== 5) return { parsed: null, error: "Cron 需为 5 段：分 时 日 月 周" };

  const minute = parseCronField(parts[0]!, 0, 59);
  if (!minute.field || minute.error) return { parsed: null, error: minute.error };

  const hour = parseCronField(parts[1]!, 0, 23);
  if (!hour.field || hour.error) return { parsed: null, error: hour.error };

  const dayOfMonth = parseCronField(parts[2]!, 1, 31);
  if (!dayOfMonth.field || dayOfMonth.error) return { parsed: null, error: dayOfMonth.error };

  const month = parseCronField(parts[3]!, 1, 12);
  if (!month.field || month.error) return { parsed: null, error: month.error };

  const dayOfWeek = parseCronField(parts[4]!, 0, 6, { dayOfWeek: true });
  if (!dayOfWeek.field || dayOfWeek.error) return { parsed: null, error: dayOfWeek.error };

  return {
    parsed: {
      minute: minute.field,
      hour: hour.field,
      dayOfMonth: dayOfMonth.field,
      month: month.field,
      dayOfWeek: dayOfWeek.field,
    },
    error: null,
  };
}

function maxDayOfMonth(month: number): number {
  if (month === 2) return 29;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

function isCronScheduleReachable(parsed: ParsedCronExpression): boolean {
  // Cron semantics: if day-of-week is restricted, schedule remains reachable regardless of day-of-month.
  if (!parsed.dayOfWeek.wildcard) return true;
  if (parsed.dayOfMonth.wildcard) return true;

  for (const month of parsed.month.values) {
    const maxDay = maxDayOfMonth(month);
    for (const day of parsed.dayOfMonth.values) {
      if (day <= maxDay) return true;
    }
  }
  return false;
}

function validateCronExpression(expression: string): { parsed: ParsedCronExpression | null; error: string | null } {
  const parsed = parseCronExpression(expression);
  if (!parsed.parsed || parsed.error) return parsed;
  if (!isCronScheduleReachable(parsed.parsed)) {
    return { parsed: null, error: "Cron 不会触发：所选月份中不存在对应日期" };
  }
  return { parsed: parsed.parsed, error: null };
}

function cronDayMatches(parsed: ParsedCronExpression, d: Dayjs): boolean {
  const domMatch = parsed.dayOfMonth.valueSet.has(d.date());
  const dowMatch = parsed.dayOfWeek.valueSet.has(d.day());
  if (parsed.dayOfMonth.wildcard && parsed.dayOfWeek.wildcard) return true;
  if (parsed.dayOfMonth.wildcard) return dowMatch;
  if (parsed.dayOfWeek.wildcard) return domMatch;
  return domMatch || dowMatch;
}

function nextGreater(values: number[], current: number): number | null {
  for (const v of values) {
    if (v > current) return v;
  }
  return null;
}

function prevLess(values: number[], current: number): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i]!;
    if (v < current) return v;
  }
  return null;
}

function findNextCronOccurrence(parsed: ParsedCronExpression, from: Dayjs): Dayjs | null {
  let cursor = from.second(0).millisecond(0).add(1, "minute");

  for (let i = 0; i < CRON_MAX_SEARCH_MINUTES; i++) {
    const month = cursor.month() + 1;
    if (!parsed.month.valueSet.has(month)) {
      const nextMonth = nextGreater(parsed.month.values, month);
      const targetMonth = nextMonth ?? parsed.month.values[0]!;
      cursor = (nextMonth == null ? cursor.add(1, "year") : cursor)
        .date(1)
        .month(targetMonth - 1)
        .hour(0)
        .minute(0)
        .second(0)
        .millisecond(0);
      continue;
    }

    if (!cronDayMatches(parsed, cursor)) {
      cursor = cursor.add(1, "day").hour(0).minute(0).second(0).millisecond(0);
      continue;
    }

    const hour = cursor.hour();
    if (!parsed.hour.valueSet.has(hour)) {
      const nextHour = nextGreater(parsed.hour.values, hour);
      if (nextHour == null) {
        cursor = cursor
          .add(1, "day")
          .hour(parsed.hour.values[0]!)
          .minute(0)
          .second(0)
          .millisecond(0);
      } else {
        cursor = cursor.hour(nextHour).minute(0).second(0).millisecond(0);
      }
      continue;
    }

    const minute = cursor.minute();
    if (!parsed.minute.valueSet.has(minute)) {
      const nextMinute = nextGreater(parsed.minute.values, minute);
      if (nextMinute == null) {
        cursor = cursor
          .add(1, "hour")
          .minute(parsed.minute.values[0]!)
          .second(0)
          .millisecond(0);
      } else {
        cursor = cursor.minute(nextMinute).second(0).millisecond(0);
      }
      continue;
    }

    return cursor.second(0).millisecond(0);
  }

  return null;
}

function findPrevCronOccurrence(parsed: ParsedCronExpression, from: Dayjs): Dayjs | null {
  let cursor = from.second(0).millisecond(0);

  for (let i = 0; i < CRON_MAX_SEARCH_MINUTES; i++) {
    const month = cursor.month() + 1;
    if (!parsed.month.valueSet.has(month)) {
      const prevMonth = prevLess(parsed.month.values, month);
      const targetMonth = prevMonth ?? parsed.month.values[parsed.month.values.length - 1]!;
      cursor = (prevMonth == null ? cursor.subtract(1, "year") : cursor)
        .date(1)
        .month(targetMonth - 1)
        .endOf("month")
        .hour(23)
        .minute(59)
        .second(0)
        .millisecond(0);
      continue;
    }

    if (!cronDayMatches(parsed, cursor)) {
      cursor = cursor.subtract(1, "day").hour(23).minute(59).second(0).millisecond(0);
      continue;
    }

    const hour = cursor.hour();
    if (!parsed.hour.valueSet.has(hour)) {
      const prevHour = prevLess(parsed.hour.values, hour);
      if (prevHour == null) {
        cursor = cursor
          .subtract(1, "day")
          .hour(parsed.hour.values[parsed.hour.values.length - 1]!)
          .minute(59)
          .second(0)
          .millisecond(0);
      } else {
        cursor = cursor.hour(prevHour).minute(59).second(0).millisecond(0);
      }
      continue;
    }

    const minute = cursor.minute();
    if (!parsed.minute.valueSet.has(minute)) {
      const prevMinute = prevLess(parsed.minute.values, minute);
      if (prevMinute == null) {
        cursor = cursor
          .subtract(1, "hour")
          .minute(parsed.minute.values[parsed.minute.values.length - 1]!)
          .second(0)
          .millisecond(0);
      } else {
        cursor = cursor.minute(prevMinute).second(0).millisecond(0);
      }
      continue;
    }

    return cursor.second(0).millisecond(0);
  }

  return null;
}

function resolveRecurringEnd(start: Dayjs, fallbackEnd: Dayjs, durationDays?: number): Dayjs {
  if (!Number.isFinite(durationDays) || durationDays == null) return fallbackEnd;
  const safeDurationDays = Math.max(1, Math.trunc(durationDays));
  return start.add(safeDurationDays, "day");
}

export function computeRecurringWindow(
  now: Dayjs,
  gameId: GameId,
  activity: RecurringActivity
): { start: Dayjs; end: Dayjs; cycleKey: string } {
  const offsetMin = getRecurringTzOffsetMinutes(gameId);
  const n = now.utcOffset(offsetMin);

  if (activity.rule.kind === "cron") {
    const { parsed } = parseCronExpression(activity.rule.expression);
    if (!parsed) return { start: dayjs("invalid"), end: dayjs("invalid"), cycleKey: "" };

    const prev = findPrevCronOccurrence(parsed, n);
    const next = findNextCronOccurrence(parsed, n);
    if (!prev || !next || !next.isAfter(prev)) {
      return { start: dayjs("invalid"), end: dayjs("invalid"), cycleKey: "" };
    }

    return { start: prev, end: resolveRecurringEnd(prev, next, activity.durationDays), cycleKey: toIsoWithOffset(prev) };
  }

  if (activity.rule.kind === "monthly") {
    const { day, hour, minute } = activity.rule;

    const thisMonthStart = n.startOf("month");
    const thisMonthDay = clampDayOfMonth(thisMonthStart, day);
    const thisMonth = thisMonthStart
      .date(thisMonthDay)
      .hour(hour)
      .minute(minute)
      .second(0)
      .millisecond(0);

    const start =
      n.isBefore(thisMonth) ? (() => {
        const prevMonthStart = thisMonthStart.subtract(1, "month");
        const prevDay = clampDayOfMonth(prevMonthStart, day);
        return prevMonthStart
          .date(prevDay)
          .hour(hour)
          .minute(minute)
          .second(0)
          .millisecond(0);
      })() : thisMonth;

    const nextMonthStart = start.startOf("month").add(1, "month");
    const nextDay = clampDayOfMonth(nextMonthStart, day);
    const end = nextMonthStart
      .date(nextDay)
      .hour(hour)
      .minute(minute)
      .second(0)
      .millisecond(0);

    return { start, end: resolveRecurringEnd(start, end, activity.durationDays), cycleKey: toIsoWithOffset(start) };
  }

  if (activity.rule.kind === "interval") {
    const { startDate, everyDays, hour, minute } = activity.rule;
    const startBase = dayjs(`${startDate} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, "YYYY-MM-DD HH:mm", true);
    const anchor = startBase
      .utcOffset(offsetMin, true)
      .second(0)
      .millisecond(0);

    const safeEveryDays = Math.max(1, Math.trunc(everyDays));

    if (n.isBefore(anchor)) {
      const fallbackEnd = anchor.add(safeEveryDays, "day");
      return {
        start: anchor,
        end: resolveRecurringEnd(anchor, fallbackEnd, activity.durationDays),
        cycleKey: toIsoWithOffset(anchor),
      };
    }

    const diffMs = n.valueOf() - anchor.valueOf();
    const spanMs = safeEveryDays * DAY_MS;
    const step = Math.floor(diffMs / spanMs);
    const start = anchor.add(step * safeEveryDays, "day");
    const fallbackEnd = start.add(safeEveryDays, "day");
    return {
      start,
      end: resolveRecurringEnd(start, fallbackEnd, activity.durationDays),
      cycleKey: toIsoWithOffset(start),
    };
  }

  const { weekday, hour, minute } = activity.rule;
  const nowDow = n.day();
  const diffDays = (nowDow - weekday + 7) % 7;
  let start = n
    .subtract(diffDays, "day")
    .hour(hour)
    .minute(minute)
    .second(0)
    .millisecond(0);
  if (n.isBefore(start)) start = start.subtract(7, "day");
  const fallbackEnd = start.add(7, "day");
  return {
    start,
    end: resolveRecurringEnd(start, fallbackEnd, activity.durationDays),
    cycleKey: toIsoWithOffset(start),
  };
}

const GAME_META: Record<GameId, { name: string; icon: string }> = {
  genshin: { name: "原神", icon: genshinIcon },
  starrail: { name: "崩坏：星穹铁道", icon: starrailIcon },
  ww: { name: "鸣潮", icon: wwIcon },
  zzz: { name: "绝区零", icon: zzzIcon },
  snowbreak: { name: "尘白禁区", icon: snowbreakIcon },
  endfield: { name: "明日方舟：终末地", icon: endfieldIcon },
};

export function parseDateTime(input: string): Dayjs {
  // Safari does not reliably parse "YYYY-MM-DD HH:mm" without custom parsing.
  const formats = ["YYYY-MM-DD HH:mm:ss", "YYYY-MM-DD HH:mm", "YYYY-MM-DD"];
  for (const fmt of formats) {
    const d = dayjs(input, fmt, true);
    if (d.isValid()) return d;
  }
  return dayjs(input);
}

function normalizeEventTitle(input: string): string {
  // Some upstream titles contain literal "\n" sequences; normalize them to a single-line label.
  return input.replace(/\\[rnt]/g, " ").replace(/\s+/g, " ").trim();
}

function formatRange(s: string, e: string) {
  const sd = parseDateTime(s);
  const ed = parseDateTime(e);
  if (!sd.isValid() || !ed.isValid()) return `${s} ~ ${e}`;
  return `${sd.format("MM/DD HH:mm")} ~ ${ed.format("MM/DD HH:mm")}`;
}

function preprocessAnnContent(input: string): string {
  // miHoYo announcements sometimes escape their <t ...>time</t> placeholders, e.g.
  // "&lt;t class=\"t_lc\"&gt;2026/03/23 03:59:00&lt;/t&gt;". Keep only the timestamp text.
  return input.replace(/&lt;t[^&]*?&gt;([\s\S]*?)&lt;\/t&gt;/g, "$1");
}

function looksLikeHtml(input: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(input);
}

type Rgb = { r: number; g: number; b: number };
type Rgba = Rgb & { a: number };
type Hsl = { h: number; s: number; l: number };

type EventDetailVariant = "titleBanner" | "sideImage" | "none";

const DARK_ANN_BASE_BG: Rgb = { r: 11, g: 16, b: 32 }; // matches --bg0 in dark mode (approx)
const MIN_ANN_TEXT_CONTRAST = 4.5;
let COLOR_PARSE_CTX: CanvasRenderingContext2D | null = null;

const EVENT_DETAIL_VARIANT_BY_GAME: Record<GameId, EventDetailVariant> = {
  genshin: "titleBanner",
  starrail: "titleBanner",
  zzz: "titleBanner",
  ww: "sideImage",
  snowbreak: "none",
  endfield: "none",
};

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function srgbToLinear(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function relativeLuminance(rgb: Rgb): number {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fg: Rgb, bg: Rgb): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

function blendOver(bg: Rgb, fg: Rgb, alpha: number): Rgb {
  const a = clamp(alpha, 0, 1);
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
  };
}

function parseHexColor(input: string): Rgba | null {
  const hex = input.trim().replace(/^#/, "");
  if (![3, 4, 6, 8].includes(hex.length)) return null;

  function expand(n: string): string {
    return n.length === 1 ? `${n}${n}` : n;
  }

  const r = parseInt(expand(hex.slice(0, hex.length === 3 || hex.length === 4 ? 1 : 2)), 16);
  const g = parseInt(
    expand(hex.slice(hex.length === 3 || hex.length === 4 ? 1 : 2, hex.length === 3 || hex.length === 4 ? 2 : 4)),
    16
  );
  const b = parseInt(
    expand(hex.slice(hex.length === 3 || hex.length === 4 ? 2 : 4, hex.length === 3 || hex.length === 4 ? 3 : 6)),
    16
  );
  const a = hex.length === 4 ? parseInt(expand(hex.slice(3, 4)), 16) : hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255;

  if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;
  return { r, g, b, a: a / 255 };
}

function parseRgbFunc(input: string): Rgba | null {
  const m = input.trim().match(/^rgba?\((.*)\)$/i);
  if (!m) return null;

  // Support both "r, g, b, a" and "r g b / a" styles.
  const raw = m[1].trim();
  const parts = raw.includes(",") ? raw.split(",").map((p) => p.trim()) : raw.split(/\s+\/?\s*/).filter(Boolean);
  if (parts.length < 3) return null;

  function parseChannel(v: string): number | null {
    if (v.endsWith("%")) {
      const n = parseFloat(v);
      if (Number.isNaN(n)) return null;
      return clamp((n / 100) * 255, 0, 255);
    }
    const n = parseFloat(v);
    if (Number.isNaN(n)) return null;
    return clamp(n, 0, 255);
  }

  function parseAlpha(v: string): number | null {
    if (v.endsWith("%")) {
      const n = parseFloat(v);
      if (Number.isNaN(n)) return null;
      return clamp(n / 100, 0, 1);
    }
    const n = parseFloat(v);
    if (Number.isNaN(n)) return null;
    return clamp(n, 0, 1);
  }

  const r = parseChannel(parts[0]);
  const g = parseChannel(parts[1]);
  const b = parseChannel(parts[2]);
  if (r === null || g === null || b === null) return null;
  const a = parts.length >= 4 ? parseAlpha(parts[3]) : 1;
  if (a === null) return null;

  return { r, g, b, a };
}

function parseCssColor(input: string): Rgba | null {
  const s = input.trim();
  if (!s) return null;
  if (s.startsWith("#")) return parseHexColor(s);
  if (/^rgba?\(/i.test(s)) return parseRgbFunc(s);

  // Fallback for named colors / hsl() etc. (keeps parsing local; no DOM attachment).
  if (typeof document === "undefined") return null;
  if (typeof CSS !== "undefined" && typeof CSS.supports === "function" && !CSS.supports("color", s)) return null;

  try {
    if (!COLOR_PARSE_CTX) {
      const canvas = document.createElement("canvas");
      COLOR_PARSE_CTX = canvas.getContext("2d");
    }
    const ctx = COLOR_PARSE_CTX;
    if (!ctx) return null;
    ctx.fillStyle = s;
    const normalized = ctx.fillStyle;
    if (normalized.startsWith("#")) return parseHexColor(normalized);
    if (/^rgba?\(/i.test(normalized)) return parseRgbFunc(normalized);
  } catch {
    // ignore
  }

  return null;
}

function rgbToHsl(rgb: Rgb): Hsl {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) return { h: 0, s: 0, l };

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  switch (max) {
    case r:
      h = (g - b) / d + (g < b ? 6 : 0);
      break;
    case g:
      h = (b - r) / d + 2;
      break;
    default:
      h = (r - g) / d + 4;
      break;
  }
  h /= 6;
  return { h, s, l };
}

function hslToRgb(hsl: Hsl): Rgb {
  const { h, s } = hsl;
  const l = clamp(hsl.l, 0, 1);

  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  function hue2rgb(t: number): number {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  }

  const r = hue2rgb(h + 1 / 3);
  const g = hue2rgb(h);
  const b = hue2rgb(h - 1 / 3);
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

function adjustRgbForContrast(fg: Rgb, bg: Rgb, minRatio: number): Rgb {
  if (contrastRatio(fg, bg) >= minRatio) return fg;

  const fgHsl = rgbToHsl(fg);
  const bgLum = relativeLuminance(bg);

  // Decide direction based on the background luminance (works even when fg is *darker* than a dark bg).
  const lighten = bgLum < 0.4;
  const startL = fgHsl.l;

  let best = fg;

  if (lighten) {
    let lo = startL;
    let hi = 1;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      const cand = hslToRgb({ ...fgHsl, l: mid });
      if (contrastRatio(cand, bg) >= minRatio) {
        best = cand;
        hi = mid;
      } else {
        lo = mid;
      }
    }
    return best;
  }

  let lo = 0;
  let hi = startL;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    const cand = hslToRgb({ ...fgHsl, l: mid });
    if (contrastRatio(cand, bg) >= minRatio) {
      best = cand;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
}

function rgbToCss(rgb: Rgb): string {
  return `rgb(${clamp(Math.round(rgb.r), 0, 255)}, ${clamp(Math.round(rgb.g), 0, 255)}, ${clamp(Math.round(rgb.b), 0, 255)})`;
}

function normalizeAnnouncementHtml(html: string, theme: "light" | "dark"): string {
  if (theme !== "dark") return html;
  if (typeof DOMParser === "undefined") return html;

  const doc = new DOMParser().parseFromString(html, "text/html");
  const root = doc.body;

  const candidates = root.querySelectorAll<HTMLElement>("[style],[color],[bgcolor]");
  for (const el of candidates) {
    const bgRaw = el.style.backgroundColor || el.getAttribute("bgcolor") || "";
    const parsedBg = bgRaw ? parseCssColor(bgRaw) : null;
    const bg =
      parsedBg && parsedBg.a > 0.05
        ? parsedBg.a >= 1
          ? ({ r: parsedBg.r, g: parsedBg.g, b: parsedBg.b } satisfies Rgb)
          : blendOver(DARK_ANN_BASE_BG, { r: parsedBg.r, g: parsedBg.g, b: parsedBg.b }, parsedBg.a)
        : DARK_ANN_BASE_BG;

    const fgRaw = el.style.color || el.getAttribute("color") || "";
    if (!fgRaw) continue;
    const parsedFg = parseCssColor(fgRaw);
    if (!parsedFg || parsedFg.a <= 0.05) continue;

    const fgEffective =
      parsedFg.a >= 1
        ? ({ r: parsedFg.r, g: parsedFg.g, b: parsedFg.b } satisfies Rgb)
        : blendOver(bg, { r: parsedFg.r, g: parsedFg.g, b: parsedFg.b }, parsedFg.a);

    if (contrastRatio(fgEffective, bg) >= MIN_ANN_TEXT_CONTRAST) continue;

    const adjusted = adjustRgbForContrast(fgEffective, bg, MIN_ANN_TEXT_CONTRAST);
    el.style.setProperty("color", rgbToCss(adjusted), "important");
    if (el.hasAttribute("color")) el.removeAttribute("color");
  }

  return root.innerHTML;
}

function EventDetail(props: {
  event: ParsedEvent;
  checked: boolean;
  now: Dayjs;
  variant: EventDetailVariant;
}) {
  const theme = useTheme();
  const isEnd = props.now.isAfter(props.event._e);
  const isStrike = props.checked || isEnd;
  const hasBanner = Boolean(props.event.banner);
  const showBanner = props.variant !== "none" && hasBanner;
  const renderedContent = useMemo(() => {
    const raw = props.event.content;
    if (!raw) return null;

    const normalized = preprocessAnnContent(raw);
    if (!looksLikeHtml(normalized)) {
      return { kind: "text" as const, text: normalized };
    }

    const cleanHtml = DOMPurify.sanitize(normalized, { USE_PROFILES: { html: true } });
    const themedHtml = normalizeAnnouncementHtml(cleanHtml, theme);
    return { kind: "html" as const, html: themedHtml };
  }, [props.event.content, theme]);

  if (props.variant === "sideImage") {
    return (
      <div
        className={clsx(
          "p-4 grid gap-3 items-start",
          showBanner && "md:grid-cols-[260px_1fr]"
        )}
      >
        {showBanner ? (
          <div className="rounded-xl overflow-hidden border border-[color:var(--line)] bg-[color:var(--tile)] self-start">
            <img
              src={props.event.banner}
              alt={props.event.title}
              className="block w-full h-auto"
              referrerPolicy="no-referrer"
            />
          </div>
        ) : null}
        <div className="min-w-0">
          <div className="text-xs text-[color:var(--muted)] font-mono mb-2">
            {formatRange(props.event.start_time, props.event.end_time)}
          </div>
          <div
            className={clsx(
              "text-base font-semibold leading-snug",
              isStrike && "opacity-60 line-through"
            )}
          >
            {props.event.title}
          </div>
          {props.event.linkUrl ? (
            <a
              className="mt-2 inline-block text-sm text-[color:var(--accent)] hover:underline"
              href={props.event.linkUrl}
              target="_blank"
              rel="noreferrer"
            >
              打开活动详情
            </a>
          ) : renderedContent ? null : (
            <div className="mt-2 text-xs text-[color:var(--muted)]">无详情链接</div>
          )}
          {renderedContent ? (
            renderedContent.kind === "html" ? (
              <div
                className="mt-3 text-sm text-[color:var(--ink2)] event-ann-content"
                // Content is sanitized above.
                dangerouslySetInnerHTML={{ __html: renderedContent.html }}
              />
            ) : (
              <div className="mt-3 text-sm text-[color:var(--ink2)] whitespace-pre-wrap">
                {renderedContent.text}
              </div>
            )
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 grid gap-3">
      <div className="text-xs text-[color:var(--muted)] font-mono">
        {formatRange(props.event.start_time, props.event.end_time)}
      </div>
      <div
        className={clsx(
          "text-base font-semibold leading-snug",
          isStrike && "opacity-60 line-through"
        )}
      >
        {props.event.title}
      </div>

      {props.variant === "titleBanner" && showBanner ? (
        <div className="justify-self-start w-fit max-w-full rounded-xl overflow-hidden border border-[color:var(--line)] bg-[color:var(--tile)]">
          <img
            src={props.event.banner}
            alt={props.event.title}
            className="block max-h-[120px] md:max-h-[160px] lg:max-h-[180px] w-auto max-w-full h-auto object-contain object-left"
            referrerPolicy="no-referrer"
          />
        </div>
      ) : null}

      {props.event.linkUrl ? (
        <a
          className="inline-block text-sm text-[color:var(--accent)] hover:underline"
          href={props.event.linkUrl}
          target="_blank"
          rel="noreferrer"
        >
          打开活动详情
        </a>
      ) : renderedContent ? null : (
        <div className="text-xs text-[color:var(--muted)]">无详情链接</div>
      )}

      {renderedContent ? (
        renderedContent.kind === "html" ? (
          <div
            className="text-sm text-[color:var(--ink2)] event-ann-content"
            // Content is sanitized above.
            dangerouslySetInnerHTML={{ __html: renderedContent.html }}
          />
        ) : (
          <div className="text-sm text-[color:var(--ink2)] whitespace-pre-wrap">
            {renderedContent.text}
          </div>
        )
      ) : null}
    </div>
  );
}

function EventListRow(props: {
  event: ParsedEvent;
  checked: boolean;
  isSelected: boolean;
  now: Dayjs;
  onSelect: () => void;
  onToggleCompleted: () => void;
}) {
  const isEnd = props.now.isAfter(props.event._e);
  const isStrike = props.checked || isEnd;

  return (
    <div
      className={clsx(
        "p-3 flex items-start gap-3 cursor-pointer transition-colors",
        props.checked && "opacity-60",
        props.isSelected ? "bg-indigo-50/50 dark:bg-indigo-500/10" : "hover:bg-white/50 dark:hover:bg-white/5"
      )}
      onClick={props.onSelect}
    >
      <div className="flex items-center self-center">
        <input
          type="checkbox"
          checked={props.checked}
          onClick={(e) => e.stopPropagation()}
          onChange={() => props.onToggleCompleted()}
          className="w-5 h-5 rounded border-[color:var(--line)] bg-transparent accent-indigo-600 focus:ring-indigo-500 cursor-pointer"
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className={clsx("text-sm font-semibold leading-snug", isStrike && "opacity-70 line-through")}>
          {props.event.title}
        </div>
        <div className="mt-1 text-[11px] text-[color:var(--muted)] font-mono">
          {formatRange(props.event.start_time, props.event.end_time)}
        </div>
      </div>

      {props.event.linkUrl ? (
        <a
          className="text-xs text-[color:var(--accent)] hover:underline mt-[2px]"
          href={props.event.linkUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          详情
        </a>
      ) : null}
    </div>
  );
}

function EventListPanel<T extends ParsedEvent>(props: {
  title: string;
  titleClassName?: string;
  events: T[];
  emptyText: string;
  checked: boolean;
  selectedId: string | number | null;
  now: Dayjs;
  onSelect: (eventId: string | number) => void;
  onToggleCompleted: (event: T) => void;
}) {
  return (
    <div className="glass shadow-ink rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-[color:var(--line)] bg-[color:var(--wash)]">
        <div className={clsx("text-sm font-semibold", props.titleClassName)}>{props.title}</div>
      </div>

      <div className="divide-y divide-[color:var(--line)]">
        {props.events.length > 0 ? (
          props.events.map((event) => (
            <EventListRow
              key={String(event.id)}
              event={event}
              checked={props.checked}
              isSelected={props.selectedId === event.id}
              now={props.now}
              onSelect={() => {
                props.onSelect(event.id);
              }}
              onToggleCompleted={() => props.onToggleCompleted(event)}
            />
          ))
        ) : (
          <div className="p-4 text-xs text-[color:var(--muted)]">{props.emptyText}</div>
        )}
      </div>
    </div>
  );
}

function sortByPhase<T extends { _s: Dayjs; _e: Dayjs; id: string | number }>(items: T[], now: Dayjs): T[] {
  const nowMs = now.valueOf();

  const phase = (e: { _s: Dayjs; _e: Dayjs }) => {
    const s = e._s.valueOf();
    const ed = e._e.valueOf();
    // 0: ongoing, 1: upcoming, 2: ended
    if (nowMs >= s && nowMs < ed) return 0;
    if (nowMs < s) return 1;
    return 2;
  };

  const sorted = [...items];
  sorted.sort((a, b) => {
    const pa = phase(a);
    const pb = phase(b);
    if (pa !== pb) return pa - pb;

    if (pa === 0) {
      return (
        a._e.valueOf() - b._e.valueOf() ||
        a._s.valueOf() - b._s.valueOf() ||
        String(a.id).localeCompare(String(b.id))
      );
    }

    if (pa === 1) {
      return (
        a._s.valueOf() - b._s.valueOf() ||
        a._e.valueOf() - b._e.valueOf() ||
        String(a.id).localeCompare(String(b.id))
      );
    }

    return (
      b._e.valueOf() - a._e.valueOf() ||
      b._s.valueOf() - a._s.valueOf() ||
      String(a.id).localeCompare(String(b.id))
    );
  });
  return sorted;
}

type RecurringFormRuleKind = RecurringRule["kind"];

type RecurringFormState = {
  title: string;
  kind: RecurringFormRuleKind;
  monthlyDay: string;
  weeklyWeekday: string;
  time: string;
  intervalStartDate: string;
  intervalDays: string;
  durationDays: string;
  customCron: string;
};

const WEEKDAY_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: WEEKDAY_NAMES[0] },
  { value: 1, label: WEEKDAY_NAMES[1] },
  { value: 2, label: WEEKDAY_NAMES[2] },
  { value: 3, label: WEEKDAY_NAMES[3] },
  { value: 4, label: WEEKDAY_NAMES[4] },
  { value: 5, label: WEEKDAY_NAMES[5] },
  { value: 6, label: WEEKDAY_NAMES[6] },
];

function makeRecurringFormState(now: Dayjs): RecurringFormState {
  return {
    title: "",
    kind: "monthly",
    monthlyDay: "1",
    weeklyWeekday: String(now.day()),
    time: "04:00",
    intervalStartDate: now.format("YYYY-MM-DD"),
    intervalDays: "7",
    durationDays: "",
    customCron: "0 4 1 * *",
  };
}

function deriveTimeFromCronExpression(expression: string): string | null {
  const source = expression.trim();
  if (!source) return null;
  const { parsed, error } = validateCronExpression(source);
  if (!parsed || error) return null;
  if (parsed.hour.values.length !== 1 || parsed.minute.values.length !== 1) return null;
  return `${pad2(parsed.hour.values[0]!)}:${pad2(parsed.minute.values[0]!)}`;
}

function makeRecurringFormStateFromActivity(activity: RecurringActivity): RecurringFormState {
  const base = makeRecurringFormState(dayjs());
  const durationDays = activity.durationDays == null ? "" : String(activity.durationDays);

  if (activity.rule.kind === "monthly") {
    return {
      ...base,
      title: activity.title,
      durationDays,
      kind: "monthly",
      monthlyDay: String(activity.rule.day),
      time: `${pad2(activity.rule.hour)}:${pad2(activity.rule.minute)}`,
      customCron: `${activity.rule.minute} ${activity.rule.hour} ${activity.rule.day} * *`,
    };
  }

  if (activity.rule.kind === "weekly") {
    return {
      ...base,
      title: activity.title,
      durationDays,
      kind: "weekly",
      weeklyWeekday: String(activity.rule.weekday),
      time: `${pad2(activity.rule.hour)}:${pad2(activity.rule.minute)}`,
      customCron: `${activity.rule.minute} ${activity.rule.hour} * * ${activity.rule.weekday}`,
    };
  }

  if (activity.rule.kind === "interval") {
    return {
      ...base,
      title: activity.title,
      durationDays,
      kind: "interval",
      intervalStartDate: activity.rule.startDate,
      intervalDays: String(activity.rule.everyDays),
      time: `${pad2(activity.rule.hour)}:${pad2(activity.rule.minute)}`,
      customCron: "",
    };
  }

  return {
    ...base,
    title: activity.title,
    durationDays,
    kind: "cron",
    time: deriveTimeFromCronExpression(activity.rule.expression) ?? base.time,
    customCron: activity.rule.expression,
  };
}

function buildCronFromForm(form: RecurringFormState): string {
  if (form.kind === "cron") return form.customCron;

  const parsedTime = parseTimeInput(form.time) ?? { hour: 0, minute: 0 };
  const hour = Math.min(23, Math.max(0, Math.trunc(parsedTime.hour)));
  const minute = Math.min(59, Math.max(0, Math.trunc(parsedTime.minute)));

  if (form.kind === "monthly") {
    const day = Number(form.monthlyDay);
    const safeDay = Number.isFinite(day) ? Math.min(31, Math.max(1, Math.trunc(day))) : 1;
    return `${minute} ${hour} ${safeDay} * *`;
  }

  if (form.kind === "weekly") {
    const weekday = Number(form.weeklyWeekday);
    const safeWeekday = Number.isFinite(weekday) ? Math.min(6, Math.max(0, Math.trunc(weekday))) : 0;
    return `${minute} ${hour} * * ${safeWeekday}`;
  }
  return "";
}

function parseTimeInput(value: string): { hour: number; minute: number } | null {
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function parseRecurringForm(form: RecurringFormState): { value: Omit<RecurringActivity, "id"> | null; error: string | null } {
  const title = form.title.trim();
  if (!title) return { value: null, error: "请输入循环活动名称" };

  const durationRaw = form.durationDays.trim();
  let durationDays: number | undefined;
  if (durationRaw) {
    const n = Number(durationRaw);
    if (!Number.isInteger(n) || n < 1 || n > 3650) {
      return { value: null, error: "持续天数需在 1-3650，或留空" };
    }
    durationDays = n;
  }

  if (form.kind === "cron") {
    const expression = form.customCron.trim();
    const parsedCron = validateCronExpression(expression);
    if (!parsedCron.parsed || parsedCron.error) {
      return { value: null, error: parsedCron.error ?? "Cron 表达式不合法" };
    }
    return {
      value: {
        title,
        durationDays,
        rule: { kind: "cron", expression },
      },
      error: null,
    };
  }

  const parsedTime = parseTimeInput(form.time);
  if (!parsedTime) return { value: null, error: "刷新时间格式应为 HH:mm" };

  if (form.kind === "monthly") {
    const day = Number(form.monthlyDay);
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      return { value: null, error: "每月日期需在 1-31" };
    }
    return {
      value: {
        title,
        durationDays,
        rule: { kind: "monthly", day, ...parsedTime },
      },
      error: null,
    };
  }

  if (form.kind === "weekly") {
    const weekday = Number(form.weeklyWeekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return { value: null, error: "每周日期不合法" };
    }
    return {
      value: {
        title,
        durationDays,
        rule: { kind: "weekly", weekday, ...parsedTime },
      },
      error: null,
    };
  }

  const startDate = form.intervalStartDate.trim();
  if (!dayjs(startDate, "YYYY-MM-DD", true).isValid()) {
    return { value: null, error: "开始日期格式不正确" };
  }
  const everyDays = Number(form.intervalDays);
  if (!Number.isInteger(everyDays) || everyDays < 1 || everyDays > 3650) {
    return { value: null, error: "循环天数需在 1-3650" };
  }

  return {
    value: {
      title,
      durationDays,
      rule: { kind: "interval", startDate, everyDays, ...parsedTime },
    },
    error: null,
  };
}

export default function TimelineCalendar(props: { events: CalendarEvent[]; gameId: GameId }) {
  const {
    prefs,
    setShowNotStarted,
    setShowWeekSeparators,
    toggleCompleted: toggleCompletedPref,
    toggleRecurringCompleted: toggleRecurringCompletedPref,
    addRecurringActivity,
    updateRecurringActivity,
    removeRecurringActivity,
  } = usePrefs();
  const [dayWidth, setDayWidth] = useState(26); // px per day
  const [selectedId, setSelectedId] = useState<string | number | null>(null);
  const [selectedFrom, setSelectedFrom] = useState<"timeline" | "list" | null>(null);
  const [now, setNow] = useState(() => dayjs());
  const [isRecurringSettingsOpen, setIsRecurringSettingsOpen] = useState(false);
  const [recurringForm, setRecurringForm] = useState<RecurringFormState>(() => makeRecurringFormState(dayjs()));
  const [recurringFormError, setRecurringFormError] = useState<string | null>(null);
  const [editingRecurringId, setEditingRecurringId] = useState<string | null>(null);
  const gameMeta = GAME_META[props.gameId];
  const eventDetailVariant = EVENT_DETAIL_VARIANT_BY_GAME[props.gameId];
  const showNotStarted = prefs.timeline.showNotStarted;
  const showWeekSeparators = prefs.timeline.showWeekSeparators;
  const completedIdsArr = prefs.timeline.completedIdsByGame[props.gameId] ?? [];
  const completedIds = useMemo(() => new Set<string | number>(completedIdsArr), [completedIdsArr]);
  const completedRecurring = prefs.timeline.completedRecurringByGame[props.gameId] ?? {};
  const recurringDefs = prefs.timeline.recurringActivitiesByGame[props.gameId] ?? [];
  const recurringTzLabel = useMemo(
    () => formatFixedUtcOffset(getRecurringTzOffsetMinutes(props.gameId)),
    [props.gameId]
  );

  const toggleCompleted = (eventId: string | number) => toggleCompletedPref(props.gameId, eventId);
  const toggleRecurringCompleted = (activityId: string, cycleKey: string) =>
    toggleRecurringCompletedPref(props.gameId, activityId, cycleKey);

  const hScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(dayjs()), 60_000);
    return () => clearInterval(t);
	  }, []);

  // When switching games, reset UI state.
  useEffect(() => {
    setSelectedId(null);
    setSelectedFrom(null);
    setIsRecurringSettingsOpen(false);
    setRecurringForm(makeRecurringFormState(dayjs()));
    setRecurringFormError(null);
    setEditingRecurringId(null);
  }, [props.gameId]);

  const toggleSelectedFromList = (eventId: string | number) => {
    // Mirror the timeline behavior: clicking the same list item again closes the detail panel.
    if (selectedId === eventId && selectedFrom === "list") {
      setSelectedId(null);
      setSelectedFrom(null);
      return;
    }
    setSelectedId(eventId);
    setSelectedFrom("list");
  };

  const parsedUpstream = useMemo(() => {
    const items = props.events
      .map((e) => {
        const s = parseDateTime(e.start_time);
        const ed = parseDateTime(e.end_time);
        return { ...e, kind: "upstream" as const, title: normalizeEventTitle(e.title), _s: s, _e: ed };
      })
      .filter((e) => e._s.isValid() && e._e.isValid() && e._e.isAfter(e._s));
    return items;
  }, [props.events]);

  const sortedUpstream = useMemo(() => sortByPhase(parsedUpstream, now), [parsedUpstream, now]);

  const visibleUpstreamSorted = useMemo(() => {
    if (showNotStarted) return sortedUpstream;
    const nowMs = now.valueOf();
    return sortedUpstream.filter((e) => nowMs >= e._s.valueOf());
  }, [sortedUpstream, showNotStarted, now]);

  const parsedRecurring = useMemo(() => {
    if (recurringDefs.length === 0) return [] as ParsedRecurringEvent[];

    const items: ParsedRecurringEvent[] = [];
    for (const a of recurringDefs) {
      const w = computeRecurringWindow(now, props.gameId, a);
      if (!w.start.isValid() || !w.end.isValid() || !w.end.isAfter(w.start)) continue;
      // Ensure we only ever show the *current* cycle (no future occurrences).
      if (now.valueOf() < w.start.valueOf() || now.valueOf() >= w.end.valueOf()) continue;

      const event: CalendarEvent = {
        id: `rec:${props.gameId}:${a.id}`,
        title: a.title,
        start_time: toIsoWithOffset(w.start),
        end_time: toIsoWithOffset(w.end),
        content: `循环活动：${formatRecurringRule(props.gameId, a.rule, a.durationDays)}`,
      };

      items.push({
        ...event,
        _s: w.start,
        _e: w.end,
        kind: "recurring",
        recurringActivityId: a.id,
        cycleKey: w.cycleKey,
      });
    }

    return sortByPhase(items, now);
  }, [now, props.gameId, recurringDefs]);

  const { activeUpstreamEvents, completedUpstreamEvents } = useMemo(() => {
    const active = visibleUpstreamSorted.filter((e) => !completedIds.has(e.id));
    const completed = visibleUpstreamSorted.filter((e) => completedIds.has(e.id));
    return { activeUpstreamEvents: active, completedUpstreamEvents: completed };
  }, [visibleUpstreamSorted, completedIds]);

  const { activeRecurringEvents, completedRecurringEvents } = useMemo(() => {
    if (parsedRecurring.length === 0) {
      return { activeRecurringEvents: [] as ParsedRecurringEvent[], completedRecurringEvents: [] as ParsedRecurringEvent[] };
    }
    const active: ParsedRecurringEvent[] = [];
    const completed: ParsedRecurringEvent[] = [];
    for (const e of parsedRecurring) {
      if (completedRecurring[e.recurringActivityId] === e.cycleKey) completed.push(e);
      else active.push(e);
    }
    return { activeRecurringEvents: active, completedRecurringEvents: completed };
  }, [parsedRecurring, completedRecurring]);

  const activeTimelineEvents = useMemo(() => {
    return sortByPhase(
      [...activeRecurringEvents, ...activeUpstreamEvents] satisfies ParsedEvent[],
      now
    );
  }, [activeRecurringEvents, activeUpstreamEvents, now]);

  const selectedEvent = useMemo(() => {
    if (selectedId == null) return null;
    return (
      (visibleUpstreamSorted.find((e) => e.id === selectedId) ??
        parsedRecurring.find((e) => e.id === selectedId) ??
        null) as AnyParsedEvent | null
    );
  }, [visibleUpstreamSorted, parsedRecurring, selectedId]);

  // If selected ID disappears (data refresh / filter changes), hide the detail panel.
  useEffect(() => {
    if (selectedId == null) return;
    if (selectedEvent) return;
    setSelectedId(null);
    setSelectedFrom(null);
  }, [selectedEvent, selectedId]);

  const { rangeStart, rangeEnd, months, weeks } = useMemo(() => {
    const baseMonth = now.startOf("month");
    const windowStart = baseMonth.subtract(1, "month").startOf("month");
    const windowEnd = baseMonth.add(1, "month").endOf("month");
    const todayStart = now.startOf("day");
    const todayEnd = now.endOf("day");

    // Only consider events that overlap the maximum visible window.
    // Timeline start/end are then derived from those visible events:
    // - If any event starts before windowStart, show the full (n-1) month and truncate.
    // - Otherwise start from the earliest visible event start.
    // End follows the same rule with windowEnd / latest end.
    const visible = activeTimelineEvents.filter(
      (e) => e._e.valueOf() > windowStart.valueOf() && e._s.valueOf() < windowEnd.valueOf()
    );

    let start = windowStart;
    let end = windowEnd;

    if (visible.length > 0) {
      let minS = visible[0]!._s;
      let maxE = visible[0]!._e;
      let hasBeforeWindowStart = visible[0]!._s.isBefore(windowStart);
      let hasAfterWindowEnd = visible[0]!._e.isAfter(windowEnd);

      for (const e of visible) {
        if (e._s.isBefore(minS)) minS = e._s;
        if (e._e.isAfter(maxE)) maxE = e._e;
        if (e._s.isBefore(windowStart)) hasBeforeWindowStart = true;
        if (e._e.isAfter(windowEnd)) hasAfterWindowEnd = true;
      }

      start = hasBeforeWindowStart ? windowStart : minS;
      end = hasAfterWindowEnd ? windowEnd : maxE;
    }

    // Ensure the timeline always includes "today", even if all visible events are
    // entirely in the future or past (or only later/earlier within today).
    // - today is the max timeline start (start cannot be after todayStart)
    // - today is the min timeline end (end cannot be before todayEnd)
    if (start.isAfter(todayStart)) start = todayStart;
    if (end.isBefore(todayEnd)) end = todayEnd;
    if (end.isBefore(start)) end = start;

    const monthSegments: Array<{ key: string; label: string; width: number }> = [];
    const weekSegments: Array<{ key: string; label: string; tooltip: string; width: number }> = [];
    // Start from the month containing "start".
    let m = start.startOf("month");
    const totalMs = Math.max(1, end.valueOf() - start.valueOf());

    while (m.isBefore(end) || m.isSame(end, "month")) {
      const segStart = m.isBefore(start) ? start : m;
      const segEnd = m.endOf("month").isAfter(end) ? end : m.endOf("month");
      const segMs = segEnd.valueOf() - segStart.valueOf();
      const segWidth = (segMs / totalMs) * 100; // percentage

      monthSegments.push({
        key: segStart.format("YYYY-MM"),
        label: `${segStart.format("M")}月`,
        width: segWidth,
      });
      m = m.add(1, "month");
    }

    let w = start.startOf("isoWeek");
    while (w.isBefore(end) || w.isSame(end, "day")) {
      const segStart = w.isBefore(start) ? start : w;
      const segEnd = w.endOf("isoWeek").isAfter(end) ? end : w.endOf("isoWeek");
      const segMs = Math.max(1, segEnd.valueOf() - segStart.valueOf());
      const week = segStart.isoWeek();
      const weekYear = segStart.isoWeekYear();

      weekSegments.push({
        key: `${weekYear}-W${String(week).padStart(2, "0")}`,
        label: weekYear === now.year() ? `第${week}周` : `${weekYear}年第${week}周`,
        tooltip: `${weekYear}年第${week}周`,
        width: (segMs / totalMs) * 100,
      });
      w = w.add(1, "week");
    }

    return {
      rangeStart: start,
      rangeEnd: end,
      months: monthSegments,
      weeks: weekSegments,
    };
  }, [activeTimelineEvents, now]);

  const timelineEvents = useMemo(() => {
    return activeTimelineEvents.filter(
      (e) => e._e.valueOf() > rangeStart.valueOf() && e._s.valueOf() < rangeEnd.valueOf()
    );
  }, [activeTimelineEvents, rangeStart, rangeEnd]);

  const isTimelineEmpty = activeTimelineEvents.length === 0;

  // If the detail panel was opened by clicking the timeline, and that event becomes completed
  // (so it disappears from the timeline), hide the detail panel.
  useEffect(() => {
    if (selectedFrom !== "timeline") return;
    if (selectedId == null) return;
    if (!selectedEvent) return;

    const isCompleted =
      selectedEvent.kind === "recurring"
        ? completedRecurring[selectedEvent.recurringActivityId] === selectedEvent.cycleKey
        : completedIds.has(selectedId);
    if (!isCompleted) return;
    setSelectedId(null);
    setSelectedFrom(null);
  }, [completedIds, completedRecurring, selectedEvent, selectedFrom, selectedId]);

  const totalWidth = useMemo(() => {
    const ms = rangeEnd.valueOf() - rangeStart.valueOf();
    return (ms / DAY_MS) * dayWidth;
  }, [rangeStart, rangeEnd, dayWidth]);

  const nowX = useMemo(() => {
    const ms = now.valueOf() - rangeStart.valueOf();
    return (ms / DAY_MS) * dayWidth;
  }, [now, rangeStart, dayWidth]);

  const isNowInRange = !now.isBefore(rangeStart) && !now.isAfter(rangeEnd);
  const nowLabelX = useMemo(() => {
    // Keep the chip readable near edges.
    const pad = 80;
    return Math.min(Math.max(nowX, pad), Math.max(pad, totalWidth - pad));
  }, [nowX, totalWidth]);

  const axisHeights = useMemo(() => {
    const monthRow = 36;
    return { monthRow, total: monthRow };
  }, []);

  useEffect(() => {
    // Calculate dayWidth to fit container width exactly
    const updateWidth = () => {
      const el = hScrollRef.current;
      if (!el) return;

      const containerWidth = el.clientWidth;
      const rangeDays = (rangeEnd.valueOf() - rangeStart.valueOf()) / DAY_MS;
      if (rangeDays === 0) return;

      const calculatedDayWidth = containerWidth / rangeDays;
      setDayWidth(calculatedDayWidth);
    };

    // Initial calculation with a small delay to ensure container is rendered
    const timer = setTimeout(updateWidth, 0);

    // Update on window resize
    window.addEventListener('resize', updateWidth);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', updateWidth);
    };
  }, [rangeStart, rangeEnd]);

  useEffect(() => {
    // Auto-scroll to "now" when data/range changes.
    if (isTimelineEmpty) return;
    if (!isNowInRange) return;
    const el = hScrollRef.current;
    if (!el) return;

    const desired = Math.max(0, nowX - el.clientWidth * 0.25);
    el.scrollTo({ left: desired, behavior: "smooth" });
    // Only do this on range/zoom changes, not every minute tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeStart.valueOf(), rangeEnd.valueOf(), dayWidth, activeTimelineEvents.length]);

  const recurringDefinitionsSorted = useMemo(() => {
    return [...recurringDefs].sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"));
  }, [recurringDefs]);

  const recurringCronPreview = useMemo(() => buildCronFromForm(recurringForm), [recurringForm]);
  const recurringCronValidationError = useMemo(() => {
    if (recurringForm.kind !== "cron") return null;
    if (!recurringForm.customCron.trim()) return "请输入 Cron 表达式";
    const { error } = validateCronExpression(recurringForm.customCron);
    return error;
  }, [recurringForm.customCron, recurringForm.kind]);

  const isRecurringSubmitDisabled = recurringForm.kind === "cron" && Boolean(recurringCronValidationError);

  const resetRecurringForm = () => {
    setEditingRecurringId(null);
    setRecurringForm(makeRecurringFormState(dayjs()));
    setRecurringFormError(null);
  };

  const handleSubmitRecurring = () => {
    const { value, error } = parseRecurringForm(recurringForm);
    if (!value || error) {
      setRecurringFormError(error ?? "循环活动参数不合法");
      return;
    }
    if (editingRecurringId) {
      updateRecurringActivity(props.gameId, editingRecurringId, value);
    } else {
      addRecurringActivity(props.gameId, value);
    }
    resetRecurringForm();
  };

  return (
    <div className="fade-in grid gap-3">
      <div className="glass shadow-ink rounded-2xl overflow-hidden relative">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-[color:var(--line)] bg-[color:var(--wash)]">
          <div className="flex items-baseline gap-3 min-w-0">
            <div className="text-sm font-semibold shrink-0">
              <img
                src={gameMeta.icon}
                alt=""
                aria-hidden="true"
                className="inline-block w-5 h-5 object-contain rounded-md mr-2 align-text-bottom"
                referrerPolicy="no-referrer"
              />
              {gameMeta.name}
            </div>
            {!isTimelineEmpty ? (
              <div className="text-xs text-[color:var(--muted)] font-mono">
                {rangeStart.format("YYYY/MM/DD")} ~ {rangeEnd.format("YYYY/MM/DD")}
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <label className="flex items-center gap-2 text-xs text-[color:var(--muted)] cursor-pointer select-none">
              <span>按周分隔</span>
              <input
                type="checkbox"
                checked={showWeekSeparators}
                onChange={(e) => setShowWeekSeparators(e.target.checked)}
                className="w-5 h-5 rounded border-[color:var(--line)] bg-transparent accent-indigo-600 focus:ring-indigo-500 cursor-pointer"
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-[color:var(--muted)] cursor-pointer select-none">
              <span>显示未开始活动</span>
              <input
                type="checkbox"
                checked={showNotStarted}
                onChange={(e) => setShowNotStarted(e.target.checked)}
                className="w-5 h-5 rounded border-[color:var(--line)] bg-transparent accent-indigo-600 focus:ring-indigo-500 cursor-pointer"
              />
            </label>
          </div>
        </div>

        <div ref={hScrollRef} className="max-h-[70vh] overflow-auto">
          {isTimelineEmpty ? (
            <div className="min-h-[180px] flex items-center justify-center px-6 py-10">
              <div className="text-sm text-[color:var(--muted)] select-none">
                所有活动已完成，长草中(´-ω-`)
              </div>
            </div>
          ) : (
            <div className="relative" style={{ width: totalWidth }}>
              {/* Now line */}
              {isNowInRange ? (
                <div
                  className="pointer-events-none absolute top-0 bottom-0 z-30"
                  style={{ left: nowX }}
                >
                  <div className="w-[2px] h-full bg-indigo-500/80" />
                </div>
              ) : null}

              {/* Now label */}
              {isNowInRange ? (
                <div
                  className="pointer-events-none absolute top-2 z-40"
                  style={{ left: nowLabelX, transform: "translateX(-50%)" }}
                >
                  <div className="px-3 py-1 rounded-full text-xs text-white bg-indigo-500 shadow">
                    {now.format("M/D")}
                  </div>
                </div>
              ) : null}

              {/* Sticky axis */}
              <div
                className="sticky top-0 z-20 bg-[color:var(--wash-strong)] backdrop-blur border-b border-[color:var(--line)]"
              >
                <div
                  className="flex"
                  style={{ height: axisHeights.monthRow, width: totalWidth }}
                >
                  {months.map((m, idx) => (
                    <div
                      key={m.key}
                      className={clsx(
                        "flex items-center justify-center text-sm font-semibold text-[color:var(--ink2)]",
                        idx < months.length - 1 && "border-r border-[color:var(--line)]"
                      )}
                      style={{ width: `${m.width}%` }}
                    >
                      {m.label}
                    </div>
                  ))}
                </div>
            </div>

            {/* Bars */}
            <div className="relative">
              {/* Month separators */}
              {!showWeekSeparators ? (
                <div className="absolute inset-0 pointer-events-none flex" style={{ width: totalWidth }}>
                  {months.map((m, idx) => (
                    <div
                      key={m.key}
                      className={clsx(
                        idx < months.length - 1 && "border-r border-[color:var(--line)]"
                      )}
                      style={{ width: `${m.width}%` }}
                    />
                  ))}
                </div>
              ) : null}
              {showWeekSeparators ? (
                <div className="absolute inset-0 pointer-events-none flex" style={{ width: totalWidth }}>
                  {weeks.map((w, idx) => (
                    <div
                      key={`week-separator-${w.key}`}
                      className={clsx(
                        idx < weeks.length - 1 && "border-r border-[color:var(--line)]"
                      )}
                      style={{ width: `${w.width}%` }}
                    />
                  ))}
                </div>
              ) : null}

              {timelineEvents.map((e, idx) => {
                const isSelected = selectedId === e.id;
                const isEnd = now.isAfter(e._e);
                const remainingMs = Math.max(0, e._e.valueOf() - now.valueOf());
                const remainingDays = Math.floor(remainingMs / DAY_MS);
                const remainingHours = Math.floor(remainingMs / HOUR_MS);
                const remainingMinutes = Math.floor(remainingMs / MINUTE_MS);
                const showMinutes = !isEnd && remainingMs < HOUR_MS;
                const showHours = !isEnd && remainingMs < DAY_MS && !showMinutes;
                const remainingLabel = showMinutes
                  ? `${remainingMinutes}分`
                  : showHours
                    ? `${remainingHours}h`
                    : `${remainingDays}天`;
                const remainingAriaLabel = showMinutes
                  ? `剩余${remainingMinutes}分钟`
                  : showHours
                    ? `剩余${remainingHours}小时`
                    : `剩余${remainingDays}天`;
                const isUrgent = isUrgentByRemainingMs(e.kind, remainingMs);

                const isTruncatedStart = e._s.isBefore(rangeStart);
                const isTruncatedEnd = e._e.isAfter(rangeEnd);

                const startMs = Math.max(e._s.valueOf(), rangeStart.valueOf());
                const endMs = Math.min(e._e.valueOf(), rangeEnd.valueOf());

                const left = ((startMs - rangeStart.valueOf()) / DAY_MS) * dayWidth;
                const width = Math.max(6, ((endMs - startMs) / DAY_MS) * dayWidth);
                const showCountdownOnly = width <= 88;
                const countdownPaddingX = showCountdownOnly ? (width <= 56 ? 4 : 8) : 0;
                const countdownUnits = Array.from(remainingLabel).reduce(
                  (sum, ch) => sum + (/[^\x00-\x7F]/.test(ch) ? 1 : 0.62),
                  0
                );
                const countdownAvailableWidth = Math.max(0, width - countdownPaddingX * 2);
                const countdownFontSize = showCountdownOnly
                  ? clamp((countdownAvailableWidth / Math.max(countdownUnits, 1)) * 0.95, 10, 13)
                  : 13;

                const [colorA, colorB] = TIMELINE_BAR_GRADIENTS[idx % TIMELINE_BAR_GRADIENTS.length]!;

                // Determine border radius based on truncation
                let borderRadius = "0.75rem"; // rounded-xl
                if (isTruncatedStart && isTruncatedEnd) {
                  borderRadius = "0";
                } else if (isTruncatedStart) {
                  borderRadius = "0 0.75rem 0.75rem 0";
                } else if (isTruncatedEnd) {
                  borderRadius = "0.75rem 0 0 0.75rem";
                }

                return (
                  <div
                    key={String(e.id)}
                    className={clsx(
                      "relative border-b border-[color:var(--line)]",
                      "hover:bg-white/20 dark:hover:bg-transparent"
                    )}
                    style={{ height: 56 }}
                  >
                    <div
                      className={clsx(
                        "absolute top-2 bottom-2 py-2 overflow-hidden",
                        "flex items-center",
                        showCountdownOnly ? "justify-center" : "px-3",
                        "z-10 text-[13px] leading-5 shadow-sm cursor-pointer",
                        "transition-[box-shadow,filter] duration-150 ease-out",
                        "hover:shadow-md hover:brightness-105",
                        isSelected
                          ? "ring-2 ring-[color:var(--ring)]"
                          : "ring-0 hover:ring-2 hover:ring-[color:var(--ring)]"
                      )}
                      style={{
                        left,
                        width,
                        background: `linear-gradient(90deg, ${colorA}, ${colorB})`,
                        opacity: isEnd ? 0.55 : 0.95,
                        borderRadius,
                        ...(showCountdownOnly ? { paddingLeft: countdownPaddingX, paddingRight: countdownPaddingX } : null),
                      }}
                      onClick={() => {
                        // Clicking the same timeline event again should hide the detail panel.
                        if (selectedId === e.id && selectedFrom === "timeline") {
                          setSelectedId(null);
                          setSelectedFrom(null);
                          return;
                        }
                        setSelectedId(e.id);
                        setSelectedFrom("timeline");
                      }}
                    >
                      {!showCountdownOnly ? (
                        <div className="min-w-0 flex-1">
                          <div
                            className={clsx(
                              "text-slate-900 font-medium bg-transparent gc-fade-truncate-1",
                              isEnd && "line-through"
                            )}
                          >
                            {e.title}
                          </div>
                        </div>
                      ) : null}
                      <div
                        className={clsx(
                          "leading-none font-mono tabular-nums",
                          showCountdownOnly ? "w-full min-w-0 text-center whitespace-nowrap" : "shrink-0 pl-2 text-[13px]",
                          isUrgent ? "text-red-700 font-semibold" : "text-slate-800/70"
                        )}
                        style={showCountdownOnly ? { fontSize: `${countdownFontSize}px` } : undefined}
                        aria-label={remainingAriaLabel}
                      >
                        {remainingLabel}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          )}
        </div>
      </div>

      {selectedEvent ? (
        <div className="glass shadow-ink rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[color:var(--line)] bg-[color:var(--wash)]">
            <div className="text-sm font-semibold">活动详情</div>
            <label className="flex items-center gap-2 text-xs text-[color:var(--muted)] cursor-pointer select-none">
              <span>已完成</span>
              <input
                type="checkbox"
                checked={
                  selectedEvent.kind === "recurring"
                    ? completedRecurring[selectedEvent.recurringActivityId] === selectedEvent.cycleKey
                    : completedIds.has(selectedEvent.id)
                }
                onChange={() => {
                  if (selectedEvent.kind === "recurring") {
                    toggleRecurringCompleted(selectedEvent.recurringActivityId, selectedEvent.cycleKey);
                  } else {
                    toggleCompleted(selectedEvent.id);
                  }
                }}
                className="w-5 h-5 rounded border-[color:var(--line)] bg-transparent accent-indigo-600 focus:ring-indigo-500 cursor-pointer"
              />
            </label>
          </div>
          <EventDetail
            event={selectedEvent}
            checked={
              selectedEvent.kind === "recurring"
                ? completedRecurring[selectedEvent.recurringActivityId] === selectedEvent.cycleKey
                : completedIds.has(selectedEvent.id)
            }
            now={now}
            variant={eventDetailVariant}
          />
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <EventListPanel
          title="所有活动"
          events={activeUpstreamEvents}
          emptyText="暂无未完成活动"
          checked={false}
          selectedId={selectedId}
          now={now}
          onSelect={toggleSelectedFromList}
          onToggleCompleted={(event) => toggleCompleted(event.id)}
        />

          <div className="glass shadow-ink rounded-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-[color:var(--line)] bg-[color:var(--wash)] flex items-center justify-between gap-3">
              <div className="text-sm font-semibold">循环活动</div>
              <button
                type="button"
                className={clsx(
                  "inline-flex items-center justify-center rounded-md transition-colors",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]",
                  isRecurringSettingsOpen ? "text-[color:var(--accent)]" : "text-[color:var(--muted)] hover:text-[color:var(--ink)]"
                )}
                onClick={() => {
                  if (isRecurringSettingsOpen) {
                    setIsRecurringSettingsOpen(false);
                    resetRecurringForm();
                    return;
                  }
                  setIsRecurringSettingsOpen(true);
                  setRecurringFormError(null);
                }}
                aria-label={isRecurringSettingsOpen ? "关闭循环活动设置" : "打开循环活动设置"}
                title={isRecurringSettingsOpen ? "关闭循环活动设置" : "打开循环活动设置"}
                aria-haspopup="dialog"
                aria-expanded={isRecurringSettingsOpen}
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065Z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
                  />
                </svg>
              </button>
            </div>
            {isRecurringSettingsOpen ? (
              <div className="px-4 py-3 border-b border-[color:var(--line)] bg-[color:var(--wash)]/40">
                <form
                  className="grid gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSubmitRecurring();
                  }}
                >
                  {editingRecurringId ? (
                    <div className="text-xs text-[color:var(--accent)]">正在编辑循环活动</div>
                  ) : null}

                  <div className="grid gap-2 md:grid-cols-2">
                    <label className="grid gap-1">
                      <span className="text-xs text-[color:var(--muted)]">活动名称</span>
                      <input
                        id="event_title"
                        name="event_title"
                        type="text"
                        value={recurringForm.title}
                        onChange={(e) => {
                          setRecurringForm((prev) => ({ ...prev, title: e.target.value }));
                          if (recurringFormError) setRecurringFormError(null);
                        }}
                        placeholder="例如：深境螺旋"
                        className="w-full px-2 py-2 rounded-xl border border-[color:var(--line)] bg-transparent text-sm"
                      />
                    </label>

                    <label className="grid gap-1">
                      <span className="text-xs text-[color:var(--muted)]">刷新时间（{recurringTzLabel}）</span>
                      <input
                        type="time"
                        value={recurringForm.time}
                        disabled={recurringForm.kind === "cron"}
                        onChange={(e) => {
                          setRecurringForm((prev) => ({ ...prev, time: e.target.value }));
                          if (recurringFormError) setRecurringFormError(null);
                        }}
                        className={clsx(
                          "w-full px-2 py-2 rounded-xl border border-[color:var(--line)] bg-transparent text-sm",
                          recurringForm.kind === "cron" && "opacity-70 cursor-not-allowed"
                        )}
                      />
                    </label>
                  </div>

                  <div className="grid gap-2 md:grid-cols-2">
                    <label className={clsx("grid gap-1", recurringForm.kind === "cron" && "md:col-span-2")}>
                      <span className="text-xs text-[color:var(--muted)]">循环方式</span>
                      <select
                        value={recurringForm.kind}
                        onChange={(e) => {
                          const kind = e.target.value as RecurringFormRuleKind;
                          setRecurringForm((prev) => {
                            if (kind !== "cron") return { ...prev, kind };
                            const nextCron = prev.customCron.trim() ? prev.customCron : buildCronFromForm(prev);
                            return { ...prev, kind, customCron: nextCron };
                          });
                          if (recurringFormError) setRecurringFormError(null);
                        }}
                        className="w-full px-2 py-2 rounded-xl border border-[color:var(--line)] bg-transparent text-sm"
                      >
                        <option value="monthly">每月</option>
                        <option value="weekly">每周</option>
                        <option value="interval">固定天数</option>
                        <option value="cron">自定义 Cron</option>
                      </select>
                    </label>

                    {recurringForm.kind === "monthly" ? (
                      <label className="grid gap-1">
                        <span className="text-xs text-[color:var(--muted)]">每月几号</span>
                        <input
                          type="number"
                          min="1"
                          max="31"
                          value={recurringForm.monthlyDay}
                          onChange={(e) => {
                            setRecurringForm((prev) => ({ ...prev, monthlyDay: e.target.value }));
                            if (recurringFormError) setRecurringFormError(null);
                          }}
                          className="w-full px-2 py-2 rounded-xl border border-[color:var(--line)] bg-transparent text-sm"
                        />
                      </label>
                    ) : recurringForm.kind === "weekly" ? (
                      <label className="grid gap-1">
                        <span className="text-xs text-[color:var(--muted)]">每周几</span>
                        <select
                          value={recurringForm.weeklyWeekday}
                          onChange={(e) => {
                            setRecurringForm((prev) => ({ ...prev, weeklyWeekday: e.target.value }));
                            if (recurringFormError) setRecurringFormError(null);
                          }}
                          className="w-full px-2 py-2 rounded-xl border border-[color:var(--line)] bg-transparent text-sm"
                        >
                          {WEEKDAY_OPTIONS.map((opt) => (
                            <option key={opt.value} value={String(opt.value)}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : recurringForm.kind === "interval" ? (
                      <label className="grid gap-1">
                        <span className="text-xs text-[color:var(--muted)]">开始日期</span>
                        <input
                          type="date"
                          value={recurringForm.intervalStartDate}
                          onChange={(e) => {
                            setRecurringForm((prev) => ({ ...prev, intervalStartDate: e.target.value }));
                            if (recurringFormError) setRecurringFormError(null);
                          }}
                          className="w-full px-2 py-2 rounded-xl border border-[color:var(--line)] bg-transparent text-sm"
                        />
                      </label>
                    ) : null}
                  </div>

                  <div className="grid gap-2 md:grid-cols-2">
                    {recurringForm.kind === "interval" ? (
                      <label className="grid gap-1">
                        <span className="text-xs text-[color:var(--muted)]">循环天数</span>
                        <input
                          type="number"
                          min="1"
                          max="3650"
                          value={recurringForm.intervalDays}
                          onChange={(e) => {
                            setRecurringForm((prev) => ({ ...prev, intervalDays: e.target.value }));
                            if (recurringFormError) setRecurringFormError(null);
                          }}
                          className="w-full px-2 py-2 rounded-xl border border-[color:var(--line)] bg-transparent text-sm"
                        />
                      </label>
                    ) : (
                      <label className="grid gap-1">
                        <span className="text-xs text-[color:var(--muted)]">Cron表达式</span>
                        <input
                          type="text"
                          value={recurringCronPreview}
                          readOnly={recurringForm.kind !== "cron"}
                          placeholder="例如：0 4 * * 1"
                          onChange={(e) => {
                            if (recurringForm.kind !== "cron") return;
                            const nextCron = e.target.value;
                            setRecurringForm((prev) => {
                              const nextTime = deriveTimeFromCronExpression(nextCron);
                              if (!nextTime) return { ...prev, customCron: nextCron };
                              return { ...prev, customCron: nextCron, time: nextTime };
                            });
                            if (recurringFormError) setRecurringFormError(null);
                          }}
                          className={clsx(
                            "w-full px-2 py-2 rounded-xl border border-[color:var(--line)] bg-transparent text-sm font-mono",
                            recurringForm.kind === "cron" && recurringCronValidationError && "border-red-400",
                            recurringForm.kind !== "cron" && "opacity-70 cursor-not-allowed"
                          )}
                        />
                      </label>
                    )}

                    <label className="grid gap-1">
                      <span className="text-xs text-[color:var(--muted)]">持续天数（可选）</span>
                      <input
                        type="number"
                        min="1"
                        max="3650"
                        value={recurringForm.durationDays}
                        placeholder="留空为连续循环"
                        onChange={(e) => {
                          setRecurringForm((prev) => ({ ...prev, durationDays: e.target.value }));
                          if (recurringFormError) setRecurringFormError(null);
                        }}
                        className="w-full px-2 py-2 rounded-xl border border-[color:var(--line)] bg-transparent text-sm"
                      />
                    </label>
                  </div>

                  {recurringForm.kind === "cron" && recurringCronValidationError ? (
                    <div className="text-[11px] text-red-500">{recurringCronValidationError}</div>
                  ) : null}

                  <div className="text-[11px] text-[color:var(--muted)]">
                    {recurringForm.kind === "interval"
                      ? `自 ${recurringForm.intervalStartDate || "（未设置）"} 起每 ${
                          recurringForm.intervalDays || "N"
                        } 天 ${recurringForm.time || "00:00"} 刷新（${recurringTzLabel}）`
                      : recurringCronPreview
                        ? formatCronHumanReadable(recurringCronPreview)
                        : "（空）"}
                  </div>

                  {recurringFormError ? (
                    <div className="text-xs text-red-500">{recurringFormError}</div>
                  ) : null}

                  <div className="flex justify-end gap-2">
                    {editingRecurringId ? (
                      <button
                        type="button"
                        onClick={resetRecurringForm}
                        className="px-3 py-2 rounded-xl text-sm border border-[color:var(--line)] transition hover:border-[color:var(--ink)] hover:bg-[color:var(--tile)]"
                      >
                        取消
                      </button>
                    ) : null}
                    <button
                      type="submit"
                      disabled={isRecurringSubmitDisabled}
                      className={clsx(
                        "px-3 py-2 rounded-xl text-sm border border-[color:var(--line)] transition",
                        "hover:border-[color:var(--ink)] hover:bg-[color:var(--tile)]",
                        isRecurringSubmitDisabled && "opacity-50 cursor-not-allowed hover:border-[color:var(--line)] hover:bg-transparent"
                      )}
                    >
                      {editingRecurringId ? "保存" : "添加循环活动"}
                    </button>
                  </div>
                </form>

                <div className="mt-3 pt-3 border-t border-[color:var(--line)] grid gap-2">
                  <div className="text-xs text-[color:var(--muted)]">已配置项目</div>
                  {recurringDefinitionsSorted.length > 0 ? (
                    recurringDefinitionsSorted.map((activity) => (
                      <div
                        key={activity.id}
                        className="rounded-xl border border-[color:var(--line)] px-2 py-2 flex items-start justify-between gap-2"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-medium break-words">{activity.title}</div>
                          <div className="text-[11px] text-[color:var(--muted)] mt-1">
                            {formatRecurringRule(props.gameId, activity.rule, activity.durationDays)}
                          </div>
                        </div>
                        <div className="shrink-0 flex items-center gap-2">
                          <button
                            type="button"
                            className={clsx(
                              "text-xs px-2 py-1 rounded-lg border border-[color:var(--line)] transition",
                              "hover:border-[color:var(--ink)] hover:bg-[color:var(--tile)]",
                              editingRecurringId === activity.id && "border-[color:var(--accent)] text-[color:var(--accent)]"
                            )}
                            onClick={() => {
                              setIsRecurringSettingsOpen(true);
                              setEditingRecurringId(activity.id);
                              setRecurringForm(makeRecurringFormStateFromActivity(activity));
                              setRecurringFormError(null);
                            }}
                          >
                            修改
                          </button>
                          <button
                            type="button"
                            className="text-xs px-2 py-1 rounded-lg border border-[color:var(--line)] hover:border-red-400 hover:text-red-500 transition"
                            onClick={() => {
                              if (editingRecurringId === activity.id) resetRecurringForm();
                              removeRecurringActivity(props.gameId, activity.id);
                            }}
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-xs text-[color:var(--muted)]">当前游戏尚未配置循环活动</div>
                  )}
                </div>
              </div>
            ) : null}
            <div className="divide-y divide-[color:var(--line)]">
              {activeRecurringEvents.length > 0 ? (
                activeRecurringEvents.map((event) => (
                  <EventListRow
                    key={String(event.id)}
                    event={event}
                    checked={false}
                    isSelected={selectedId === event.id}
                    now={now}
                    onSelect={() => {
                      toggleSelectedFromList(event.id);
                    }}
                    onToggleCompleted={() => toggleRecurringCompleted(event.recurringActivityId, event.cycleKey)}
                  />
                ))
              ) : (
                <div className="p-4 text-xs text-[color:var(--muted)]">
                  暂无未完成循环活动
                </div>
              )}
            </div>
        </div>
      </div>

      {completedUpstreamEvents.length > 0 || completedRecurringEvents.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-2">
          <EventListPanel
            title="已完成活动"
            titleClassName="text-[color:var(--ink2)]"
            events={completedUpstreamEvents}
            emptyText="暂无已完成活动"
            checked={true}
            selectedId={selectedId}
            now={now}
            onSelect={toggleSelectedFromList}
            onToggleCompleted={(event) => toggleCompleted(event.id)}
          />

          <EventListPanel
            title="已完成循环活动"
            titleClassName="text-[color:var(--ink2)]"
            events={completedRecurringEvents}
            emptyText="暂无已完成循环活动"
            checked={true}
            selectedId={selectedId}
            now={now}
            onSelect={toggleSelectedFromList}
            onToggleCompleted={(event) => toggleRecurringCompleted(event.recurringActivityId, event.cycleKey)}
          />
        </div>
      ) : null}
    </div>
  );
}
