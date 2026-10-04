import { fetchGameSummaryEntry } from "../api/summary";
import type { CalendarEvent } from "../api/types";
import { type CachedResourceState, createGameResourceHook } from "./useCachedResource";

export type UseEventsState = CachedResourceState<CalendarEvent[]>;

// Announced livestreams ride along in the events feed but are not activities;
// they only feed the version progress bar (useLivestreamEvents).
export const useEvents = createGameResourceHook<CalendarEvent[]>(async (game) => {
  const entry = await fetchGameSummaryEntry(game);
  if (!entry.ok) throw new Error(entry.error || "加载失败");
  return { data: entry.events.filter((event) => !event.is_livestream), updatedAtMs: entry.updatedAtMs };
});

export const useLivestreamEvents = createGameResourceHook<CalendarEvent[]>(async (game) => {
  const entry = await fetchGameSummaryEntry(game);
  if (!entry.ok) throw new Error(entry.error || "加载失败");
  return { data: entry.events.filter((event) => event.is_livestream), updatedAtMs: entry.updatedAtMs };
});
