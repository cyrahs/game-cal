import { fetchGameSummaryEntry } from "../api/summary";
import type { GameVersionInfo } from "../api/types";
import { type CachedResourceState, createGameResourceHook } from "./useCachedResource";

export type UseCurrentVersionState = CachedResourceState<GameVersionInfo | null>;

export const useCurrentVersion = createGameResourceHook<GameVersionInfo | null>(async (game) => {
  const entry = await fetchGameSummaryEntry(game);
  if (!entry.ok) throw new Error(entry.error || "加载失败");
  return { data: entry.version, updatedAtMs: entry.updatedAtMs };
});
