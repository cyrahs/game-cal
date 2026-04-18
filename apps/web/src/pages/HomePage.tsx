import { useMemo } from "react";

import type { GameId } from "../api/types";
import TimelineCalendar, { type TimelineCalendarEvent } from "../components/TimelineCalendar/TimelineCalendar";
import { usePrefs } from "../context/prefs";
import { useEvents } from "../hooks/useEvents";
import { useCurrentVersion } from "../hooks/useCurrentVersion";

const GAME_LABELS: Record<GameId, string> = {
  genshin: "原神",
  starrail: "崩坏：星穹铁道",
  zzz: "绝区零",
  ww: "鸣潮",
  snowbreak: "尘白禁区",
  endfield: "明日方舟：终末地",
};

export default function HomePage() {
  const { prefs } = usePrefs();
  const genshinEvents = useEvents("genshin");
  const starrailEvents = useEvents("starrail");
  const zzzEvents = useEvents("zzz");
  const wwEvents = useEvents("ww");
  const snowbreakEvents = useEvents("snowbreak");
  const endfieldEvents = useEvents("endfield");
  const genshinVersion = useCurrentVersion("genshin");
  const starrailVersion = useCurrentVersion("starrail");
  const zzzVersion = useCurrentVersion("zzz");
  const wwVersion = useCurrentVersion("ww");
  const snowbreakVersion = useCurrentVersion("snowbreak");
  const endfieldVersion = useCurrentVersion("endfield");
  const visibleGameIdSet = useMemo(() => new Set<GameId>(prefs.visibleGameIds), [prefs.visibleGameIds]);

  const aggregatedEvents = useMemo<TimelineCalendarEvent[]>(() => {
    const pairs = [
      ["genshin", genshinEvents],
      ["starrail", starrailEvents],
      ["zzz", zzzEvents],
      ["ww", wwEvents],
      ["snowbreak", snowbreakEvents],
      ["endfield", endfieldEvents],
    ] as const;

    return pairs.flatMap(([gameId, state]) => {
      if (!visibleGameIdSet.has(gameId)) return [];
      if (state.status !== "success") return [];
      return state.data.map((event) => ({ ...event, gameId }));
    });
  }, [endfieldEvents, genshinEvents, snowbreakEvents, starrailEvents, visibleGameIdSet, wwEvents, zzzEvents]);

  const currentVersions = useMemo(() => {
    return [genshinVersion, starrailVersion, zzzVersion, wwVersion, snowbreakVersion, endfieldVersion].flatMap((state) => {
      if (state.status !== "success" || !state.data) return [];
      if (!visibleGameIdSet.has(state.data.game)) return [];
      return state.data;
    });
  }, [endfieldVersion, genshinVersion, snowbreakVersion, starrailVersion, visibleGameIdSet, wwVersion, zzzVersion]);

  const states = (
    [
      ["genshin", genshinEvents],
      ["starrail", starrailEvents],
      ["zzz", zzzEvents],
      ["ww", wwEvents],
      ["snowbreak", snowbreakEvents],
      ["endfield", endfieldEvents],
    ] as const
  ).flatMap(([gameId, state]) => (visibleGameIdSet.has(gameId) ? [state] : []));
  const versionStates = (
    [
      ["genshin", genshinVersion],
      ["starrail", starrailVersion],
      ["zzz", zzzVersion],
      ["ww", wwVersion],
      ["snowbreak", snowbreakVersion],
      ["endfield", endfieldVersion],
    ] as const
  ).flatMap(([gameId, state]) => (visibleGameIdSet.has(gameId) ? [state] : []));
  const hasSuccess = states.some((state) => state.status === "success");
  const isLoading = states.some((state) => state.status === "loading") || versionStates.some((state) => state.status === "loading");
  const eventErrors = [
    ["genshin", genshinEvents],
    ["starrail", starrailEvents],
    ["zzz", zzzEvents],
    ["ww", wwEvents],
    ["snowbreak", snowbreakEvents],
    ["endfield", endfieldEvents],
  ] as const;
  const failedEventLoads = eventErrors.flatMap(([gameId, state]) => {
    if (!visibleGameIdSet.has(gameId)) return [];
    if (state.status !== "error") return [];
    return `${GAME_LABELS[gameId]}: ${state.error.message}`;
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
