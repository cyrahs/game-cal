import { useEffect, useMemo, useState } from "react";
import { apiGetWithUpdatedAt } from "../api/client";
import type { CalendarEvent, GameId } from "../api/types";

type UseEventsState =
  | { status: "loading"; data: null; error: null; updatedAtMs: null }
  | { status: "success"; data: CalendarEvent[]; error: null; updatedAtMs: number }
  | { status: "error"; data: null; error: Error; updatedAtMs: null };

const memory = new Map<string, { at: number; data: CalendarEvent[]; updatedAtMs: number }>();
const TTL_MS = 60_000;

export function useEvents(game: GameId) {
  const key = useMemo(() => `events:${game}`, [game]);
  const [state, setState] = useState<UseEventsState>({
    status: "loading",
    data: null,
    error: null,
    updatedAtMs: null,
  });

  useEffect(() => {
    let cancelled = false;

    const cached = memory.get(key);
    if (cached && Date.now() - cached.at < TTL_MS) {
      setState({ status: "success", data: cached.data, error: null, updatedAtMs: cached.updatedAtMs });
      return;
    }

    setState({ status: "loading", data: null, error: null, updatedAtMs: null });
    apiGetWithUpdatedAt<CalendarEvent[]>(`/api/events/${game}`)
      .then(({ json, updatedAtMs }) => {
        if (cancelled) return;
        const safeUpdatedAtMs = updatedAtMs ?? Date.now();
        memory.set(key, { at: Date.now(), data: json.data, updatedAtMs: safeUpdatedAtMs });
        setState({ status: "success", data: json.data, error: null, updatedAtMs: safeUpdatedAtMs });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ status: "error", data: null, error: err as Error, updatedAtMs: null });
      });

    return () => {
      cancelled = true;
    };
  }, [game, key]);

  return state;
}
