import { FetchError, fetchJson } from "../lib/fetch.js";
import { toIsoWithSourceOffset, unixSecondsToIsoWithSourceOffset } from "../lib/time.js";
import type { RuntimeEnv } from "../lib/runtimeEnv.js";
import type { CalendarEvent, GameId } from "../types.js";

// Livestream ("前瞻") redemption codes are not part of the in-game notice feeds.
//
// - miHoYo games (Genshin, Star Rail, ZZZ): the 米游社 livestream page serves the
//   codes as text through `event/miyolive/refreshCode` (keyed by the stream's
//   act_id, which the app-style home navigator and official posts link to). The
//   official account's follow-up posts carry the expiry wording, e.g.
//   "兑换码将于2026年9月21日23:59:59失效". Star Rail additionally lists the codes
//   in plain text, which is kept as a fallback when the livestream API is gone.
// - Wuthering Waves: 库街区 official account (userId 10012001) leaves the codes as
//   the first-floor publisher comment on the "x.x版本前瞻通讯 | 回顾影像" post.
//   The forum feeds are recommendation-ordered, so the post is discovered through
//   the public search endpoint, which returns matches newest-first.

const SOURCE_TZ_OFFSET = "+08:00";
const SOURCE_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_POST_AGE_MS = 60 * DAY_MS;
const FETCH_TIMEOUT_MS = 12_000;
// Whole-game budget. The notice feed waits on this, and a Worker refresh that
// runs from a request's waitUntil() only has ~30s in total.
const LIVESTREAM_FETCH_BUDGET_MS = 15_000;

const LIVESTREAM_CODE_ID_MARKER = ":livestream-code:";

const LIVESTREAM_KEYWORD = "前瞻";
const CODE_KEYWORD = "兑换码";
const RELATIVE_EXPIRY_TEXT = "有效期以官方说明为准";

const PREVIEW_ANNOUNCEMENT_KEYWORD = "预告";

type MiyousheGameConfig = {
  game: GameId;
  gids: number;
  officialUid: string;
  articlePath: string;
};

const MIYOUSHE_GAMES: Partial<Record<GameId, MiyousheGameConfig>> = {
  genshin: { game: "genshin", gids: 2, officialUid: "75276539", articlePath: "ys" },
  starrail: { game: "starrail", gids: 6, officialUid: "288909600", articlePath: "sr" },
  zzz: { game: "zzz", gids: 8, officialUid: "152039148", articlePath: "zzz" },
};
const MIYOUSHE_DEFAULT_USER_POST_API = "https://bbs-api.miyoushe.com/post/wapi/userPost";
const MIYOUSHE_DEFAULT_HOME_API = "https://bbs-api.mihoyo.com/apihub/api/home/new";
const MIYOLIVE_DEFAULT_INDEX_API = "https://api-takumi.mihoyo.com/event/miyolive/index";
const MIYOLIVE_DEFAULT_CODE_API = "https://api-takumi.mihoyo.com/event/miyolive/refreshCode";
const MIYOUSHE_USER_POST_SIZE = 50;
const MIYOUSHE_ARTICLE_URL = "https://www.miyoushe.com/";
const MIYOUSHE_LIVE_PAGE_URL = "https://webstatic.mihoyo.com/bbs/event/live/index.html";
const MIYOUSHE_LIVE_PAGE_PATH = "/bbs/event/live/";
const MIYOLIVE_MAX_ACTS = 3;
// Matching a livestream to its expiry post when neither names a version.
const MIYOUSHE_POST_MATCH_WINDOW_MS = 3 * DAY_MS;

