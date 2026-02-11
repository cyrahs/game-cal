import dayjs, { type Dayjs } from "dayjs";
import isBetween from "dayjs/plugin/isBetween";
import isSameOrAfter from "dayjs/plugin/isSameOrAfter";
import type { CalendarBar, CalendarEvent } from "./types";

dayjs.extend(isBetween);
dayjs.extend(isSameOrAfter);

export const palette = [
  "#fda4af",
  "#fdba74",
  "#fde047",
  "#86efac",
  "#5eead4",
  "#93c5fd",
  "#e9d5ff",
];

export function generateCalendarGrid(date: Dayjs): Dayjs[][] {
  const startM = date.startOf("month");
  const endM = date.endOf("month");
  const start = startM.subtract(Number(startM.format("d")), "day"); // to Sunday
  const end = endM.add(6 - Number(endM.format("d")), "day"); // to Saturday
  const length = end.diff(start, "day") + 1;

  const days = Array.from({ length }, (_, i) => start.add(i, "day"));
  const weeks: Dayjs[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}

export function assignLevels(events: CalendarEvent[]): Array<CalendarEvent & { level: number }> {
  const check: Dayjs[] = [];
  const sorted = [...events].sort((a, b) => (dayjs(a.start_time).isBefore(b.start_time) ? -1 : 1));

  return sorted.map((e) => {
    if (check.length === 0) {
      check.push(dayjs(e.end_time));
      return { ...e, level: 1 };
    }

    const idx = check.findIndex((endDate) => dayjs(e.start_time).isSameOrAfter(endDate));
    if (idx === -1) {
      check.push(dayjs(e.end_time));
      return { ...e, level: check.length };
    }

    check[idx] = dayjs(e.end_time);
    return { ...e, level: idx + 1 };
  });
}

export function calculateBarsForMonth(month: Dayjs, events: CalendarEvent[]): CalendarBar[][] {
  const weeks = generateCalendarGrid(month);
  const leveled = assignLevels(events);

  const colorMap = new Map<string | number, string>();
  leveled.forEach((e, i) => {
    colorMap.set(e.id, palette[i % palette.length]);
  });

  return weeks.map((week) => {
    const bars: CalendarBar[] = [];
    for (const e of leveled) {
      let left = 0;
      let width = 0;

      for (const day of week) {
        if (day.isBetween(e.start_time, e.end_time, "day", "[]")) width += 1;
        if (width === 0) left += 1;
      }

      if (width > 0) {
        bars.push({
          ...e,
          left,
          width,
          color: colorMap.get(e.id)!,
        });
      }
    }

    return bars;
  });
}

export function sortOverview(events: CalendarEvent[]): CalendarEvent[] {
  const active: CalendarEvent[] = [];
  const ended: CalendarEvent[] = [];

  for (const e of events) {
    if (dayjs().isAfter(e.end_time)) ended.push({ ...e, isEnd: true });
    else active.push(e);
  }

  return [...active, ...ended];
}

