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

export function formatLocalUtcOffsetLabel(date: Date): string {
  return formatFixedUtcOffset(-date.getTimezoneOffset());
}

/**
 * Compact countdown text: ≥1 day → "3d5h", <1 day → "5h12m", <1 hour → "12m30s".
 * Units are floored, so the text only changes once the next lower unit rolls over.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m${seconds}s`;
}
