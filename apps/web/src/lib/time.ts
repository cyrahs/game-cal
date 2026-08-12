import dayjs, { type Dayjs } from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import utc from "dayjs/plugin/utc";

dayjs.extend(customParseFormat);
dayjs.extend(utc);

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function toIsoWithOffset(d: Dayjs): string {
  return d.format("YYYY-MM-DDTHH:mm:ssZ");
}

export function formatFixedUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(Math.trunc(offsetMinutes));
  const hh = Math.floor(abs / 60);
  const mm = abs % 60;
  if (mm === 0) return `UTC${sign}${hh}`;
  return `UTC${sign}${hh}:${String(mm).padStart(2, "0")}`;
}

export function parseDateTime(input: string | null | undefined): Dayjs {
  if (!input) return dayjs("invalid");
  // Safari does not reliably parse "YYYY-MM-DD HH:mm" without custom parsing.
  const formats = ["YYYY-MM-DD HH:mm:ss", "YYYY-MM-DD HH:mm", "YYYY-MM-DD"];
  for (const fmt of formats) {
    const d = dayjs(input, fmt, true);
    if (d.isValid()) return d;
  }
  return dayjs(input);
}
