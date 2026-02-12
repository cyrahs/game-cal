export type GameId =
  | "genshin"
  | "starrail"
  | "ww"
  | "zzz"
  | "snowbreak"
  | "endfield";

export interface CalendarEvent {
  id: string | number;
  title: string;
  // ISO-8601 datetime with explicit timezone offset, e.g. "2026-02-10T12:00:00+08:00"
  start_time: string;
  // ISO-8601 datetime with explicit timezone offset, e.g. "2026-02-10T12:00:00+08:00"
  end_time: string;
  is_gacha?: boolean;
  banner?: string;
  content?: string;
  linkUrl?: string;
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
