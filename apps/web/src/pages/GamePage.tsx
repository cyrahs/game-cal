import type { GameId } from "../api/types";
import { useEvents } from "../hooks/useEvents";
import TimelineCalendar from "../components/TimelineCalendar/TimelineCalendar";

export default function GamePage(props: { game: GameId }) {
  const state = useEvents(props.game);

  if (state.status === "loading") {
    return (
      <div className="glass rounded-2xl p-6 shadow-ink">
        <div className="text-sm font-semibold">加载中...</div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="glass rounded-2xl p-6 shadow-ink border-red-500/30">
        <div className="text-sm font-semibold">加载失败</div>
        <div className="mt-2 text-xs text-[color:var(--muted)] font-mono">{state.error.message}</div>
      </div>
    );
  }

  return <TimelineCalendar events={state.data} gameId={props.game} />;
}
