import { useSyncExternalStore } from "react";
import { clamp } from "../lib/color";
import { getClockNowMs, subscribeClock } from "../lib/clock";

/**
 * Version progress track with a live "xx.xx%" label above the end of the fill.
 * The snapshot is the formatted percentage, so it only re-renders when the
 * visible value changes, on the shared per-second clock.
 */
export default function VersionProgressBar(props: { startMs: number; endMs: number; color: string; ink: string }) {
  const { startMs, endMs } = props;
  const label = useSyncExternalStore(subscribeClock, () => {
    const pct = clamp(((getClockNowMs() - startMs) / Math.max(1, endMs - startMs)) * 100, 0, 100);
    return pct.toFixed(2);
  });
  const pct = Number(label);
  const text = `${label}%`;
  // Half the label's width: monospace text is 1ch per character.
  const half = `${text.length / 2}ch`;

  return (
    <div className="grid gap-1">
      {/* The label is centered above the end of the fill, clamped so it never overhangs the track. */}
      <div className="relative h-4 font-mono text-[11px] md:text-xs">
        <span className="absolute inset-y-0 w-0" style={{ left: `clamp(${half}, ${pct}%, calc(100% - ${half}))` }}>
          <span
            className="absolute bottom-0 left-0 -translate-x-1/2 leading-4 font-semibold whitespace-nowrap"
            style={{ color: props.ink }}
          >
            {text}
          </span>
        </span>
      </div>
      <div className="h-2.5 rounded-full bg-[color:var(--line-soft)]">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: props.color }} />
      </div>
    </div>
  );
}