const WW_KUROBBS_OFFICIAL_USER_ID = "10012001";
const WW_KUROBBS_GAME_ID = 3;
const WW_KUROBBS_SEARCH_KEYWORD = "前瞻通讯";
const WW_KUROBBS_SEARCH_PAGES = 2;
const WW_KUROBBS_SEARCH_PAGE_SIZE = 20;
const WW_MAX_DETAIL_REQUESTS = 4;
const WW_DEFAULT_SEARCH_API = "https://api.kurobbs.com/forum/search/v2/post";
const WW_DEFAULT_POST_DETAIL_API = "https://api.kurobbs.com/forum/getPostDetail";
const WW_KUROBBS_POST_URL = "https://www.kurobbs.com/mc/post/";
// `source` is mandatory; `devCode`/`version` are required to be present but are
// not validated upstream. No login token is needed for public posts.
const WW_KUROBBS_HEADERS: Record<string, string> = {
  source: "android",
  devCode: "game-cal",
  version: "2.2.0",
  "content-type": "application/x-www-form-urlencoded",
};

type JsonObject = Record<string, unknown>;

export type RedeemCodeExpiry = {
  iso: string | null;
  text: string | null;
};

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringOrUndefined(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Timeouts, network errors, 429 and 5xx may pass on the next refresh; other
// HTTP errors mean the resource itself is gone or refused.
function isTransientFetchFailure(err: unknown): boolean {
  if (err instanceof FetchError) return err.status === 429 || err.status >= 500;
  return true;
}

function sourceYearFromMs(ms: number): number {
  return new Date(ms + SOURCE_TZ_OFFSET_MS).getUTCFullYear();
}

function msToSourceIso(ms: number): string {
  return unixSecondsToIsoWithSourceOffset(Math.floor(ms / 1000), SOURCE_TZ_OFFSET);
}

export function extractVersionLabel(input: string): string | null {
  const explicit = /(\d+(?:\.\d+)+)\s*版本/.exec(input);
  if (explicit?.[1]) return explicit[1];
  const bare = /(?<![\d.])(\d+\.\d+)(?![\d.])\s*前瞻/.exec(input);
  return bare?.[1] ?? null;
}

function withQuery(base: string, params: Record<string, string | number>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) query.set(key, String(value));
  return `${base}${base.includes("?") ? "&" : "?"}${query.toString()}`;
}

