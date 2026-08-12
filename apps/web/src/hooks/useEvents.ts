import { fetchGameSummaryEntry } from "../api/summary";
import type { CalendarEvent } from "../api/types";
import { type CachedResourceState, createGameResourceHook } from "./useCachedResource";

export type UseEventsState = CachedResourceState<CalendarEvent[]>;

export const useEvents = createGameResourceHook<CalendarEvent[]>(async (game) => {
  const entry = await fetchGameSummaryEntry(game);
  if (!entry.ok) throw new Error(entry.error || "加载失败");
  return { data: entry.events, updatedAtMs: entry.updatedAtMs };
});
