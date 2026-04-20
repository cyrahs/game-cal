import type { GachaKind, GameId } from "../types.js";

function normalizeForGachaKind(...inputs: Array<string | undefined>): string {
  return inputs
    .filter((input): input is string => typeof input === "string")
    .join(" ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&lt;[^&]*?&gt;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(input: string, words: string[]): boolean {
  return words.some((word) => input.includes(word));
}

function mergeGachaKind(hasCharacter: boolean, hasWeapon: boolean): GachaKind {
  if (hasCharacter && hasWeapon) return "mixed";
  if (hasCharacter) return "character";
  if (hasWeapon) return "weapon";
  return "other";
}

export function combineGachaKinds(
  first: GachaKind | undefined,
  second: GachaKind | undefined
): GachaKind | undefined {
  if (!first) return second;
  if (!second) return first;
  if (first === "mixed" || second === "mixed") return "mixed";
  if (
    (first === "character" && second === "weapon") ||
    (first === "weapon" && second === "character")
  ) {
    return "mixed";
  }
  if (first === "character" || second === "character") return "character";
  if (first === "weapon" || second === "weapon") return "weapon";
  return "other";
}

export function isGachaEventTitle(game: GameId, title: string): boolean {
  const normalized = title.trim();
  if (!normalized) return false;

  switch (game) {
    case "endfield":
      return (
        normalized.includes("特许寻访") ||
        normalized.includes("特殊寻访") ||
        normalized.includes("申领")
      );
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

export function classifyGachaEvent(game: GameId, title: string, content?: string): GachaKind {
  const normalizedTitle = normalizeForGachaKind(title);
  const normalizedText = normalizeForGachaKind(title, content);
  if (!normalizedTitle && !normalizedText) return "other";

  switch (game) {
    case "endfield": {
      const hasWeaponTitle = normalizedTitle.includes("申领");
      const hasCharacterTitle =
        normalizedTitle.includes("特许寻访") || normalizedTitle.includes("特殊寻访");
      if (hasWeaponTitle && !hasCharacterTitle) return "weapon";

      const hasWeapon =
        hasWeaponTitle ||
        (normalizedText.includes("申领") && hasAny(normalizedText, ["武器", "获取概率提升"])) ||
        /武器[^。；;]*概率提升/.test(normalizedText);
      const hasCharacter =
        hasCharacterTitle ||
        (!hasWeaponTitle && hasAny(normalizedText, ["特许寻访", "特殊寻访"])) ||
        (normalizedText.includes("作战演练") && normalizedText.includes("寻访"));
      return mergeGachaKind(hasCharacter, hasWeapon);
    }
    case "starrail": {
      const hasWarpContext = normalizedText.includes("跃迁") || normalizedText.includes("概率提升");
      const hasCharacter =
        hasAny(normalizedText, ["角色活动跃迁", "角色联动跃迁"]) ||
        (hasWarpContext &&
          (hasAny(normalizedText, ["限定5星角色", "5星角色", "4星角色"]) ||
            /(?:^|[^光])5星角色/.test(normalizedText)));
      const hasWeapon =
        hasAny(normalizedText, ["光锥活动跃迁", "光锥联动跃迁"]) ||
        (hasWarpContext && hasAny(normalizedText, ["限定5星光锥", "5星光锥", "4星光锥"]));
      const explicit = mergeGachaKind(hasCharacter, hasWeapon);
      if (explicit !== "other") return explicit;
      if (normalizedTitle.includes("跃迁") && normalizedTitle.includes("光锥")) return "weapon";
      if (normalizedTitle.includes("跃迁") && normalizedTitle.includes("角色")) return "character";
      if (normalizedTitle.includes("活动跃迁") || normalizedTitle.includes("联动跃迁")) return "mixed";
      return "other";
    }
    case "genshin": {
      const hasWishContext = normalizedText.includes("祈愿");
      const hasWeapon =
        normalizedTitle.includes("神铸赋形") ||
        (hasWishContext && hasAny(normalizedText, ["概率提升武器", "武器活动祈愿", "武器祈愿"]));
      if (hasWeapon) return "weapon";

      const hasCharacter =
        hasWishContext &&
        (normalizedTitle.includes("概率UP") ||
          hasAny(normalizedText, ["概率提升角色", "活动祈愿中获得更多角色"]));
      return hasCharacter ? "character" : "other";
    }
    case "ww": {
      const hasWeapon = /武器.*唤取/.test(normalizedTitle);
      const hasCharacter = /角色.*唤取/.test(normalizedTitle);
      return mergeGachaKind(hasCharacter, hasWeapon);
    }
    case "snowbreak": {
      const hasWeapon = /武器(?:定向)?共鸣/.test(normalizedText);
      const hasCharacter = /角色(?:定向)?共鸣/.test(normalizedText);
      return mergeGachaKind(hasCharacter, hasWeapon);
    }
    case "zzz": {
      const hasFrequencyContext = hasAny(normalizedText, ["频段", "调频", "概率提升"]);
      const hasCharacter =
        normalizedTitle.includes("独家频段") ||
        (hasFrequencyContext && hasAny(normalizedText, ["限定S级代理人", "S级代理人", "代理人"]));
      const hasWeapon =
        hasFrequencyContext && hasAny(normalizedText, ["音擎频段", "音擎调频", "限定S级音擎", "S级音擎"]);
      const explicit = mergeGachaKind(hasCharacter, hasWeapon);
      if (explicit !== "other") return explicit;
      if (normalizedTitle.includes("限时频段")) return "mixed";
      return "other";
    }
    default: {
      const _exhaustive: never = game;
      return _exhaustive;
    }
  }
}