function stripHtml(input: string): string {
  // Reward titles wrap numbers in inline <span>s, so tags must not become spaces.
  return input
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pull redemption codes out of an official post/comment.
 *
 * Bracketed codes (【CODE】 / [CODE] / 「CODE」) win when present. Otherwise every
 * standalone upper-case alphanumeric token after the first "兑换码" mention is
 * treated as a code. Digit-only tokens (dates, reward amounts) are ignored.
 */
export function extractRedeemCodes(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (code: string): void => {
    if (!/[A-Z]/.test(code) || seen.has(code)) return;
    seen.add(code);
    out.push(code);
  };

  for (const match of text.matchAll(/[【\[「]\s*([A-Z0-9]{6,24})\s*[】\]」]/g)) {
    push(match[1]!);
  }
  if (out.length > 0) return out;

  const idx = text.indexOf(CODE_KEYWORD);
  if (idx < 0) return out;
  for (const match of text.slice(idx).matchAll(/(?<![A-Za-z0-9])[A-Z0-9]{8,24}(?![A-Za-z0-9])/g)) {
    push(match[0]);
  }
  return out;
}

const EXPIRY_CONTEXT_RE = /失效|有效期|截止|过期|兑换期限|前兑换|前使用|前领取|兑换码/;
const EXPIRY_DATE_TIME_RE =
  /(?:(\d{4})\s*[年/.\-]\s*)?(\d{1,2})\s*[月/.\-]\s*(\d{1,2})\s*日?\s*(\d{1,2})\s*(?:[:：]\s*(\d{2})(?:\s*[:：]\s*(\d{2}))?|[时点])/g;

/**
 * Find the code expiry inside the official wording, e.g.
 * "兑换码将于2026年9月21日23:59:59失效" or "兑换码有效期至2026年9月21日23:59".
 *
 * Only a date-time that sits next to expiry wording is accepted, so unrelated
 * timestamps in the same post (stream schedule, version launch) are ignored.
 * "24:00" rolls over to the next day; a missing year falls back to the post
 * year and rolls forward when the result would precede the post.
 */
export function extractRedeemCodeExpiry(
  text: string,
  opts: { fallbackYear: number; notBeforeMs?: number }
): RedeemCodeExpiry {
  for (const match of text.matchAll(EXPIRY_DATE_TIME_RE)) {
    const idx = match.index ?? 0;
    const context = text.slice(Math.max(0, idx - 24), idx + match[0].length + 12);
    if (!EXPIRY_CONTEXT_RE.test(context)) continue;

    const explicitYear = match[1] ? Number(match[1]) : null;
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = match[5] ? Number(match[5]) : 0;
    const second = match[6] ? Number(match[6]) : 0;
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    if (hour < 0 || hour > 24 || minute > 59 || second > 59) continue;

    const toMs = (year: number): number =>
      Date.UTC(year, month - 1, day, hour, minute, second) - SOURCE_TZ_OFFSET_MS;
    let year = explicitYear ?? opts.fallbackYear;
    let ms = toMs(year);
    if (explicitYear == null && opts.notBeforeMs != null && ms < opts.notBeforeMs - DAY_MS) {
      year += 1;
      ms = toMs(year);
    }
    if (!Number.isFinite(ms)) continue;

    return { iso: msToSourceIso(ms), text: match[0] };
  }

  return { iso: null, text: null };
}

function buildLivestreamCodeEvent(opts: {
  game: GameId;
  sourceId: string;
  versionLabel: string | null;
  codes: string[];
  startMs: number;
  expiry: RedeemCodeExpiry;
  text: string;
  linkUrl: string;
  banner?: string;
}): CalendarEvent {
  const title = `${opts.versionLabel ? `${opts.versionLabel}版本` : ""}前瞻兑换码`;
  const base = {
    id: `${opts.game}${LIVESTREAM_CODE_ID_MARKER}${opts.sourceId}`,
    title,
    start_time: msToSourceIso(opts.startMs),
    is_gacha: false,
    banner: opts.banner,
    content: opts.text,
    linkUrl: opts.linkUrl,
    redeem_codes: opts.codes.length > 0 ? opts.codes : undefined,
  };

  const expiryMs = opts.expiry.iso ? Date.parse(opts.expiry.iso) : Number.NaN;
  if (Number.isFinite(expiryMs) && expiryMs > opts.startMs) {
    return { ...base, end_time: opts.expiry.iso, end_time_kind: "explicit" };
  }
  return {
    ...base,
    end_time: null,
    end_time_kind: "relative",
    end_time_text: RELATIVE_EXPIRY_TEXT,
  };
}

export function isLivestreamCodeEvent(event: CalendarEvent): boolean {
  return String(event.id).includes(LIVESTREAM_CODE_ID_MARKER);
}

// The livestream API failed transiently. `events` holds what the official
// posts alone still support: the expiry, plus Star Rail's plain-text codes.
class DegradedLivestreamCodesError extends Error {
  readonly events: CalendarEvent[];

  constructor(events: CalendarEvent[]) {
    super("livestream API unavailable; only post-derived code events");
    this.name = "DegradedLivestreamCodesError";
    this.events = events;
  }
}

function dedupeByCodes(events: CalendarEvent[]): CalendarEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = (event.redeem_codes ?? []).join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// miHoYo games (米游社 official posts + miyolive livestream API)
// ---------------------------------------------------------------------------

type MiyoushePost = {
  postId: string;
  subject: string;
  text: string;
  createdMs: number;
  cover?: string;
  links: string[];
};

type MiyousheExpiryPost = MiyoushePost & {
  versionLabel: string | null;
  codes: string[];
  expiry: RedeemCodeExpiry;
};

type MiyoliveCodes = {
  actId: string;
  title: string;
  versionLabel: string | null;
  startMs: number;
  codes: Array<{ code: string; reward: string }>;
};

function extractMiyoushePostContent(post: JsonObject): { text: string; links: string[] } {
  // `structured_content` is a Quill delta (JSON string); string inserts hold
  // the full text while `content` in list responses is truncated.
  const structured = toStringOrUndefined(post.structured_content);
  if (structured) {
    try {
      const parsed: unknown = JSON.parse(structured);
      if (Array.isArray(parsed)) {
        const parts: string[] = [];
        const links: string[] = [];
        for (const op of parsed) {
          if (!isRecord(op)) continue;
          if (typeof op.insert === "string") parts.push(op.insert);
          const link = isRecord(op.attributes) ? toStringOrUndefined(op.attributes.link) : undefined;
          if (link) links.push(link);
        }
        if (parts.length > 0) return { text: parts.join(""), links };
      }
    } catch {
      // fall through to plain content
    }
  }
  return { text: toStringOrUndefined(post.content) ?? "", links: [] };
}

function extractLiveActIds(links: string[]): string[] {
  const out: string[] = [];
  for (const link of links) {
    if (!link.includes(MIYOUSHE_LIVE_PAGE_PATH)) continue;
    const match = /[?&]act_id=([A-Za-z0-9_]+)/.exec(link);
    if (match?.[1] && !out.includes(match[1])) out.push(match[1]);
  }
  return out;
}

async function fetchMiyousheOfficialPosts(
  config: MiyousheGameConfig,
  env: RuntimeEnv,
  nowMs: number
): Promise<MiyoushePost[]> {
  const url = withQuery(env.MIYOUSHE_USER_POST_API_URL ?? MIYOUSHE_DEFAULT_USER_POST_API, {
    uid: config.officialUid,
    size: MIYOUSHE_USER_POST_SIZE,
  });
  const res = await fetchJson<unknown>(url, {
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: { referer: "https://www.miyoushe.com/" },
  });
  // A rejected or malformed page is a failure, not "no posts": an empty result
  // would replace the cached code events until the next refresh.
  if (
    !isRecord(res) ||
    toNumberOrNull(res.retcode) !== 0 ||
    !isRecord(res.data) ||
    !Array.isArray(res.data.list)
  ) {
    throw new Error(`Unexpected 米游社 userPost response for uid ${config.officialUid}`);
  }
  const list = res.data.list;

  const out: MiyoushePost[] = [];
  for (const item of list) {
    if (!isRecord(item) || !isRecord(item.post)) continue;
    const post = item.post;
    const postId = toStringOrUndefined(post.post_id);
    const createdAtSeconds = toNumberOrNull(post.created_at);
    if (!postId || createdAtSeconds == null) continue;
    const createdMs = createdAtSeconds * 1000;
    if (nowMs - createdMs > MAX_POST_AGE_MS) continue;

    const { text, links } = extractMiyoushePostContent(post);
    out.push({
      postId,
      subject: toStringOrUndefined(post.subject) ?? "",
      text: text.trim(),
      createdMs,
      cover: toStringOrUndefined(post.cover) || undefined,
      links,
    });
  }
  return out;
}

async function fetchMiyousheNavigatorLiveActIds(
  config: MiyousheGameConfig,
  env: RuntimeEnv
): Promise<string[]> {
  const url = withQuery(env.MIYOUSHE_HOME_API_URL ?? MIYOUSHE_DEFAULT_HOME_API, {
    gids: config.gids,
  });
  // Only the app client receives the navigator (the web variant returns []).
  const res = await fetchJson<unknown>(url, {
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: { "x-rpc-client_type": "2" },
  });
  const navigator =
    isRecord(res) && isRecord(res.data) && Array.isArray(res.data.navigator)
      ? res.data.navigator
      : [];
  const links = navigator
    .map((entry) => (isRecord(entry) ? toStringOrUndefined(entry.app_path) : undefined))
    .filter((link): link is string => Boolean(link));
  return extractLiveActIds(links);
}

async function fetchMiyoliveCodes(
  actId: string,
  config: MiyousheGameConfig,
  env: RuntimeEnv,
  nowMs: number
): Promise<MiyoliveCodes | null> {
  const headers = { "x-rpc-act_id": actId };
  const index = await fetchJson<unknown>(env.MIYOLIVE_INDEX_API_URL ?? MIYOLIVE_DEFAULT_INDEX_API, {
    timeoutMs: FETCH_TIMEOUT_MS,
    headers,
  });
  if (!isRecord(index) || toNumberOrNull(index.retcode) !== 0 || !isRecord(index.data)) return null;
  const live = isRecord(index.data.live) ? index.data.live : null;
  const streamer = isRecord(index.data.streamer) ? index.data.streamer : null;
  if (!live || toStringOrUndefined(streamer?.aid) !== config.officialUid) return null;

  const title = toStringOrUndefined(live.title) ?? "";
  const codeRes = await fetchJson<unknown>(
    withQuery(env.MIYOLIVE_CODE_API_URL ?? MIYOLIVE_DEFAULT_CODE_API, {
      version: toStringOrUndefined(live.code_ver) ?? "",
      time: Math.floor(nowMs / 1000),
    }),
    { timeoutMs: FETCH_TIMEOUT_MS, headers }
  );
  const codeList =
    isRecord(codeRes) &&
    toNumberOrNull(codeRes.retcode) === 0 &&
    isRecord(codeRes.data) &&
    Array.isArray(codeRes.data.code_list)
      ? codeRes.data.code_list
      : [];

  const codes: MiyoliveCodes["codes"] = [];
  let firstCodeMs: number | null = null;
  for (const entry of codeList) {
    if (!isRecord(entry)) continue;
    const code = toStringOrUndefined(entry.code)?.trim();
    if (!code || codes.some((existing) => existing.code === code)) continue;
    codes.push({ code, reward: stripHtml(toStringOrUndefined(entry.title) ?? "") });
    const gotAt = toNumberOrNull(entry.to_get_time);
    if (gotAt != null && gotAt > 0) {
      const gotMs = gotAt * 1000;
      firstCodeMs = firstCodeMs == null ? gotMs : Math.min(firstCodeMs, gotMs);
    }
  }
  if (codes.length === 0) return null;

  const liveStart = toStringOrUndefined(live.start)?.trim();
  const liveStartMs = liveStart ? Date.parse(toIsoWithSourceOffset(liveStart, SOURCE_TZ_OFFSET)) : Number.NaN;
  const startMs = firstCodeMs ?? (Number.isFinite(liveStartMs) ? liveStartMs : nowMs);

  return { actId, title, versionLabel: extractVersionLabel(title), startMs, codes };
}

function collectMiyousheExpiryPosts(posts: MiyoushePost[]): MiyousheExpiryPost[] {
  return posts
    .filter((post) => {
      const haystack = `${post.subject}\n${post.text}`;
      return (
        haystack.includes(LIVESTREAM_KEYWORD) &&
        post.text.includes(CODE_KEYWORD) &&
        !post.subject.includes(PREVIEW_ANNOUNCEMENT_KEYWORD)
      );
    })
    .map((post) => ({
      ...post,
      versionLabel: extractVersionLabel(post.subject) ?? extractVersionLabel(post.text),
      codes: extractRedeemCodes(post.text),
      expiry: extractRedeemCodeExpiry(post.text, {
        fallbackYear: sourceYearFromMs(post.createdMs),
        notBeforeMs: post.createdMs,
      }),
    }))
    .filter((post) => post.codes.length > 0 || post.expiry.iso != null)
    .sort((a, b) => a.createdMs - b.createdMs);
}

function pickExpiryPostForLive(
  live: MiyoliveCodes,
  posts: MiyousheExpiryPost[]
): MiyousheExpiryPost | undefined {
  // Several follow-up posts repeat the expiry; prefer the richest one (codes in
  // text, then a cover image, then the most recent) as the linked article.
  const score = (post: MiyousheExpiryPost): number =>
    (post.codes.length > 0 ? 2 : 0) + (post.cover ? 1 : 0);
  const pickBest = (candidates: MiyousheExpiryPost[]): MiyousheExpiryPost | undefined =>
    [...candidates].sort((a, b) => score(b) - score(a) || b.createdMs - a.createdMs)[0];

  const withExpiry = posts.filter((post) => post.expiry.iso != null);
  if (live.versionLabel) {
    const sameVersion = pickBest(withExpiry.filter((post) => post.versionLabel === live.versionLabel));
    if (sameVersion) return sameVersion;
  }
  return pickBest(
    withExpiry.filter(
      (post) =>
        post.versionLabel == null &&
        post.createdMs >= live.startMs &&
        post.createdMs - live.startMs <= MIYOUSHE_POST_MATCH_WINDOW_MS
    )
  );
}

async function fetchMiyousheLivestreamCodeEvents(
  config: MiyousheGameConfig,
  env: RuntimeEnv,
  nowMs: number
): Promise<CalendarEvent[]> {
  const [posts, navigatorActIds] = await Promise.all([
    fetchMiyousheOfficialPosts(config, env, nowMs),
    fetchMiyousheNavigatorLiveActIds(config, env).catch(() => []),
  ]);
  const postActIds = posts
    .filter((post) => `${post.subject}\n${post.text}`.includes(LIVESTREAM_KEYWORD))
    .flatMap((post) => extractLiveActIds(post.links));
  const actIds = [...new Set([...navigatorActIds, ...postActIds])].slice(0, MIYOLIVE_MAX_ACTS);

  // An ended or foreign stream answers normally and yields null. A transport
  // failure is reported after the post fallback below has run, so the caller
  // can prefer previously fetched codes over the post-only result.
  let livestreamApiFailed = false;
  const lives = (
    await Promise.all(
      actIds.map((actId) =>
        fetchMiyoliveCodes(actId, config, env, nowMs).catch((err: unknown) => {
          if (isTransientFetchFailure(err)) livestreamApiFailed = true;
          return null;
        })
      )
    )
  ).filter((live): live is MiyoliveCodes => live != null);

  const expiryPosts = collectMiyousheExpiryPosts(posts);
  const articleUrl = (postId: string): string =>
    `${MIYOUSHE_ARTICLE_URL}${config.articlePath}/article/${postId}`;
  const events: CalendarEvent[] = [];
  const usedVersions = new Set<string>();

  for (const live of lives) {
    const post = pickExpiryPostForLive(live, expiryPosts);
    const versionLabel = live.versionLabel ?? post?.versionLabel ?? null;
    const rewardLines = live.codes.map(({ code, reward }) => (reward ? `${code}：${reward}` : code));
    const text = [rewardLines.join("\n"), post?.text ?? ""].filter(Boolean).join("\n\n");
    events.push(
      buildLivestreamCodeEvent({
        game: config.game,
        sourceId: live.actId,
        versionLabel,
        codes: live.codes.map(({ code }) => code),
        startMs: live.startMs,
        expiry: post?.expiry ?? { iso: null, text: null },
        text,
        linkUrl: post ? articleUrl(post.postId) : withQuery(MIYOUSHE_LIVE_PAGE_URL, { act_id: live.actId }),
        banner: post?.cover,
      })
    );
    if (versionLabel) usedVersions.add(versionLabel);
  }

  // Posts not covered by a livestream: Star Rail lists the codes in text, and
  // every game states the expiry, which still makes a useful reminder.
  for (const post of expiryPosts) {
    const versionKey = post.versionLabel ?? `post:${post.postId}`;
    if (usedVersions.has(versionKey)) continue;
    const better = expiryPosts.find(
      (other) =>
        other !== post &&
        (other.versionLabel ?? `post:${other.postId}`) === versionKey &&
        other.codes.length > post.codes.length
    );
    if (better) continue;
    usedVersions.add(versionKey);
    events.push(
      buildLivestreamCodeEvent({
        game: config.game,
        sourceId: post.postId,
        versionLabel: post.versionLabel,
        codes: post.codes,
        startMs: post.createdMs,
        expiry: post.expiry,
        text: post.text,
        linkUrl: articleUrl(post.postId),
        banner: post.cover,
      })
    );
  }

  if (livestreamApiFailed) throw new DegradedLivestreamCodesError(events);
  return events;
}

export async function fetchMiyousheLivestreamCodeEventsForGame(
  game: GameId,
  env: RuntimeEnv = {},
  nowMs: number = Date.now()
): Promise<CalendarEvent[]> {
  const config = MIYOUSHE_GAMES[game];
  if (!config) return [];
  return await fetchMiyousheLivestreamCodeEvents(config, env, nowMs);
}

// ---------------------------------------------------------------------------
// Wuthering Waves (库街区)
// ---------------------------------------------------------------------------

async function fetchKurobbsJson(
  url: string,
  form: Record<string, string | number>
): Promise<unknown> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) body.set(key, String(value));
  return await fetchJson<unknown>(url, {
    method: "POST",
    headers: WW_KUROBBS_HEADERS,
    body: body.toString(),
    timeoutMs: FETCH_TIMEOUT_MS,
  });
}

function joinKurobbsContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => (isRecord(block) ? toStringOrUndefined(block.content)?.trim() ?? "" : ""))
    .filter(Boolean)
    .join("\n");
}

// `createTimestamp` is when the post was drafted/scheduled; `postTime`
// ("YYYY-MM-DD HH:mm", UTC+8) is when it was actually published.
function kurobbsPostTimeToMs(value: unknown): number | null {
  const text = toStringOrUndefined(value)?.trim();
  if (!text || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(text)) return null;
  const ms = Date.parse(toIsoWithSourceOffset(text, SOURCE_TZ_OFFSET));
  return Number.isFinite(ms) ? ms : null;
}

// Search results wrap keyword hits in <em>…</em>.
function stripKurobbsHighlight(input: string): string {
  return input.replace(/<\/?em>/g, "");
}

function isKurobbsOfficialUser(value: unknown): boolean {
  return toStringOrUndefined(value) === WW_KUROBBS_OFFICIAL_USER_ID;
}

type WwCodePostCandidate = {
  postId: string;
  title: string;
  createMs: number;
};

export async function fetchWwLivestreamCodeEvents(
  env: RuntimeEnv = {},
  nowMs: number = Date.now()
): Promise<CalendarEvent[]> {
  const searchUrl = env.WW_KUROBBS_SEARCH_API_URL ?? WW_DEFAULT_SEARCH_API;
  const detailUrl = env.WW_KUROBBS_POST_DETAIL_API_URL ?? WW_DEFAULT_POST_DETAIL_API;

  const pageResults = await Promise.allSettled(
    Array.from({ length: WW_KUROBBS_SEARCH_PAGES }, (_, i) =>
      fetchKurobbsJson(searchUrl, {
        keyword: WW_KUROBBS_SEARCH_KEYWORD,
        gameId: WW_KUROBBS_GAME_ID,
        pageIndex: i + 1,
        pageSize: WW_KUROBBS_SEARCH_PAGE_SIZE,
      })
    )
  );
  const postLists = pageResults.map((result) =>
    result.status === "fulfilled" &&
    isRecord(result.value) &&
    isRecord(result.value.data) &&
    Array.isArray(result.value.data.postList)
      ? result.value.data.postList
      : null
  );
  if (postLists.every((posts) => posts == null)) {
    const rejected = pageResults.find((result) => result.status === "rejected");
    throw rejected ? rejected.reason : new Error("Unexpected 库街区 search response");
  }

  const candidates = new Map<string, WwCodePostCandidate>();
  for (const posts of postLists) {
    for (const post of posts ?? []) {
      if (!isRecord(post) || !isKurobbsOfficialUser(post.userId)) continue;
      const postId = toStringOrUndefined(post.postId);
      const title = stripKurobbsHighlight(toStringOrUndefined(post.postTitle) ?? "");
      const createMs = toNumberOrNull(post.createTimestamp);
      if (!postId || createMs == null || !title.includes(LIVESTREAM_KEYWORD)) continue;
      if (nowMs - createMs > MAX_POST_AGE_MS) continue;
      candidates.set(postId, { postId, title, createMs });
    }
  }

  const ordered = [...candidates.values()]
    .sort((a, b) => b.createMs - a.createMs)
    .slice(0, WW_MAX_DETAIL_REQUESTS);
  const details = await Promise.all(
    ordered.map((candidate) =>
      fetchKurobbsJson(detailUrl, {
        postId: candidate.postId,
        showOrderType: 2,
        isOnlyPublisher: 1,
        pageIndex: 1,
        pageSize: 20,
      })
    )
  );

  const out: CalendarEvent[] = [];
  ordered.forEach((candidate, index) => {
    const detail = details[index];
    const data = isRecord(detail) && isRecord(detail.data) ? detail.data : null;
    if (!data) return;

    const postDetail = isRecord(data.postDetail) ? data.postDetail : null;
    const title = toStringOrUndefined(postDetail?.postTitle) ?? candidate.title;
    const startMs =
      kurobbsPostTimeToMs(postDetail?.postTime) ??
      toNumberOrNull(postDetail?.createTimestamp) ??
      candidate.createMs;
    const coverImages = Array.isArray(postDetail?.coverImages) ? postDetail.coverImages : [];
    const banner = isRecord(coverImages[0]) ? toStringOrUndefined(coverImages[0].url) : undefined;

    const publisherComments = (Array.isArray(data.comment) ? data.comment : [])
      .filter(
        (comment): comment is JsonObject =>
          isRecord(comment) &&
          (toNumberOrNull(comment.isPublisher) === 1 || isKurobbsOfficialUser(comment.userId))
      )
      .map((comment) => joinKurobbsContent(comment.commentContent));

    const texts = [joinKurobbsContent(postDetail?.postContent), ...publisherComments].filter(
      (text) => text.includes(CODE_KEYWORD)
    );
    for (const text of texts) {
      const codes = extractRedeemCodes(text);
      if (codes.length === 0) continue;
      out.push(
        buildLivestreamCodeEvent({
          game: "ww",
          sourceId: candidate.postId,
          versionLabel: extractVersionLabel(title) ?? extractVersionLabel(text),
          codes,
          startMs,
          expiry: extractRedeemCodeExpiry(text, {
            fallbackYear: sourceYearFromMs(startMs),
            notBeforeMs: startMs,
          }),
          text,
          linkUrl: `${WW_KUROBBS_POST_URL}${candidate.postId}`,
          banner: banner || undefined,
        })
      );
      break;
    }
  });

  return dedupeByCodes(out);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function isLivestreamCodesDisabled(env: RuntimeEnv): boolean {
  const value = env.LIVESTREAM_CODES_DISABLED?.trim().toLowerCase();
  return value === "1" || value === "true";
}

async function fetchLivestreamCodeEventsUnguarded(
  game: GameId,
  env: RuntimeEnv
): Promise<CalendarEvent[]> {
  switch (game) {
    case "genshin":
    case "starrail":
    case "zzz":
      return await fetchMiyousheLivestreamCodeEventsForGame(game, env);
    case "ww":
      return await fetchWwLivestreamCodeEvents(env);
    default:
      return [];
  }
}

/**
 * Best-effort: code events are an add-on to the regular notice feed, so an
 * upstream failure never fails the game. It keeps the code events from
 * `previousEvents` (the caller's last cached snapshot) instead, because the
 * result is cached for a full TTL and codes only stay valid for a few days.
 */
export async function fetchLivestreamCodeEvents(
  game: GameId,
  env: RuntimeEnv = {},
  previousEvents: readonly CalendarEvent[] = []
): Promise<CalendarEvent[]> {
  if (isLivestreamCodesDisabled(env)) return [];

  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("livestream code fetch exceeded its budget")),
      LIVESTREAM_FETCH_BUDGET_MS
    );
  });
  try {
    return await Promise.race([fetchLivestreamCodeEventsUnguarded(game, env), deadline]);
  } catch (err) {
    const previousCodeEvents = previousEvents.filter(isLivestreamCodeEvent);
    if (!(err instanceof DegradedLivestreamCodesError)) return previousCodeEvents;
    // Keep the codes fetched before; add only versions they do not cover yet.
    const covered = new Set(previousCodeEvents.map((event) => event.title));
    return [...previousCodeEvents, ...err.events.filter((event) => !covered.has(event.title))];
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}
