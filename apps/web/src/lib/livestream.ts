import type { CalendarEvent, GameId } from "../api/types";
import { DAY_MS, pad2 } from "./time";

// Version livestreams ("前瞻特别节目") air on a fixed weekday and time, a fixed
// number of weeks before the week the current version ends. Until the official
// announcement is out (an `is_livestream` event from the API), the next stream
// is predicted from that pattern.

export type LivestreamRule = {
  // Weeks (Monday-based, UTC+8) between the stream's week and the version end's week.
  weeksBefore: number;
  // 1 = Monday ... 7 = Sunday.
  weekday: number;
  hour: number;
  minute: number;
};

export type LivestreamInfo = {
  kind: "predicted" | "confirmed";
  startMs: number;
  // Predictions only: the pattern the date came from, as shown to the user.
  ruleText?: string;
  // Confirmed only: the announced stream's title and the official post.
  title?: string;
  linkUrl?: string;
};

const SOURCE_OFFSET_MS = 8 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const WEEKDAY_NAMES = ["一", "二", "三", "四", "五", "六", "日"];
const WEEK_COUNT_NAMES = ["", "一", "两", "三", "四"];

// From the official preview posts (米游社 / 库街区 / 终末地), 2024 to 2026.
// Most streams fit; holidays and anniversaries occasionally shift one by a few days.
export const LIVESTREAM_RULES: Partial<Record<GameId, LivestreamRule>> = {
  genshin: { weeksBefore: 2, weekday: 5, hour: 20, minute: 0 },
  starrail: { weeksBefore: 2, weekday: 5, hour: 19, minute: 30 },
  zzz: { weeksBefore: 2, weekday: 5, hour: 19, minute: 30 },
  ww: { weeksBefore: 2, weekday: 5, hour: 19, minute: 0 },
  endfield: { weeksBefore: 2, weekday: 5, hour: 19, minute: 30 },
};

export function describeLivestreamRule(rule: LivestreamRule): string {
  const weeks = WEEK_COUNT_NAMES[rule.weeksBefore] ?? String(rule.weeksBefore);
  return `版本结束前${weeks}周的周${WEEKDAY_NAMES[rule.weekday - 1]} ${pad2(rule.hour)}:${pad2(rule.minute)}（UTC+8）`;
}

/** Applies a rule to a version end time. Week boundaries and the clock time are in UTC+8. */
export function livestreamTimeFromRule(rule: LivestreamRule, versionEndMs: number): number {
  const local = versionEndMs + SOURCE_OFFSET_MS;
  const dayStart = Math.floor(local / DAY_MS) * DAY_MS;
  // 1970-01-01 was a Thursday, so Monday-based weekday index = (days + 3) % 7.
  const weekdayIndex = (Math.floor(local / DAY_MS) + 3) % 7;
  const weekStart = dayStart - weekdayIndex * DAY_MS;
  const streamDay = weekStart - rule.weeksBefore * WEEK_MS + (rule.weekday - 1) * DAY_MS;
  return streamDay + (rule.hour * 60 + rule.minute) * 60 * 1000 - SOURCE_OFFSET_MS;
}

/**
 * The predicted livestream for the version that follows the current one, or null
 * when the game has no known pattern or the date falls outside the current version.
 */
export function predictLivestream(gameId: GameId, versionStartMs: number, versionEndMs: number): LivestreamInfo | null {
  const rule = LIVESTREAM_RULES[gameId];
  if (!rule || !(versionEndMs > versionStartMs)) return null;
  const startMs = livestreamTimeFromRule(rule, versionEndMs);
  if (startMs <= versionStartMs || startMs >= versionEndMs) return null;
  return { kind: "predicted", startMs, ruleText: describeLivestreamRule(rule) };
}

/**
 * The officially announced stream for the next version: the latest
 * `is_livestream` event that starts inside the current version. Streams before
 * the version start belong to the current version and are ignored.
 */
export function pickAnnouncedLivestream(
  events: readonly CalendarEvent[],
  versionStartMs: number,
  versionEndMs: number,
): LivestreamInfo | null {
  let best: { startMs: number; event: CalendarEvent } | null = null;
  for (const event of events) {
    if (!event.is_livestream) continue;
    const startMs = Date.parse(event.start_time);
    if (!Number.isFinite(startMs) || startMs <= versionStartMs || startMs >= versionEndMs) continue;
    if (!best || startMs > best.startMs) best = { startMs, event };
  }
  if (!best) return null;
  return { kind: "confirmed", startMs: best.startMs, title: best.event.title, linkUrl: best.event.linkUrl };
}

/** The announced stream when there is one, else the prediction. */
export function resolveLivestream(
  gameId: GameId,
  events: readonly CalendarEvent[],
  versionStartMs: number,
  versionEndMs: number,
): LivestreamInfo | null {
  return (
    pickAnnouncedLivestream(events, versionStartMs, versionEndMs) ??
    predictLivestream(gameId, versionStartMs, versionEndMs)
  );
}
