import { fetchJson } from "../lib/fetch.js";
import { toIsoWithSourceOffset } from "../lib/time.js";
import type { RuntimeEnv } from "../lib/runtimeEnv.js";
import type { CalendarEvent } from "../types.js";

type KuroWikiGameData = {
  code: number;
  msg: string;
  data?: {
    contentJson?: {
      sideModules?: Array<{
        title: string;
        content: Array<{
          title: string;
          contentUrl?: string;
          linkConfig: {
            linkUrl?: string;
            entryId?: string;
          };
          countDown?: {
            dateRange: [string, string];
          };
        }>;
        more?: {
          linkConfig?: {
            catalogueId?: number;
          };
        };
      }>;
    };
  };
};

const KURO_HOME_DEFAULT = "https://api.kurobbs.com/wiki/core/homepage/getPage";
const KURO_CATALOGUE_DEFAULT =
  "https://api.kurobbs.com/wiki/core/catalogue/item/getPage";
const MC_WIKI_TYPE = "9";
const TARGET_TITLE = "版本活动";
const WW_SOURCE_TZ_OFFSET = "+08:00";

type KuroCatalogueResponse = {
  code: number;
  msg: string;
  data?: {
    results?: {
      records?: Array<
        | {
            entryId?: number;
            content?: {
              contentUrl?: string;
            };
          }
        | null
      >;
    };
  };
};

function stableHash64(input: string): string {
  // FNV-1a 64-bit. Fast, deterministic, and works in both Node and Workers.
  // (Avoids importing Node builtins, since this file is typechecked in the worker package too.)
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;

  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }

  return hash.toString(16).padStart(16, "0");
}

function stableEventIdFromTitleAndEntryId(title: string, entryId: string): string {
  return stableHash64(`${title}|${entryId}`);
}

function stableEventIdFromTitleAndStartTime(title: string, startTime: string): string {
  return stableHash64(`${title}|${startTime}`);
}

export async function fetchWwEvents(
  env: RuntimeEnv = {}
): Promise<CalendarEvent[]> {
  const url = env.KURO_WIKI_HOME_URL ?? KURO_HOME_DEFAULT;
  const res = await fetchJson<KuroWikiGameData>(url, {
    method: "POST",
    headers: { Wiki_type: MC_WIKI_TYPE },
    timeoutMs: 12_000,
  });

  const sideModules = res.data?.contentJson?.sideModules ?? [];
  const target = sideModules.find((m) => m.title === TARGET_TITLE);
  if (!target) return [];

  const catalogueId = target.more?.linkConfig?.catalogueId;
  const imgMap = new Map<string, string>();
  if (catalogueId) {
    const catalogueUrl =
      env.KURO_WIKI_CATALOGUE_URL ?? KURO_CATALOGUE_DEFAULT;
    const catalogueRes = await fetchJson<KuroCatalogueResponse>(
      `${catalogueUrl}?catalogueId=${catalogueId}&page=1&limit=1000`,
      {
        method: "POST",
        headers: {
          Wiki_type: MC_WIKI_TYPE,
          "content-type": "application/x-www-form-urlencoded",
        },
        timeoutMs: 12_000,
      }
    ).catch(() => null);

    const records = catalogueRes?.data?.results?.records ?? [];
    for (const r of records) {
      const entryId = r?.entryId;
      const img = r?.content?.contentUrl;
      if (entryId && img) imgMap.set(String(entryId), img);
    }
  }

  return target.content
    .filter((c) => Boolean(c.countDown?.dateRange?.[0]) && Boolean(c.countDown?.dateRange?.[1]))
    .map((c) => {
      const [start_time, end_time] = c.countDown!.dateRange;
      // Kuro Wiki's entryId is essentially the announcement id; multiple events can share it.
      // Hash title + entryId to keep ids stable but unique within the list.
      const id = c.linkConfig.entryId
        ? stableEventIdFromTitleAndEntryId(c.title, c.linkConfig.entryId)
        : stableEventIdFromTitleAndStartTime(c.title, start_time);
      return {
        id,
        title: c.title,
        start_time: toIsoWithSourceOffset(start_time, WW_SOURCE_TZ_OFFSET),
        end_time: toIsoWithSourceOffset(end_time, WW_SOURCE_TZ_OFFSET),
        banner: (c.linkConfig.entryId && imgMap.get(c.linkConfig.entryId)) ?? c.contentUrl,
        linkUrl: c.linkConfig.linkUrl,
      };
    });
}
