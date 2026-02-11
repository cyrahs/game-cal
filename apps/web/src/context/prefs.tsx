import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { GameId } from "../api/types";
import defaultRecurringSettingsTemplate from "../data/default-recurring-events.json";
import { ThemeProvider, type Theme } from "./theme";
import { decryptJson, encryptJson } from "../sync/crypto";

const SYNC_UUID_KEY = "gc.sync.uuid";
const SYNC_PASSWORD_KEY = "gc.sync.password";
const SYNC_CACHE_KEY = "gc.sync.cache";
const THEME_KEY = "gc.theme";
const AUTO_PULL_INTERVAL_MS = 30 * 60 * 1000;
const ACTIVE_AUTO_PULL_DEDUPE_MS = 3000;

const ALL_GAME_IDS: GameId[] = [
  "genshin",
  "starrail",
  "zzz",
  "ww",
  "snowbreak",
  "endfield",
];
const ALL_GAME_ID_SET = new Set<GameId>(ALL_GAME_IDS);

export type RecurringRule =
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "monthly"; day: number; hour: number; minute: number }
  | { kind: "interval"; startDate: string; everyDays: number; hour: number; minute: number }
  | { kind: "cron"; expression: string };

export type RecurringActivity = {
  id: string;
  title: string;
  rule: RecurringRule;
  durationDays?: number;
};

export type RecurringSettingsExport = {
  type: "game-cal.recurring-settings";
  v: 1;
  recurringActivitiesByGame: Partial<Record<GameId, RecurringActivity[]>>;
};

export type RecurringSettingsImportResult =
  | {
      ok: true;
      gameCount: number;
      activityCount: number;
    }
  | {
      ok: false;
      error: string;
    };

const DEFAULT_RECURRING_ACTIVITIES_BY_GAME: Partial<Record<GameId, RecurringActivity[]>> =
  parseRecurringSettingsImport(defaultRecurringSettingsTemplate) ?? {};

function cloneRecurringRule(rule: RecurringRule): RecurringRule {
  if (rule.kind === "weekly") return { ...rule };
  if (rule.kind === "monthly") return { ...rule };
  return { ...rule };
}

function cloneRecurringActivitiesByGame(
  source: Partial<Record<GameId, RecurringActivity[]>>
): Partial<Record<GameId, RecurringActivity[]>> {
  const next: Partial<Record<GameId, RecurringActivity[]>> = {};
  for (const gameId of ALL_GAME_IDS) {
    const arr = source[gameId];
    if (!arr || arr.length === 0) continue;
    next[gameId] = arr.map((activity) => ({
      id: activity.id,
      title: activity.title,
      durationDays: activity.durationDays,
      rule: cloneRecurringRule(activity.rule),
    }));
  }
  return next;
}

function normalizeRecurringId(input: string): string {
  const v = input.trim();
  return v.length > 0 ? v.slice(0, 128) : "";
}

function normalizeRecurringTitle(input: string): string {
  return input.trim().slice(0, 80);
}

function toInt(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) return Math.trunc(input);
  if (typeof input === "string" && input.trim() !== "") {
    const n = Number(input);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

function clampInt(input: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(input)));
}

function coerceRecurringDurationDays(input: unknown): number | undefined {
  if (input == null) return undefined;
  const raw = toInt(input);
  if (raw === null) return undefined;
  return clampInt(raw, 1, 3650);
}

function coerceRecurringRule(input: unknown): RecurringRule | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const kind = obj.kind;

  if (kind === "weekly") {
    const weekday = toInt(obj.weekday);
    const hour = toInt(obj.hour);
    const minute = toInt(obj.minute);
    if (weekday === null || hour === null || minute === null) return null;
    return {
      kind: "weekly",
      weekday: clampInt(weekday, 0, 6),
      hour: clampInt(hour, 0, 23),
      minute: clampInt(minute, 0, 59),
    };
  }

  if (kind === "monthly") {
    const day = toInt(obj.day);
    const hour = toInt(obj.hour);
    const minute = toInt(obj.minute);
    if (day === null || hour === null || minute === null) return null;
    return {
      kind: "monthly",
      day: clampInt(day, 1, 31),
      hour: clampInt(hour, 0, 23),
      minute: clampInt(minute, 0, 59),
    };
  }

  if (kind === "interval") {
    const startDate = typeof obj.startDate === "string" ? obj.startDate.trim() : "";
    const everyDays = toInt(obj.everyDays);
    const hour = toInt(obj.hour);
    const minute = toInt(obj.minute);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return null;
    if (everyDays === null || hour === null || minute === null) return null;
    return {
      kind: "interval",
      startDate,
      everyDays: clampInt(everyDays, 1, 3650),
      hour: clampInt(hour, 0, 23),
      minute: clampInt(minute, 0, 59),
    };
  }

  if (kind === "cron") {
    const expression = typeof obj.expression === "string" ? obj.expression.trim() : "";
    if (expression.length === 0 || expression.length > 128) return null;
    if (expression.split(/\s+/).length !== 5) return null;
    return { kind: "cron", expression };
  }

  return null;
}

