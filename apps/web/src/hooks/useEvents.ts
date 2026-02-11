import { useEffect, useMemo, useState } from "react";
import { apiGet } from "../api/client";
import type { CalendarEvent, GameId } from "../api/types";

type UseEventsState =
  | { status: "loading"; data: null; error: null }
  | { status: "success"; data: CalendarEvent[]; error: null }
  | { status: "error"; data: null; error: Error };

const memory = new Map<string, { at: number; data: CalendarEvent[] }>();
const TTL_MS = 60_000;

export function useEvents(game: GameId) {
  const key = useMemo(() => `events:${game}`, [game]);
  const [state, setState] = useState<UseEventsState>({
    status: "loading",
    data: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

    const cached = memory.get(key);
    if (cached && Date.now() - cached.at < TTL_MS) {
      setState({ status: "success", data: cached.data, error: null });
      return;
    }

    setState({ status: "loading", data: null, error: null });
    apiGet<CalendarEvent[]>(`/api/events/${game}`)
      .then((res) => {
        if (cancelled) return;
        memory.set(key, { at: Date.now(), data: res.data });
        setState({ status: "success", data: res.data, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ status: "error", data: null, error: err as Error });
      });

    return () => {
      cancelled = true;
    };
  }, [game, key]);

  return state;
}
