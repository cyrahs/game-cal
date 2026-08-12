import type { GameId } from "../api/types";

import genshinIcon from "../assets/genshin.png";
import starrailIcon from "../assets/starrail.png";
import zzzIcon from "../assets/zzz.png";
import wwIcon from "../assets/wutheringwave.png";
import snowbreakIcon from "../assets/snowbreak.png";
import endfieldIcon from "../assets/endfield.png";

export type GameRegistryEntry = {
  id: GameId;
  name: string;
  icon: string;
  route: string;
  dataSource: string;
};

// Single source of truth for supported games on the web side.
// Adding a game: add one entry here (plus its API parser in apps/api/src/games).
export const GAME_REGISTRY: readonly GameRegistryEntry[] = [
  { id: "genshin", name: "原神", icon: genshinIcon, route: "/genshin", dataSource: "米哈游公告 API" },
  { id: "starrail", name: "崩坏：星穹铁道", icon: starrailIcon, route: "/starrail", dataSource: "米哈游公告 API" },
  { id: "zzz", name: "绝区零", icon: zzzIcon, route: "/zzz", dataSource: "米哈游公告 API" },
  { id: "ww", name: "鸣潮", icon: wwIcon, route: "/ww", dataSource: "库洛公告 API" },
  { id: "snowbreak", name: "尘白禁区", icon: snowbreakIcon, route: "/snowbreak", dataSource: "西山居公告 API" },
  { id: "endfield", name: "明日方舟：终末地", icon: endfieldIcon, route: "/endfield", dataSource: "鹰角公告 API" },
];

export const ALL_GAME_IDS: GameId[] = GAME_REGISTRY.map((g) => g.id);

export const GAME_REGISTRY_BY_ID: Record<GameId, GameRegistryEntry> = Object.fromEntries(
  GAME_REGISTRY.map((g) => [g.id, g])
) as Record<GameId, GameRegistryEntry>;

export const GAME_META: Record<GameId, { name: string; icon: string }> = GAME_REGISTRY_BY_ID;
