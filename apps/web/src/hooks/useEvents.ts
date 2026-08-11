import { apiGetWithUpdatedAt } from "../api/client";
import type { CalendarEvent } from "../api/types";
import { type CachedResourceState, createGameResourceHook } from "./useCachedResource";

export type UseEventsState = CachedResourceState<CalendarEvent[]>;

export const useEvents = createGameResourceHook<CalendarEvent[]>(async (game) => {
  const { json, updatedAtMs } = await apiGetWithUpdatedAt<CalendarEvent[]>(`/api/events/${game}`);
  return { data: json.data, updatedAtMs: updatedAtMs ?? Date.now() };
});
