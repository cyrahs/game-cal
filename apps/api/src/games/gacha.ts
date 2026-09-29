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

export function isValidGachaKind(input: unknown): input is GachaKind {
  return input === "character" || input === "weapon" || input === "mixed" || input === "other";
}

export function resolveGachaKind(
  game: GameId,
  title: string,
  content?: string,
  upstreamKind?: GachaKind
): GachaKind {
  const fallbackKind = classifyGachaEvent(game, title, content);
  if (!isValidGachaKind(upstreamKind)) return fallbackKind;
  if (upstreamKind === "other" && fallbackKind !== "other") return fallbackKind;
  return upstreamKind;
}

export function resolveGachaClassification(
  game: GameId,
  title: string,
  content?: string,
  upstreamIsGacha?: boolean,
  upstreamKind?: GachaKind
): { isGacha: boolean; gachaKind: GachaKind } {
  if (upstreamIsGacha === false) {
    return { isGacha: false, gachaKind: "other" };
  }

  const gachaKind = resolveGachaKind(game, title, content, upstreamKind);
  const isGacha = upstreamIsGacha === true || isGachaEventTitle(game, title) || gachaKind !== "other";
  return { isGacha, gachaKind };
}

export function isCharacterTrialGachaKind(kind: GachaKind): boolean {
  return kind === "character" || kind === "mixed";
}

export function isCharacterTrialGachaEvent(
  game: GameId,
  title: string,
  content?: string,
  upstreamKind?: GachaKind
): boolean {
  return isCharacterTrialGachaKind(resolveGachaKind(game, title, content, upstreamKind));
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
      // The announcement body can bundle unrelated rewards and activities that
      // mention warps, characters, and light cones. Only a warp-scoped title
      // establishes that the announcement itself is a gacha event.
      if (!isGachaEventTitle("starrail", normalizedTitle)) return "other";

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

export interface GachaFeatured {
  characters: string[];
  weapons: string[];
}

type FeaturedPattern = {
  // Group 1 is the item kind word, group 2 the run of bracketed names that follows it.
  regex: RegExp;
  characterWords: string[];
};

// Only the top-rarity limited items are "featured"; the 4-star / A-rank rate-ups
// are shared across banners and would just repeat on every line.
const FEATURED_PATTERNS: Record<GameId, FeaturedPattern[]> = {
  genshin: [
    { regex: /限定5星(角色|武器)\s*((?:「[^」]+」[、，,\s]*)+)/g, characterWords: ["角色"] },
  ],
  starrail: [
    { regex: /限定5星(角色|光锥)\s*((?:「[^」]+」[、，,\s]*)+)/g, characterWords: ["角色"] },
  ],
  zzz: [
    {
      regex: /限定S级(代理人|音擎)\s*((?:[[「【][^\]」】]+[\]」】][、，,\s]*)+)/g,
      characterWords: ["代理人"],
    },
  ],
  ww: [
    { regex: /(?<!\d)5星(角色|武器)\s*((?:「[^」]+」[、，,\s]*)+)/g, characterWords: ["角色"] },
  ],
  endfield: [
    { regex: /概率提升的6星(干员|武器)为\s*((?:【[^】]+】[、，,\s]*)+)/g, characterWords: ["干员"] },
    { regex: /6星(干员|武器)\s*((?:【[^】]+】[、，,\s]*)+)\s*获取概率提升/g, characterWords: ["干员"] },
  ],
  // No banner announcement sample is available for Snowbreak yet; it keeps the notice title.
  snowbreak: [],
};

const WEAPON_NOUN: Record<GameId, string> = {
  genshin: "武器",
  starrail: "光锥",
  zzz: "音擎",
  ww: "武器",
  endfield: "武器",
  snowbreak: "武器",
};

function normalizeForFeatured(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitBracketedNames(run: string): string[] {
  return [...run.matchAll(/[[「【]([^\]」】]+)[\]」】]/g)].map((m) => m[1]!);
}

function cleanFeaturedName(game: GameId, raw: string): string {
  // Drop element / path / weapon-type annotations: 真珠（欢愉•冰）, 克拉蕾(电·锋御), 寒夜幽影（施术单元）.
  let name = raw.replace(/\s*[（(][^（）()]*[）)]\s*$/, "").trim();
  // Genshin prefixes an epithet or a weapon type: 雪宴之锋·薇斯纳, 单手剑·蝶变.
  if (game === "genshin") {
    const parts = name.split(/[·•・]/);
    name = parts[parts.length - 1]!.trim();
  }
  return name;
}

function pushUnique(list: string[], name: string): void {
  if (name && !list.includes(name)) list.push(name);
}

/**
 * Extracts the featured (limited top-rarity) characters and weapons a banner
 * announcement promotes. Returns empty lists when the text does not match the
 * game's known wording, so callers can fall back to the notice title.
 */
export function extractGachaFeatured(game: GameId, title: string, content?: string): GachaFeatured {
  const featured: GachaFeatured = { characters: [], weapons: [] };
  const text = normalizeForFeatured(content ?? "");

  for (const pattern of FEATURED_PATTERNS[game]) {
    for (const match of text.matchAll(pattern.regex)) {
      const target = pattern.characterWords.includes(match[1]!) ? featured.characters : featured.weapons;
      for (const raw of splitBracketedNames(match[2]!)) pushUnique(target, cleanFeaturedName(game, raw));
    }
  }

  // Genshin wish titles name the featured items directly: 「X」祈愿：「雪宴之锋·薇斯纳(风)」概率UP！
  if (game === "genshin" && featured.characters.length === 0 && featured.weapons.length === 0) {
    const run = /祈愿[：:]\s*((?:「[^」]+」\s*)+)/.exec(normalizeForFeatured(title))?.[1];
    if (run) {
      const target = classifyGachaEvent(game, title, content) === "weapon" ? featured.weapons : featured.characters;
      for (const raw of splitBracketedNames(run)) pushUnique(target, cleanFeaturedName(game, raw));
    }
  }

  return featured;
}

/**
 * Short banner label built from the featured items: characters when there are
 * any, otherwise the weapons prefixed with the game's weapon noun, followed by
 * "限时UP". Returns null when nothing was extracted.
 */
export function formatGachaFeaturedTitle(game: GameId, featured: GachaFeatured): string | null {
  if (featured.characters.length > 0) return `${featured.characters.join("、")} 限时UP`;
  if (featured.weapons.length > 0) return `${WEAPON_NOUN[game]}：${featured.weapons.join("、")} 限时UP`;
  return null;
}
