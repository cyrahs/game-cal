import { invalidateSummaryCache } from "../api/summary";
import { useCurrentVersion } from "./useCurrentVersion";
import { useEvents } from "./useEvents";

// Retry entry point for error states: drop every layer of cache, then force
// all mounted event/version hooks to refetch immediately.
export function refreshGameData(): void {
  invalidateSummaryCache();
  useEvents.invalidate();
  useCurrentVersion.invalidate();
}
