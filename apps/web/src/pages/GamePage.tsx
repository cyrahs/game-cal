import type { GameId } from "../api/types";
import LoadingCard from "../components/LoadingCard";
import TimelineCalendar from "../components/TimelineCalendar/TimelineCalendar";
import { refreshGameData } from "../hooks/refreshGameData";
import { useCurrentVersion } from "../hooks/useCurrentVersion";
import { useEvents } from "../hooks/useEvents";
import { localizeErrorMessage } from "../lib/errors";

export default function GamePage(props: { game: GameId }) {
  const eventsState = useEvents(props.game);
  const currentVersionState = useCurrentVersion(props.game);

  if (eventsState.status === "loading") {
    return <LoadingCard />;
  }

  if (eventsState.status === "error") {
    return (
      <div className="glass rounded-2xl p-6 shadow-ink border-red-500/30">
        <div className="text-sm font-semibold">加载失败</div>
        <div className="mt-2 text-xs text-[color:var(--muted)]">{localizeErrorMessage(eventsState.error.message)}</div>
        <button
          type="button"
          className="glass mt-3 px-3 py-2 rounded-xl text-xs border border-[color:var(--line)] hover:border-[color:var(--ink)] transition"
          onClick={refreshGameData}
        >
          重试
        </button>
      </div>
    );
  }

  return <TimelineCalendar events={eventsState.data} gameId={props.game} currentVersionState={currentVersionState} />;
}
