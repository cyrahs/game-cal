// Gacha classification is shared with the API/Worker so both ends stay in sync.
// The implementation lives in apps/api/src/games/gacha.ts (same pattern as the
// Worker, which imports API sources directly across the workspace).
export {
  classifyGachaEvent,
  extractGachaFeatured,
  formatGachaFeaturedTitle,
  isCharacterTrialGachaEvent,
  isCharacterTrialGachaKind,
  isGachaEventTitle,
  resolveGachaClassification,
  resolveGachaKind,
} from "../../../api/src/games/gacha";
export type { GachaFeatured } from "../../../api/src/games/gacha";
