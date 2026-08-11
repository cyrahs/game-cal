import { useMemo } from "react";

import type { GameId } from "../api/types";
import TimelineCalendar, { type TimelineCalendarEvent } from "../components/TimelineCalendar/TimelineCalendar";
import { usePrefs } from "../context/prefs";
import { ALL_GAME_IDS, GAME_REGISTRY_BY_ID } from "../lib/games";
import { useEvents } from "../hooks/useEvents";
import { useCurrentVersion } from "../hooks/useCurrentVersion";

export default function HomePage() {
  const { prefs } = usePrefs();
  // ALL_GAME_IDS is a module constant, so the hook call order is stable across renders.
  const eventStates = ALL_GAME_IDS.map((gameId) => [gameId, useEvents(gameId)] as const);
  const versionStates = ALL_GAME_IDS.map((gameId) => [gameId, useCurrentVersion(gameId)] as const);
  const visibleGameIdSet = useMemo(() => new Set<GameId>(prefs.visibleGameIds), [prefs.visibleGameIds]);

  const visibleEventStates = eventStates.filter(([gameId]) => visibleGameIdSet.has(gameId));
  const visibleVersionStates = versionStates.filter(([gameId]) => visibleGameIdSet.has(gameId));

  const aggregatedEvents = useMemo<TimelineCalendarEvent[]>(() => {
    return eventStates.flatMap(([gameId, state]) => {
      if (!visibleGameIdSet.has(gameId)) return [];
      if (state.status !== "success") return [];
      return state.data.map((event) => ({ ...event, gameId }));
    });
    // eventStates is a fresh array each render; depend on the stable per-game state objects instead.
  }, [...eventStates.map(([, state]) => state), visibleGameIdSet]);

  const currentVersions = useMemo(() => {
    return versionStates.flatMap(([, state]) => {
      if (state.status !== "success" || !state.data) return [];
      if (!visibleGameIdSet.has(state.data.game)) return [];
      return state.data;
    });
  }, [...versionStates.map(([, state]) => state), visibleGameIdSet]);

  const hasSuccess = visibleEventStates.some(([, state]) => state.status === "success");
  const isLoading =
    visibleEventStates.some(([, state]) => state.status === "loading") ||
    visibleVersionStates.some(([, state]) => state.status === "loading");
  const failedEventLoads = visibleEventStates.flatMap(([gameId, state]) => {
    if (state.status !== "error") return [];
    return `${GAME_REGISTRY_BY_ID[gameId].name}: ${state.error.message}`;
  });

  if (!hasSuccess && isLoading) {
    return (
      <div className="glass rounded-2xl p-6 shadow-ink">
        <div className="text-sm font-semibold">加载中...</div>
      </div>
    );
  }

  if (!hasSuccess && failedEventLoads.length > 0) {
    return (
      <div className="glass rounded-2xl p-6 shadow-ink border-red-500/30">
        <div className="text-sm font-semibold">加载失败</div>
        <div className="mt-2 grid gap-1 text-xs text-[color:var(--muted)] font-mono">
          {failedEventLoads.map((message) => (
            <div key={message}>{message}</div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {isLoading ? (
        <div className="glass rounded-2xl px-4 py-3 text-xs text-[color:var(--muted)] shadow-ink">
          部分游戏数据加载中...
        </div>
      ) : null}

      {failedEventLoads.length > 0 ? (
        <div className="glass rounded-2xl px-4 py-3 text-xs text-red-600/90 dark:text-red-400/90 shadow-ink">
          {failedEventLoads.join("；")}
        </div>
      ) : null}

      <TimelineCalendar events={aggregatedEvents} currentVersions={currentVersions} mode="home" />
    </div>
  );
}
