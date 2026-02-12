import type { CalendarEvent, GameId, GameVersionInfo } from "../types.js";
import type { RuntimeEnv } from "../lib/runtimeEnv.js";
import { fetchGenshinCurrentVersion, fetchGenshinEvents } from "./genshin.js";
import { fetchStarRailCurrentVersion, fetchStarRailEvents } from "./starrail.js";
import { fetchWwCurrentVersion, fetchWwEvents } from "./ww.js";
import { fetchZzzCurrentVersion, fetchZzzEvents } from "./zzz.js";
import { fetchEndfieldEvents } from "./endfield.js";
import { fetchSnowbreakCurrentVersion, fetchSnowbreakEvents } from "./snowbreak.js";

export const GAMES: Array<{ id: GameId; name: string }> = [
  { id: "genshin", name: "原神" },
  { id: "starrail", name: "崩坏：星穹铁道" },
  { id: "ww", name: "鸣潮" },
  { id: "zzz", name: "绝区零" },
  { id: "snowbreak", name: "尘白禁区" },
  { id: "endfield", name: "明日方舟：终末地" },
];

export async function fetchEventsForGame(
  game: GameId,
  env: RuntimeEnv = {}
): Promise<CalendarEvent[]> {
  switch (game) {
    case "genshin":
      return await fetchGenshinEvents(env);
    case "starrail":
      return await fetchStarRailEvents(env);
    case "ww":
      return await fetchWwEvents(env);
    case "zzz":
      return await fetchZzzEvents(env);
    case "snowbreak":
      return await fetchSnowbreakEvents(env);
    case "endfield":
      return await fetchEndfieldEvents(env);
    default: {
      const _exhaustive: never = game;
      return _exhaustive;
    }
  }
}

export async function fetchCurrentVersionForGame(
  game: GameId,
  env: RuntimeEnv = {}
): Promise<GameVersionInfo | null> {
  switch (game) {
    case "genshin":
      return await fetchGenshinCurrentVersion(env);
    case "starrail":
      return await fetchStarRailCurrentVersion(env);
    case "zzz":
      return await fetchZzzCurrentVersion(env);
    case "ww":
      return await fetchWwCurrentVersion(env);
    case "snowbreak":
      return await fetchSnowbreakCurrentVersion(env);
    case "endfield":
      return null;
    default: {
      const _exhaustive: never = game;
      return _exhaustive;
    }
  }
}