function coerceRecurringActivity(input: unknown): RecurringActivity | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const id = typeof obj.id === "string" ? normalizeRecurringId(obj.id) : "";
  const title = typeof obj.title === "string" ? normalizeRecurringTitle(obj.title) : "";
  const rule = coerceRecurringRule(obj.rule);
  const durationDays = coerceRecurringDurationDays(obj.durationDays);

  if (!id || !title || !rule) return null;
  return { id, title, rule, durationDays };
}

function coerceRecurringActivitiesByGame(input: unknown): Partial<Record<GameId, RecurringActivity[]>> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const next: Partial<Record<GameId, RecurringActivity[]>> = {};
  for (const gameId of ALL_GAME_IDS) {
    const arr = (input as any)[gameId];
    if (!Array.isArray(arr)) continue;
    const cleaned: RecurringActivity[] = [];
    const usedIds = new Set<string>();
    for (const item of arr) {
      const activity = coerceRecurringActivity(item);
      if (!activity) continue;
      if (usedIds.has(activity.id)) continue;
      usedIds.add(activity.id);
      cleaned.push(activity);
    }
    if (cleaned.length > 0) next[gameId] = cleaned;
  }
  return next;
}

function parseRecurringSettingsImport(input: unknown): Partial<Record<GameId, RecurringActivity[]>> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const obj = input as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(obj, "recurringActivitiesByGame")) {
    return coerceRecurringActivitiesByGame(obj.recurringActivitiesByGame);
  }

  const hasRawGameArray = ALL_GAME_IDS.some((gameId) => Object.prototype.hasOwnProperty.call(obj, gameId) && Array.isArray(obj[gameId]));
  if (!hasRawGameArray) return null;

  const source = input;
  return coerceRecurringActivitiesByGame(source);
}

function createRecurringActivityId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `ra_${Date.now().toString(36)}_${rand}`;
}

type SyncCache = { uuid: string; clientUpdatedAt: number; blob: string };
type SyncPrefs = Omit<PrefsState, "theme">;

export type PrefsState = {
  v: 1;
  updatedAt: number;
  theme: Theme;
  visibleGameIds: GameId[];
  hiddenGameIds: GameId[];
  timeline: {
    showNotStarted: boolean;
    completedIdsByGame: Partial<Record<GameId, Array<string | number>>>;
    completedRecurringByGame: Partial<Record<GameId, Record<string, string>>>;
    recurringActivitiesByGame: Partial<Record<GameId, RecurringActivity[]>>;
  };
};

type SyncPhase = "init" | "ready" | "syncing" | "disabled" | "error" | "conflict";

type SyncState = {
  phase: SyncPhase;
  lastPullAt?: number;
  lastPushAt?: number;
  error?: string;
  conflict?: { uuid: string; blob: string; clientUpdatedAt: number };
};

export type PrefsContextValue = {
  prefs: PrefsState;
  setTheme: (t: Theme) => void;
  setVisibleGameIds: (ids: GameId[]) => void;
  setShowNotStarted: (v: boolean) => void;
  toggleCompleted: (gameId: GameId, eventId: string | number) => void;
  toggleRecurringCompleted: (gameId: GameId, activityId: string, cycleKey: string) => void;
  addRecurringActivity: (gameId: GameId, activity: Omit<RecurringActivity, "id">) => void;
  updateRecurringActivity: (gameId: GameId, activityId: string, activity: Omit<RecurringActivity, "id">) => void;
  removeRecurringActivity: (gameId: GameId, activityId: string) => void;
  exportRecurringSettings: () => RecurringSettingsExport;
  importRecurringSettings: (input: unknown) => RecurringSettingsImportResult;

  sync: {
    uuid: string;
    password: string;
    setUuid: (uuid: string) => void;
    setPassword: (password: string) => void;
    generateUuid: () => string;
    generatePassword: () => string;
    pull: () => Promise<void>;
    push: (opts?: { force?: boolean; forceNetwork?: boolean }) => Promise<void>;
    rotatePassword: (newPassword: string) => Promise<void>;
    state: SyncState;
  };
};

