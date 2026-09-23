import { useEffect, useRef, useState } from "react";
import type { GameId } from "../api/types";

export type CachedResourceState<T> =
  | { status: "loading"; data: null; error: null; updatedAtMs: null }
  | { status: "success"; data: T; error: null; updatedAtMs: number }
  | { status: "error"; data: null; error: Error; updatedAtMs: null };

// How long client-side data is considered fresh. The Worker refreshes its own
// cache on a cron, so polling faster than this only re-reads the same payload.
const STALE_AFTER_MS = 5 * 60_000;
// How often mounted hooks check whether a background revalidation is due.
const REVALIDATE_CHECK_INTERVAL_MS = 60_000;

type CacheEntry<T> = { at: number; data: T; updatedAtMs: number };

const LOADING = { status: "loading", data: null, error: null, updatedAtMs: null } as const;

/**
 * Builds a per-game data hook with a shared in-memory cache and
 * stale-while-revalidate semantics:
 * - cached data renders immediately (even when stale) — no loading flash;
 * - stale data triggers a deduped background refetch;
 * - mounted hooks revalidate periodically and when the tab becomes visible;
 * - a failed refetch keeps showing the last good data.
 */
export type GameResourceHook<T> = ((game: GameId) => CachedResourceState<T>) & {
  /** Drops the cache and forces every mounted hook to refetch (used by retry buttons). */
  invalidate: () => void;
};

export function createGameResourceHook<T>(
  fetcher: (game: GameId) => Promise<{ data: T; updatedAtMs: number }>
): GameResourceHook<T> {
  const memory = new Map<GameId, CacheEntry<T>>();
  const inFlight = new Map<GameId, Promise<CacheEntry<T>>>();
  const mountedRevalidators = new Set<() => void>();

  function toSuccess(entry: CacheEntry<T>): CachedResourceState<T> {
    return { status: "success", data: entry.data, error: null, updatedAtMs: entry.updatedAtMs };
  }

  function isFresh(entry: CacheEntry<T>): boolean {
    return Date.now() - entry.at < STALE_AFTER_MS;
  }

  function useGameResource(game: GameId): CachedResourceState<T> {
    const [state, setState] = useState<{ key: GameId; value: CachedResourceState<T> }>({
      key: game,
      value: LOADING,
    });
    // Tracks the cache entry already rendered, so periodic ticks don't re-render needlessly.
    const appliedAtRef = useRef<number | null>(null);

    useEffect(() => {
      let cancelled = false;

      const applyEntry = (entry: CacheEntry<T>) => {
        if (cancelled || appliedAtRef.current === entry.at) return;
        appliedAtRef.current = entry.at;
        setState({ key: game, value: toSuccess(entry) });
      };

      const applyBare = (value: CachedResourceState<T>) => {
        if (cancelled) return;
        appliedAtRef.current = null;
        setState({ key: game, value });
      };

      const revalidate = () => {
        const cached = memory.get(game);
        if (cached) {
          // Always render what we have; refetch below only if stale.
          applyEntry(cached);
          if (isFresh(cached)) return;
        } else {
          applyBare(LOADING);
        }

        let request = inFlight.get(game);
        if (!request) {
          request = fetcher(game)
            .then((res) => {
              const entry: CacheEntry<T> = { at: Date.now(), data: res.data, updatedAtMs: res.updatedAtMs };
              memory.set(game, entry);
              return entry;
            })
            .finally(() => {
              if (inFlight.get(game) === request) inFlight.delete(game);
            });
          inFlight.set(game, request);
        }

        request
          .then((entry) => applyEntry(entry))
          .catch((err) => {
            // Keep serving the last good data on refresh failures.
            const latest = memory.get(game);
            if (latest) {
              applyEntry(latest);
              return;
            }
            applyBare({ status: "error", data: null, error: err as Error, updatedAtMs: null });
          });
      };

      appliedAtRef.current = null;
      revalidate();

      mountedRevalidators.add(revalidate);
      const interval = setInterval(revalidate, REVALIDATE_CHECK_INTERVAL_MS);
      const onVisibilityChange = () => {
        if (document.visibilityState === "visible") revalidate();
      };
      document.addEventListener("visibilitychange", onVisibilityChange);

      return () => {
        cancelled = true;
        mountedRevalidators.delete(revalidate);
        clearInterval(interval);
        document.removeEventListener("visibilitychange", onVisibilityChange);
      };
    }, [game]);

    if (state.key !== game) {
      // Route switched this render; fall back to the cache until the effect catches up.
      const cached = memory.get(game);
      if (cached) return toSuccess(cached);
      return LOADING;
    }

    return state.value;
  }

  return Object.assign(useGameResource, {
    invalidate: () => {
      memory.clear();
      for (const revalidate of mountedRevalidators) revalidate();
    },
  });
}
