import { useSyncExternalStore } from "react";
import { clamp } from "../lib/color";
import { getClockNowMs, subscribeClock } from "../lib/clock";

/**
 * Version progress track with a live "xx.xx%" pill riding on the end of the fill.
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
  // Half the pill's width: monospace text (1ch per char) + px-1.5 padding + 2px border on each side.
  const half = `(${text.length / 2}ch + 8px)`;

  return (
    <div className="relative h-5 flex items-center">
      <div className="w-full h-2.5 rounded-full bg-[color:var(--line-soft)]">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: props.color }} />
      </div>
      {/* The pill is centered on the end of the fill (covering its rounded cap), clamped inside the track. */}
      <span
        className="absolute inset-y-0 w-0 font-mono text-[11px]"
        style={{ left: `clamp(calc${half}, ${pct}%, calc(100% - ${half}))` }}
      >
        <span
          className="absolute top-1/2 left-0 -translate-x-1/2 -translate-y-1/2 h-5 px-1.5 rounded-full border-2 bg-[color:var(--card)] leading-4 font-semibold whitespace-nowrap"
          style={{ borderColor: props.color, color: props.ink }}
        >
          {text}
        </span>
      </span>
    </div>
  );
}
