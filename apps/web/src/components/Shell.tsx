import clsx from "clsx";
import dayjs from "dayjs";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";

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
  const { prefs, setTheme, setVisibleGameIds, sync, exportRecurringSettings, importRecurringSettings } = usePrefs();
  const genshinEvents = useEvents("genshin");
  const starrailEvents = useEvents("starrail");
  const zzzEvents = useEvents("zzz");
  const wwEvents = useEvents("ww");
  const snowbreakEvents = useEvents("snowbreak");
  const endfieldEvents = useEvents("endfield");
  const theme = prefs.theme;
  const visibleGameIds = prefs.visibleGameIds;
  const buildCommit = (__BUILD_COMMIT__ || "unknown").trim() || "unknown";
  const buildCommitShort = buildCommit === "unknown" ? "unknown" : buildCommit.slice(0, 12);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const recurringImportInputRef = useRef<HTMLInputElement | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [recurringSettingsFeedback, setRecurringSettingsFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [now, setNow] = useState(() => dayjs());
  const timezoneLabel = useMemo(() => formatUtcOffsetLabelByDate(now.toDate()), [now]);

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

  return (
    <div className="min-h-screen relative">
      <div className="max-w-[1200px] mx-auto px-4 py-6">
        <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="flex flex-col">
            <div className="text-2xl font-semibold tracking-tight">Game Calendar</div>
            <div className="text-sm text-[color:var(--muted)]">活动日历 ({timezoneLabel})</div>
          </div>

          <nav className="flex items-center gap-2">
            {games
              .filter((g) => visibleGameIdSet.has(g.id))
              .map((g) => (
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
                    d="M12 3v2m0 14v2m9-9h-2M5 12H3m15.364-6.364-1.414 1.414M7.05 16.95l-1.414 1.414m0-11.314 1.414 1.414m11.314 11.314 1.414 1.414M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"
                  />
                </svg>
              ) : (
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79Z"
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
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065Z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
                  />
                </svg>
              </button>

              {isSettingsOpen ? (
                <div
                  id="gc-settings"
                  role="dialog"
                  aria-label="显示的游戏"
                  className={clsx(
                    "absolute right-0 top-full mt-2 w-80 z-50 fade-in",
                    "rounded-2xl border border-[color:var(--line)] shadow-ink",
                    "bg-[color:var(--popover)] backdrop-blur-2xl",
                    "max-h-[75vh] overflow-auto"
                  )}
                >
                  <div className="p-3">
                    <div className="text-sm font-semibold">显示的游戏</div>

                    <div className="mt-3 flex flex-col gap-2">
                      {games.map((g) => {
                        const checked = visibleGameIdSet.has(g.id);
                        const inputId = `gc-visible-${g.id}`;
                        return (
                          <label
                            key={g.id}
                            htmlFor={inputId}
                            className={clsx(
                              "flex items-center gap-3 rounded-xl px-2 py-2 cursor-pointer transition",
                              "hover:bg-[color:var(--wash)]"
                            )}
                          >
                            <input
                              id={inputId}
                              type="checkbox"
                              className="h-4 w-4 accent-[color:var(--accent)]"
                              checked={checked}
                              onChange={() => {
                                const set = new Set<GameId>(visibleGameIds);
                                if (set.has(g.id)) set.delete(g.id);
                                else set.add(g.id);
                                setVisibleGameIds(allGameIds.filter((id) => set.has(id)));
                              }}
                            />
                            <img
                              src={g.icon}
                              alt=""
                              className="w-7 h-7 object-contain rounded-lg ring-1 ring-[color:var(--line)]"
                              referrerPolicy="no-referrer"
                            />
                            <span className="text-sm">{g.name}</span>
                          </label>
                        );
                      })}
                    </div>

                    <div className="mt-3 text-[11px] text-[color:var(--muted)]">
                      未勾选的游戏会从顶部导航隐藏。
                    </div>

                    <div className="my-4 h-px bg-[color:var(--line)]" />

                    <div className="text-sm font-semibold">同步</div>
                    <div className="mt-2 text-[11px] text-[color:var(--muted)]">
                      状态会在本地加密后上传到云端（D1）。该功能需服务端启用 Worker + D1；Node API 模式会显示“云端未启用”。
                    </div>

                    <div className="mt-3 grid gap-2">
                      <label className="grid gap-1">
                        <span className="text-xs text-[color:var(--muted)]">UUID</span>
                        <input
                          className="w-full px-2 py-2 rounded-xl border border-[color:var(--line)] bg-transparent text-xs font-mono"
                          value={sync.uuid}
                          onChange={(e) => sync.setUuid(e.target.value)}
                          spellCheck={false}
                          inputMode="text"
                        />
                      </label>

                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="glass flex-1 px-3 py-2 rounded-xl text-xs border border-[color:var(--line)] hover:border-[color:var(--ink)]"
                          onClick={() => sync.setUuid(sync.generateUuid())}
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
                          onChange={(e) => sync.setPassword(e.target.value)}
                          spellCheck={false}
                          inputMode="text"
                        />
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

                    <div className="my-4 h-px bg-[color:var(--line)]" />

                    <div className="text-sm font-semibold">循环活动设置</div>
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
          <div className="flex items-center justify-between gap-3">
            <span>
              数据来源: 米哈游公告 API / 库洛 Wiki API / 西山居公告 API / 鹰角公告 API。 仅供学习参考。{" "}
              <a
                href="https://github.com/cyrahs/game-cal"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-[color:var(--ink)]"
              >
                GitHub
              </a>
            </span>
            <span className="shrink-0 text-right font-mono" title={`build ${buildCommit}`}>
              build {buildCommitShort}
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
}
