import { fetchJson } from "../lib/fetch.js";
import { toIsoWithSourceOffset, unixSecondsToIsoWithSourceOffset } from "../lib/time.js";
import type { RuntimeEnv } from "../lib/runtimeEnv.js";
import type { CalendarEvent, GameVersionInfo } from "../types.js";
import { classifyGachaEvent, isGachaEventTitle } from "./gacha.js";

type MihoyoAnnItem = {
  ann_id: number;
  title: string;
  subtitle?: string;
  banner?: string;
  content?: string;
  start_time?: string;
  end_time?: string;
};

type MihoyoAnnCategory = {
  type_id: number;
  type_label: string;
  list: MihoyoAnnItem[];
};

type MihoyoAnnListResponse = {
  retcode: number;
  message: string;
  data?: {
    list?: MihoyoAnnCategory[];
  };
};

type MihoyoAnnContentItem = {
  ann_id: number;
  title: string;
  subtitle?: string;
  banner?: string;
  content?: string;
  lang?: string;
  remind_text?: string;
};

type MihoyoAnnContentResponse = {
  retcode: number;
  message: string;
  data?: {
    list?: MihoyoAnnContentItem[];
  };
};

const GENSHIN_DEFAULT_LIST_API =
  "https://hk4e-api.mihoyo.com/common/hk4e_cn/announcement/api/getAnnList?game=hk4e&game_biz=hk4e_cn&lang=zh-cn&bundle_id=hk4e_cn&platform=pc&region=cn_gf01&level=55&uid=100000000";

const GENSHIN_DEFAULT_CONTENT_API =
  "https://hk4e-api.mihoyo.com/common/hk4e_cn/announcement/api/getAnnContent?game=hk4e&game_biz=hk4e_cn&lang=zh-cn&bundle_id=hk4e_cn&platform=pc&region=cn_gf01&level=55&uid=100000000";
const GENSHIN_SOURCE_TZ_OFFSET = "+08:00";
const VERSION_UPDATE_NOTICE_KEYWORD = "版本更新说明";
const GENSHIN_DATE_TIME_PATTERN =
  String.raw`\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}\s*\d{1,2}:\d{2}(?::\d{2})?`;
const RANGE_SEPARATOR_PATTERN = String.raw`(?:-|~|～|至|到|—|–|\u2013|\u2014)`;
const GENSHIN_MOON_VERSION_LABELS = [
  "「月之一」",
  "「月之二」",
  "「月之三」",
  "「月之四」",
  "「月之五」",
  "「月之六」",
];

// Keep this conservative: filter obvious non-event notices.
const IGNORE_ANN_IDS = new Set<number>([
  495, 1263, 423, 422, 762, 20835,
]);

const IGNORE_WORDS = [
  "修复",
  "内容专题页",
  "米游社",
  "调研",
  "防沉迷",
  "问卷",
  "公平运营",
  "有奖活动",
  "反馈功能",
];

const IGNORE_TITLE_PATTERNS = [
  /礼包.*(?:限时)?上架/,
  /(?:限时)?上架.*礼包/,
  /「.*纪行」活动说明/,
];

