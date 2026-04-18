import { useEffect, useMemo, useState } from "react";
import { apiGetWithUpdatedAt } from "../api/client";
import type { CalendarEvent, GameId } from "../api/types";

type UseEventsState =
  | { status: "loading"; data: null; error: null; updatedAtMs: null }
  | { status: "success"; data: CalendarEvent[]; error: null; updatedAtMs: number }
  | { status: "error"; data: null; error: Error; updatedAtMs: null };
type KeyedUseEventsState = { key: string; value: UseEventsState };

const memory = new Map<string, { at: number; data: CalendarEvent[]; updatedAtMs: number }>();
const inFlight = new Map<string, Promise<{ data: CalendarEvent[]; updatedAtMs: number }>>();
const TTL_MS = 60_000;

export function useEvents(game: GameId) {
  const key = useMemo(() => `events:${game}`, [game]);
  const [state, setState] = useState<KeyedUseEventsState>({
    key,
    value: { status: "loading", data: null, error: null, updatedAtMs: null },
  });

  useEffect(() => {
    let cancelled = false;

    const cached = memory.get(key);
    if (cached && Date.now() - cached.at < TTL_MS) {
      setState({ key, value: { status: "success", data: cached.data, error: null, updatedAtMs: cached.updatedAtMs } });
      return;
    }

    setState({ key, value: { status: "loading", data: null, error: null, updatedAtMs: null } });
    let request = inFlight.get(key);
    if (!request) {
      request = apiGetWithUpdatedAt<CalendarEvent[]>(`/api/events/${game}`)
        .then(({ json, updatedAtMs }) => {
          const safeUpdatedAtMs = updatedAtMs ?? Date.now();
          memory.set(key, { at: Date.now(), data: json.data, updatedAtMs: safeUpdatedAtMs });
          return { data: json.data, updatedAtMs: safeUpdatedAtMs };
        })
        .finally(() => {
          if (inFlight.get(key) === request) inFlight.delete(key);
        });
      inFlight.set(key, request);
    }

    request
      .then(({ data, updatedAtMs }) => {
        if (cancelled) return;
        setState({ key, value: { status: "success", data, error: null, updatedAtMs } });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ key, value: { status: "error", data: null, error: err as Error, updatedAtMs: null } });
      });

    return () => {
      cancelled = true;
    };
  }, [game, key]);

  if (state.key !== key) {
    const cached = memory.get(key);
    if (cached && Date.now() - cached.at < TTL_MS) {
      return { status: "success", data: cached.data, error: null, updatedAtMs: cached.updatedAtMs } satisfies UseEventsState;
    }
    return { status: "loading", data: null, error: null, updatedAtMs: null } satisfies UseEventsState;
  }

  return state.value;
}
