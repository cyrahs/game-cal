import type { CalendarEvent, GameId } from "../types.js";
import type { RuntimeEnv } from "../lib/runtimeEnv.js";
import { fetchGenshinEvents } from "./genshin.js";
import { fetchStarRailEvents } from "./starrail.js";
import { fetchWwEvents } from "./ww.js";
import { fetchZzzEvents } from "./zzz.js";
import { fetchEndfieldEvents } from "./endfield.js";
import { fetchSnowbreakEvents } from "./snowbreak.js";

export const GAMES: Array<{ id: GameId; name: string }> = [
  { id: "genshin", name: "原神" },
  { id: "starrail", name: "崩坏：星穹铁道" },
  { id: "ww", name: "鸣潮" },
  { id: "zzz", name: "绝区零" },
  { id: "snowbreak", name: "尘白禁区" },
  { id: "endfield", name: "终末地" },
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
