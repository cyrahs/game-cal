import dayjs from "dayjs";
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

/** Current local time with live seconds (e.g. "14:05:32"), on the same shared clock. */
export function LiveClock() {
  const text = useSyncExternalStore(subscribeClock, () => dayjs(getClockNowMs()).format("HH:mm:ss"));
  return <>{text}</>;
}
