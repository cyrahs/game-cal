import { useEffect, useMemo, useState } from "react";
import { fetchGameSummaryEntry } from "../api/summary";
import type { GameId, GameVersionInfo } from "../api/types";

export type UseCurrentVersionState =
  | { status: "loading"; data: null; error: null }
  | { status: "success"; data: GameVersionInfo | null; error: null }
  | { status: "error"; data: null; error: Error };
type KeyedUseCurrentVersionState = { key: string; value: UseCurrentVersionState };

const memory = new Map<string, { at: number; data: GameVersionInfo | null }>();
const TTL_MS = 60_000;

export function useCurrentVersion(game: GameId) {
  const key = useMemo(() => `current-version:${game}`, [game]);
  const [state, setState] = useState<KeyedUseCurrentVersionState>({
    key,
    value: { status: "loading", data: null, error: null },
  });

  useEffect(() => {
    let cancelled = false;

    const cached = memory.get(key);
    if (cached && Date.now() - cached.at < TTL_MS) {
      setState({ key, value: { status: "success", data: cached.data, error: null } });
      return;
    }

    setState({ key, value: { status: "loading", data: null, error: null } });
    fetchGameSummaryEntry(game)
      .then((entry) => {
        if (!entry.ok) throw new Error(entry.error || "加载失败");
        memory.set(key, { at: Date.now(), data: entry.version });
        if (cancelled) return;
        setState({ key, value: { status: "success", data: entry.version, error: null } });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ key, value: { status: "error", data: null, error: err as Error } });
      });

    return () => {
      cancelled = true;
    };
  }, [game, key]);

  if (state.key !== key) {
    const cached = memory.get(key);
    if (cached && Date.now() - cached.at < TTL_MS) {
      return { status: "success", data: cached.data, error: null } satisfies UseCurrentVersionState;
    }
    return { status: "loading", data: null, error: null } satisfies UseCurrentVersionState;
  }

  return state.value;
}
