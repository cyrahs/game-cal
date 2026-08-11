import type { Dayjs } from "dayjs";

export type CronField = {
  values: number[];
  valueSet: Set<number>;
  wildcard: boolean;
};

export type ParsedCronExpression = {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
};

const CRON_MAX_SEARCH_MINUTES = 5 * 366 * 24 * 60;

export function detectUniformStep(values: number[], min: number, max: number): { start: number; step: number } | null {
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

export function parseCronExpression(expression: string): { parsed: ParsedCronExpression | null; error: string | null } {
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

export function validateCronExpression(expression: string): { parsed: ParsedCronExpression | null; error: string | null } {
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

export function findNextCronOccurrence(parsed: ParsedCronExpression, from: Dayjs): Dayjs | null {
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

export function findPrevCronOccurrence(parsed: ParsedCronExpression, from: Dayjs): Dayjs | null {
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
