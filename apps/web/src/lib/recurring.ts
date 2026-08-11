import dayjs, { type Dayjs } from "dayjs";

import type { GameId } from "../api/types";
import type { MonthlyCardState, RecurringActivity, RecurringRule } from "../context/prefs";
import {
  detectUniformStep,
  findNextCronOccurrence,
  findPrevCronOccurrence,
  parseCronExpression,
  validateCronExpression,
} from "./cron";
import { DAY_MS, MINUTE_MS, formatFixedUtcOffset, pad2, toIsoWithOffset } from "./time";

export const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

type GameDailyResetConfig = {
  tzOffsetMinutes: number;
  resetOffsetMinutes: number;
};

const GAME_DAILY_RESET_CONFIG_BY_GAME: Record<GameId, GameDailyResetConfig> = {
  // Current upstream sources in this app are all CN servers (UTC+8) and use 04:00 as daily rollover.
  genshin: { tzOffsetMinutes: 8 * 60, resetOffsetMinutes: 4 * 60 },
  starrail: { tzOffsetMinutes: 8 * 60, resetOffsetMinutes: 4 * 60 },
  zzz: { tzOffsetMinutes: 8 * 60, resetOffsetMinutes: 4 * 60 },
  ww: { tzOffsetMinutes: 8 * 60, resetOffsetMinutes: 4 * 60 },
  snowbreak: { tzOffsetMinutes: 8 * 60, resetOffsetMinutes: 4 * 60 },
  endfield: { tzOffsetMinutes: 8 * 60, resetOffsetMinutes: 4 * 60 },
};

export function getRecurringTzOffsetMinutes(gameId: GameId): number {
  return GAME_DAILY_RESET_CONFIG_BY_GAME[gameId]?.tzOffsetMinutes ?? 8 * 60;
}

export function getDailyResetOffsetMinutes(gameId: GameId): number {
  return GAME_DAILY_RESET_CONFIG_BY_GAME[gameId]?.resetOffsetMinutes ?? 4 * 60;
}

export function formatCronHumanReadable(expression: string): string {
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

export function formatRecurringRule(gameId: GameId, rule: RecurringRule, durationDays?: number): string {
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

function toDailyCycleIndex(ms: number, tzOffsetMinutes: number, resetOffsetMinutes: number): number {
  const tzOffsetMs = tzOffsetMinutes * MINUTE_MS;
  const resetOffsetMs = resetOffsetMinutes * MINUTE_MS;
  return Math.floor((ms + tzOffsetMs - resetOffsetMs) / DAY_MS);
}

export function getMonthlyCardRemainingDays(
  entry: MonthlyCardState | null | undefined,
  now: Dayjs,
  tzOffsetMinutes: number,
  resetOffsetMinutes: number
): number | null {
  if (!entry) return null;
  const baseDays = Math.max(0, Math.trunc(entry.remainingDays));
  if (!Number.isFinite(entry.asOfMs)) return baseDays;
  const asOfMs = Math.trunc(entry.asOfMs);
  const nowCycle = toDailyCycleIndex(now.valueOf(), tzOffsetMinutes, resetOffsetMinutes);
  const asOfCycle = toDailyCycleIndex(asOfMs, tzOffsetMinutes, resetOffsetMinutes);
  const elapsedCycles = Math.max(0, nowCycle - asOfCycle);
  if (elapsedCycles > baseDays) return null;
  return baseDays - elapsedCycles;
}

export function getMonthlyCardEndTime(now: Dayjs, remainingDays: number, tzOffsetMinutes: number, resetOffsetMinutes: number): Dayjs {
  const currentCycle = toDailyCycleIndex(now.valueOf(), tzOffsetMinutes, resetOffsetMinutes);
  const tzOffsetMs = tzOffsetMinutes * MINUTE_MS;
  const resetOffsetMs = resetOffsetMinutes * MINUTE_MS;
  const nextResetMs = (currentCycle + 1) * DAY_MS - tzOffsetMs + resetOffsetMs;
  return dayjs(nextResetMs).add(Math.max(0, Math.trunc(remainingDays)), "day");
}
