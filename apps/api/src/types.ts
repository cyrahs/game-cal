export type GameId =
  | "genshin"
  | "starrail"
  | "ww"
  | "zzz"
  | "snowbreak"
  | "endfield";

export type GachaKind = "character" | "weapon" | "mixed" | "other";

// Featured (limited top-rarity) items of one banner.
export interface GachaFeatured {
  characters: string[];
  weapons: string[];
}

export interface CalendarEvent {
  id: string | number;
  title: string;
  // ISO-8601 datetime with explicit timezone offset, e.g. "2026-02-10T12:00:00+08:00"
  start_time: string;
  // ISO-8601 datetime with explicit timezone offset, e.g. "2026-02-10T12:00:00+08:00".
  // Some upstream notices only provide a relative ending condition; in that case
  // end_time is null and end_time_text carries the human-readable condition.
  end_time: string | null;
  end_time_kind?: "explicit" | "relative";
  end_time_text?: string;
  is_gacha?: boolean;
  gacha_kind?: GachaKind;
  // Set when one notice announces several banners and the event covers just one
  // of them, so its featured items cannot be read from the shared content.
  gacha_featured?: GachaFeatured;
  banner?: string;
  content?: string;
  linkUrl?: string;
  // Livestream ("前瞻") redemption codes; end_time is the official expiry.
  redeem_codes?: string[];
}

export interface GameVersionInfo {
  game: GameId;
  version: string;
  // ISO-8601 datetime with explicit timezone offset, e.g. "2026-02-10T12:00:00+08:00"
  start_time: string;
  // ISO-8601 datetime with explicit timezone offset, e.g. "2026-02-10T12:00:00+08:00"
  end_time: string;
  ann_id?: number;
  title?: string;
}

export interface ApiResponse<T> {
  code: number;
  msg?: string;
  data: T;
}

// /api/summary
export type GameSummaryEntry =
  | {
      game: GameId;
      ok: true;
      events: CalendarEvent[];
      version: GameVersionInfo | null;
      updatedAtMs: number; // epoch ms of the events snapshot
    }
  | {
      game: GameId;
      ok: false;
      error: string;
    };

export interface GamesSummary {
  games: GameSummaryEntry[];
}

// /api/sync/*
export interface SyncStateData {
  uuid: string;
  blob: string; // client-side encrypted JSON blob (see apps/web/src/sync/crypto.ts)
  clientUpdatedAt: number; // epoch ms (conflict resolution)
}

export interface SyncPutBody {
  blob: string;
  clientUpdatedAt: number;
}

export interface SyncRotateBody extends SyncPutBody {
  newPassword: string;
}
