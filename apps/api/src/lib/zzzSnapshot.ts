import { SimpleTtlCache } from "./cache.js";
import { FetchError, fetchJson } from "./fetch.js";
import type { RuntimeEnv } from "./runtimeEnv.js";

export type MihoyoNapActivity = {
  activity_id?: string;
  name?: string;
  start_time?: string;
  end_time?: string;
};

export type MihoyoNapActivityListResponse = {
  retcode: number;
  message: string;
  data?: {
    activity_list?: MihoyoNapActivity[];
  };
};

export type MihoyoNapAnnItem = {
  ann_id?: number;
  title?: string;
  subtitle?: string;
  start_time?: string;
  end_time?: string;
};

export type MihoyoNapAnnCategory = {
  type_id: number;
  type_label: string;
  list: MihoyoNapAnnItem[];
};

export type MihoyoNapAnnListResponse = {
  retcode: number;
  message: string;
  data?: {
    list?: MihoyoNapAnnCategory[];
  };
};

export type MihoyoNapAnnContentItem = {
  ann_id?: number;
  title?: string;
  subtitle?: string;
  banner?: string;
  img?: string;
  content?: string;
  lang?: string;
  remind_text?: string;
  href?: string;
  href_type?: number;
};

export type MihoyoNapAnnContentResponse = {
  retcode: number;
  message: string;
  data?: {
    list?: MihoyoNapAnnContentItem[];
    pic_list?: MihoyoNapAnnContentItem[];
  };
};

export const ZZZ_DEFAULT_ACTIVITY_API =
  "https://announcement-static.mihoyo.com/common/nap_cn/announcement/api/getActivityList?uid=11111111&game=nap&game_biz=nap_cn&lang=zh-cn&bundle_id=nap_cn&channel_id=1&level=60&platform=pc&region=prod_gf_cn";

export const ZZZ_DEFAULT_LIST_API =
  "https://announcement-static.mihoyo.com/common/nap_cn/announcement/api/getAnnList?uid=11111111&game=nap&game_biz=nap_cn&lang=zh-cn&bundle_id=nap_cn&channel_id=1&level=60&platform=pc&region=prod_gf_cn";

export const ZZZ_DEFAULT_CONTENT_API =
  "https://announcement-static.mihoyo.com/common/nap_cn/announcement/api/getAnnContent?uid=11111111&game=nap&game_biz=nap_cn&lang=zh-cn&bundle_id=nap_cn&channel_id=1&level=60&platform=pc&region=prod_gf_cn";

export const ZZZ_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const ZZZ_SNAPSHOT_CACHE_TTL_MS = 5 * 60 * 1000;

export type ZzzSnapshotBundle = {
  schema_version: typeof ZZZ_SNAPSHOT_SCHEMA_VERSION;
  game: "zzz";
  activity: MihoyoNapActivityListResponse;
  list: MihoyoNapAnnListResponse;
  content: MihoyoNapAnnContentResponse;
};

export class ZzzSnapshotValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ZzzSnapshotValidationError";
  }
}

export class ZzzSnapshotTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ZzzSnapshotTransportError";
  }
}

const zzzSnapshotCache = new SimpleTtlCache();

function invalidSnapshot(message: string, options?: ErrorOptions): never {
  throw new ZzzSnapshotValidationError(
    `Invalid ZZZ snapshot: ${message}`,
    options
  );
}

function validateSnapshotSourceUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    invalidSnapshot(`${label} must be an absolute HTTP URL`, { cause: error });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    invalidSnapshot(`${label} must be an absolute HTTP URL`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) {
    invalidSnapshot(`unexpected ${label} field ${unexpected}`);
  }
}

function assertOptionalString(
  value: Record<string, unknown>,
  key: string,
  label: string
): void {
  if (value[key] !== undefined && typeof value[key] !== "string") {
    invalidSnapshot(`${label}.${key} must be a string`);
  }
}

function assertOptionalNumber(
  value: Record<string, unknown>,
  key: string,
  label: string
): void {
  if (
    value[key] !== undefined &&
    (typeof value[key] !== "number" || !Number.isFinite(value[key]))
  ) {
    invalidSnapshot(`${label}.${key} must be a finite number`);
  }
}

