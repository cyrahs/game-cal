import type { GameId } from "../types.js";

export function isGachaEventTitle(game: GameId, title: string): boolean {
  const normalized = title.trim();
  if (!normalized) return false;

  switch (game) {
    case "endfield":
      return normalized.includes("特许寻访");
    case "starrail":
      return normalized.includes("跃迁");
    case "genshin":
      return normalized.includes("祈愿");
    case "ww":
      return normalized.includes("唤取");
    case "snowbreak":
      return normalized.includes("共鸣开启");
    case "zzz":
      return normalized.includes("限时频段") || normalized.includes("独家频段");
    default: {
      const _exhaustive: never = game;
      return _exhaustive;
    }
  }
}