function shouldIgnoreGenshinTitle(title: string): boolean {
  if (IGNORE_WORDS.some((w) => title.includes(w))) return true;
  if (IGNORE_TITLE_PATTERNS.some((pattern) => pattern.test(title))) return true;
  return false;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripHtml(input: string | undefined): string {
  return decodeHtmlEntities(input ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h\d|li|tr)>/gi, "\n")
    .replace(/<(p|div|h\d|li|tr)[^>]*>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function normalizeDateTimeCandidate(input: string | undefined): string | null {
  const source = (input ?? "").replace(/\s+/g, "").trim();
  if (!source) return null;

  const m =
    /^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(
      source
    );
  if (!m) return null;

  const yyyy = m[1]!;
  const mo = String(Number(m[2]!)).padStart(2, "0");
  const dd = String(Number(m[3]!)).padStart(2, "0");
  const hh = String(Number(m[4]!)).padStart(2, "0");
  const mi = m[5]!;
  const ss = m[6] ? m[6] : "00";
  return `${yyyy}-${mo}-${dd} ${hh}:${mi}:${ss}`;
}

function toGenshinSourceIso(input: string | undefined): string | null {
  const normalized = normalizeDateTimeCandidate(input);
  return normalized ? toIsoWithSourceOffset(normalized, GENSHIN_SOURCE_TZ_OFFSET) : null;
}

function addHoursToSourceIso(input: string, hours: number): string | null {
  const startMs = Date.parse(input);
  if (!Number.isFinite(startMs) || !Number.isFinite(hours) || hours <= 0 || hours > 24) return null;

  return unixSecondsToIsoWithSourceOffset(
    Math.round((startMs + hours * 60 * 60 * 1000) / 1000),
    GENSHIN_SOURCE_TZ_OFFSET
  );
}

function addDaysToSourceIso(input: string, days: number): string | null {
  const startMs = Date.parse(input);
  if (!Number.isFinite(startMs) || !Number.isFinite(days)) return null;

  return unixSecondsToIsoWithSourceOffset(
    Math.round((startMs + days * 24 * 60 * 60 * 1000) / 1000),
    GENSHIN_SOURCE_TZ_OFFSET
  );
}

function sameSourceMinute(a: string, b: string): boolean {
  return a.slice(0, 16) === b.slice(0, 16);
}

function preserveStructuredEndSeconds(parsedEndIso: string, listEndIso: string): string {
  if (!sameSourceMinute(parsedEndIso, listEndIso)) return parsedEndIso;

  const parsedMs = Date.parse(parsedEndIso);
  const listMs = Date.parse(listEndIso);
  if (!Number.isFinite(parsedMs) || !Number.isFinite(listMs)) return parsedEndIso;
  return listMs >= parsedMs && listMs - parsedMs < 60_000 ? listEndIso : parsedEndIso;
}

function collectDateTimeCandidates(input: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(`(${GENSHIN_DATE_TIME_PATTERN})`, "g");
  for (const match of input.matchAll(re)) {
    const normalized = normalizeDateTimeCandidate(match[1]);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function extractWishTimeSection(content: string | undefined): string | null {
  const text = stripHtml(content);
  const startIdx = text.indexOf("祈愿时间");
  if (startIdx < 0) return null;

  const section = text.slice(startIdx);
  const endMarkers = ["●活动期间", "※", "〓活动说明〓", "〓祈愿说明〓"];
  const markerIdx = endMarkers
    .map((marker) => section.indexOf(marker))
    .filter((idx) => idx > "祈愿时间".length)
    .sort((a, b) => a - b)[0];

  return section.slice(0, markerIdx ?? 1_000);
}

function isGenshinTimeLabelLine(line: string, label: string): boolean {
  const normalized = line.replace(/\s+/g, "").trim();
  return (
    normalized === label ||
    normalized === `〓${label}〓` ||
    normalized.startsWith(`${label}：`) ||
    normalized.startsWith(`${label}:`)
  );
}

function extractLabeledSection(
  content: string | undefined,
  labels: string[]
): string | null {
  const text = stripHtml(content);
  const lines = text.split("\n");

  for (const label of labels) {
    const startIdx = lines.findIndex((line) => isGenshinTimeLabelLine(line, label));
    if (startIdx < 0) continue;

    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i += 1) {
      if (/^〓.+〓$/.test(lines[i]!)) {
        endIdx = i;
        break;
      }
    }

    return lines.slice(startIdx, endIdx).join("\n");
  }

  return null;
}

function extractRelativeVersionLabel(input: string): string | null {
  const quoted = /([「“"][^」”"]+[」”"])\s*版本(?:更新后|开启后|期间)/.exec(input);
  if (quoted?.[1]) {
    return quoted[1]
      .replace(/^“/, "「")
      .replace(/”$/, "」")
      .replace(/^"/, "「")
      .replace(/"$/, "」");
  }

  const loose = /([^\s，。,；;：:~～\-—–\u2013\u2014]{1,24})\s*版本(?:更新后|开启后|期间)/.exec(input);
  return loose?.[1] ?? null;
}

function resolveRelativeVersionStartIso(
  input: string,
  opts: {
    versionMaintenanceEndByLabel: Map<string, string>;
    singleVersionMaintenanceEndIso: string | null;
  }
): string | null {
  const relativeVersionLabel = extractRelativeVersionLabel(input);
  if (relativeVersionLabel) {
    return opts.versionMaintenanceEndByLabel.get(relativeVersionLabel) ?? null;
  }

  return /版本(?:更新后|开启后|期间)/.test(input)
    ? opts.singleVersionMaintenanceEndIso
    : null;
}

function extractMaintenanceEndIsoFromVersionContent(content: string | undefined): string | null {
  const text = stripHtml(content);
  if (!text) return null;

  const rangeRe = new RegExp(
    `(?:更新时间|更新维护时间|维护时间)[^\\d]{0,80}(${GENSHIN_DATE_TIME_PATTERN})\\s*${RANGE_SEPARATOR_PATTERN}\\s*(${GENSHIN_DATE_TIME_PATTERN})`
  );
  const range = rangeRe.exec(text);
  const rangeEndIso = toGenshinSourceIso(range?.[2]);
  if (rangeEndIso) return rangeEndIso;

  const startRe = new RegExp(
    `(?:更新时间|更新维护时间|维护时间)[^\\d]{0,80}(${GENSHIN_DATE_TIME_PATTERN})\\s*开始`
  );
  const start = startRe.exec(text);
  if (!start?.[1]) return null;

  const duration = /预计\s*([0-9]+(?:\.[0-9]+)?)\s*(?:个)?\s*小时\s*(?:完成|结束)?/.exec(
    text.slice(start.index)
  );
  const durationHours = Number(duration?.[1]);
  const startIso = toGenshinSourceIso(start[1]);
  return startIso ? addHoursToSourceIso(startIso, durationHours) : null;
}

function addInferredMoonVersionMaintenanceEnds(map: Map<string, string>): void {
  for (const [label, maintenanceEndIso] of [...map.entries()]) {
    const sourceIdx = GENSHIN_MOON_VERSION_LABELS.indexOf(label);
    if (sourceIdx < 0) continue;

    for (let targetIdx = 0; targetIdx < GENSHIN_MOON_VERSION_LABELS.length; targetIdx += 1) {
      const targetLabel = GENSHIN_MOON_VERSION_LABELS[targetIdx]!;
      if (map.has(targetLabel)) continue;

      const inferred = addDaysToSourceIso(maintenanceEndIso, (targetIdx - sourceIdx) * 42);
      if (inferred) {
        map.set(targetLabel, inferred);
      }
    }
  }
}

function extractGenshinGachaTimeRangeFromContent(
  content: string | undefined,
  opts: {
    versionMaintenanceEndByLabel: Map<string, string>;
    singleVersionMaintenanceEndIso: string | null;
    listEndIso: string;
  }
): { startIso: string | null; endIso: string | null } {
  const section = extractWishTimeSection(content);
  if (!section) return { startIso: null, endIso: null };

  const rangeRe = new RegExp(
    `(${GENSHIN_DATE_TIME_PATTERN})\\s*${RANGE_SEPARATOR_PATTERN}\\s*(${GENSHIN_DATE_TIME_PATTERN})`
  );
  const range = rangeRe.exec(section);
  if (range) {
    const startIso = toGenshinSourceIso(range[1]);
    const rawEndIso = toGenshinSourceIso(range[2]);
    return {
      startIso,
      endIso: rawEndIso ? preserveStructuredEndSeconds(rawEndIso, opts.listEndIso) : null,
    };
  }

  const dates = collectDateTimeCandidates(section);
  const relativeStartIso = resolveRelativeVersionStartIso(section, opts);

  if (/版本(?:更新后|开启后)/.test(section) && dates.length > 0) {
    if (!relativeStartIso) return { startIso: null, endIso: null };

    const rawEndIso = toIsoWithSourceOffset(dates[0]!, GENSHIN_SOURCE_TZ_OFFSET);
    return {
      startIso: relativeStartIso,
      endIso: preserveStructuredEndSeconds(rawEndIso, opts.listEndIso),
    };
  }

  if (/版本(?:更新后|开启后|期间)/.test(section) && dates.length === 0) {
    return {
      startIso: relativeStartIso,
      endIso: relativeStartIso ? opts.listEndIso : null,
    };
  }

  if (dates.length >= 2) {
    const rawEndIso = toIsoWithSourceOffset(dates[1]!, GENSHIN_SOURCE_TZ_OFFSET);
    return {
      startIso: toIsoWithSourceOffset(dates[0]!, GENSHIN_SOURCE_TZ_OFFSET),
      endIso: preserveStructuredEndSeconds(rawEndIso, opts.listEndIso),
    };
  }

  return { startIso: null, endIso: null };
}

function extractGenshinActivityTimeRangeFromContent(
  content: string | undefined,
  opts: {
    versionMaintenanceEndByLabel: Map<string, string>;
    singleVersionMaintenanceEndIso: string | null;
    listEndIso: string;
  }
): { startIso: string | null; endIso: string | null } {
  const section = extractLabeledSection(content, [
    "获取奖励时限",
    "整体活动时间",
    "活动时间",
    "开放时间",
    "开启时间",
    "领取时间",
  ]);
  if (!section) return { startIso: null, endIso: null };

  const dates = collectDateTimeCandidates(section);
  const relativeStartIso = resolveRelativeVersionStartIso(section, opts);

  if (/版本(?:更新后|开启后|期间)/.test(section) && dates.length > 0) {
    if (!relativeStartIso) return { startIso: null, endIso: null };

    const rawEndIso = toIsoWithSourceOffset(dates[0]!, GENSHIN_SOURCE_TZ_OFFSET);
    return {
      startIso: relativeStartIso,
      endIso: preserveStructuredEndSeconds(rawEndIso, opts.listEndIso),
    };
  }

  if (/版本(?:更新后|开启后|期间)/.test(section) && dates.length === 0) {
    return {
      startIso: relativeStartIso,
      endIso: relativeStartIso ? opts.listEndIso : null,
    };
  }

  if (dates.length >= 2) {
    const rawEndIso = toIsoWithSourceOffset(dates[1]!, GENSHIN_SOURCE_TZ_OFFSET);
    return {
      startIso: toIsoWithSourceOffset(dates[0]!, GENSHIN_SOURCE_TZ_OFFSET),
      endIso: preserveStructuredEndSeconds(rawEndIso, opts.listEndIso),
    };
  }

  return { startIso: null, endIso: null };
}

function isCompleteTimeRange(range: { startIso: string | null; endIso: string | null }): boolean {
  return Boolean(range.startIso && range.endIso);
}

type GenshinVersionNotice = {
  item: MihoyoAnnItem;
  startIso: string;
  endIso: string;
  startMs: number;
  endMs: number;
};

function pickCurrentVersionNotice(items: MihoyoAnnItem[]): GenshinVersionNotice | null {
  const candidates = items
    .filter((item) => {
      const title = item.title ?? "";
      const subtitle = item.subtitle ?? "";
      return title.includes(VERSION_UPDATE_NOTICE_KEYWORD) || subtitle.includes(VERSION_UPDATE_NOTICE_KEYWORD);
    })
    .map((item) => {
      if (!item.start_time || !item.end_time) return null;
      const startIso = toIsoWithSourceOffset(item.start_time, GENSHIN_SOURCE_TZ_OFFSET);
      const endIso = toIsoWithSourceOffset(item.end_time, GENSHIN_SOURCE_TZ_OFFSET);
      const startMs = Date.parse(startIso);
      const endMs = Date.parse(endIso);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
      return { item, startIso, endIso, startMs, endMs };
    })
    .filter((x): x is GenshinVersionNotice => x != null);

  if (candidates.length === 0) return null;

  const nowMs = Date.now();
  const active = candidates
    .filter((x) => x.startMs <= nowMs && nowMs < x.endMs)
    .sort((a, b) => b.startMs - a.startMs);
  if (active.length > 0) return active[0]!;

  const upcoming = candidates
    .filter((x) => x.startMs > nowMs)
    .sort((a, b) => a.startMs - b.startMs);
  if (upcoming.length > 0) return upcoming[0]!;

  const recentPast = candidates.sort((a, b) => b.endMs - a.endMs);
  return recentPast[0] ?? null;
}

function extractVersionLabelFromText(text: string): string | null {
  const raw = text.trim();
  if (!raw) return null;

  const quoted = /[「“"]([^「」”"]+)[」”"]\s*(?:版本)?(?:更新说明|更新公告)/.exec(raw);
  if (quoted?.[1]) return `「${quoted[1].trim()}」`;

  const numeric = /(\d+(?:\.\d+)+)\s*版本(?:更新说明)?/.exec(raw);
  if (numeric?.[1]) return numeric[1];

  const loose = /([^\s，。,；;：:]{1,24})\s*版本(?:更新说明)?/.exec(raw);
  if (loose?.[1]) return loose[1];

  return null;
}

function extractVersionLabel(item: MihoyoAnnItem): string | null {
  const fromTitle = extractVersionLabelFromText(item.title ?? "");
  if (fromTitle) return fromTitle;

  const fromSubtitle = extractVersionLabelFromText(item.subtitle ?? "");
  if (fromSubtitle) return fromSubtitle;

  const subtitleText = (item.subtitle ?? "")
    .replace(VERSION_UPDATE_NOTICE_KEYWORD, "")
    .trim();
  if (subtitleText) return subtitleText;

  return null;
}

async function fetchGenshinAnnouncementCategories(env: RuntimeEnv): Promise<MihoyoAnnCategory[]> {
  const listApiUrl = env.GENSHIN_API_URL ?? GENSHIN_DEFAULT_LIST_API;
  const listRes = await fetchJson<MihoyoAnnListResponse>(listApiUrl, {
    timeoutMs: 12_000,
  });
  return listRes.data?.list ?? [];
}

export async function fetchGenshinEvents(env: RuntimeEnv = {}): Promise<CalendarEvent[]> {
  const contentApiUrl =
    env.GENSHIN_CONTENT_API_URL ?? GENSHIN_DEFAULT_CONTENT_API;

  const categories = await fetchGenshinAnnouncementCategories(env);
  const eventCategory = categories.find((c) => c.type_id === 1); // 活动公告
  const list = eventCategory?.list ?? [];

  const filtered = list
    .filter((item) => item.start_time && item.end_time)
    .filter((item) => {
      const title = item.title ?? "";
      if (isGachaEventTitle("genshin", title)) return true;
      if (IGNORE_ANN_IDS.has(item.ann_id)) return false;
      return !shouldIgnoreGenshinTitle(title);
    });

  // getAnnContent includes the full (HTML) announcement body but does not include
  // reliable structured start/end fields, so we merge it with getAnnList by ann_id.
  const contentById = new Map<number, MihoyoAnnContentItem>();
  try {
    const contentRes = await fetchJson<MihoyoAnnContentResponse>(contentApiUrl, {
      timeoutMs: 12_000,
    });
    const contentList = contentRes.data?.list ?? [];
    for (const it of contentList) {
      if (typeof it?.ann_id === "number") {
        contentById.set(it.ann_id, it);
      }
    }
  } catch {
    // If content fetch fails, still return the event list based on getAnnList.
  }

  const noticeCategory =
    categories.find((c) => c.type_id === 2) ??
    categories.find((c) => c.type_label.includes("游戏公告"));
  const versionMaintenanceEndByLabel = new Map<string, string>();
  for (const noticeItem of noticeCategory?.list ?? []) {
    const noticeTitle = noticeItem.title ?? "";
    const noticeSubtitle = noticeItem.subtitle ?? "";
    if (
      !noticeTitle.includes(VERSION_UPDATE_NOTICE_KEYWORD) &&
      !noticeSubtitle.includes(VERSION_UPDATE_NOTICE_KEYWORD)
    ) {
      continue;
    }

    const versionLabel = extractVersionLabel(noticeItem);
    if (!versionLabel) continue;

    const noticeContent = contentById.get(noticeItem.ann_id)?.content ?? noticeItem.content;
    const maintenanceEndIso = extractMaintenanceEndIsoFromVersionContent(noticeContent);
    if (maintenanceEndIso) {
      versionMaintenanceEndByLabel.set(versionLabel, maintenanceEndIso);
    }
  }
  const concreteVersionMaintenanceEnds = [...new Set(versionMaintenanceEndByLabel.values())];
  const singleVersionMaintenanceEndIso =
    concreteVersionMaintenanceEnds.length === 1 ? concreteVersionMaintenanceEnds[0]! : null;
  addInferredMoonVersionMaintenanceEnds(versionMaintenanceEndByLabel);

  return filtered.map((item) => {
    const contentItem = contentById.get(item.ann_id);
    const title = item.title ?? "";
    const content = contentItem?.content ?? item.content;
    const gachaKind = classifyGachaEvent("genshin", title, content);
    const isGacha = isGachaEventTitle("genshin", title) || gachaKind !== "other";
    const listStartIso = toIsoWithSourceOffset(item.start_time!, GENSHIN_SOURCE_TZ_OFFSET);
    const listEndIso = toIsoWithSourceOffset(item.end_time!, GENSHIN_SOURCE_TZ_OFFSET);
    const gachaContentRange = isGacha
      ? extractGenshinGachaTimeRangeFromContent(content, {
          versionMaintenanceEndByLabel,
          singleVersionMaintenanceEndIso,
          listEndIso,
        })
      : null;
    const contentRange = gachaContentRange && isCompleteTimeRange(gachaContentRange)
      ? gachaContentRange
      : extractGenshinActivityTimeRangeFromContent(content, {
          versionMaintenanceEndByLabel,
          singleVersionMaintenanceEndIso,
          listEndIso,
        });
    const resolvedStartIso = contentRange.startIso ?? listStartIso;
    const resolvedEndIso = contentRange.endIso ?? listEndIso;
    const sMs = Date.parse(resolvedStartIso);
    const eMs = Date.parse(resolvedEndIso);
    const hasValidContentRange = Number.isFinite(sMs) && Number.isFinite(eMs) && eMs > sMs;

    return {
      id: item.ann_id,
      title,
      start_time: hasValidContentRange ? resolvedStartIso : listStartIso,
      end_time: hasValidContentRange ? resolvedEndIso : listEndIso,
      is_gacha: isGacha,
      gacha_kind: isGacha ? gachaKind : undefined,
      banner: item.banner ?? contentItem?.banner,
      content,
    };
  });
}

export async function fetchGenshinCurrentVersion(env: RuntimeEnv = {}): Promise<GameVersionInfo | null> {
  const categories = await fetchGenshinAnnouncementCategories(env);
  const noticeCategory =
    categories.find((c) => c.type_id === 2) ??
    categories.find((c) => c.type_label.includes("游戏公告"));
  const notice = pickCurrentVersionNotice(noticeCategory?.list ?? []);
  if (!notice) return null;

  const version = extractVersionLabel(notice.item);
  if (!version) return null;

  return {
    game: "genshin",
    version,
    start_time: notice.startIso,
    end_time: notice.endIso,
    ann_id: notice.item.ann_id,
    title: notice.item.title,
  };
}