function assertActivityResponse(
  value: unknown
): asserts value is MihoyoNapActivityListResponse {
  if (!isRecord(value)) {
    invalidSnapshot("activity must be an object");
  }
  if (value.retcode !== 0) {
    invalidSnapshot("activity.retcode must be 0");
  }
  if (typeof value.message !== "string") {
    invalidSnapshot("activity.message must be a string");
  }
  if (!isRecord(value.data) || !Array.isArray(value.data.activity_list)) {
    invalidSnapshot("activity.data.activity_list must be an array");
  }

  for (const [index, item] of value.data.activity_list.entries()) {
    const label = `activity.data.activity_list[${index}]`;
    if (!isRecord(item)) {
      invalidSnapshot(`${label} must be an object`);
    }
    assertOptionalString(item, "activity_id", label);
    assertOptionalString(item, "name", label);
    assertOptionalString(item, "start_time", label);
    assertOptionalString(item, "end_time", label);
  }
}

function assertAnnItem(value: unknown, label: string): asserts value is MihoyoNapAnnItem {
  if (!isRecord(value)) {
    invalidSnapshot(`${label} must be an object`);
  }
  assertOptionalNumber(value, "ann_id", label);
  assertOptionalString(value, "title", label);
  assertOptionalString(value, "subtitle", label);
  assertOptionalString(value, "start_time", label);
  assertOptionalString(value, "end_time", label);
}

function assertListResponse(value: unknown): asserts value is MihoyoNapAnnListResponse {
  if (!isRecord(value)) {
    invalidSnapshot("list must be an object");
  }
  if (value.retcode !== 0) {
    invalidSnapshot("list.retcode must be 0");
  }
  if (typeof value.message !== "string") {
    invalidSnapshot("list.message must be a string");
  }
  if (!isRecord(value.data) || !Array.isArray(value.data.list)) {
    invalidSnapshot("list.data.list must be an array");
  }

  for (const [categoryIndex, category] of value.data.list.entries()) {
    const label = `list.data.list[${categoryIndex}]`;
    if (!isRecord(category)) {
      invalidSnapshot(`${label} must be an object`);
    }
    if (typeof category.type_id !== "number" || !Number.isFinite(category.type_id)) {
      invalidSnapshot(`${label}.type_id must be a finite number`);
    }
    if (typeof category.type_label !== "string") {
      invalidSnapshot(`${label}.type_label must be a string`);
    }
    if (!Array.isArray(category.list)) {
      invalidSnapshot(`${label}.list must be an array`);
    }
    for (const [itemIndex, item] of category.list.entries()) {
      assertAnnItem(item, `${label}.list[${itemIndex}]`);
    }
  }
}

function assertContentItem(
  value: unknown,
  label: string
): asserts value is MihoyoNapAnnContentItem {
  if (!isRecord(value)) {
    invalidSnapshot(`${label} must be an object`);
  }
  assertOptionalNumber(value, "ann_id", label);
  assertOptionalString(value, "title", label);
  assertOptionalString(value, "subtitle", label);
  assertOptionalString(value, "banner", label);
  assertOptionalString(value, "img", label);
  assertOptionalString(value, "content", label);
  assertOptionalString(value, "lang", label);
  assertOptionalString(value, "remind_text", label);
  assertOptionalString(value, "href", label);
  assertOptionalNumber(value, "href_type", label);
}

function assertContentResponse(
  value: unknown
): asserts value is MihoyoNapAnnContentResponse {
  if (!isRecord(value)) {
    invalidSnapshot("content must be an object");
  }
  if (value.retcode !== 0) {
    invalidSnapshot("content.retcode must be 0");
  }
  if (typeof value.message !== "string") {
    invalidSnapshot("content.message must be a string");
  }
  if (
    !isRecord(value.data) ||
    !Array.isArray(value.data.list) ||
    !Array.isArray(value.data.pic_list)
  ) {
    invalidSnapshot(
      "content.data.list and content.data.pic_list must be arrays"
    );
  }

  for (const [index, item] of value.data.list.entries()) {
    assertContentItem(item, `content.data.list[${index}]`);
  }
  for (const [index, item] of value.data.pic_list.entries()) {
    assertContentItem(item, `content.data.pic_list[${index}]`);
  }
}

export function parseZzzSnapshotBundle(value: unknown): ZzzSnapshotBundle {
  if (!isRecord(value)) {
    invalidSnapshot("root must be an object");
  }
  assertExactKeys(
    value,
    ["schema_version", "game", "activity", "list", "content"],
    "root"
  );
  if (value.schema_version !== ZZZ_SNAPSHOT_SCHEMA_VERSION) {
    invalidSnapshot(
      `schema_version must be ${ZZZ_SNAPSHOT_SCHEMA_VERSION}`
    );
  }
  if (value.game !== "zzz") {
    invalidSnapshot('game must be "zzz"');
  }

  assertActivityResponse(value.activity);
  assertListResponse(value.list);
  assertContentResponse(value.content);
  return value as ZzzSnapshotBundle;
}

