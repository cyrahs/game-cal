import { apiGet } from "../api/client";
import type { GameVersionInfo } from "../api/types";
import { type CachedResourceState, createGameResourceHook } from "./useCachedResource";

export type UseCurrentVersionState = CachedResourceState<GameVersionInfo | null>;

export const useCurrentVersion = createGameResourceHook<GameVersionInfo | null>(async (game) => {
  const res = await apiGet<GameVersionInfo | null>(`/api/version/${game}`);
  return { data: res.data, updatedAtMs: Date.now() };
});