const PrefsContext = createContext<PrefsContextValue | null>(null);

function safeLsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLsSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function safeLsRemove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function parseSyncCache(raw: string | null): SyncCache | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SyncCache>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.uuid !== "string") return null;
    if (typeof parsed.blob !== "string") return null;
    if (typeof parsed.clientUpdatedAt !== "number" || !Number.isFinite(parsed.clientUpdatedAt)) return null;
    return { uuid: parsed.uuid, blob: parsed.blob, clientUpdatedAt: Math.trunc(parsed.clientUpdatedAt) };
  } catch {
    return null;
  }
}

function readSyncCacheForUuid(uuid: string): SyncCache | null {
  const parsed = parseSyncCache(safeLsGet(SYNC_CACHE_KEY));
  if (!parsed || parsed.uuid !== uuid) return null;
  return parsed;
}

function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  const b64 = btoa(binary);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomPassword(): string {
  // 32 bytes -> 43 chars base64url (no padding)
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function getSystemTheme(): Theme {
  const prefersDark =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
}

function getStoredTheme(): Theme | null {
  const stored = safeLsGet(THEME_KEY);
  return stored === "dark" || stored === "light" ? stored : null;
}

function getInitialTheme(): Theme {
  return getStoredTheme() ?? getSystemTheme();
}

function makeDefaultPrefs(): PrefsState {
  return {
    v: 1,
    updatedAt: 0,
    theme: getInitialTheme(),
    visibleGameIds: [...ALL_GAME_IDS],
    hiddenGameIds: [],
    timeline: {
      showNotStarted: false,
      completedIdsByGame: {},
      completedRecurringByGame: {},
      recurringActivitiesByGame: cloneRecurringActivitiesByGame(DEFAULT_RECURRING_ACTIVITIES_BY_GAME),
    },
  };
}

function toSyncPrefs(input: PrefsState): SyncPrefs {
  const { theme: _theme, ...syncPrefs } = input;
  return syncPrefs;
}

function coercePrefs(input: unknown): PrefsState {
  const base = makeDefaultPrefs();
  if (!input || typeof input !== "object") return base;
  const obj = input as any;

  // Theme is local-only and should never be restored from synced payloads.
  const theme: Theme = base.theme;

  let hiddenGameIds = base.hiddenGameIds;
  if (Array.isArray(obj.hiddenGameIds)) {
    const hiddenSet = new Set<GameId>();
    for (const item of obj.hiddenGameIds) {
      if (typeof item !== "string") continue;
      if (!ALL_GAME_ID_SET.has(item as GameId)) continue;
      hiddenSet.add(item as GameId);
    }
    hiddenGameIds = ALL_GAME_IDS.filter((id) => hiddenSet.has(id));
  }
  const hiddenSet = new Set<GameId>(hiddenGameIds);
  let visibleGameIds = ALL_GAME_IDS.filter((id) => !hiddenSet.has(id));
  if (visibleGameIds.length === 0) {
    visibleGameIds = base.visibleGameIds;
    hiddenGameIds = base.hiddenGameIds;
  }

  const showNotStarted =
    typeof obj.timeline?.showNotStarted === "boolean" ? (obj.timeline.showNotStarted as boolean) : base.timeline.showNotStarted;

  const completedIdsByGame: PrefsState["timeline"]["completedIdsByGame"] = {};
  const src = obj.timeline?.completedIdsByGame;
  if (src && typeof src === "object") {
    for (const gameId of ALL_GAME_IDS) {
      const arr = (src as any)[gameId];
      if (!Array.isArray(arr)) continue;
      const cleaned: Array<string | number> = [];
      for (const v of arr) {
        if (typeof v === "string" || typeof v === "number") cleaned.push(v);
      }
      if (cleaned.length > 0) completedIdsByGame[gameId] = cleaned;
    }
  }

  const completedRecurringByGame: PrefsState["timeline"]["completedRecurringByGame"] = {};
  const srcRecurring = obj.timeline?.completedRecurringByGame;
  if (srcRecurring && typeof srcRecurring === "object") {
    for (const gameId of ALL_GAME_IDS) {
      const entry = (srcRecurring as any)[gameId];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
        if (typeof v === "string") cleaned[k] = v;
      }
      if (Object.keys(cleaned).length > 0) completedRecurringByGame[gameId] = cleaned;
    }
  }

  const recurringActivitiesByGame = coerceRecurringActivitiesByGame(obj.timeline?.recurringActivitiesByGame) ?? base.timeline.recurringActivitiesByGame;

  const updatedAt = typeof obj.updatedAt === "number" && Number.isFinite(obj.updatedAt) ? obj.updatedAt : 0;

  return {
    v: 1,
    updatedAt,
    theme,
    visibleGameIds,
    hiddenGameIds,
    timeline: { showNotStarted, completedIdsByGame, completedRecurringByGame, recurringActivitiesByGame },
  };
}