function isFetchTransportError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (typeof error !== "object" || error === null || !("name" in error)) {
    return false;
  }
  return error.name === "AbortError" || error.name === "TimeoutError";
}

async function fetchSnapshotJson(url: string): Promise<unknown> {
  try {
    return await fetchJson<unknown>(url, { timeoutMs: 12_000 });
  } catch (error) {
    if (error instanceof FetchError) {
      throw error;
    }
    if (error instanceof SyntaxError) {
      invalidSnapshot("upstream returned malformed JSON", { cause: error });
    }
    if (isFetchTransportError(error)) {
      throw new ZzzSnapshotTransportError(
        "ZZZ snapshot upstream transport failed",
        { cause: error }
      );
    }
    throw error;
  }
}

function cloneSnapshot(snapshot: ZzzSnapshotBundle): ZzzSnapshotBundle {
  return structuredClone(snapshot);
}

async function getCachedSnapshot(
  cacheKey: string,
  load: () => Promise<ZzzSnapshotBundle>
): Promise<ZzzSnapshotBundle> {
  const canonical = await zzzSnapshotCache.getOrSet(
    cacheKey,
    ZZZ_SNAPSHOT_CACHE_TTL_MS,
    load
  );
  return cloneSnapshot(canonical);
}

async function getSnapshotFromIndividualSources(opts: {
  activityUrl: string;
  listUrl: string;
  contentUrl: string;
}): Promise<ZzzSnapshotBundle> {
  const activityUrl = validateSnapshotSourceUrl(
    opts.activityUrl,
    "activity source URL"
  );
  const listUrl = validateSnapshotSourceUrl(opts.listUrl, "list source URL");
  const contentUrl = validateSnapshotSourceUrl(
    opts.contentUrl,
    "content source URL"
  );
  const cacheKey = `individual:${JSON.stringify([
    activityUrl,
    listUrl,
    contentUrl,
  ])}`;

  return await getCachedSnapshot(cacheKey, async () => {
    const [activity, list, content] = await Promise.all([
      fetchSnapshotJson(activityUrl),
      fetchSnapshotJson(listUrl),
      fetchSnapshotJson(contentUrl),
    ]);
    return parseZzzSnapshotBundle({
      schema_version: ZZZ_SNAPSHOT_SCHEMA_VERSION,
      game: "zzz",
      activity,
      list,
      content,
    });
  });
}

export async function getOfficialZzzSnapshotBundle(): Promise<ZzzSnapshotBundle> {
  return await getSnapshotFromIndividualSources({
    activityUrl: ZZZ_DEFAULT_ACTIVITY_API,
    listUrl: ZZZ_DEFAULT_LIST_API,
    contentUrl: ZZZ_DEFAULT_CONTENT_API,
  });
}

export async function getZzzSnapshotBundle(
  env: RuntimeEnv = {}
): Promise<ZzzSnapshotBundle> {
  const configuredSnapshotUrlValue = env.ZZZ_SNAPSHOT_API_URL?.trim();
  if (configuredSnapshotUrlValue) {
    const configuredSnapshotUrl = validateSnapshotSourceUrl(
      configuredSnapshotUrlValue,
      "configured source URL"
    );
    return await getCachedSnapshot(
      `configured:${configuredSnapshotUrl}`,
      async () => {
        const value = await fetchSnapshotJson(configuredSnapshotUrl);
        return parseZzzSnapshotBundle(value);
      }
    );
  }

  return await getSnapshotFromIndividualSources({
    activityUrl:
      env.ZZZ_ACTIVITY_API_URL?.trim() || ZZZ_DEFAULT_ACTIVITY_API,
    listUrl: env.ZZZ_API_URL?.trim() || ZZZ_DEFAULT_LIST_API,
    contentUrl:
      env.ZZZ_CONTENT_API_URL?.trim() || ZZZ_DEFAULT_CONTENT_API,
  });
}

export function classifyZzzSnapshotRelayError(error: unknown): number {
  if (error instanceof ZzzSnapshotValidationError) {
    return 422;
  }
  if (error instanceof ZzzSnapshotTransportError) {
    return 502;
  }
  if (error instanceof FetchError) {
    if (error.status === 429) return 429;
    if (error.status >= 400 && error.status < 500) return 424;
    if (error.status >= 500 && error.status < 600) return 502;
  }
  return 422;
}
