// Timeline-shaped placeholder shown while the first fetch is in flight, so the
// page does not jump from a bare text line to the full calendar.
export default function LoadingCard() {
  return (
    <div className="glass rounded-2xl p-4 shadow-ink" role="status" aria-label="加载中">
      <div className="animate-pulse grid gap-3">
        <div className="h-4 w-24 rounded-md bg-[color:var(--tile)]" />
        <div className="h-9 w-full rounded-xl bg-[color:var(--tile)]" />
        <div className="h-9 w-4/5 rounded-xl bg-[color:var(--tile)]" />
        <div className="h-9 w-3/5 rounded-xl bg-[color:var(--tile)]" />
        <div className="h-9 w-2/3 rounded-xl bg-[color:var(--tile)]" />
      </div>
      <span className="sr-only">加载中...</span>
    </div>
  );
}
