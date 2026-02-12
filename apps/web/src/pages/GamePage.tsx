import type { GameId } from "../api/types";
import { useEvents } from "../hooks/useEvents";
import { useCurrentVersion } from "../hooks/useCurrentVersion";
import TimelineCalendar from "../components/TimelineCalendar/TimelineCalendar";

export default function GamePage(props: { game: GameId }) {
  const eventsState = useEvents(props.game);
  const currentVersionState = useCurrentVersion(props.game);

  if (eventsState.status === "loading") {
    return (
      <div className="glass rounded-2xl p-6 shadow-ink">
        <div className="text-sm font-semibold">加载中...</div>
      </div>
    );
  }

  if (eventsState.status === "error") {
    return (
      <div className="glass rounded-2xl p-6 shadow-ink border-red-500/30">
        <div className="text-sm font-semibold">加载失败</div>
        <div className="mt-2 text-xs text-[color:var(--muted)] font-mono">{eventsState.error.message}</div>
      </div>
    );
  }

  return <TimelineCalendar events={eventsState.data} gameId={props.game} currentVersionState={currentVersionState} />;
}
