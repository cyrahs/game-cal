import { useSyncExternalStore } from "react";
import { getClockNowMs, subscribeClock } from "../lib/clock";
import { formatDuration } from "../lib/time";

/**
 * Live duration text driven by the shared per-second clock. The snapshot is the
 * formatted string, so React only re-renders this span when the visible text
 * changes (hourly for "3d5h", per minute for "5h12m", per second under an hour).
 */
export function LiveDuration(props: { untilMs?: number; sinceMs?: number }) {
  const { untilMs, sinceMs } = props;
  const text = useSyncExternalStore(subscribeClock, () => {
    const now = getClockNowMs();
    return formatDuration(untilMs !== undefined ? untilMs - now : now - (sinceMs ?? now));
  });
  return <>{text}</>;
}
