import clsx from "clsx";
import dayjs, { type Dayjs } from "dayjs";
import { useMemo, useState } from "react";
import type { CalendarEvent } from "./types";
import { calculateBarsForMonth, generateCalendarGrid, sortOverview } from "./utils";

const weekday = ["日", "一", "二", "三", "四", "五", "六"];

function formatUtcOffsetLabel(input: string): string {
  const d = dayjs(input);
  if (!d.isValid()) return "UTC?";
  const mins = -d.toDate().getTimezoneOffset();
  const sign = mins >= 0 ? "+" : "-";
  const abs = Math.abs(mins);
  const hh = Math.floor(abs / 60);
  const mm = abs % 60;
  if (mm === 0) return `UTC${sign}${hh}`;
  return `UTC${sign}${hh}:${String(mm).padStart(2, "0")}`;
}

export default function EventCalendar(props: { value: Dayjs; events: CalendarEvent[] }) {
  const [month, setMonth] = useState(props.value.startOf("month"));
  const [showOverview, setShowOverview] = useState(true);

  const weeks = useMemo(() => generateCalendarGrid(month), [month]);
  const barsByWeek = useMemo(() => calculateBarsForMonth(month, props.events), [month, props.events]);
  const overview = useMemo(() => sortOverview(props.events), [props.events]);

  const maxLevels = useMemo(() => {
    return barsByWeek.map((bars) => bars.reduce((m, b) => Math.max(m, b.level), 1));
  }, [barsByWeek]);

  return (
    <div className="fade-in grid grid-cols-1 gap-3 lg:grid-cols-[340px_1fr]">
      <aside
        className={clsx(
          "glass shadow-ink rounded-2xl overflow-hidden transition-[max-height,opacity] duration-300",
          showOverview ? "opacity-100" : "opacity-60"
        )}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[color:var(--line)]">
          <div className="flex flex-col">
            <div className="text-sm font-semibold">活动概览</div>
            <div className="text-xs text-[color:var(--muted)] font-mono">{overview.length} items</div>
          </div>
          <button
            className="text-xs rounded-full px-3 py-1 border border-[color:var(--line)] hover:border-[color:var(--ink)] transition"
            onClick={() => setShowOverview((v) => !v)}
          >
            {showOverview ? "收起" : "展开"}
          </button>
        </div>

        <div className={clsx("p-3 overflow-auto max-h-[64vh]")}>
          <div className={clsx("grid gap-3", showOverview ? "opacity-100" : "opacity-0 h-0 overflow-hidden")}>
            {overview.map((e) => (
              <div
                key={String(e.id)}
                className={clsx(
                  "rounded-xl border border-[color:var(--line)] bg-[color:var(--tile-strong)] overflow-hidden",
                  e.isEnd && "opacity-70"
                )}
              >
                {e.banner ? (
                  <div className="bg-black/5 dark:bg-white/5">
                    <img
                      src={e.banner}
                      alt={e.title}
                      loading="lazy"
                      className="w-full h-28 object-cover"
                      referrerPolicy="no-referrer"
                    />
                  </div>
                ) : null}
                <div className="p-3">
                  <div className={clsx("text-sm leading-snug", e.isEnd && "line-through")}>{e.title}</div>
                  <div className="mt-2 text-[11px] font-mono text-[color:var(--muted)]">
                    {dayjs(e.start_time).format("YYYY/MM/DD HH:mm")} ~ {dayjs(e.end_time).format("YYYY/MM/DD HH:mm")} ({formatUtcOffsetLabel(e.start_time)})
                  </div>
                  {e.linkUrl ? (
                    <a
                      className="mt-2 inline-block text-xs text-[color:var(--accent)] hover:underline"
                      href={e.linkUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      活动详情
                    </a>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          {!showOverview ? (
            <div className="text-xs text-[color:var(--muted)] px-1 py-4">
              概览已收起。点击右上角展开。
            </div>
          ) : null}
        </div>
      </aside>

      <section className="glass shadow-ink rounded-2xl overflow-hidden">
        <header className="flex items-center justify-between px-4 py-3 border-b border-[color:var(--line)]">
          <button
            className="rounded-lg px-2 py-1 border border-[color:var(--line)] hover:border-[color:var(--ink)] transition"
            onClick={() => setMonth((m) => m.subtract(1, "month"))}
            aria-label="prev-month"
          >
            ←
          </button>
          <div className="text-sm font-semibold">
            {month.format("YYYY")} 年 {month.format("M")} 月
          </div>
          <button
            className="rounded-lg px-2 py-1 border border-[color:var(--line)] hover:border-[color:var(--ink)] transition"
            onClick={() => setMonth((m) => m.add(1, "month"))}
            aria-label="next-month"
          >
            →
          </button>
        </header>

        <div className="grid grid-cols-7 text-xs border-b border-[color:var(--line)] bg-[color:var(--wash)]">
          {weekday.map((w) => (
            <div key={w} className="py-2 text-center text-[color:var(--muted)]">
              周{w}
            </div>
          ))}
        </div>

        <div className="p-3">
          <div className="grid gap-2">
            {weeks.map((week, wi) => {
              const bars = barsByWeek[wi] ?? [];
              const maxLevel = maxLevels[wi] ?? 1;
              const height = 38 + maxLevel * 20; // px (day row + stacked bars)

              return (
                <div
                  key={wi}
                  className="relative rounded-xl bg-[color:var(--tile)] border border-[color:var(--line)] overflow-hidden"
                  style={{ height }}
                >
                  <div className="grid grid-cols-7">
                    {week.map((d) => {
                      const isToday = d.isSame(dayjs(), "day");
                      const isThisMonth = d.isSame(month, "month");
                      return (
                        <div
                          key={d.format("YYYY-MM-DD")}
                          className={clsx(
                            "px-2 py-1 text-right text-xs border-r border-[color:var(--line)] last:border-r-0",
                            !isThisMonth && "text-[color:var(--muted)] opacity-70"
                          )}
                        >
                          <span
                            className={clsx(
                              "inline-flex items-center justify-center w-6 h-6 rounded-full",
                              isToday && "bg-[color:var(--accent)] text-white"
                            )}
                          >
                            {d.format("D")}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {/* bars */}
                  <div className="absolute left-0 right-0 top-8 bottom-0">
                    {bars.map((b) => (
                      <div
                        key={String(b.id) + ":" + wi}
                        className="absolute px-2 py-[2px] rounded-lg text-[11px] leading-4 text-slate-900 border border-white/60 shadow-sm overflow-hidden text-ellipsis whitespace-nowrap"
                        style={{
                          background: b.color,
                          width: `calc((${b.width} * 100%) / 7)`,
                          left: b.left === 0 || b.left === 7 ? undefined : `calc((${b.left} * 100%) / 7)`,
                          top: `${(b.level - 1) * 20}px`,
                        }}
                        title={b.title}
                      >
                        {b.title}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}
