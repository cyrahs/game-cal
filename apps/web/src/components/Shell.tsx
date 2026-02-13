import clsx from "clsx";
import dayjs from "dayjs";
import { type ChangeEvent, type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import genshinIcon from "../assets/genshin.png";
import starrailIcon from "../assets/starrail.png";
import wwIcon from "../assets/wutheringwave.png";
import zzzIcon from "../assets/zzz.png";
import endfieldIcon from "../assets/endfield.png";
import snowbreakIcon from "../assets/snowbreak.png";
import type { CalendarEvent, GameId } from "../api/types";
import { usePrefs } from "../context/prefs";
import { useEvents } from "../hooks/useEvents";
import { computeRecurringWindow, isUrgentByRemainingMs, parseDateTime } from "./TimelineCalendar/TimelineCalendar";

type GameLink = { id: GameId; to: string; name: string; icon: string };
type SettingsTabId = "games" | "sync" | "config";

const games: GameLink[] = [
  {
    id: "genshin",
    to: "/",
    name: "原神",
    icon: genshinIcon,
  },
  {
    id: "starrail",
    to: "/starrail",
    name: "崩坏：星穹铁道",
    icon: starrailIcon,
  },
  {
    id: "zzz",
    to: "/zzz",
    name: "绝区零",
    icon: zzzIcon,
  },
  {
    id: "ww",
    to: "/ww",
    name: "鸣潮",
    icon: wwIcon,
  },
  {
    id: "snowbreak",
    to: "/snowbreak",
    name: "尘白禁区",
    icon: snowbreakIcon,
  },
  {
    id: "endfield",
    to: "/endfield",
    name: "明日方舟：终末地",
    icon: endfieldIcon,
  },
];

const allGameIds = games.map((g) => g.id);
const GAME_BY_ID = games.reduce(
  (acc, game) => {
    acc[game.id] = game;
    return acc;
  },
  {} as Record<GameId, GameLink>
);
const DATA_SOURCE_BY_GAME: Record<GameId, string> = {
  genshin: "米哈游公告 API",
  starrail: "米哈游公告 API",
  zzz: "米哈游公告 API",
  ww: "库洛公告 API",
  snowbreak: "西山居公告 API",
  endfield: "鹰角公告 API",
};

function parseGameId(value: string): GameId | null {
  return allGameIds.includes(value as GameId) ? (value as GameId) : null;
}

function reorderGameIds(ids: GameId[], fromId: GameId, targetIndex: number): GameId[] {
  const fromIndex = ids.indexOf(fromId);
  if (fromIndex < 0) return ids;

  const boundedTargetIndex = Math.max(0, Math.min(ids.length, targetIndex));
  const insertIndex = fromIndex < boundedTargetIndex ? boundedTargetIndex - 1 : boundedTargetIndex;
  if (insertIndex === fromIndex) return ids;

  const next = [...ids];
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) return ids;
  next.splice(insertIndex, 0, moved);
  return next;
}

function formatUtcOffsetLabelByDate(date: Date): string {
  const mins = -date.getTimezoneOffset();
  const sign = mins >= 0 ? "+" : "-";
  const abs = Math.abs(mins);
  const hh = Math.floor(abs / 60);
  const mm = abs % 60;
  if (mm === 0) return `UTC${sign}${hh}`;
  return `UTC${sign}${hh}:${String(mm).padStart(2, "0")}`;
}

