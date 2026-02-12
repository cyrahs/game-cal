import { useEffect, useMemo, useState } from "react";
import { apiGet } from "../api/client";
import type { GameId, GameVersionInfo } from "../api/types";

export type UseCurrentVersionState =
  | { status: "loading"; data: null; error: null }
  | { status: "success"; data: GameVersionInfo | null; error: null }
  | { status: "error"; data: null; error: Error };

const memory = new Map<string, { at: number; data: GameVersionInfo | null }>();
const TTL_MS = 60_000;

export function useCurrentVersion(game: GameId) {
  const key = useMemo(() => `current-version:${game}`, [game]);
  const [state, setState] = useState<UseCurrentVersionState>({
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
    apiGet<GameVersionInfo | null>(`/api/version/${game}`)
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
