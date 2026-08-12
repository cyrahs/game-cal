import { useEffect, useMemo, useState } from "react";
import { fetchGameSummaryEntry } from "../api/summary";
import type { CalendarEvent, GameId } from "../api/types";

type UseEventsState =
  | { status: "loading"; data: null; error: null; updatedAtMs: null }
  | { status: "success"; data: CalendarEvent[]; error: null; updatedAtMs: number }
  | { status: "error"; data: null; error: Error; updatedAtMs: null };
type KeyedUseEventsState = { key: string; value: UseEventsState };

const memory = new Map<string, { at: number; data: CalendarEvent[]; updatedAtMs: number }>();
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
    fetchGameSummaryEntry(game)
      .then((entry) => {
        if (!entry.ok) throw new Error(entry.error || "加载失败");
        memory.set(key, { at: Date.now(), data: entry.events, updatedAtMs: entry.updatedAtMs });
        if (cancelled) return;
        setState({ key, value: { status: "success", data: entry.events, error: null, updatedAtMs: entry.updatedAtMs } });
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