export default function Shell() {
  const location = useLocation();
  const { prefs, setTheme, setGameOrderIds, setVisibleGameIds, sync, exportRecurringSettings, importRecurringSettings } = usePrefs();
  const genshinEvents = useEvents("genshin");
  const starrailEvents = useEvents("starrail");
  const zzzEvents = useEvents("zzz");
  const wwEvents = useEvents("ww");
  const snowbreakEvents = useEvents("snowbreak");
  const endfieldEvents = useEvents("endfield");
  const theme = prefs.theme;
  const visibleGameIds = prefs.visibleGameIds;
  const gameOrderIds = prefs.gameOrderIds;
  const buildCommit = (__BUILD_COMMIT__ || "unknown").trim() || "unknown";
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTabId>("games");
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const recurringImportInputRef = useRef<HTMLInputElement | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [syncInputErrors, setSyncInputErrors] = useState<{ uuid?: string; password?: string }>({});
  const [recurringSettingsFeedback, setRecurringSettingsFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [draggingGameId, setDraggingGameId] = useState<GameId | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const gameRowRefs = useRef<Partial<Record<GameId, HTMLDivElement | null>>>({});
  const [now, setNow] = useState(() => dayjs());
  const timezoneLabel = useMemo(() => formatUtcOffsetLabelByDate(now.toDate()), [now]);
  const currentGameId = useMemo<GameId>(() => {
    const normalizedPath = location.pathname.replace(/\/+$/, "") || "/";
    const matched = games.find((g) => g.to === normalizedPath);
    return matched?.id ?? "genshin";
  }, [location.pathname]);
  const currentDataSource = DATA_SOURCE_BY_GAME[currentGameId];
  const currentUpstreamUpdatedAtLabel = (() => {
    const state =
      currentGameId === "genshin"
        ? genshinEvents
        : currentGameId === "starrail"
          ? starrailEvents
          : currentGameId === "zzz"
            ? zzzEvents
            : currentGameId === "ww"
              ? wwEvents
              : currentGameId === "snowbreak"
                ? snowbreakEvents
                : endfieldEvents;

    if (state.status !== "success") return null;
    const d = dayjs(state.updatedAtMs);
    if (!d.isValid()) return null;
    return `更新于 ${d.format("MM/DD HH:mm")}`;
  })();

  const handleSyncUuidChange = (value: string) => {
    if (value.length > sync.uuidMaxLength) {
      setSyncInputErrors((prev) => ({ ...prev, uuid: `UUID 不能超过 ${sync.uuidMaxLength} 个字符` }));
      return;
    }
    setSyncInputErrors((prev) => (prev.uuid ? { ...prev, uuid: undefined } : prev));
    sync.setUuid(value);
  };

  const handleSyncPasswordChange = (value: string) => {
    if (value.length > sync.passwordMaxLength) {
      setSyncInputErrors((prev) => ({ ...prev, password: `Password 不能超过 ${sync.passwordMaxLength} 个字符` }));
      return;
    }
    setSyncInputErrors((prev) => (prev.password ? { ...prev, password: undefined } : prev));
    sync.setPassword(value);
  };

  const handleExportRecurringSettings = () => {
    try {
      const payload = exportRecurringSettings();
      const text = JSON.stringify(payload, null, 2);
      const blob = new Blob([text], { type: "application/json;charset=utf-8" });
      const downloadUrl = URL.createObjectURL(blob);
      const download = document.createElement("a");
      download.href = downloadUrl;
      download.download = `game-cal-recurring-${dayjs().format("YYYYMMDD-HHmmss")}.json`;
      download.click();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);

      let gameCount = 0;
      let activityCount = 0;
      for (const gameId of allGameIds) {
        const activities = payload.recurringActivitiesByGame[gameId];
        if (!activities || activities.length === 0) continue;
        gameCount += 1;
        activityCount += activities.length;
      }
      setRecurringSettingsFeedback({ kind: "success", text: `已导出 ${gameCount} 个游戏，共 ${activityCount} 条循环活动。` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setRecurringSettingsFeedback({ kind: "error", text: `导出失败：${msg}` });
    }
  };

  const handleImportRecurringSettings = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw) as unknown;
      const result = importRecurringSettings(parsed);
      if (!result.ok) {
        setRecurringSettingsFeedback({ kind: "error", text: `导入失败：${result.error}` });
        return;
      }
      setRecurringSettingsFeedback({
        kind: "success",
        text: `导入成功：${result.gameCount} 个游戏，共 ${result.activityCount} 条循环活动。`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setRecurringSettingsFeedback({ kind: "error", text: `导入失败：${msg}` });
    } finally {
      e.target.value = "";
    }
  };

  const visibleGameIdSet = useMemo(() => new Set<GameId>(visibleGameIds), [visibleGameIds]);
  const orderedMenuGameIds = useMemo(() => {
    if (gameOrderIds.length > 0) return gameOrderIds;
    return allGameIds;
  }, [gameOrderIds]);
  const orderedVisibleGames = useMemo(
    () => orderedMenuGameIds.filter((id) => visibleGameIdSet.has(id)).map((id) => GAME_BY_ID[id]),
    [orderedMenuGameIds, visibleGameIdSet]
  );
  const orderedMenuGames = useMemo(() => orderedMenuGameIds.map((id) => GAME_BY_ID[id]), [orderedMenuGameIds]);
  const upstreamEventsByGame = useMemo<Record<GameId, CalendarEvent[]>>(
    () => ({
      genshin: genshinEvents.status === "success" ? genshinEvents.data : [],
      starrail: starrailEvents.status === "success" ? starrailEvents.data : [],
      zzz: zzzEvents.status === "success" ? zzzEvents.data : [],
      ww: wwEvents.status === "success" ? wwEvents.data : [],
      snowbreak:
        snowbreakEvents.status === "success" ? snowbreakEvents.data : [],
      endfield: endfieldEvents.status === "success" ? endfieldEvents.data : [],
    }),
    [endfieldEvents, genshinEvents, snowbreakEvents, starrailEvents, wwEvents, zzzEvents]
  );
  const hasUrgentByGame = useMemo<Record<GameId, boolean>>(() => {
    const nowMs = now.valueOf();
    const next: Record<GameId, boolean> = {
      genshin: false,
      starrail: false,
      zzz: false,
      ww: false,
      snowbreak: false,
      endfield: false,
    };

    for (const gameId of allGameIds) {
      const completedIds = new Set<string | number>(prefs.timeline.completedIdsByGame[gameId] ?? []);
      const upstreamEvents = upstreamEventsByGame[gameId];
      let urgent = false;

      for (const event of upstreamEvents) {
        if (completedIds.has(event.id)) continue;
        const end = parseDateTime(event.end_time);
        if (!end.isValid()) continue;
        if (isUrgentByRemainingMs("upstream", end.valueOf() - nowMs)) {
          urgent = true;
          break;
        }
      }

      if (!urgent) {
        const recurringDefs = prefs.timeline.recurringActivitiesByGame[gameId] ?? [];
        const completedRecurring = prefs.timeline.completedRecurringByGame[gameId] ?? {};
        for (const activity of recurringDefs) {
          const window = computeRecurringWindow(now, gameId, activity);
          if (!window.start.isValid() || !window.end.isValid() || !window.end.isAfter(window.start)) continue;
          if (nowMs < window.start.valueOf() || nowMs >= window.end.valueOf()) continue;
          if (completedRecurring[activity.id] === window.cycleKey) continue;
          if (isUrgentByRemainingMs("recurring", window.end.valueOf() - nowMs)) {
            urgent = true;
            break;
          }
        }
      }

      next[gameId] = urgent;
    }

    return next;
  }, [now, prefs.timeline.completedIdsByGame, prefs.timeline.completedRecurringByGame, prefs.timeline.recurringActivitiesByGame, upstreamEventsByGame]);

  useEffect(() => {
    const t = setInterval(() => setNow(dayjs()), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!isSettingsOpen) return;

    function onPointerDown(e: MouseEvent | TouchEvent) {
      const root = settingsRef.current;
      if (!root) return;

      const target = e.target;
      if (!(target instanceof Node)) return;
      if (root.contains(target)) return;
      setIsSettingsOpen(false);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setIsSettingsOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown, { passive: true });
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isSettingsOpen]);

  const handleToggleVisibleGame = (gameId: GameId) => {
    const visibleSet = new Set<GameId>(visibleGameIds);
    if (visibleSet.has(gameId)) visibleSet.delete(gameId);
    else visibleSet.add(gameId);
    setVisibleGameIds(orderedMenuGameIds.filter((id) => visibleSet.has(id)));
  };

  const getDropIndexByClientY = (clientY: number): number => {
    for (let i = 0; i < orderedMenuGames.length; i += 1) {
      const game = orderedMenuGames[i];
      if (!game) continue;
      const row = gameRowRefs.current[game.id];
      if (!row) continue;
      const rect = row.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return orderedMenuGames.length;
  };

  const handleGameDragStart = (e: DragEvent<HTMLDivElement>, gameId: GameId, rowIndex: number) => {
    setDraggingGameId(gameId);
    setDropIndex(rowIndex);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", gameId);
  };

  const handleGameDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!draggingGameId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const nextDropIndex = getDropIndexByClientY(e.clientY);
    if (dropIndex !== nextDropIndex) setDropIndex(nextDropIndex);
  };

  const applyGameDrop = (sourceGameId: GameId, targetIndex: number) => {
    const nextOrder = reorderGameIds(orderedMenuGameIds, sourceGameId, targetIndex);
    if (nextOrder !== orderedMenuGameIds) setGameOrderIds(nextOrder);
  };

  const handleGameDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const sourceGameId = draggingGameId ?? parseGameId(e.dataTransfer.getData("text/plain"));
    if (!sourceGameId) {
      setDraggingGameId(null);
      setDropIndex(null);
      return;
    }

    const targetIndex = dropIndex ?? getDropIndexByClientY(e.clientY);
    applyGameDrop(sourceGameId, targetIndex);
    setDraggingGameId(null);
    setDropIndex(null);
  };

  const handleGameListDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const sourceGameId = draggingGameId ?? parseGameId(e.dataTransfer.getData("text/plain"));
    if (!sourceGameId) {
      setDraggingGameId(null);
      setDropIndex(null);
      return;
    }

    const targetIndex = dropIndex ?? getDropIndexByClientY(e.clientY);
    applyGameDrop(sourceGameId, targetIndex);
    setDraggingGameId(null);
    setDropIndex(null);
  };

  const handleGameDragEnd = () => {
    setDraggingGameId(null);
    setDropIndex(null);
  };

  return (
    <div className="min-h-screen relative">
      <div className="max-w-[1200px] mx-auto px-4 py-6">
        <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="flex items-end gap-2">
            <div className="text-2xl font-semibold tracking-tight leading-none">Game Calendar</div>
            <div className="text-xs text-[color:var(--muted)] leading-none">{timezoneLabel}</div>
          </div>

          <nav className="flex items-center gap-2">
            {orderedVisibleGames.map((g) => (
              <NavLink
                key={g.to}
                to={g.to}
                end={g.to === "/"}
                aria-label={g.name}
                title={g.name}
                className={({ isActive }) =>
                  clsx(
                    "inline-flex items-center justify-center rounded-xl transition hover:-translate-y-[1px]",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]",
                    isActive && "ring-2 ring-[color:var(--ink)] ring-offset-2 ring-offset-[color:var(--bg0)]"
                  )
                }
              >
                <span className="relative inline-flex">
                  <img
                    src={g.icon}
                    alt={g.name}
                    className={clsx(
                      "w-9 h-9 object-contain rounded-xl",
                      "ring-1 ring-transparent transition",
                      "hover:ring-[color:var(--ring)]",
                      "active:scale-[0.98]"
                    )}
                    referrerPolicy="no-referrer"
                  />
                  {hasUrgentByGame[g.id] ? (
                    <span
                      className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-red-500 ring-2 ring-[color:var(--bg0)]"
                      title={`${g.name} 有即将结束的未完成活动`}
                      aria-label={`${g.name} 有即将结束的未完成活动`}
                    />
                  ) : null}
                </span>
              </NavLink>
            ))}

            {orderedVisibleGames.length > 0 ? (
              <span aria-hidden="true" className="mx-1 h-5 w-px bg-[color:var(--line)]" />
            ) : null}

            <a
              href="https://github.com/cyrahs/game-cal"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GitHub"
              title="GitHub"
              className={clsx(
                "glass w-9 h-9 rounded-xl inline-flex items-center justify-center transition hover:-translate-y-[1px]",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]",
                "hover:border-[color:var(--ink)]"
              )}
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
              </svg>
            </a>

            <button
              type="button"
              className={clsx(
                "glass w-9 h-9 rounded-xl inline-flex items-center justify-center transition hover:-translate-y-[1px]",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]",
                "hover:border-[color:var(--ink)]"
              )}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
              title={theme === "dark" ? "浅色模式" : "深色模式"}
            >
              {theme === "dark" ? (
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M12 3v1m0 16v1m-8-9H3m3.314-5.686L5.5 5.5m12.186.814L18.5 5.5M6.314 17.69l-.814.81m12.186-.81l.814.81M21 12h-1m-4 0a4 4 0 1 1-8 0 4 4 0 1 1 8 0z"
                  />
                </svg>
              ) : (
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M3.32 11.684a9 9 0 0 0 9 9c3.787 0 7.028-2.339 8.357-5.651a8.99 8.99 0 0 1-3.357.651 9 9 0 0 1-9-9 9.05 9.05 0 0 1 .644-3.353C5.656 4.66 3.32 7.899 3.32 11.684z"
                  />
                </svg>
              )}
            </button>

            <div className="relative" ref={settingsRef}>
              <button
                type="button"
                className={clsx(
                  "glass w-9 h-9 rounded-xl inline-flex items-center justify-center transition hover:-translate-y-[1px]",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]",
                  "hover:border-[color:var(--ink)]",
                  isSettingsOpen && "border-[color:var(--ink)]"
                )}
                onClick={() => setIsSettingsOpen((v) => !v)}
                aria-label="设置"
                title="设置"
                aria-haspopup="dialog"
                aria-expanded={isSettingsOpen}
                aria-controls="gc-settings"
              >
                <svg className="w-5 h-5" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeLinejoin="round">
                  <circle cx="16" cy="16" r="4" strokeWidth="2" />
                  <path
                    strokeWidth="2"
                    strokeMiterlimit="10"
                    d="M27.758 10.366l-1-1.732a2 2 0 0 0-2.732-.732l-.526.304c-2 1.154-4.5-.289-4.5-2.598V5a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v.608c0 2.309-2.5 3.753-4.5 2.598l-.526-.304a2 2 0 0 0-2.732.732l-1 1.732a2 2 0 0 0 .732 2.732l.526.304c2 1.155 2 4.041 0 5.196l-.526.304a2 2 0 0 0-.732 2.732l1 1.732a2 2 0 0 0 2.732.732l.526-.304c2-1.155 4.5.289 4.5 2.598V27a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-.608c0-2.309 2.5-3.753 4.5-2.598l.526.304a2 2 0 0 0 2.732-.732l1-1.732a2 2 0 0 0-.732-2.732l-.526-.304c-2-1.155-2-4.041 0-5.196l.526-.304a2 2 0 0 0 .732-2.732z"
                  />
                </svg>
              </button>

              {isSettingsOpen ? (
                <div
                  id="gc-settings"
                  role="dialog"
                  aria-label="设置"
                  className={clsx(
                    "absolute right-0 top-full mt-2 w-80 z-50 fade-in",
                    "rounded-2xl border border-[color:var(--line)] shadow-ink",
                    "bg-[color:var(--popover)] backdrop-blur-2xl",
                    "max-h-[75vh] overflow-auto no-scrollbar"
                  )}
                >
                  <div className="p-3">
                    <div className="grid grid-cols-3 gap-1 rounded-xl bg-[color:var(--wash)] p-1" role="tablist" aria-label="设置标签页">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={activeSettingsTab === "games"}
                        className={clsx(
                          "rounded-lg px-2 py-1.5 text-xs transition",
                          activeSettingsTab === "games"
                            ? "bg-[color:var(--card)] text-[color:var(--ink)] shadow-sm"
                            : "text-[color:var(--muted)] hover:text-[color:var(--ink)]"
                        )}
                        onClick={() => setActiveSettingsTab("games")}
                      >
                        游戏
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={activeSettingsTab === "sync"}
                        className={clsx(
                          "rounded-lg px-2 py-1.5 text-xs transition",
                          activeSettingsTab === "sync"
                            ? "bg-[color:var(--card)] text-[color:var(--ink)] shadow-sm"
                            : "text-[color:var(--muted)] hover:text-[color:var(--ink)]"
                        )}
                        onClick={() => setActiveSettingsTab("sync")}
                      >
                        同步
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={activeSettingsTab === "config"}
                        className={clsx(
                          "rounded-lg px-2 py-1.5 text-xs transition",
                          activeSettingsTab === "config"
                            ? "bg-[color:var(--card)] text-[color:var(--ink)] shadow-sm"
                            : "text-[color:var(--muted)] hover:text-[color:var(--ink)]"
                        )}
                        onClick={() => setActiveSettingsTab("config")}
                      >
                        配置
                      </button>
                    </div>

                    {activeSettingsTab === "games" ? (
                      <>
                        <div className="mt-3 flex flex-col" onDragOver={handleGameDragOver} onDrop={handleGameListDrop}>
                          {orderedMenuGames.map((g, index) => {
                            const checked = visibleGameIdSet.has(g.id);
                            const inputId = `gc-visible-${g.id}`;
                            const showIndicatorBefore = draggingGameId !== null && dropIndex === index;
                            return (
                              <div key={g.id} className="flex flex-col">
                                {showIndicatorBefore ? (
                                  <div className="px-2 pb-1" aria-hidden="true">
                                    <div className="h-0.5 rounded-full bg-[color:var(--accent)]" />
                                  </div>
                                ) : null}

                                <div
                                  ref={(node) => {
                                    gameRowRefs.current[g.id] = node;
                                  }}
                                  draggable
                                  onDragStart={(e) => handleGameDragStart(e, g.id, index)}
                                  onDragOver={handleGameDragOver}
                                  onDrop={handleGameDrop}
                                  onDragEnd={handleGameDragEnd}
                                  className={clsx(
                                    "group w-full flex items-center gap-2 rounded-xl px-2 py-2 transition border border-transparent",
                                    "hover:bg-[color:var(--wash)]",
                                    draggingGameId === g.id && "opacity-60"
                                  )}
                                >
                                  <span
                                    aria-hidden="true"
                                    title={`拖动排序：${g.name}`}
                                    className={clsx(
                                      "inline-flex h-7 w-5 shrink-0 items-center justify-center rounded-md text-[color:var(--muted)]",
                                      "cursor-grab active:cursor-grabbing group-hover:text-[color:var(--ink)]"
                                    )}
                                  >
                                    <svg className="h-3.5 w-3.5" viewBox="0 0 8 12" fill="currentColor">
                                      <circle cx="2" cy="2" r="1" />
                                      <circle cx="6" cy="2" r="1" />
                                      <circle cx="2" cy="6" r="1" />
                                      <circle cx="6" cy="6" r="1" />
                                      <circle cx="2" cy="10" r="1" />
                                      <circle cx="6" cy="10" r="1" />
                                    </svg>
                                  </span>
                                  <label htmlFor={inputId} className="flex min-w-0 flex-1 items-center gap-3 cursor-pointer">
                                    <span className="flex min-w-0 flex-1 items-center gap-3">
                                      <img
                                        src={g.icon}
                                        alt=""
                                        className="w-7 h-7 object-contain rounded-lg ring-1 ring-[color:var(--line)]"
                                        referrerPolicy="no-referrer"
                                      />
                                      <span className="text-sm">{g.name}</span>
                                    </span>
                                    <input
                                      id={inputId}
                                      type="checkbox"
                                      className="h-4 w-4 shrink-0 accent-[color:var(--accent)]"
                                      checked={checked}
                                      onChange={() => handleToggleVisibleGame(g.id)}
                                    />
                                  </label>
                                </div>
                              </div>
                            );
                          })}
                          {draggingGameId !== null && dropIndex === orderedMenuGames.length ? (
                            <div className="px-2 pt-1" aria-hidden="true">
                              <div className="h-0.5 rounded-full bg-[color:var(--accent)]" />
                            </div>
                          ) : null}
                        </div>

                        <div className="mt-3 text-[11px] text-[color:var(--muted)]">
                          拖动左侧手柄可排序；未勾选的游戏会从顶部导航隐藏。
                        </div>
                      </>
                    ) : null}

                    {activeSettingsTab === "sync" ? (
                      <>
                        <div className="mt-3 text-sm font-semibold">同步</div>
                        <div className="mt-2 text-[11px] text-[color:var(--muted)]">
                          状态会在本地加密后上传到云端（D1）。该功能需服务端启用 Worker + D1；Node API 模式会显示“云端未启用”。
                        </div>

                        <div className="mt-3 grid gap-2">
                          <label className="grid gap-1">
                            <span className="text-xs text-[color:var(--muted)]">UUID</span>
                            <input
                              className="w-full px-2 py-2 rounded-xl border border-[color:var(--line)] bg-transparent text-xs font-mono"
                              value={sync.uuid}
                              onChange={(e) => handleSyncUuidChange(e.target.value)}
                              minLength={sync.uuidMinLength}
                              aria-invalid={Boolean(syncInputErrors.uuid)}
                              spellCheck={false}
                              inputMode="text"
                            />
                            {syncInputErrors.uuid ? (
                              <span className="text-[11px] text-red-600/80 dark:text-red-400/80">{syncInputErrors.uuid}</span>
                            ) : null}
                          </label>

                          <div className="flex gap-2">
                            <button
                              type="button"
                              className="glass flex-1 px-3 py-2 rounded-xl text-xs border border-[color:var(--line)] hover:border-[color:var(--ink)]"
                              onClick={() => {
                                setSyncInputErrors((prev) => (prev.uuid ? { ...prev, uuid: undefined } : prev));
                                sync.setUuid(sync.generateUuid());
                              }}
                            >
                              生成 UUID
                            </button>
                            <button
                              type="button"
                              className="glass flex-1 px-3 py-2 rounded-xl text-xs border border-[color:var(--line)] hover:border-[color:var(--ink)]"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(sync.uuid);
                                } catch {
                                  // ignore
                                }
                              }}
                            >
                              复制
                            </button>
                          </div>

                          <label className="grid gap-1">
                            <span className="text-xs text-[color:var(--muted)]">Password</span>
                            <input
                              className="w-full px-2 py-2 rounded-xl border border-[color:var(--line)] bg-transparent text-xs font-mono"
                              type={showPassword ? "text" : "password"}
                              value={sync.password}
                              onChange={(e) => handleSyncPasswordChange(e.target.value)}
                              minLength={sync.passwordMinLength}
                              aria-invalid={Boolean(syncInputErrors.password)}
                              spellCheck={false}
                              inputMode="text"
                            />
                            {syncInputErrors.password ? (
                              <span className="text-[11px] text-red-600/80 dark:text-red-400/80">{syncInputErrors.password}</span>
                            ) : null}
                          </label>

                          <div className="flex gap-2">
                            <button
                              type="button"
                              className="glass flex-1 px-3 py-2 rounded-xl text-xs border border-[color:var(--line)] hover:border-[color:var(--ink)]"
                              onClick={() => setShowPassword((v) => !v)}
                            >
                              {showPassword ? "隐藏" : "显示"}
                            </button>
                            <button
                              type="button"
                              className="glass flex-1 px-3 py-2 rounded-xl text-xs border border-[color:var(--line)] hover:border-[color:var(--ink)]"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(sync.password);
                                } catch {
                                  // ignore
                                }
                              }}
                            >
                              复制
                            </button>
                          </div>

                          <button
                            type="button"
                            className="glass px-3 py-2 rounded-xl text-xs border border-[color:var(--line)] hover:border-[color:var(--ink)]"
                            onClick={() => void sync.rotatePassword(sync.generatePassword())}
                          >
                            生成新密码并更新云端
                          </button>
                        </div>

                        <div className="mt-3 flex gap-2">
                          <button
                            type="button"
                            className="glass flex-1 px-3 py-2 rounded-xl text-xs border border-[color:var(--line)] hover:border-[color:var(--ink)]"
                            onClick={() => void sync.pull()}
                          >
                            从云端拉取
                          </button>
                          <button
                            type="button"
                            className="glass flex-1 px-3 py-2 rounded-xl text-xs border border-[color:var(--line)] hover:border-[color:var(--ink)]"
                            onClick={() => void sync.push({ forceNetwork: true })}
                          >
                            上传到云端
                          </button>
                        </div>

                        {sync.state.phase === "conflict" ? (
                          <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
                            <div className="font-semibold text-amber-800 dark:text-amber-200">
                              检测到冲突：云端版本更新
                            </div>
                            <div className="mt-2 flex gap-2">
                              <button
                                type="button"
                                className="glass flex-1 px-3 py-2 rounded-xl text-xs border border-[color:var(--line)] hover:border-[color:var(--ink)]"
                                onClick={() => void sync.pull()}
                              >
                                使用云端
                              </button>
                              <button
                                type="button"
                                className="glass flex-1 px-3 py-2 rounded-xl text-xs border border-[color:var(--line)] hover:border-[color:var(--ink)]"
                                onClick={() => void sync.push({ force: true, forceNetwork: true })}
                              >
                                强制覆盖
                              </button>
                            </div>
                          </div>
                        ) : null}

                        <div className="mt-3 text-[11px] text-[color:var(--muted)]">
                          状态:{" "}
                          {sync.state.phase === "init"
                            ? "初始化"
                            : sync.state.phase === "syncing"
                              ? "同步中"
                              : sync.state.phase === "ready"
                                ? "就绪"
                                : sync.state.phase === "disabled"
                                  ? "云端未启用"
                                  : sync.state.phase === "conflict"
                                    ? "冲突"
                                    : "错误"}
                          {sync.state.error ? (
                            <span className="block mt-1 text-red-600/80 dark:text-red-400/80">{sync.state.error}</span>
                          ) : null}
                          {sync.state.lastPullAt ? (
                            <span className="block mt-1">上次拉取: {new Date(sync.state.lastPullAt).toLocaleString()}</span>
                          ) : null}
                          {sync.state.lastPushAt ? (
                            <span className="block mt-1">上次上传: {new Date(sync.state.lastPushAt).toLocaleString()}</span>
                          ) : null}
                        </div>
                      </>
                    ) : null}

                    {activeSettingsTab === "config" ? (
                      <>
                        <div className="mt-3 text-sm font-semibold">循环活动配置</div>
                        <div className="mt-2 text-[11px] text-[color:var(--muted)]">
                          可导出当前循环活动配置到 JSON 文件，也可从文件导入并覆盖现有循环活动配置。
                        </div>
                        <div className="mt-3 flex gap-2">
                          <button
                            type="button"
                            className="glass flex-1 px-3 py-2 rounded-xl text-xs border border-[color:var(--line)] hover:border-[color:var(--ink)]"
                            onClick={handleExportRecurringSettings}
                          >
                            导出循环活动
                          </button>
                          <button
                            type="button"
                            className="glass flex-1 px-3 py-2 rounded-xl text-xs border border-[color:var(--line)] hover:border-[color:var(--ink)]"
                            onClick={() => {
                              setRecurringSettingsFeedback(null);
                              recurringImportInputRef.current?.click();
                            }}
                          >
                            导入循环活动
                          </button>
                        </div>
                        <input
                          ref={recurringImportInputRef}
                          type="file"
                          accept="application/json,.json"
                          className="hidden"
                          onChange={(e) => void handleImportRecurringSettings(e)}
                        />
                        {recurringSettingsFeedback ? (
                          <div
                            className={clsx(
                              "mt-2 text-[11px]",
                              recurringSettingsFeedback.kind === "error" ? "text-red-600/90 dark:text-red-400/90" : "text-[color:var(--muted)]"
                            )}
                          >
                            {recurringSettingsFeedback.text}
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          </nav>
        </header>

        <main className="mt-6">
          <Outlet />
        </main>

        <footer className="mt-10 pb-6 text-xs text-[color:var(--muted)]">
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-1">
            <span className="min-w-0">数据来源: {currentDataSource}</span>
            {currentUpstreamUpdatedAtLabel ? (
              <span className="min-w-0 font-mono text-[11px]">
                {currentUpstreamUpdatedAtLabel}
              </span>
            ) : null}
            <span className="min-w-0 font-mono text-[11px]" title={`build ${buildCommit}`}>
              build {buildCommit}
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
}