async function syncRequest<T>(
  path: string,
  init: RequestInit & { headers?: Record<string, string> }
): Promise<{ status: number; body: { code: number; msg?: string; data: T } | null }> {
  const res = await fetch(path, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.headers ?? {}),
    },
  });

  try {
    const json = (await res.json()) as { code: number; msg?: string; data: T };
    return { status: res.status, body: json };
  } catch {
    return { status: res.status, body: null };
  }
}

export function PrefsProvider(props: { children: ReactNode }) {
  const [uuid, setUuidState] = useState(() => {
    const raw = (safeLsGet(SYNC_UUID_KEY) ?? "").trim();
    if (raw && raw.length <= 64) return raw;
    const next = randomUuid();
    safeLsSet(SYNC_UUID_KEY, next);
    return next;
  });

  const [password, setPasswordState] = useState(() => {
    const raw = (safeLsGet(SYNC_PASSWORD_KEY) ?? "").trim();
    if (raw) return raw;
    const next = randomPassword();
    safeLsSet(SYNC_PASSWORD_KEY, next);
    return next;
  });

  const [prefs, setPrefs] = useState<PrefsState>(() => makeDefaultPrefs());

  const prefsRef = useRef(prefs);
  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  const [syncState, setSyncState] = useState<SyncState>({ phase: "init" });
  const syncStateRef = useRef(syncState);
  useEffect(() => {
    syncStateRef.current = syncState;
  }, [syncState]);

  const pendingNetworkPushRef = useRef(false);
  const suppressNextAutoPushRef = useRef(false);
  const autoPushTimerRef = useRef<number | null>(null);
  const lastAutoPushUpdatedAtRef = useRef<number>(0);
  const pullInFlightRef = useRef(false);
  const lastActiveAutoPullAtRef = useRef<number>(0);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", prefs.theme === "dark");
  }, [prefs.theme]);

  useEffect(() => {
    safeLsSet(SYNC_UUID_KEY, uuid);
  }, [uuid]);

  useEffect(() => {
    safeLsSet(SYNC_PASSWORD_KEY, password);
  }, [password]);

  const setUuid = useCallback((next: string) => {
    setUuidState(next.trim());
    // Clear cached blob: it belongs to the previous uuid.
    safeLsRemove(SYNC_CACHE_KEY);
  }, []);

  const setPassword = useCallback((next: string) => {
    setPasswordState(next);
    // Clear cached blob: it's encrypted with the previous password.
    safeLsRemove(SYNC_CACHE_KEY);
  }, []);

  const push = useCallback(
    async (opts?: { force?: boolean; forceNetwork?: boolean }) => {
      const force = opts?.force ?? false;
      const forceNetwork = opts?.forceNetwork ?? false;
      const phase0 = syncStateRef.current.phase;
      const shouldNetwork = forceNetwork || phase0 === "ready";

      if (shouldNetwork) pendingNetworkPushRef.current = false;

      // Ensure we have a usable clientUpdatedAt (used for conflict resolution).
      const snap0 = prefsRef.current;
      const snap = snap0.updatedAt > 0 ? snap0 : { ...snap0, updatedAt: Date.now() };
      if (snap !== snap0) {
        suppressNextAutoPushRef.current = true;
        setPrefs(snap);
      }

      if (shouldNetwork) {
        setSyncState((s) => ({
          ...s,
          phase: "syncing",
          error: undefined,
          conflict: undefined,
        }));
      }

      let blob: string;
      try {
        blob = await encryptJson(password, toSyncPrefs(snap));
        safeLsSet(
          SYNC_CACHE_KEY,
          JSON.stringify({ uuid, clientUpdatedAt: snap.updatedAt, blob } satisfies SyncCache)
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setSyncState({ phase: "error", error: `Encrypt failed: ${msg}` });
        return;
      }

      if (!shouldNetwork) {
        // Keep local encrypted persistence working without hitting the network.
        if (phase0 === "init" || phase0 === "syncing") pendingNetworkPushRef.current = true;
        return;
      }

      const { status, body } = await syncRequest<{ uuid: string; blob: string; clientUpdatedAt: number }>(
        `/api/sync/${encodeURIComponent(uuid)}${force ? "?force=1" : ""}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json", "x-gc-password": password },
          body: JSON.stringify({ blob, clientUpdatedAt: snap.updatedAt }),
        }
      );

      if (status === 501) {
        setSyncState({ phase: "disabled", error: body?.msg ?? "Sync disabled on server" });
        return;
      }

      if (status === 409 && body?.data) {
        setSyncState({
          phase: "conflict",
          error: body.msg ?? "Conflict",
          conflict: body.data,
          lastPullAt: undefined,
          lastPushAt: undefined,
        });
        return;
      }

      if (!body || status >= 400 || body.code >= 400) {
        setSyncState({ phase: "error", error: body?.msg ?? `Sync push failed: HTTP ${status}` });
        return;
      }

      setSyncState((s) => ({ phase: "ready", lastPullAt: s.lastPullAt, lastPushAt: Date.now() }));
    },
    [password, uuid]
  );

  const pull = useCallback(async () => {
    if (pullInFlightRef.current) return;
    pullInFlightRef.current = true;

    setSyncState((s) => ({ ...s, phase: "syncing", error: undefined, conflict: undefined }));

    try {
      const { status, body } = await syncRequest<{ uuid: string; blob: string; clientUpdatedAt: number }>(
        `/api/sync/${encodeURIComponent(uuid)}`,
        { method: "GET", headers: { "x-gc-password": password } }
      );

      if (status === 501) {
        setSyncState({ phase: "disabled", error: body?.msg ?? "Sync disabled on server" });
        return;
      }

      if (status === 404) {
        // No cloud state yet; seed it using the current prefs.
        await push({ force: true, forceNetwork: true });
        return;
      }

      if (!body) {
        setSyncState({ phase: "error", error: `Sync pull failed: HTTP ${status}` });
        return;
      }

      if (status === 403) {
        setSyncState({ phase: "error", error: body.msg ?? "Invalid password" });
        return;
      }

      if (body.code >= 400) {
        setSyncState({ phase: "error", error: body.msg ?? `Sync pull failed: code ${body.code}` });
        return;
      }

      const data = body.data;
      try {
        const decrypted = await decryptJson(password, data.blob);
        const cached = readSyncCacheForUuid(uuid);
        const hasLocalSyncContext = Boolean(cached);
        const cloudUpdatedAt = Math.trunc(data.clientUpdatedAt);
        const cachedClientUpdatedAt = cached ? Math.trunc(cached.clientUpdatedAt) : 0;
        const localUpdatedAt = hasLocalSyncContext
          ? Math.max(Math.trunc(prefsRef.current.updatedAt), cachedClientUpdatedAt)
          : 0;
        const next = coercePrefs(decrypted);
        next.updatedAt = cloudUpdatedAt;

        // If this device has no cache for the current uuid, always trust cloud data.
        // Otherwise, keep the newer side by clientUpdatedAt.
        if (!hasLocalSyncContext || cloudUpdatedAt >= localUpdatedAt) {
          if (!hasLocalSyncContext || cloudUpdatedAt > localUpdatedAt) {
            suppressNextAutoPushRef.current = true;
            setPrefs(next);
          }
          safeLsSet(
            SYNC_CACHE_KEY,
            JSON.stringify({ uuid: data.uuid, clientUpdatedAt: data.clientUpdatedAt, blob: data.blob } satisfies SyncCache)
          );
        } else {
          // Local cache is newer; push to cloud once we become ready.
          pendingNetworkPushRef.current = true;
        }
        setSyncState((s) => ({ phase: "ready", lastPullAt: Date.now(), lastPushAt: s.lastPushAt }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setSyncState({ phase: "error", error: `Decrypt failed: ${msg}` });
      }
    } finally {
      pullInFlightRef.current = false;
    }
  }, [password, push, uuid]);

  const rotatePassword = useCallback(
    async (newPassword: string) => {
      const nextPw = newPassword.trim();
      if (!nextPw) {
        setSyncState({ phase: "error", error: "New password is empty" });
        return;
      }

      const snap0 = prefsRef.current;
      const snap = { ...snap0, updatedAt: Date.now() };

      setSyncState((s) => ({ ...s, phase: "syncing", error: undefined, conflict: undefined }));

      let blob: string;
      try {
        blob = await encryptJson(nextPw, toSyncPrefs(snap));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setSyncState({ phase: "error", error: `Encrypt failed: ${msg}` });
        return;
      }

      const { status, body } = await syncRequest<any>(`/api/sync/${encodeURIComponent(uuid)}/rotate`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-gc-password": password },
        body: JSON.stringify({ newPassword: nextPw, blob, clientUpdatedAt: snap.updatedAt }),
      });

      if (status === 501) {
        setSyncState({ phase: "disabled", error: body?.msg ?? "Sync disabled on server" });
        return;
      }

      if (!body || status >= 400 || body.code >= 400) {
        setSyncState({ phase: "error", error: body?.msg ?? `Password rotate failed: HTTP ${status}` });
        return;
      }

      suppressNextAutoPushRef.current = true;
      setPasswordState(nextPw);
      setPrefs(snap);
      safeLsSet(SYNC_CACHE_KEY, JSON.stringify({ uuid, clientUpdatedAt: snap.updatedAt, blob } satisfies SyncCache));

      setSyncState((s) => ({ phase: "ready", lastPullAt: s.lastPullAt, lastPushAt: Date.now() }));
    },
    [password, uuid]
  );

  // Load encrypted cache (if present) on uuid/password changes.
  useEffect(() => {
    const parsed = readSyncCacheForUuid(uuid);
    if (!parsed) return;

    (async () => {
      try {
        const decrypted = await decryptJson(password, parsed.blob);
        const next = coercePrefs(decrypted);
        next.updatedAt = Math.trunc(parsed.clientUpdatedAt);
        setPrefs((prev) => {
          if (next.updatedAt <= prev.updatedAt) return prev;
          suppressNextAutoPushRef.current = true;
          return next;
        });
      } catch {
        // Ignore: wrong password / corrupted cache.
      }
    })();
  }, [password, uuid]);

  // Initial pull + whenever uuid/password changes.
  useEffect(() => {
    const t = window.setTimeout(() => void pull(), 400);
    return () => window.clearTimeout(t);
  }, [password, pull, uuid]);

  // Pull once when the page becomes active (tab switch or app/window focus).
  useEffect(() => {
    const triggerActivePull = () => {
      if (syncStateRef.current.phase === "disabled") return;
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      // A tab switch may fire both visibility + focus. Keep only one pull.
      if (now - lastActiveAutoPullAtRef.current < ACTIVE_AUTO_PULL_DEDUPE_MS) return;
      lastActiveAutoPullAtRef.current = now;
      void pull();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") triggerActivePull();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", triggerActivePull);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", triggerActivePull);
    };
  }, [pull]);

  // Periodic sync to refresh cloud state during long idle sessions.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (syncStateRef.current.phase === "disabled") return;
      if (document.visibilityState !== "visible") return;
      void pull();
    }, AUTO_PULL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [pull]);

  // If we had local changes while sync wasn't ready (startup), push once it becomes ready.
  useEffect(() => {
    if (syncState.phase !== "ready") return;
    if (!pendingNetworkPushRef.current) return;
    pendingNetworkPushRef.current = false;
    const t = window.setTimeout(() => {
      void push({ forceNetwork: true });
    }, 0);
    return () => window.clearTimeout(t);
  }, [push, syncState.phase]);

  // Auto-push (debounced) on preference changes.
  useEffect(() => {
    if (prefs.updatedAt <= 0) return;
    if (suppressNextAutoPushRef.current) {
      suppressNextAutoPushRef.current = false;
      if (autoPushTimerRef.current) window.clearTimeout(autoPushTimerRef.current);
      autoPushTimerRef.current = null;
      return;
    }
    if (prefs.updatedAt === lastAutoPushUpdatedAtRef.current) return;
    lastAutoPushUpdatedAtRef.current = prefs.updatedAt;

    if (autoPushTimerRef.current) window.clearTimeout(autoPushTimerRef.current);
    autoPushTimerRef.current = window.setTimeout(() => {
      void push();
    }, 800);
    return () => {
      if (autoPushTimerRef.current) window.clearTimeout(autoPushTimerRef.current);
      autoPushTimerRef.current = null;
    };
  }, [prefs.updatedAt, push]);

  const setTheme = useCallback((t: Theme) => {
    safeLsSet(THEME_KEY, t);
    setPrefs((prev) => (prev.theme === t ? prev : { ...prev, theme: t }));
  }, []);

  const setVisibleGameIds = useCallback((ids: GameId[]) => {
    const filtered = ALL_GAME_IDS.filter((id) => ids.includes(id));
    setPrefs((prev) => {
      if (filtered.length === 0) return prev;
      const hiddenGameIds = ALL_GAME_IDS.filter((id) => !filtered.includes(id));
      return { ...prev, visibleGameIds: filtered, hiddenGameIds, updatedAt: Date.now() };
    });
  }, []);

  const setShowNotStarted = useCallback((v: boolean) => {
    setPrefs((prev) => ({ ...prev, timeline: { ...prev.timeline, showNotStarted: v }, updatedAt: Date.now() }));
  }, []);

  const toggleCompleted = useCallback((gameId: GameId, eventId: string | number) => {
    setPrefs((prev) => {
      const existing = prev.timeline.completedIdsByGame[gameId] ?? [];
      const set = new Set(existing);
      if (set.has(eventId)) set.delete(eventId);
      else set.add(eventId);
      const nextByGame: PrefsState["timeline"]["completedIdsByGame"] = { ...prev.timeline.completedIdsByGame };
      if (set.size === 0) delete nextByGame[gameId];
      else nextByGame[gameId] = Array.from(set);
      return { ...prev, timeline: { ...prev.timeline, completedIdsByGame: nextByGame }, updatedAt: Date.now() };
    });
  }, []);

  const toggleRecurringCompleted = useCallback((gameId: GameId, activityId: string, cycleKey: string) => {
    setPrefs((prev) => {
      const existingForGame = prev.timeline.completedRecurringByGame[gameId] ?? {};
      const nextForGame: Record<string, string> = { ...existingForGame };
      if (nextForGame[activityId] === cycleKey) delete nextForGame[activityId];
      else nextForGame[activityId] = cycleKey;

      const nextByGame: PrefsState["timeline"]["completedRecurringByGame"] = { ...prev.timeline.completedRecurringByGame };
      if (Object.keys(nextForGame).length === 0) delete nextByGame[gameId];
      else nextByGame[gameId] = nextForGame;

      return { ...prev, timeline: { ...prev.timeline, completedRecurringByGame: nextByGame }, updatedAt: Date.now() };
    });
  }, []);

  const addRecurringActivity = useCallback((gameId: GameId, activity: Omit<RecurringActivity, "id">) => {
    setPrefs((prev) => {
      const title = normalizeRecurringTitle(activity.title);
      const rule = coerceRecurringRule(activity.rule);
      if (!title || !rule) return prev;
      const durationDays = coerceRecurringDurationDays(activity.durationDays);
      const existing = prev.timeline.recurringActivitiesByGame[gameId] ?? [];
      const nextEntry: RecurringActivity = {
        id: createRecurringActivityId(),
        title,
        rule,
        durationDays,
      };

      const nextByGame: PrefsState["timeline"]["recurringActivitiesByGame"] = {
        ...prev.timeline.recurringActivitiesByGame,
        [gameId]: [...existing, nextEntry],
      };

      return { ...prev, timeline: { ...prev.timeline, recurringActivitiesByGame: nextByGame }, updatedAt: Date.now() };
    });
  }, []);

  const updateRecurringActivity = useCallback(
    (gameId: GameId, activityId: string, activity: Omit<RecurringActivity, "id">) => {
      const normalizedId = normalizeRecurringId(activityId);
      if (!normalizedId) return;

      setPrefs((prev) => {
        const title = normalizeRecurringTitle(activity.title);
        const rule = coerceRecurringRule(activity.rule);
        if (!title || !rule) return prev;

        const existing = prev.timeline.recurringActivitiesByGame[gameId] ?? [];
        const targetIndex = existing.findIndex((item) => item.id === normalizedId);
        if (targetIndex < 0) return prev;

        const durationDays = coerceRecurringDurationDays(activity.durationDays);
        const nextEntry: RecurringActivity = {
          ...existing[targetIndex]!,
          title,
          rule,
          durationDays,
        };
        const nextActivities = [...existing];
        nextActivities[targetIndex] = nextEntry;

        const nextByGame: PrefsState["timeline"]["recurringActivitiesByGame"] = {
          ...prev.timeline.recurringActivitiesByGame,
          [gameId]: nextActivities,
        };

        return { ...prev, timeline: { ...prev.timeline, recurringActivitiesByGame: nextByGame }, updatedAt: Date.now() };
      });
    },
    []
  );

  const removeRecurringActivity = useCallback((gameId: GameId, activityId: string) => {
    const normalizedId = normalizeRecurringId(activityId);
    if (!normalizedId) return;

    setPrefs((prev) => {
      const existing = prev.timeline.recurringActivitiesByGame[gameId] ?? [];
      const nextActivities = existing.filter((item) => item.id !== normalizedId);
      if (nextActivities.length === existing.length) return prev;

      const nextActivitiesByGame: PrefsState["timeline"]["recurringActivitiesByGame"] = {
        ...prev.timeline.recurringActivitiesByGame,
      };
      if (nextActivities.length === 0) delete nextActivitiesByGame[gameId];
      else nextActivitiesByGame[gameId] = nextActivities;

      const existingCompleted = prev.timeline.completedRecurringByGame[gameId] ?? {};
      const nextCompletedForGame = { ...existingCompleted };
      delete nextCompletedForGame[normalizedId];

      const nextCompletedByGame: PrefsState["timeline"]["completedRecurringByGame"] = {
        ...prev.timeline.completedRecurringByGame,
      };
      if (Object.keys(nextCompletedForGame).length === 0) delete nextCompletedByGame[gameId];
      else nextCompletedByGame[gameId] = nextCompletedForGame;

      return {
        ...prev,
        timeline: {
          ...prev.timeline,
          recurringActivitiesByGame: nextActivitiesByGame,
          completedRecurringByGame: nextCompletedByGame,
        },
        updatedAt: Date.now(),
      };
    });
  }, []);

  const exportRecurringSettings = useCallback((): RecurringSettingsExport => {
    return {
      type: "game-cal.recurring-settings",
      v: 1,
      recurringActivitiesByGame: cloneRecurringActivitiesByGame(prefsRef.current.timeline.recurringActivitiesByGame),
    };
  }, []);

  const importRecurringSettings = useCallback((input: unknown): RecurringSettingsImportResult => {
    const recurringActivitiesByGame = parseRecurringSettingsImport(input);
    if (!recurringActivitiesByGame) {
      return { ok: false, error: "文件格式不正确，缺少 recurringActivitiesByGame 或内容无效。" };
    }

    let gameCount = 0;
    let activityCount = 0;
    const validIdByGame: Partial<Record<GameId, Set<string>>> = {};
    for (const gameId of ALL_GAME_IDS) {
      const entries = recurringActivitiesByGame[gameId];
      if (!entries || entries.length === 0) continue;
      gameCount += 1;
      activityCount += entries.length;
      validIdByGame[gameId] = new Set(entries.map((entry) => entry.id));
    }

    setPrefs((prev) => {
      const nextCompletedRecurringByGame: PrefsState["timeline"]["completedRecurringByGame"] = {};
      for (const gameId of ALL_GAME_IDS) {
        const existing = prev.timeline.completedRecurringByGame[gameId];
        const validIds = validIdByGame[gameId];
        if (!existing || !validIds || validIds.size === 0) continue;
        const nextForGame: Record<string, string> = {};
        for (const [id, cycleKey] of Object.entries(existing)) {
          if (validIds.has(id)) nextForGame[id] = cycleKey;
        }
        if (Object.keys(nextForGame).length > 0) nextCompletedRecurringByGame[gameId] = nextForGame;
      }

      return {
        ...prev,
        timeline: {
          ...prev.timeline,
          recurringActivitiesByGame: cloneRecurringActivitiesByGame(recurringActivitiesByGame),
          completedRecurringByGame: nextCompletedRecurringByGame,
        },
        updatedAt: Date.now(),
      };
    });

    return { ok: true, gameCount, activityCount };
  }, []);

  const value: PrefsContextValue = useMemo(
    () => ({
      prefs,
      setTheme,
      setVisibleGameIds,
      setShowNotStarted,
      toggleCompleted,
      toggleRecurringCompleted,
      addRecurringActivity,
      updateRecurringActivity,
      removeRecurringActivity,
      exportRecurringSettings,
      importRecurringSettings,
      sync: {
        uuid,
        password,
        setUuid,
        setPassword,
        generateUuid: randomUuid,
        generatePassword: randomPassword,
        pull,
        push,
        rotatePassword,
        state: syncState,
      },
    }),
    [
      addRecurringActivity,
      exportRecurringSettings,
      importRecurringSettings,
      password,
      prefs,
      pull,
      push,
      removeRecurringActivity,
      rotatePassword,
      setPassword,
      setTheme,
      setUuid,
      setVisibleGameIds,
      setShowNotStarted,
      syncState,
      toggleCompleted,
      toggleRecurringCompleted,
      updateRecurringActivity,
      uuid,
    ]
  );

  return (
    <PrefsContext.Provider value={value}>
      <ThemeProvider theme={prefs.theme}>{props.children}</ThemeProvider>
    </PrefsContext.Provider>
  );
}

export function usePrefs(): PrefsContextValue {
  const ctx = useContext(PrefsContext);
  if (!ctx) throw new Error("usePrefs must be used within <PrefsProvider />");
  return ctx;
}
