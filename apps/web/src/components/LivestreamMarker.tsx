import clsx from "clsx";
import dayjs from "dayjs";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { clamp } from "../lib/color";
import { getClockNowMs, subscribeClock } from "../lib/clock";
import type { LivestreamInfo } from "../lib/livestream";
import { LiveDuration } from "./LiveDuration";

/**
 * A dot on the version track at the next version livestream. Hovering (or
 * focusing) shows the details; on touch screens a tap toggles them.
 * Predicted streams are a hollow ring, confirmed ones a solid dot.
 */
export default function LivestreamMarker(props: { info: LivestreamInfo; startMs: number; endMs: number; ink: string }) {
  const { info, startMs, endMs, ink } = props;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [shiftPx, setShiftPx] = useState(0);
  const lastPointerRef = useRef<string>("mouse");
  const aired = useSyncExternalStore(subscribeClock, () => getClockNowMs() >= info.startMs);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Centered under the dot, then nudged back inside the viewport near either edge.
  useLayoutEffect(() => {
    if (!open || !tipRef.current) {
      setShiftPx(0);
      return;
    }
    const margin = 8;
    const rect = tipRef.current.getBoundingClientRect();
    const left = rect.left - shiftPx;
    const right = rect.right - shiftPx;
    const maxRight = document.documentElement.clientWidth - margin;
    setShiftPx(left < margin ? margin - left : right > maxRight ? maxRight - right : 0);
    // Measure once per opening; the dot does not move while the card is shown.
  }, [open]);

  const pct = clamp(((info.startMs - startMs) / Math.max(1, endMs - startMs)) * 100, 0, 100);
  const confirmed = info.kind === "confirmed";
  const when = dayjs(info.startMs);
  const kindLabel = confirmed ? "官方" : "预测";

  return (
    <div
      ref={rootRef}
      className="absolute top-1/2 z-10 -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${pct}%` }}
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") setOpen(true);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") setOpen(false);
      }}
    >
      <button
        type="button"
        aria-label={`${(confirmed && info.title) || "下个版本前瞻"}（${kindLabel}）：${when.format("MM/DD HH:mm")}`}
        aria-expanded={open}
        onPointerDown={(e) => {
          lastPointerRef.current = e.pointerType;
        }}
        onClick={() => {
          // A mouse already opened it on hover; a tap or a key press toggles.
          if (lastPointerRef.current === "mouse") setOpen(true);
          else setOpen((v) => !v);
          lastPointerRef.current = "";
        }}
        onBlur={(e) => {
          if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
        }}
        className={clsx(
          "relative block w-3.5 h-3.5 rounded-full border-2 transition-transform hover:scale-110",
          "after:absolute after:-inset-2 after:content-[''] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]",
        )}
        style={
          confirmed
            ? { background: ink, borderColor: "var(--card)", boxShadow: `0 0 0 1.5px ${ink}` }
            : { background: "var(--card)", borderColor: ink }
        }
      />
      {open ? (
        // The top padding bridges the gap to the dot, so the pointer can reach the link.
        <div
          className="absolute top-full left-1/2 pt-2.5"
          style={{ transform: `translateX(calc(-50% + ${shiftPx}px))` }}
        >
          <div
            ref={tipRef}
            role="tooltip"
            className="w-max max-w-[min(300px,calc(100vw-16px))] rounded-xl border border-[color:var(--line)] bg-[color:var(--card)] px-3 py-2.5 shadow-ink grid gap-1 text-xs"
          >
            <div className="flex items-center gap-2">
              <span className="font-semibold text-[color:var(--ink)]">
                {(confirmed && info.title) || "下个版本前瞻"}
              </span>
              <span
                className="rounded-md border px-1.5 text-[11px] leading-[18px] font-semibold"
                style={
                  confirmed ? { color: ink, borderColor: ink } : { color: "var(--muted)", borderColor: "var(--line)" }
                }
              >
                {kindLabel}
              </span>
            </div>
            {/* Remaining time over the start time, like the gacha cards. */}
            <div className="grid gap-0.5">
              <span className="font-mono text-[13px] font-semibold text-[color:var(--ink)]">
                {aired ? confirmed ? "已开播" : "推算时间已过" : <LiveDuration untilMs={info.startMs} />}
              </span>
              <span className="font-mono text-[11px] text-[color:var(--muted)]">{when.format("MM/DD HH:mm")}</span>
            </div>
            {!confirmed && info.ruleText ? (
              <div className="text-[color:var(--muted)]">{info.ruleText}</div>
            ) : null}
            {confirmed && info.linkUrl ? (
              <a
                href={info.linkUrl}
                target="_blank"
                rel="noreferrer"
                className="w-fit font-semibold underline-offset-2 hover:underline"
                style={{ color: ink }}
              >
                查看官方预告 ↗
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
