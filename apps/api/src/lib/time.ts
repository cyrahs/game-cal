function normalizeTzOffset(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("sourceTzOffset is required");

  // Accept common variants like: "+08:00", "-0800", "UTC+8", "UTC-8", "GMT+08:00".
  const s0 = raw.replace(/^(UTC|GMT)\s*/i, "").trim();
  if (s0.toUpperCase() === "Z") return "+00:00";

  const m =
    /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(s0) ??
    /^([+-])(\d{2})(\d{2})$/.exec(s0);
  if (!m) throw new Error(`Invalid sourceTzOffset: ${input}`);

  const sign = m[1]!;
  const hh = Number(m[2]!);
  const mm = Number(m[3] ?? "0");

  if (!Number.isFinite(hh) || !Number.isFinite(mm)) {
    throw new Error(`Invalid sourceTzOffset: ${input}`);
  }
  if (hh < 0 || hh > 23) throw new Error(`Invalid sourceTzOffset: ${input}`);
  if (mm < 0 || mm > 59) throw new Error(`Invalid sourceTzOffset: ${input}`);

  return `${sign}${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function normalizeExistingOffsetSuffix(s: string): string {
  // Convert "+0800" -> "+08:00" (keep "Z" as-is).
  const m = /([+-])(\d{2})(\d{2})$/.exec(s);
  if (!m) return s;
  return `${s.slice(0, -5)}${m[1]}${m[2]}:${m[3]}`;
}

function hasTimeZoneSuffix(s: string): boolean {
  return /[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s);
}

/**
 * Convert upstream "local" datetime strings into ISO-8601 with an explicit
 * timezone offset, so browsers can reliably convert to the user's timezone.
 *
 * Upstream sources typically return values like "YYYY-MM-DD HH:mm:ss" without
 * timezone info. We assume those are in the provided sourceTzOffset.
 */
export function toIsoWithSourceOffset(
  input: string,
  sourceTzOffset: string
): string {
  const SOURCE_TZ_OFFSET = normalizeTzOffset(sourceTzOffset);
  const s = input.trim();
  if (!s) return input;

  // Already has an explicit TZ suffix (Z / +/-hh:mm / +/-hhmm).
  if (hasTimeZoneSuffix(s)) return normalizeExistingOffsetSuffix(s);

  // ISO-like without TZ: "YYYY-MM-DDTHH:mm(:ss)?" -> append offset.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    const withSeconds = s.length === 16 ? `${s}:00` : s;
    return `${withSeconds}${SOURCE_TZ_OFFSET}`;
  }

  // Common upstream formats: "YYYY-MM-DD", "YYYY-MM-DD HH:mm", "YYYY-MM-DD HH:mm:ss"
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return `${s}T00:00:00${SOURCE_TZ_OFFSET}`;
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) {
    return `${s.replace(" ", "T")}:00${SOURCE_TZ_OFFSET}`;
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return `${s.replace(" ", "T")}${SOURCE_TZ_OFFSET}`;
  }

  // Unknown format; leave untouched.
  return input;
}

function offsetToMinutes(offset: string): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  const hh = Number(m[2]);
  const mm = Number(m[3]);
  return sign * (hh * 60 + mm);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Convert a Unix timestamp (seconds since epoch) to ISO-8601 with the same
 * source offset used by {@link toIsoWithSourceOffset}.
 */
export function unixSecondsToIsoWithSourceOffset(
  input: string | number,
  sourceTzOffset: string
): string {
  const SOURCE_TZ_OFFSET = normalizeTzOffset(sourceTzOffset);
  const SOURCE_TZ_OFFSET_MINUTES = offsetToMinutes(SOURCE_TZ_OFFSET);
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n)) return String(input);

  const ms = Math.trunc(n) * 1000;
  const shiftedMs = ms + SOURCE_TZ_OFFSET_MINUTES * 60 * 1000;
  const d = new Date(shiftedMs);

  // Use UTC getters because we applied the offset by shifting the timestamp.
  const yyyy = d.getUTCFullYear();
  const mo = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const mi = pad2(d.getUTCMinutes());
  const ss = pad2(d.getUTCSeconds());

  return `${yyyy}-${mo}-${dd}T${hh}:${mi}:${ss}${SOURCE_TZ_OFFSET}`;
}
