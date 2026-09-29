import clsx from "clsx";
import DOMPurify from "dompurify";
import dayjs, { type Dayjs } from "dayjs";
import isoWeek from "dayjs/plugin/isoWeek";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { CalendarEvent, GachaKind, GameId, GameVersionInfo } from "../../api/types";
import { useTheme } from "../../context/theme";
import type { UseCurrentVersionState } from "../../hooks/useCurrentVersion";
import { type RecurringActivity, type RecurringRule, usePrefs } from "../../context/prefs";
import { looksLikeHtml, normalizeAnnouncementHtml, preprocessAnnContent } from "../../lib/announcement";
import { clamp } from "../../lib/color";
import { validateCronExpression } from "../../lib/cron";
import { normalizeEventTitle } from "../../lib/events";
import {
  extractGachaFeatured,
  formatGachaFeaturedTitle,
  type GachaFeatured,
  isCharacterTrialGachaKind,
  resolveGachaClassification,
} from "../../lib/gacha";
import { ALL_GAME_IDS, GAME_META, GAME_REGISTRY_BY_ID, gameColorVar, gameInkVar } from "../../lib/games";
import {
  WEEKDAY_NAMES,
  computeRecurringWindow,
  formatCronHumanReadable,
  formatRecurringRule,
  getDailyResetOffsetMinutes,
  getMonthlyCardEndTime,
  getMonthlyCardRemainingDays,
  getRecurringTzOffsetMinutes,
} from "../../lib/recurring";
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  formatFixedUtcOffset,
  formatLocalUtcOffsetLabel,
  pad2,
  parseDateTime,
  toIsoWithOffset,
} from "../../lib/time";

dayjs.extend(isoWeek);

const HOME_TIMELINE_PAST_DAYS = 1;
const HOME_TIMELINE_FUTURE_DAYS = 7;
const RELATIVE_END_LAYOUT_YEARS = 100;

export type TimelineCalendarEvent = CalendarEvent & { gameId?: GameId };
type TimelineCalendarProps =
  | {
      mode?: "game";
      events: TimelineCalendarEvent[];
      gameId: GameId;
      currentVersionState: UseCurrentVersionState;
      currentVersions?: never;
    }
  | {
      mode: "home";
      events: TimelineCalendarEvent[];
      currentVersions?: GameVersionInfo[];
      gameId?: never;
      currentVersionState?: never;
    };
type ParsedEvent = CalendarEvent & {
  _s: Dayjs;
  _e: Dayjs;
  _hasRelativeEnd: boolean;
  sourceGameId: GameId;
  eventKey: string;
};
type ParsedUpstreamEvent = ParsedEvent & {
  kind: "upstream";
  is_gacha: boolean;
  gacha_kind: GachaKind;
  // Featured characters / weapons pulled from the banner text, and the short label built from them.
  gacha_featured: GachaFeatured | undefined;
  gacha_title: string | null;
  // Timeline trial rows stand for one or more character banners: a "[试用] …" label
  // and the ids of every banner they cover, all completed together.
  display_title?: string;
  trial_group_ids?: Array<string | number>;
};
type ParsedRecurringEvent = ParsedEvent & {
  kind: "recurring";
  recurringActivityId: string;
  cycleKey: string;
};
type ParsedVersionEvent = ParsedEvent & { kind: "version" };
type ParsedMonthlyCardEvent = ParsedEvent & { kind: "monthlyCard" };
type TimelineOnlyParsedEvent = ParsedVersionEvent | ParsedMonthlyCardEvent;
type AnyParsedEvent = ParsedUpstreamEvent | ParsedRecurringEvent | TimelineOnlyParsedEvent;
function resolveEventGameId(event: TimelineCalendarEvent, fallbackGameId?: GameId): GameId | null {
  return event.gameId ?? fallbackGameId ?? null;
}

function makeEventKey(kind: "upstream" | "recurring" | "version" | "monthlyCard", gameId: GameId, id: string | number, suffix?: string): string {
  return [kind, gameId, String(id), suffix].filter(Boolean).join(":");
}

function getEventAccessibleTitle(event: ParsedEvent, showGameMeta: boolean, displayTitle = event.title): string {
  if (!showGameMeta) return displayTitle;
  return `${GAME_META[event.sourceGameId].name} · ${displayTitle}`;
}

function hasRelativeEnd(event: CalendarEvent): boolean {
  return event.end_time_kind === "relative" || (!event.end_time && Boolean(event.end_time_text));
}

function getRelativeEndText(event: CalendarEvent): string {
  return normalizeEventTitle(event.end_time_text || "结束时间以公告描述为准");
}

function formatEventRange(event: CalendarEvent): string {
  if (hasRelativeEnd(event)) {
    const sd = parseDateTime(event.start_time);
    const start = sd.isValid() ? sd.format("MM/DD HH:mm") : event.start_time;
    return `${start} ~ ${getRelativeEndText(event)}`;
  }

  return formatRange(event.start_time, event.end_time);
}

function formatRange(s: string, e: string | null | undefined) {
  const sd = parseDateTime(s);
  const ed = parseDateTime(e);
  if (!sd.isValid() || !ed.isValid()) return `${s} ~ ${e}`;
  return `${sd.format("MM/DD HH:mm")} ~ ${ed.format("MM/DD HH:mm")}`;
}

function formatRemainingTimeLabel(end: Dayjs, now: Dayjs): string | null {
  const remainingMs = end.valueOf() - now.valueOf();
  if (remainingMs <= 0) return null;

  const remainingDays = Math.floor(remainingMs / DAY_MS);
  const remainingHours = Math.floor(remainingMs / HOUR_MS);
  const remainingMinutes = Math.floor(remainingMs / MINUTE_MS);
  const showMinutes = remainingMs < HOUR_MS;
  const showHours = remainingMs < DAY_MS && !showMinutes;

  if (showMinutes) return `${remainingMinutes}m`;
  if (showHours) return `${remainingHours}h`;
  return `${remainingDays}d`;
}

type EventDetailVariant = "titleBanner" | "none";

const EVENT_DETAIL_VARIANT_BY_GAME: Record<GameId, EventDetailVariant> = {
  genshin: "titleBanner",
  starrail: "titleBanner",
  zzz: "titleBanner",
  ww: "titleBanner",
  snowbreak: "none",
  endfield: "none",
};

function RedeemCodeList(props: { codes: string[] }) {
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  useEffect(() => {
    if (!copiedCode) return;
    const timer = window.setTimeout(() => setCopiedCode(null), 1500);
    return () => window.clearTimeout(timer);
  }, [copiedCode]);

  return (
    <div className="grid gap-1.5">
      <div className="text-xs text-[color:var(--muted)]">前瞻兑换码（点击复制，请在失效前于游戏内兑换）</div>
      <div className="flex flex-wrap gap-2">
        {props.codes.map((code) => (
          <button
            key={code}
            type="button"
            className="glass px-3 py-1.5 rounded-xl text-sm font-mono tracking-wide border border-[color:var(--line)] hover:border-[color:var(--ink)]"
            aria-label={`复制兑换码 ${code}`}
            onClick={async (e) => {
              e.stopPropagation();
              try {
                await navigator.clipboard.writeText(code);
                setCopiedCode(code);
              } catch {
                // ignore
              }
            }}
          >
            {code}
            {copiedCode === code ? (
              <span className="ml-1.5 text-xs text-[color:var(--muted)]">已复制</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function EventDetail(props: {
  event: ParsedEvent;
  checked: boolean;
  now: Dayjs;
  variant: EventDetailVariant;
  showGameMeta?: boolean;
}) {
  const theme = useTheme();
  const isEnd = props.now.isAfter(props.event._e);
  const isDimmed = props.checked || isEnd;
  const shouldStrike = isEnd && !props.checked;
  const hasBanner = Boolean(props.event.banner);
  const showBanner = props.variant !== "none" && hasBanner;
  const remainingLabel = props.event._hasRelativeEnd ? null : formatRemainingTimeLabel(props.event._e, props.now);
  const gameMeta = GAME_META[props.event.sourceGameId];
  const renderedContent = useMemo(() => {
    const raw = props.event.content;
    if (!raw) return null;

    const normalized = preprocessAnnContent(raw);
    if (!looksLikeHtml(normalized)) {
      return { kind: "text" as const, text: normalized };
    }

    const cleanHtml = DOMPurify.sanitize(normalized, { USE_PROFILES: { html: true } });
    const themedHtml = normalizeAnnouncementHtml(cleanHtml, theme);
    return { kind: "html" as const, html: themedHtml };
  }, [props.event.content, theme]);

  return (
    <div className="p-4 grid gap-3">
      {props.showGameMeta ? (
        <div className="flex items-center gap-2 text-xs text-[color:var(--muted)]">
          <img
            src={gameMeta.icon}
            alt=""
            aria-hidden="true"
            className="w-5 h-5 object-contain rounded-md"
            referrerPolicy="no-referrer"
          />
          <span>{gameMeta.name}</span>
        </div>
      ) : null}
      <div className="text-xs text-[color:var(--muted)] font-mono">
        {formatEventRange(props.event)}
        {remainingLabel ? <span>{` (${remainingLabel})`}</span> : null}
      </div>
      <div
        className={clsx(
          "text-base font-semibold leading-snug",
          isDimmed && "opacity-60",
          shouldStrike && "line-through"
        )}
      >
        {props.event.title}
      </div>

      {props.event.redeem_codes && props.event.redeem_codes.length > 0 ? (
        <RedeemCodeList codes={props.event.redeem_codes} />
      ) : null}

      {props.variant === "titleBanner" && showBanner ? (
        <div className="justify-self-start w-fit max-w-full rounded-xl overflow-hidden border border-[color:var(--line)] bg-[color:var(--tile)]">
          <img
            src={props.event.banner}
            alt={props.event.title}
            className="block max-h-[180px] md:max-h-[240px] lg:max-h-[270px] w-auto max-w-full h-auto object-contain object-left"
            referrerPolicy="no-referrer"
          />
        </div>
      ) : null}

      {props.event.linkUrl ? (
        <a
          className="inline-block text-sm text-[color:var(--accent)] hover:underline"
          href={props.event.linkUrl}
          target="_blank"
          rel="noreferrer"
        >
          打开活动详情
        </a>
      ) : renderedContent ? null : (
        <div className="text-xs text-[color:var(--muted)]">无详情链接</div>
      )}

      {renderedContent ? (
        renderedContent.kind === "html" ? (
          <div
            className="text-sm text-[color:var(--ink2)] event-ann-content"
            // Content is sanitized above.
            dangerouslySetInnerHTML={{ __html: renderedContent.html }}
          />
        ) : (
          <div className="text-sm text-[color:var(--ink2)] whitespace-pre-wrap">
            {renderedContent.text}
          </div>
        )
      ) : null}
    </div>
  );
}

function canCompleteTimelineEvent(event: AnyParsedEvent): event is ParsedUpstreamEvent | ParsedRecurringEvent {
  return event.kind === "upstream" || event.kind === "recurring";
}

function sortByPhase<T extends { _s: Dayjs; _e: Dayjs; id: string | number; sourceGameId: GameId }>(
  items: T[],
  now: Dayjs,
  gameRankById?: ReadonlyMap<GameId, number>
): T[] {
  const nowMs = now.valueOf();

  const phase = (e: { _s: Dayjs; _e: Dayjs }) => {
    const s = e._s.valueOf();
    const ed = e._e.valueOf();
    // 0: ongoing, 1: upcoming, 2: ended
    if (nowMs >= s && nowMs < ed) return 0;
    if (nowMs < s) return 1;
    return 2;
  };

  const compareGame = (a: T, b: T) => {
    if (!gameRankById) return 0;
    return (
      (gameRankById.get(a.sourceGameId) ?? Number.MAX_SAFE_INTEGER) -
      (gameRankById.get(b.sourceGameId) ?? Number.MAX_SAFE_INTEGER)
    );
  };
  const compareId = (a: T, b: T) => String(a.id).localeCompare(String(b.id));

  const sorted = [...items];
  sorted.sort((a, b) => {
    const pa = phase(a);
    const pb = phase(b);
    if (pa !== pb) return pa - pb;

    if (gameRankById && a._e.valueOf() === b._e.valueOf()) {
      const startCompare = pa === 2 ? b._s.valueOf() - a._s.valueOf() : a._s.valueOf() - b._s.valueOf();
      return compareGame(a, b) || compareId(a, b) || startCompare;
    }

    if (pa === 0) {
      return (
        a._e.valueOf() - b._e.valueOf() ||
        a._s.valueOf() - b._s.valueOf() ||
        compareId(a, b)
      );
    }

    if (pa === 1) {
      return (
        a._s.valueOf() - b._s.valueOf() ||
        a._e.valueOf() - b._e.valueOf() ||
        compareId(a, b)
      );
    }

    return (
      b._e.valueOf() - a._e.valueOf() ||
      b._s.valueOf() - a._s.valueOf() ||
      compareId(a, b)
    );
  });
  return sorted;
}

type RecurringFormRuleKind = RecurringRule["kind"];

type RecurringFormState = {
  title: string;
  kind: RecurringFormRuleKind;
  monthlyDay: string;
  weeklyWeekday: string;
  time: string;
  intervalStartDate: string;
  intervalDays: string;
  durationDays: string;
  customCron: string;
};

const WEEKDAY_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: WEEKDAY_NAMES[0] },
  { value: 1, label: WEEKDAY_NAMES[1] },
  { value: 2, label: WEEKDAY_NAMES[2] },
  { value: 3, label: WEEKDAY_NAMES[3] },
  { value: 4, label: WEEKDAY_NAMES[4] },
  { value: 5, label: WEEKDAY_NAMES[5] },
  { value: 6, label: WEEKDAY_NAMES[6] },
];

function makeRecurringFormState(now: Dayjs): RecurringFormState {
  return {
    title: "",
    kind: "monthly",
    monthlyDay: "1",
    weeklyWeekday: String(now.day()),
    time: "04:00",
    intervalStartDate: now.format("YYYY-MM-DD"),
    intervalDays: "7",
    durationDays: "",
    customCron: "0 4 1 * *",
  };
}

function deriveTimeFromCronExpression(expression: string): string | null {
  const source = expression.trim();
  if (!source) return null;
  const { parsed, error } = validateCronExpression(source);
  if (!parsed || error) return null;
  if (parsed.hour.values.length !== 1 || parsed.minute.values.length !== 1) return null;
  return `${pad2(parsed.hour.values[0]!)}:${pad2(parsed.minute.values[0]!)}`;
}

function makeRecurringFormStateFromActivity(activity: RecurringActivity): RecurringFormState {
  const base = makeRecurringFormState(dayjs());
  const durationDays = activity.durationDays == null ? "" : String(activity.durationDays);

  if (activity.rule.kind === "monthly") {
    return {
      ...base,
      title: activity.title,
      durationDays,
      kind: "monthly",
      monthlyDay: String(activity.rule.day),
      time: `${pad2(activity.rule.hour)}:${pad2(activity.rule.minute)}`,
      customCron: `${activity.rule.minute} ${activity.rule.hour} ${activity.rule.day} * *`,
    };
  }

  if (activity.rule.kind === "weekly") {
    return {
      ...base,
      title: activity.title,
      durationDays,
      kind: "weekly",
      weeklyWeekday: String(activity.rule.weekday),
      time: `${pad2(activity.rule.hour)}:${pad2(activity.rule.minute)}`,
      customCron: `${activity.rule.minute} ${activity.rule.hour} * * ${activity.rule.weekday}`,
    };
  }

  if (activity.rule.kind === "interval") {
    return {
      ...base,
      title: activity.title,
      durationDays,
      kind: "interval",
      intervalStartDate: activity.rule.startDate,
      intervalDays: String(activity.rule.everyDays),
      time: `${pad2(activity.rule.hour)}:${pad2(activity.rule.minute)}`,
      customCron: "",
    };
  }

  return {
    ...base,
    title: activity.title,
    durationDays,
    kind: "cron",
    time: deriveTimeFromCronExpression(activity.rule.expression) ?? base.time,
    customCron: activity.rule.expression,
  };
}

function isRecurringFormStateEqual(a: RecurringFormState, b: RecurringFormState): boolean {
  return (
    a.title === b.title &&
    a.kind === b.kind &&
    a.monthlyDay === b.monthlyDay &&
    a.weeklyWeekday === b.weeklyWeekday &&
    a.time === b.time &&
    a.intervalStartDate === b.intervalStartDate &&
    a.intervalDays === b.intervalDays &&
    a.durationDays === b.durationDays &&
    a.customCron === b.customCron
  );
}

function buildCronFromForm(form: RecurringFormState): string {
  if (form.kind === "cron") return form.customCron;

  const parsedTime = parseTimeInput(form.time) ?? { hour: 0, minute: 0 };
  const hour = Math.min(23, Math.max(0, Math.trunc(parsedTime.hour)));
  const minute = Math.min(59, Math.max(0, Math.trunc(parsedTime.minute)));

  if (form.kind === "monthly") {
    const day = Number(form.monthlyDay);
    const safeDay = Number.isFinite(day) ? Math.min(31, Math.max(1, Math.trunc(day))) : 1;
    return `${minute} ${hour} ${safeDay} * *`;
  }

  if (form.kind === "weekly") {
    const weekday = Number(form.weeklyWeekday);
    const safeWeekday = Number.isFinite(weekday) ? Math.min(6, Math.max(0, Math.trunc(weekday))) : 0;
    return `${minute} ${hour} * * ${safeWeekday}`;
  }
  return "";
}

function parseTimeInput(value: string): { hour: number; minute: number } | null {
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function parseRecurringForm(form: RecurringFormState): { value: Omit<RecurringActivity, "id"> | null; error: string | null } {
  const title = form.title.trim();
  if (!title) return { value: null, error: "请输入循环活动名称" };

  const durationRaw = form.durationDays.trim();
  let durationDays: number | undefined;
  if (durationRaw) {
    const n = Number(durationRaw);
    if (!Number.isInteger(n) || n < 1 || n > 3650) {
      return { value: null, error: "持续天数需在 1-3650，或留空" };
    }
    durationDays = n;
  }

  if (form.kind === "cron") {
    const expression = form.customCron.trim();
    const parsedCron = validateCronExpression(expression);
    if (!parsedCron.parsed || parsedCron.error) {
      return { value: null, error: parsedCron.error ?? "Cron 表达式不合法" };
    }
    return {
      value: {
        title,
        durationDays,
        rule: { kind: "cron", expression },
      },
      error: null,
    };
  }

  const parsedTime = parseTimeInput(form.time);
  if (!parsedTime) return { value: null, error: "刷新时间格式应为 HH:mm" };

  if (form.kind === "monthly") {
    const day = Number(form.monthlyDay);
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      return { value: null, error: "每月日期需在 1-31" };
    }
    return {
      value: {
        title,
        durationDays,
        rule: { kind: "monthly", day, ...parsedTime },
      },
      error: null,
    };
  }

  if (form.kind === "weekly") {
    const weekday = Number(form.weeklyWeekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return { value: null, error: "每周日期不合法" };
    }
    return {
      value: {
        title,
        durationDays,
        rule: { kind: "weekly", weekday, ...parsedTime },
      },
      error: null,
    };
  }

  const startDate = form.intervalStartDate.trim();
  if (!dayjs(startDate, "YYYY-MM-DD", true).isValid()) {
    return { value: null, error: "开始日期格式不正确" };
  }
  const everyDays = Number(form.intervalDays);
  if (!Number.isInteger(everyDays) || everyDays < 1 || everyDays > 3650) {
    return { value: null, error: "循环天数需在 1-3650" };
  }

  return {
    value: {
      title,
      durationDays,
      rule: { kind: "interval", startDate, everyDays, ...parsedTime },
    },
    error: null,
  };
}

type TimelineFilter = "all" | "limited" | "recurring";
type RowCategory = "limited" | "recurring" | "other";
type RowEvent = ParsedUpstreamEvent | ParsedRecurringEvent | ParsedMonthlyCardEvent;
type TimelineRowItem = { event: RowEvent; category: RowCategory; completed: boolean };
type ResetGroup = { key: string; title: string; end: Dayjs; events: ParsedRecurringEvent[] };
type RemainingTone = "normal" | "urgent" | "ok" | "muted";

const HIDE_COMPLETED_STORAGE_KEY = "gc.timeline.hideCompleted";
// Recurring activities sharing one refresh moment (e.g. every game's weekly reset)
// collapse into a single block once at least this many line up.
const RESET_GROUP_MIN_SIZE = 3;
const FILTER_OPTIONS: Array<{ id: TimelineFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "limited", label: "限时" },
  { id: "recurring", label: "循环" },
];

function readHideCompleted(): boolean {
  try {
    return window.localStorage.getItem(HIDE_COMPLETED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeHideCompleted(value: boolean) {
  try {
    window.localStorage.setItem(HIDE_COMPLETED_STORAGE_KEY, value ? "1" : "0");
  } catch {
    // ignore
  }
}

function formatRemainingShort(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / MINUTE_MS));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}天${hours}时` : `${days}天`;
  if (hours > 0) return minutes > 0 ? `${hours}时${minutes}分` : `${hours}时`;
  return `${Math.max(1, minutes)}分`;
}

function formatDayLabel(d: Dayjs): string {
  return `${d.format("M月D日")} ${WEEKDAY_NAMES[d.day()]}`;
}

// 「活动名」说明文字 -> 活动名 (without its 「」) + subtitle, so long announcement titles stay
// scannable. A title that is only a quoted name is left as is.
function splitEventTitle(title: string): { main: string; sub: string | null } {
  const matched = /^「([^」]+)」\s*[：:·\-—]?\s*(.*)$/.exec(title);
  if (!matched) return { main: title, sub: null };
  const rest = (matched[2] ?? "").trim().replace(/^(活动|玩法)[：:]\s*/, "");
  if (!rest) return { main: title, sub: null };
  return { main: matched[1]!, sub: rest };
}

function hasFeaturedCharacters(event: ParsedUpstreamEvent): boolean {
  return (event.gacha_featured?.characters.length ?? 0) > 0;
}

function gachaWindowKey(event: ParsedUpstreamEvent): string {
  return `${event.sourceGameId}:${event._s.valueOf()}:${event._hasRelativeEnd ? "rel" : event._e.valueOf()}`;
}

function gachaStartKey(event: ParsedUpstreamEvent): string {
  return `${event.sourceGameId}:${event._s.valueOf()}`;
}

// Endfield weapon banners open with a 特许寻访 but outlive it: "于3次「特许寻访」后结束（从「冬猎」起计算）".
const ENDFIELD_PAIRED_WEAPON_END = /次「特许寻访」后结束/;

// Weapon banners paired with a character banner (opened alongside one, or tied to
// the Endfield 特许寻访 cycle) are implied by it and not listed. On home, character
// banners of one game that open and close together also share a line.
function groupGachaEvents(
  events: ParsedUpstreamEvent[],
  allGachaEvents: ParsedUpstreamEvent[],
  mergeCharacters: boolean
): Array<{ key: string; events: ParsedUpstreamEvent[] }> {
  // Pair against every banner, including an already-ended character banner whose weapon banner runs on.
  const characterStarts = new Set(allGachaEvents.filter(hasFeaturedCharacters).map(gachaStartKey));
  const groups = new Map<string, ParsedUpstreamEvent[]>();
  for (const event of events) {
    const isCharacter = hasFeaturedCharacters(event);
    const isWeaponOnly = !isCharacter && (event.gacha_featured?.weapons.length ?? 0) > 0;
    const isPairedWeapon =
      isWeaponOnly &&
      (characterStarts.has(gachaStartKey(event)) ||
        (event.sourceGameId === "endfield" && ENDFIELD_PAIRED_WEAPON_END.test(event.end_time_text ?? "")));
    if (isPairedWeapon) continue;
    const key = mergeCharacters && isCharacter ? `characters:${gachaWindowKey(event)}` : event.eventKey;
    const list = groups.get(key);
    if (list) list.push(event);
    else groups.set(key, [event]);
  }
  return [...groups.entries()].map(([key, grouped]) => ({ key, events: grouped }));
}

function gachaGroupTitle(events: ParsedUpstreamEvent[]): string {
  const first = events[0]!;
  if (events.length === 1) return first.gacha_title ?? first.title;
  const merged: GachaFeatured = { characters: [], weapons: [] };
  for (const event of events) {
    for (const name of event.gacha_featured?.characters ?? []) if (!merged.characters.includes(name)) merged.characters.push(name);
  }
  return formatGachaFeaturedTitle(first.sourceGameId, merged) ?? first.title;
}

function splitVersionLabel(version: GameVersionInfo): { num: string | null; name: string | null } {
  const raw = version.version.trim();
  const titleNum = version.title?.match(/(\d+\.\d+)/)?.[1] ?? null;
  // Version names are shown bare, without the 「」 the upstream titles wrap them in.
  const titleName = version.title?.match(/「([^」]+)」/)?.[1] ?? null;
  if (/^\d+(\.\d+)*$/.test(raw)) return { num: raw, name: titleName };
  return { num: titleNum, name: raw.match(/「([^」]+)」/)?.[1] ?? (raw || null) };
}

function toneColor(tone: RemainingTone): string {
  if (tone === "urgent") return "var(--urgent)";
  if (tone === "ok") return "var(--ok)";
  if (tone === "muted") return "var(--muted)";
  return "var(--ink2)";
}

function CheckIcon(props: { className?: string; strokeWidth?: number }) {
  return (
    <svg
      className={props.className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={props.strokeWidth ?? 3.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

// Marks anything ending within 24 hours, wherever its remaining time is shown.
function ClockIcon() {
  return (
    <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function RowCheckbox(props: { checked: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.checked}
      aria-label={props.label}
      title={props.checked ? "标记为未完成" : "标记为已完成"}
      onClick={props.onToggle}
      className="group w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
    >
      <span
        className={clsx(
          "w-[18px] h-[18px] rounded-md border-[1.5px] inline-flex items-center justify-center transition-colors",
          props.checked
            ? "bg-[color:var(--ink)] border-[color:var(--ink)] text-[color:var(--card)]"
            : "border-[color:var(--muted)] text-transparent group-hover:border-[color:var(--ink)]"
        )}
      >
        <CheckIcon className="w-3 h-3" />
      </span>
    </button>
  );
}

function SideCard(props: { title: string; meta?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)] shadow-ink px-4 pt-4 pb-2">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <h2 className="text-[15px] font-bold">{props.title}</h2>
        {props.action ?? (props.meta ? <span className="text-xs text-[color:var(--muted)]">{props.meta}</span> : null)}
      </div>
      {props.children}
    </section>
  );
}

function EmptyState(props: { title: string; sub?: string; done?: boolean; action?: ReactNode }) {
  return (
    <div className="px-6 py-12 md:py-14 flex flex-col items-center gap-2.5 text-center">
      {props.done ? (
        <div className="w-12 h-12 rounded-2xl bg-[color:var(--ok-soft)] text-[color:var(--ok)] inline-flex items-center justify-center">
          <CheckIcon className="w-6 h-6" strokeWidth={2.4} />
        </div>
      ) : null}
      <div className="text-base font-bold">{props.title}</div>
      {props.sub ? <div className="text-[13px] text-[color:var(--muted)] max-w-[420px] leading-relaxed">{props.sub}</div> : null}
      {props.action}
    </div>
  );
}

export default function TimelineCalendar(props: TimelineCalendarProps) {
  const {
    prefs,
    setMonthlyCardRemainingDays,
    toggleCompleted: toggleCompletedPref,
    toggleRecurringCompleted: toggleRecurringCompletedPref,
    addRecurringActivity,
    updateRecurringActivity,
    removeRecurringActivity,
  } = usePrefs();
  const mode = props.mode ?? "game";
  const isHome = mode === "home";
  const primaryGameId = props.gameId ?? "genshin";
  const showGameMeta = isHome;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [now, setNow] = useState(() => dayjs());
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [hideCompleted, setHideCompletedState] = useState<boolean>(() => readHideCompleted());
  // Once everything in view is done the timeline collapses into an empty state;
  // this opts back into seeing the finished rows for the rest of the session.
  const [revealAllDone, setRevealAllDone] = useState(false);
  const [isMonthlyCardEditing, setIsMonthlyCardEditing] = useState(false);
  const [monthlyCardDraft, setMonthlyCardDraft] = useState("");
  const [isRecurringSettingsOpen, setIsRecurringSettingsOpen] = useState(false);
  const showRecurringSettingsPanel = !isHome && isRecurringSettingsOpen;
  const [recurringForm, setRecurringForm] = useState<RecurringFormState>(() => makeRecurringFormState(dayjs()));
  const [recurringFormError, setRecurringFormError] = useState<string | null>(null);
  const [editingRecurringId, setEditingRecurringId] = useState<string | null>(null);
  const [pendingDeleteRecurringId, setPendingDeleteRecurringId] = useState<string | null>(null);
  const gameMeta = GAME_META[primaryGameId];
  const showNotStarted = prefs.timeline.showNotStarted;
  const showWeekSeparators = prefs.timeline.showWeekSeparators;
  const monthlyCardState = prefs.timeline.monthlyCardByGame[primaryGameId] ?? null;
  const recurringTzOffsetMinutes = getRecurringTzOffsetMinutes(primaryGameId);
  const monthlyCardResetOffsetMinutes = getDailyResetOffsetMinutes(primaryGameId);
  const sourceGameIds = useMemo<GameId[]>(() => {
    if (!isHome) return [primaryGameId];
    return prefs.visibleGameIds.length > 0 ? prefs.visibleGameIds : ALL_GAME_IDS;
  }, [isHome, prefs.visibleGameIds, primaryGameId]);
  const sourceGameIdSet = useMemo(() => new Set<GameId>(sourceGameIds), [sourceGameIds]);
  const homeGameRankById = useMemo(() => {
    if (!isHome) return undefined;
    return new Map<GameId, number>(sourceGameIds.map((gameId, index) => [gameId, index]));
  }, [isHome, sourceGameIds]);
  const completedIdsByGame = useMemo(() => {
    const next: Partial<Record<GameId, Set<string | number>>> = {};
    for (const gameId of ALL_GAME_IDS) {
      next[gameId] = new Set<string | number>(prefs.timeline.completedIdsByGame[gameId] ?? []);
    }
    return next as Record<GameId, Set<string | number>>;
  }, [prefs.timeline.completedIdsByGame]);
  const completedRecurringByGame = prefs.timeline.completedRecurringByGame;
  const recurringDefs = prefs.timeline.recurringActivitiesByGame[primaryGameId] ?? [];
  const homeRangeStart = useMemo(() => now.startOf("day").subtract(HOME_TIMELINE_PAST_DAYS, "day"), [now]);
  // Exclusive end: midnight after the last shown day.
  const homeRangeEnd = useMemo(() => now.startOf("day").add(HOME_TIMELINE_FUTURE_DAYS + 1, "day"), [now]);
  const monthlyCardRemainingDays = useMemo(
    () => getMonthlyCardRemainingDays(monthlyCardState, now, recurringTzOffsetMinutes, monthlyCardResetOffsetMinutes),
    [monthlyCardResetOffsetMinutes, monthlyCardState, now, recurringTzOffsetMinutes]
  );
  const isMonthlyCardUrgent = monthlyCardRemainingDays != null && monthlyCardRemainingDays <= 3;
  const recurringTzLabel = useMemo(() => formatFixedUtcOffset(recurringTzOffsetMinutes), [recurringTzOffsetMinutes]);
  const currentVersion =
    !isHome && props.currentVersionState?.status === "success" ? props.currentVersionState.data : null;

  const isUpstreamCompleted = (event: ParsedUpstreamEvent) => {
    const completedIds = completedIdsByGame[event.sourceGameId];
    if (!completedIds) return false;
    return (event.trial_group_ids ?? [event.id]).every((id) => completedIds.has(id));
  };
  const isRecurringCompleted = (event: ParsedRecurringEvent) =>
    completedRecurringByGame[event.sourceGameId]?.[event.recurringActivityId] === event.cycleKey;
  const toggleCompleted = (event: ParsedUpstreamEvent) => {
    if (!event.trial_group_ids) {
      toggleCompletedPref(event.sourceGameId, event.id);
      return;
    }
    // Flip only the banners not already in the target state, so the whole group ends up alike.
    const done = isUpstreamCompleted(event);
    const completedIds = completedIdsByGame[event.sourceGameId];
    for (const id of event.trial_group_ids) {
      if ((completedIds?.has(id) ?? false) === done) toggleCompletedPref(event.sourceGameId, id);
    }
  };
  const toggleRecurringCompleted = (event: ParsedRecurringEvent) =>
    toggleRecurringCompletedPref(event.sourceGameId, event.recurringActivityId, event.cycleKey);
  const isTimelineEventCompleted = (event: AnyParsedEvent): boolean => {
    if (event.kind === "recurring") return isRecurringCompleted(event);
    if (event.kind === "upstream") return isUpstreamCompleted(event);
    return false;
  };
  const toggleTimelineEventCompleted = (event: ParsedUpstreamEvent | ParsedRecurringEvent) => {
    if (event.kind === "recurring") toggleRecurringCompleted(event);
    else toggleCompleted(event);
  };
  const setHideCompleted = (value: boolean) => {
    setHideCompletedState(value);
    writeHideCompleted(value);
  };
  const monthlyCardInputRef = useRef<HTMLInputElement | null>(null);
  const detailPanelRef = useRef<HTMLDivElement | null>(null);

  const startMonthlyCardEditing = () => {
    setMonthlyCardDraft(monthlyCardRemainingDays == null ? "" : String(monthlyCardRemainingDays));
    setIsMonthlyCardEditing(true);
  };

  const cancelMonthlyCardEditing = () => {
    setIsMonthlyCardEditing(false);
    setMonthlyCardDraft("");
  };

  const commitMonthlyCardEditing = () => {
    const input = monthlyCardDraft.trim();
    if (!input) {
      setMonthlyCardRemainingDays(primaryGameId, null);
      setIsMonthlyCardEditing(false);
      return;
    }

    const parsed = Number(input);
    const normalized = Number.isFinite(parsed) ? Math.max(0, Math.min(3650, Math.trunc(parsed))) : 0;
    setMonthlyCardRemainingDays(primaryGameId, normalized);
    setIsMonthlyCardEditing(false);
  };

  useEffect(() => {
    const t = setInterval(() => setNow(dayjs()), 60_000);
    return () => clearInterval(t);
  }, []);

  // The timeline is often taller than the viewport, so a detail panel opened from
  // a row can render entirely below the fold. Scroll it into view unless its header
  // is already visible.
  useEffect(() => {
    if (!selectedKey) return;
    const el = detailPanelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const headerVisible = rect.top >= 0 && rect.top <= window.innerHeight - 160;
    if (headerVisible) return;
    const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    el.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "start" });
  }, [selectedKey]);

  useEffect(() => {
    if (!isMonthlyCardEditing) return;
    monthlyCardInputRef.current?.focus();
    monthlyCardInputRef.current?.select();
  }, [isMonthlyCardEditing]);

  // When switching games, reset UI state before paint so reused route components
  // do not briefly show controls from the previous game.
  useLayoutEffect(() => {
    setSelectedKey(null);
    setIsMonthlyCardEditing(false);
    setMonthlyCardDraft("");
    setIsRecurringSettingsOpen(false);
    setRecurringForm(makeRecurringFormState(dayjs()));
    setRecurringFormError(null);
    setEditingRecurringId(null);
    setPendingDeleteRecurringId(null);
  }, [isHome, primaryGameId]);

  useEffect(() => {
    if (!pendingDeleteRecurringId) return;

    const clearPendingDelete = (e: MouseEvent | TouchEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) {
        setPendingDeleteRecurringId(null);
        return;
      }
      if (target.closest("[data-recurring-delete-id]")) return;
      setPendingDeleteRecurringId(null);
    };

    document.addEventListener("mousedown", clearPendingDelete);
    document.addEventListener("touchstart", clearPendingDelete, { passive: true });
    return () => {
      document.removeEventListener("mousedown", clearPendingDelete);
      document.removeEventListener("touchstart", clearPendingDelete);
    };
  }, [pendingDeleteRecurringId]);

  const toggleSelected = (eventKey: string) => {
    setSelectedKey((prev) => (prev === eventKey ? null : eventKey));
  };

  const parsedUpstream = useMemo(() => {
    const items = props.events
      .map((e) => {
        const sourceGameId = resolveEventGameId(e, props.gameId);
        if (!sourceGameId) return null;
        if (isHome && !sourceGameIdSet.has(sourceGameId)) return null;
        const s = parseDateTime(e.start_time);
        const relativeEnd = hasRelativeEnd(e);
        const ed = relativeEnd ? now.add(RELATIVE_END_LAYOUT_YEARS, "year") : parseDateTime(e.end_time);
        const title = normalizeEventTitle(e.title);
        const { isGacha, gachaKind } = resolveGachaClassification(
          sourceGameId,
          title,
          e.content,
          e.is_gacha,
          e.gacha_kind
        );
        const gachaFeatured = isGacha ? (e.gacha_featured ?? extractGachaFeatured(sourceGameId, title, e.content)) : undefined;
        return {
          ...e,
          kind: "upstream" as const,
          title,
          is_gacha: isGacha,
          gacha_kind: gachaKind,
          gacha_featured: gachaFeatured,
          gacha_title: gachaFeatured ? formatGachaFeaturedTitle(sourceGameId, gachaFeatured) : null,
          _s: s,
          _e: ed,
          _hasRelativeEnd: relativeEnd,
          sourceGameId,
          eventKey: makeEventKey("upstream", sourceGameId, e.id),
        };
      })
      .filter((e): e is ParsedUpstreamEvent => Boolean(e && e._s.isValid() && e._e.isValid() && e._e.isAfter(e._s)));
    return items;
  }, [isHome, now, props.events, props.gameId, sourceGameIdSet]);

  const sortedUpstream = useMemo(() => sortByPhase(parsedUpstream, now, homeGameRankById), [homeGameRankById, parsedUpstream, now]);

  // Gacha banners live in their own sidebar card; the timeline only carries the
  // character trial activity that opens with them, one row per merged banner group.
  const visibleUpstreamSorted = useMemo(() => {
    const nowMs = now.valueOf();
    const homeEndMs = homeRangeEnd.valueOf();
    const inWindow = sortedUpstream.filter((e) => {
      if (e.is_gacha && !isCharacterTrialGachaKind(e.gacha_kind)) return false;
      if (isHome && e._hasRelativeEnd) return false;
      if (isHome && (e._e.valueOf() < nowMs || e._e.valueOf() > homeEndMs)) return false;
      if (isHome) return true;
      // Game pages hide ended activities too (redeem-code events included).
      if (!e._hasRelativeEnd && e._e.valueOf() <= nowMs) return false;
      if (showNotStarted) return true;
      return nowMs >= e._s.valueOf();
    });
    const trialBanners = inWindow.filter((e) => e.is_gacha);
    const trialRows = groupGachaEvents(trialBanners, trialBanners, true).map(({ events }): ParsedUpstreamEvent => {
      const first = events[0]!;
      return {
        ...first,
        eventKey: `${first.eventKey}:trial`,
        display_title: `[试用] ${gachaGroupTitle(events)}`,
        trial_group_ids: events.map((e) => e.id),
      };
    });
    return [...inWindow.filter((e) => !e.is_gacha), ...trialRows];
  }, [homeRangeEnd, isHome, sortedUpstream, showNotStarted, now]);

  const gachaEvents = useMemo(() => {
    const nowMs = now.valueOf();
    return sortedUpstream.filter((e) => {
      if (!e.is_gacha) return false;
      if (!e._hasRelativeEnd && e._e.valueOf() <= nowMs) return false;
      if (!isHome && !showNotStarted && nowMs < e._s.valueOf()) return false;
      return true;
    });
  }, [isHome, now, showNotStarted, sortedUpstream]);

  const codeEvents = useMemo(() => {
    const nowMs = now.valueOf();
    return sortedUpstream.filter(
      (e) => (e.redeem_codes?.length ?? 0) > 0 && nowMs >= e._s.valueOf() && e._e.valueOf() > nowMs
    );
  }, [now, sortedUpstream]);

  const parsedRecurring = useMemo(() => {
    const items: ParsedRecurringEvent[] = [];

    for (const gameId of sourceGameIds) {
      const defs = prefs.timeline.recurringActivitiesByGame[gameId] ?? [];
      for (const a of defs) {
        const w = computeRecurringWindow(now, gameId, a);
        if (!w.start.isValid() || !w.end.isValid() || !w.end.isAfter(w.start)) continue;
        // Ensure we only ever show the *current* cycle (no future occurrences).
        if (now.valueOf() < w.start.valueOf() || now.valueOf() >= w.end.valueOf()) continue;

        const event: CalendarEvent = {
          id: `rec:${gameId}:${a.id}`,
          title: a.title,
          start_time: toIsoWithOffset(w.start),
          end_time: toIsoWithOffset(w.end),
          content: `循环活动：${formatRecurringRule(gameId, a.rule, a.durationDays)}`,
        };

        items.push({
          ...event,
          _s: w.start,
          _e: w.end,
          _hasRelativeEnd: false,
          kind: "recurring",
          sourceGameId: gameId,
          eventKey: makeEventKey("recurring", gameId, a.id, w.cycleKey),
          recurringActivityId: a.id,
          cycleKey: w.cycleKey,
        });
      }
    }

    return sortByPhase(items, now, homeGameRankById);
  }, [homeGameRankById, now, prefs.timeline.recurringActivitiesByGame, sourceGameIds]);

  const visibleRecurring = useMemo(() => {
    if (!isHome) return parsedRecurring;
    const nowMs = now.valueOf();
    const homeEndMs = homeRangeEnd.valueOf();
    return parsedRecurring.filter((e) => e._e.valueOf() >= nowMs && e._e.valueOf() <= homeEndMs);
  }, [homeRangeEnd, isHome, now, parsedRecurring]);

  const monthlyCardEvents = useMemo(() => {
    if (!isHome) return [] as ParsedMonthlyCardEvent[];

    const nowMs = now.valueOf();
    const homeEndMs = homeRangeEnd.valueOf();
    const items: ParsedMonthlyCardEvent[] = [];

    for (const gameId of sourceGameIds) {
      const entry = prefs.timeline.monthlyCardByGame[gameId];
      const remainingDays = getMonthlyCardRemainingDays(
        entry,
        now,
        getRecurringTzOffsetMinutes(gameId),
        getDailyResetOffsetMinutes(gameId)
      );
      if (remainingDays == null || remainingDays > HOME_TIMELINE_FUTURE_DAYS) continue;

      const end = getMonthlyCardEndTime(
        now,
        remainingDays,
        getRecurringTzOffsetMinutes(gameId),
        getDailyResetOffsetMinutes(gameId)
      );
      if (!end.isValid() || end.valueOf() <= nowMs || end.valueOf() > homeEndMs) continue;
      const start = now.subtract(5, "day");

      const event: CalendarEvent = {
        id: `monthly-card:${gameId}`,
        title: "月卡",
        start_time: toIsoWithOffset(start),
        end_time: toIsoWithOffset(end),
        content: `月卡剩余 ${remainingDays} 天`,
      };

      items.push({
        ...event,
        _s: start,
        _e: end,
        _hasRelativeEnd: false,
        kind: "monthlyCard",
        sourceGameId: gameId,
        eventKey: makeEventKey("monthlyCard", gameId, event.id),
      });
    }

    return items;
  }, [homeRangeEnd, isHome, now, prefs.timeline.monthlyCardByGame, sourceGameIds]);

  const resetGroups = useMemo<ResetGroup[]>(() => {
    if (!isHome) return [];
    const byEnd = new Map<number, ParsedRecurringEvent[]>();
    for (const event of visibleRecurring) {
      const endMs = event._e.valueOf();
      const list = byEnd.get(endMs);
      if (list) list.push(event);
      else byEnd.set(endMs, [event]);
    }
    return [...byEnd.entries()]
      .filter(([, list]) => list.length >= RESET_GROUP_MIN_SIZE)
      .sort((a, b) => a[0] - b[0])
      .map(([endMs, list]) => {
        const allWeekly = list.every((event) => {
          const def = (prefs.timeline.recurringActivitiesByGame[event.sourceGameId] ?? []).find(
            (a) => a.id === event.recurringActivityId
          );
          return def?.rule.kind === "weekly";
        });
        return { key: String(endMs), title: allWeekly ? "每周重置" : "同时刷新", end: list[0]!._e, events: list };
      });
  }, [isHome, prefs.timeline.recurringActivitiesByGame, visibleRecurring]);

  const groupedRecurringKeys = useMemo(
    () => new Set(resetGroups.flatMap((group) => group.events.map((event) => event.eventKey))),
    [resetGroups]
  );

  const allRowItems = useMemo<TimelineRowItem[]>(() => {
    const events: RowEvent[] = [
      ...monthlyCardEvents,
      ...visibleRecurring.filter((event) => !groupedRecurringKeys.has(event.eventKey)),
      ...visibleUpstreamSorted,
    ];
    let ordered: RowEvent[];
    if (isHome) {
      // Home is an agenda: strictly by end time, so the day groups stay contiguous.
      ordered = [...events].sort(
        (a, b) =>
          a._e.valueOf() - b._e.valueOf() ||
          (homeGameRankById?.get(a.sourceGameId) ?? 0) - (homeGameRankById?.get(b.sourceGameId) ?? 0) ||
          String(a.id).localeCompare(String(b.id))
      );
    } else {
      ordered = sortByPhase(events, now, homeGameRankById);
    }
    return ordered.map((event) => ({
      event,
      category: event.kind === "recurring" ? "recurring" : event.kind === "upstream" ? "limited" : "other",
      completed: isTimelineEventCompleted(event),
    }));
  }, [
    completedIdsByGame,
    completedRecurringByGame,
    groupedRecurringKeys,
    homeGameRankById,
    isHome,
    monthlyCardEvents,
    now,
    visibleRecurring,
    visibleUpstreamSorted,
  ]);

  const filteredRowItems = useMemo(
    () => allRowItems.filter((item) => filter === "all" || item.category === filter),
    [allRowItems, filter]
  );
  const filteredAllDone = filteredRowItems.length > 0 && filteredRowItems.every((item) => item.completed);
  const displayedRowItems = useMemo(
    () =>
      hideCompleted || (filteredAllDone && !revealAllDone)
        ? filteredRowItems.filter((item) => !item.completed)
        : filteredRowItems,
    [filteredAllDone, filteredRowItems, hideCompleted, revealAllDone]
  );
  const visibleResetGroups = filter === "limited" ? [] : resetGroups;
  const filterCounts = useMemo(() => {
    const resetCount = resetGroups.reduce((sum, group) => sum + group.events.length, 0);
    const limited = allRowItems.filter((item) => item.category === "limited").length;
    const recurring = allRowItems.filter((item) => item.category === "recurring").length + resetCount;
    return { all: allRowItems.length + resetCount, limited, recurring } satisfies Record<TimelineFilter, number>;
  }, [allRowItems, resetGroups]);

  const selectedEvent = useMemo(() => {
    if (selectedKey == null) return null;
    return (
      (allRowItems.find((item) => item.event.eventKey === selectedKey)?.event ??
        gachaEvents.find((e) => e.eventKey === selectedKey) ??
        codeEvents.find((e) => e.eventKey === selectedKey) ??
        visibleRecurring.find((e) => e.eventKey === selectedKey) ??
        null) as AnyParsedEvent | null
    );
  }, [allRowItems, codeEvents, gachaEvents, selectedKey, visibleRecurring]);

  // If the selected event disappears (data refresh / filter changes), hide the detail panel.
  useEffect(() => {
    if (selectedKey == null) return;
    if (selectedEvent) return;
    setSelectedKey(null);
  }, [selectedEvent, selectedKey]);

  const axis = useMemo(() => {
    type Tick = { key: string; label: string; sub: string | null; startPct: number; widthPct: number; isToday: boolean; isWeekend: boolean };
    const ticks: Tick[] = [];

    if (isHome) {
      const start = homeRangeStart;
      const end = homeRangeEnd;
      const totalMs = Math.max(1, end.valueOf() - start.valueOf());
      const today = now.startOf("day");
      for (let d = start; d.isBefore(end); d = d.add(1, "day")) {
        const isToday = d.isSame(today, "day");
        ticks.push({
          key: d.format("YYYY-MM-DD"),
          label: d.date() === 1 ? d.format("M/D") : String(d.date()),
          sub: isToday ? "今天" : WEEKDAY_NAMES[d.day()]!,
          startPct: ((d.valueOf() - start.valueOf()) / totalMs) * 100,
          widthPct: (DAY_MS / totalMs) * 100,
          isToday,
          isWeekend: d.day() === 0 || d.day() === 6,
        });
      }
      return { rangeStart: start, rangeEnd: end, ticks };
    }

    const baseMonth = now.startOf("month");
    const windowStart = baseMonth.subtract(1, "month").startOf("month");
    const windowEnd = baseMonth.add(1, "month").endOf("month");
    const todayStart = now.startOf("day");
    const todayEnd = now.endOf("day");

    // Only consider events that overlap the maximum visible window. Timeline start/end
    // are then derived from those events: anything starting before windowStart shows the
    // full previous month truncated, otherwise start from the earliest visible start
    // (and the same rule for the end). Only rows actually shown count, so hiding
    // completed items or switching filters tightens the range to what remains.
    const visible = displayedRowItems
      .map((item) => item.event)
      .filter((e) => e._e.valueOf() > windowStart.valueOf() && e._s.valueOf() < windowEnd.valueOf());

    let start = windowStart;
    let end = windowEnd;
    if (visible.length > 0) {
      let minS = visible[0]!._s;
      let maxE = visible[0]!._e;
      let hasBeforeWindowStart = false;
      let hasAfterWindowEnd = false;
      for (const e of visible) {
        if (e._s.isBefore(minS)) minS = e._s;
        if (e._e.isAfter(maxE)) maxE = e._e;
        if (e._s.isBefore(windowStart)) hasBeforeWindowStart = true;
        if (e._e.isAfter(windowEnd)) hasAfterWindowEnd = true;
      }
      start = hasBeforeWindowStart ? windowStart : minS;
      end = hasAfterWindowEnd ? windowEnd : maxE;
    }
    // The timeline always includes today.
    if (start.isAfter(todayStart)) start = todayStart;
    if (end.isBefore(todayEnd)) end = todayEnd;

    const totalMs = Math.max(1, end.valueOf() - start.valueOf());
    const pushTick = (key: string, label: string, segStart: Dayjs, segEnd: Dayjs) => {
      ticks.push({
        key,
        label,
        sub: null,
        startPct: ((segStart.valueOf() - start.valueOf()) / totalMs) * 100,
        widthPct: (Math.max(1, segEnd.valueOf() - segStart.valueOf()) / totalMs) * 100,
        isToday: false,
        isWeekend: false,
      });
    };

    if (showWeekSeparators) {
      for (let w = start.startOf("isoWeek"); w.isBefore(end); w = w.add(1, "week")) {
        const segStart = w.isBefore(start) ? start : w;
        const segEnd = w.add(1, "week").isAfter(end) ? end : w.add(1, "week");
        pushTick(`${w.isoWeekYear()}-W${w.isoWeek()}`, w.format("M/D"), segStart, segEnd);
      }
    } else {
      for (let m = start.startOf("month"); m.isBefore(end); m = m.add(1, "month")) {
        const segStart = m.isBefore(start) ? start : m;
        const segEnd = m.add(1, "month").isAfter(end) ? end : m.add(1, "month");
        pushTick(m.format("YYYY-MM"), `${m.format("M")}月`, segStart, segEnd);
      }
    }

    return { rangeStart: start, rangeEnd: end, ticks };
  }, [displayedRowItems, homeRangeEnd, homeRangeStart, isHome, now, showWeekSeparators]);

  const rangeStartMs = axis.rangeStart.valueOf();
  const rangeMs = Math.max(1, axis.rangeEnd.valueOf() - rangeStartMs);
  const toPct = (ms: number) => clamp(((ms - rangeStartMs) / rangeMs) * 100, 0, 100);
  const isNowInRange = !now.isBefore(axis.rangeStart) && !now.isAfter(axis.rangeEnd);
  const nowPct = toPct(now.valueOf());
  const versionBand = useMemo(() => {
    if (!currentVersion) return null;
    const s = parseDateTime(currentVersion.start_time);
    const e = parseDateTime(currentVersion.end_time);
    if (!s.isValid() || !e.isValid() || !e.isAfter(s)) return null;
    const left = toPct(s.valueOf());
    const right = toPct(e.valueOf());
    if (right - left <= 0) return null;
    return { left, width: right - left };
    // toPct only depends on the axis range.
  }, [currentVersion, rangeStartMs, rangeMs]);

  const homeStats = useMemo(() => {
    if (!isHome) return null;
    const nowMs = now.valueOf();
    const items: Array<{ endMs: number; done: boolean }> = [
      ...allRowItems
        .filter((item) => item.event.kind !== "monthlyCard")
        .map((item) => ({ endMs: item.event._e.valueOf(), done: item.completed })),
      ...resetGroups.flatMap((group) =>
        group.events.map((event) => ({ endMs: event._e.valueOf(), done: isRecurringCompleted(event) }))
      ),
    ];
    const pending = items.filter((item) => !item.done && item.endMs > nowMs);
    const done = items.filter((item) => item.done).length;
    return {
      urgent: pending.filter((item) => item.endMs - nowMs <= DAY_MS).length,
      soon: pending.filter((item) => item.endMs - nowMs <= 2 * DAY_MS).length,
      done,
      total: items.length,
    };
  }, [allRowItems, completedRecurringByGame, isHome, now, resetGroups]);

  const versionRows = useMemo(() => {
    if (!isHome) return [];
    const nowMs = now.valueOf();
    const rows = sourceGameIds.map((gameId) => {
      const version = (props.currentVersions ?? []).find((v) => v.game === gameId) ?? null;
      const s = version ? parseDateTime(version.start_time) : null;
      const e = version ? parseDateTime(version.end_time) : null;
      const valid = Boolean(version && s?.isValid() && e?.isValid() && e.isAfter(s));
      const endMs = valid ? e!.valueOf() : Number.POSITIVE_INFINITY;
      const label = version ? splitVersionLabel(version) : { num: null, name: null };
      return {
        gameId,
        valid,
        endMs,
        num: label.num,
        name: label.name,
        pct: valid ? clamp(((nowMs - s!.valueOf()) / (e!.valueOf() - s!.valueOf())) * 100, 0, 100) : 0,
        remainingMs: valid ? endMs - nowMs : 0,
      };
    });
    return rows.sort((a, b) => a.endMs - b.endMs);
  }, [isHome, now, props.currentVersions, sourceGameIds]);

  const gachaGroups = useMemo(
    () => groupGachaEvents(gachaEvents, sortedUpstream.filter((e) => e.is_gacha), isHome),
    [gachaEvents, isHome, sortedUpstream]
  );

  const recurringDefinitionsSorted = useMemo(() => {
    return [...recurringDefs].sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"));
  }, [recurringDefs]);
  const editingTargetActivity = useMemo(
    () => (editingRecurringId ? recurringDefs.find((a) => a.id === editingRecurringId) ?? null : null),
    [editingRecurringId, recurringDefs]
  );
  const hasUnsavedEditingChanges = useMemo(() => {
    if (!editingTargetActivity) return false;
    const originalForm = makeRecurringFormStateFromActivity(editingTargetActivity);
    return !isRecurringFormStateEqual(recurringForm, originalForm);
  }, [editingTargetActivity, recurringForm]);

  const recurringCronPreview = useMemo(() => buildCronFromForm(recurringForm), [recurringForm]);
  const recurringCronValidationError = useMemo(() => {
    if (recurringForm.kind !== "cron") return null;
    if (!recurringForm.customCron.trim()) return "请输入 Cron 表达式";
    const { error } = validateCronExpression(recurringForm.customCron);
    return error;
  }, [recurringForm.customCron, recurringForm.kind]);

  const isRecurringSubmitDisabled = recurringForm.kind === "cron" && Boolean(recurringCronValidationError);

  const resetRecurringForm = () => {
    setEditingRecurringId(null);
    setRecurringForm(makeRecurringFormState(dayjs()));
    setRecurringFormError(null);
    setPendingDeleteRecurringId(null);
  };

  const handleSubmitRecurring = (): boolean => {
    const { value, error } = parseRecurringForm(recurringForm);
    if (!value || error) {
      setRecurringFormError(error ?? "循环活动参数不合法");
      return false;
    }
    if (editingRecurringId) {
      updateRecurringActivity(primaryGameId, editingRecurringId, value);
    } else {
      addRecurringActivity(primaryGameId, value);
    }
    resetRecurringForm();
    return true;
  };

  const toggleRecurringSettings = () => {
    if (isRecurringSettingsOpen) {
      setIsRecurringSettingsOpen(false);
      resetRecurringForm();
      return;
    }
    setIsRecurringSettingsOpen(true);
    setRecurringFormError(null);
  };

  const describeRemaining = (event: AnyParsedEvent, completed: boolean): { primary: string; secondary: string; tone: RemainingTone } => {
    const nowMs = now.valueOf();
    const endLabel = event._hasRelativeEnd ? getRelativeEndText(event) : event._e.format("MM/DD HH:mm");
    if (completed) return { primary: "已完成", secondary: endLabel, tone: "ok" };
    if (nowMs < event._s.valueOf()) {
      return { primary: "未开始", secondary: `${event._s.format("MM/DD HH:mm")} 开始`, tone: "muted" };
    }
    if (event._hasRelativeEnd) return { primary: "见公告", secondary: endLabel, tone: "muted" };
    const remainingMs = event._e.valueOf() - nowMs;
    if (remainingMs <= 0) return { primary: "已结束", secondary: endLabel, tone: "muted" };
    return { primary: `剩 ${formatRemainingShort(remainingMs)}`, secondary: endLabel, tone: remainingMs <= DAY_MS ? "urgent" : "normal" };
  };

  const barFill = (event: RowEvent, urgent: boolean): string => {
    if (event.kind === "monthlyCard") return "var(--urgent)";
    if (isHome) return urgent ? "var(--urgent)" : gameColorVar(event.sourceGameId);
    return gameColorVar(event.sourceGameId);
  };

  const renderRow = (item: TimelineRowItem) => {
    const { event, completed } = item;
    const key = event.eventKey;
    const isSelected = selectedKey === key;
    const canComplete = canCompleteTimelineEvent(event);
    const displayTitle = (event.kind === "upstream" && event.display_title) || event.title;
    // Only the lead title is shown; the full announcement title stays in the tooltip and detail panel.
    const { main } = splitEventTitle(displayTitle);
    const accessibleTitle = getEventAccessibleTitle(event, showGameMeta, displayTitle);
    const remaining = describeRemaining(event, completed);
    const nowMs = now.valueOf();
    const notStarted = nowMs < event._s.valueOf();
    const isEnded = !event._hasRelativeEnd && nowMs >= event._e.valueOf();
    const fill = barFill(event, remaining.tone === "urgent");
    const left = toPct(event._s.valueOf());
    const right = toPct(event._e.valueOf());
    const truncatedStart = event._s.valueOf() < rangeStartMs;
    const truncatedEnd = event._hasRelativeEnd || event._e.valueOf() > axis.rangeEnd.valueOf();
    const radiusStart = truncatedStart ? "0" : "8px";
    const radiusEnd = truncatedEnd ? "0" : "8px";
    const elapsedPct = clamp(((nowMs - event._s.valueOf()) / Math.max(1, event._e.valueOf() - event._s.valueOf())) * 100, 0, 100);

    return (
      <div
        key={key}
        className={clsx(
          "relative flex items-center min-h-[60px] md:min-h-0 md:h-[52px] transition-colors",
          isSelected ? "bg-[color:var(--accent-soft)]" : "hover:bg-[color:var(--tile)]"
        )}
      >
        <div
          className={clsx(
            "flex items-center gap-1 min-w-0 flex-1 md:flex-none md:w-[300px] lg:w-[320px] pl-1 md:pl-2 pr-2",
            completed && "opacity-50"
          )}
        >
          {canComplete ? (
            <RowCheckbox
              checked={completed}
              label={`${completed ? "取消完成" : "标记完成"}：${accessibleTitle}`}
              onToggle={() => toggleTimelineEventCompleted(event)}
            />
          ) : (
            <span className="w-11 shrink-0" aria-hidden="true" />
          )}
          {showGameMeta ? (
            <img
              src={GAME_META[event.sourceGameId].icon}
              alt=""
              aria-hidden="true"
              className="w-7 h-7 shrink-0 rounded-lg object-cover mr-1.5"
              referrerPolicy="no-referrer"
            />
          ) : null}
          <button
            type="button"
            className="min-w-0 flex-1 text-left py-2 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
            aria-expanded={isSelected}
            aria-label={`${accessibleTitle}，${remaining.primary}`}
            onClick={() => toggleSelected(key)}
          >
            <div className={clsx("text-sm font-semibold truncate", (completed || isEnded) && "line-through")} title={displayTitle}>
              {main}
            </div>
            <div className="md:hidden mt-1.5 h-1 rounded-full bg-[color:var(--line-soft)] overflow-hidden" aria-hidden="true">
              <div className="h-full rounded-full" style={{ width: `${elapsedPct}%`, background: fill }} />
            </div>
          </button>
        </div>

        <div
          className={clsx("hidden md:block relative flex-1 self-stretch cursor-pointer", completed && "opacity-50")}
          onClick={() => toggleSelected(key)}
          aria-hidden="true"
        >
          <div
            className="absolute top-1/2 -translate-y-1/2 h-4 box-border"
            style={{
              left: `${left}%`,
              width: `max(6px, ${right - left}%)`,
              background: notStarted ? "transparent" : fill,
              border: notStarted ? "1.5px dashed var(--muted)" : undefined,
              borderRadius: `${radiusStart} ${radiusEnd} ${radiusEnd} ${radiusStart}`,
              opacity: isEnded ? 0.5 : 1,
              // Bars running past the visible range fade out at the edge; the end date
              // is already shown in the remaining column, so no label sits on the bar.
              ...(truncatedEnd
                ? {
                    maskImage: "linear-gradient(to right, #000 calc(100% - 28px), transparent)",
                    WebkitMaskImage: "linear-gradient(to right, #000 calc(100% - 28px), transparent)",
                  }
                : null),
            }}
          />
        </div>

        <div className={clsx("shrink-0 w-[96px] md:w-[112px] pr-3 md:pr-5 text-right", completed && "opacity-70")}>
          <div
            className="inline-flex items-center justify-end gap-1 font-mono text-xs font-semibold whitespace-nowrap"
            style={{ color: toneColor(remaining.tone) }}
          >
            {remaining.tone === "urgent" ? <ClockIcon /> : null}
            {remaining.primary}
          </div>
          <div className="font-mono text-[10px] text-[color:var(--muted)] whitespace-nowrap truncate">{remaining.secondary}</div>
        </div>
      </div>
    );
  };

  const renderRowGroupHeader = (label: string, sub: string | null, count: number, urgent = false) => (
    <div className="relative h-9 flex items-end gap-2 px-4 md:px-5 pb-1.5 max-md:border-t max-md:border-[color:var(--line-soft)] first:border-t-0">
      <span className="text-[13px] font-bold" style={{ color: urgent ? "var(--urgent)" : "var(--ink)" }}>
        {label}
      </span>
      {sub ? <span className="text-xs text-[color:var(--muted)]">{sub}</span> : null}
      <span className="text-[11px] font-mono text-[color:var(--muted)] px-1.5 rounded-md bg-[color:var(--surface2)] border border-[color:var(--line-soft)]">
        {count}
      </span>
    </div>
  );

  const renderRows = () => {
    if (!isHome) {
      // Game pages split limited-time activities from recurring ones, like the home page's day groups.
      const groups = [
        { key: "limited", label: "限时活动", items: displayedRowItems.filter((item) => item.category !== "recurring") },
        { key: "recurring", label: "循环活动", items: displayedRowItems.filter((item) => item.category === "recurring") },
      ];
      return groups.map((group) =>
        group.items.length > 0 ? (
          <div key={group.key}>
            {renderRowGroupHeader(group.label, null, group.items.length)}
            {group.items.map(renderRow)}
          </div>
        ) : null
      );
    }

    const tomorrowStart = now.startOf("day").add(1, "day");
    const dayAfterStart = tomorrowStart.add(1, "day");
    const groups = [
      { key: "today", label: "今天", sub: formatDayLabel(now), urgent: true, until: tomorrowStart.valueOf() },
      { key: "tomorrow", label: "明天", sub: formatDayLabel(tomorrowStart), urgent: false, until: dayAfterStart.valueOf() },
      {
        key: "later",
        label: `未来 ${HOME_TIMELINE_FUTURE_DAYS} 天`,
        sub: `至 ${formatDayLabel(homeRangeEnd.subtract(1, "minute"))}`,
        urgent: false,
        until: Number.POSITIVE_INFINITY,
      },
    ];
    let from = Number.NEGATIVE_INFINITY;
    return groups.map((group) => {
      const items = displayedRowItems.filter((item) => {
        const endMs = item.event._e.valueOf();
        return endMs >= from && endMs < group.until;
      });
      from = group.until;
      if (items.length === 0) return null;
      return (
        <div key={group.key}>
          {renderRowGroupHeader(group.label, group.sub, items.length, group.urgent)}
          {items.map(renderRow)}
        </div>
      );
    });
  };

  const hasResetBlock = visibleResetGroups.length > 0;
  const emptyTimeline =
    displayedRowItems.length > 0 ? null : filteredAllDone ? (
      <EmptyState
        done
        title="所有活动已完成，长草中 (´-ω-`)"
        sub={isHome ? "未来 7 天内要结束的活动都已勾选完成，新活动上线后会自动出现在这里。" : "当前的活动都已勾选完成，新活动上线后会自动出现在这里。"}
        action={
          <button
            type="button"
            onClick={() => {
              if (hideCompleted) setHideCompleted(false);
              setRevealAllDone(true);
            }}
            className="mt-1 h-9 px-3.5 rounded-xl border border-[color:var(--line)] bg-[color:var(--card)] text-[13px] font-semibold text-[color:var(--ink2)] hover:border-[color:var(--ink)]"
          >
            显示已完成的活动
          </button>
        }
      />
    ) : hasResetBlock && filter === "recurring" ? null : (
      <EmptyState
        title={
          filter === "limited"
            ? isHome
              ? "未来 7 天内暂无将结束的限时活动"
              : "暂无限时活动"
            : filter === "recurring"
              ? "暂无循环活动"
              : isHome
                ? "未来 7 天内暂无将结束的活动"
                : "暂无活动"
        }
        sub={filter !== "all" ? "可以切换到「全部」查看其他类型的活动。" : undefined}
      />
    );

  const renderResetGroup = (group: ResetGroup) => {
    const doneCount = group.events.filter((event) => isRecurringCompleted(event)).length;
    const allDone = doneCount === group.events.length;
    const chips = hideCompleted ? group.events.filter((event) => !isRecurringCompleted(event)) : group.events;
    const endLabel = `${formatDayLabel(group.end)} ${group.end.format("HH:mm")}`;
    return (
      <div key={group.key} className="border-t border-[color:var(--line)] bg-[color:var(--surface2)] px-4 md:px-5 py-4 grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 min-w-0">
            <h3 className="text-sm font-bold">{group.title}</h3>
            <span className="text-xs text-[color:var(--muted)]">
              {endLabel} 刷新 · 剩{" "}
              <span className="font-mono font-semibold text-[color:var(--ink2)]">
                {formatRemainingShort(group.end.valueOf() - now.valueOf())}
              </span>
            </span>
          </div>
          <span className="text-xs font-mono text-[color:var(--muted)]">
            {doneCount}/{group.events.length} 完成
          </span>
        </div>
        {allDone ? (
          <div className="flex items-center gap-2.5 px-3.5 py-3 rounded-xl bg-[color:var(--ok-soft)] text-[color:var(--ok)] text-[13px] font-semibold">
            <CheckIcon className="w-4 h-4 shrink-0" strokeWidth={2.6} />
            {group.title === "每周重置" ? "本周事项已全部完成" : "这些事项已全部完成"}，下次刷新在 {endLabel}
          </div>
        ) : null}
        {chips.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {chips.map((event) => {
              const done = isRecurringCompleted(event);
              const meta = GAME_META[event.sourceGameId];
              return (
                <button
                  key={event.eventKey}
                  type="button"
                  role="checkbox"
                  aria-checked={done}
                  aria-label={`${done ? "取消完成" : "标记完成"}：${meta.name} · ${event.title}`}
                  onClick={() => toggleRecurringCompleted(event)}
                  className={clsx(
                    "h-9 pl-1.5 pr-3 rounded-xl border inline-flex items-center gap-2 text-[13px] transition",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]",
                    done
                      ? "border-[color:var(--line-soft)] bg-transparent opacity-60"
                      : "border-[color:var(--line)] bg-[color:var(--card)] hover:border-[color:var(--ink)]"
                  )}
                >
                  <img src={meta.icon} alt="" aria-hidden="true" className="w-[22px] h-[22px] rounded-md object-cover" referrerPolicy="no-referrer" />
                  <span className={clsx(done && "line-through")}>{event.title}</span>
                  {done ? <CheckIcon className="w-3.5 h-3.5 text-[color:var(--ok)]" strokeWidth={3} /> : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  };

  const timelineCard = (
    <section className="rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)] shadow-ink overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 md:px-5 py-3 md:py-0 md:h-16 border-b border-[color:var(--line)]">
        <div className="flex items-baseline gap-2.5 min-w-0">
          <h2 className="text-base md:text-[17px] font-bold">{isHome ? "即将结束" : "活动"}</h2>
          {isHome ? null : (
            <span className="hidden sm:inline text-[13px] text-[color:var(--muted)] truncate">{`${filterCounts.all} 项`}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div role="group" aria-label="筛选" className="flex p-[3px] rounded-[10px] bg-[color:var(--surface2)] border border-[color:var(--line)]">
            {FILTER_OPTIONS.map((option) => {
              const selected = filter === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setFilter(option.id)}
                  className={clsx(
                    "h-8 md:h-[30px] px-2.5 md:px-3 rounded-lg text-[13px] font-semibold transition",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]",
                    selected
                      ? "bg-[color:var(--card)] text-[color:var(--ink)] shadow-[0_1px_2px_rgba(0,0,0,0.12)]"
                      : "text-[color:var(--muted)] hover:text-[color:var(--ink)]"
                  )}
                >
                  {option.label}
                  <span className="hidden sm:inline ml-1 font-mono font-medium opacity-70">{filterCounts[option.id]}</span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            aria-pressed={hideCompleted}
            onClick={() => setHideCompleted(!hideCompleted)}
            title={hideCompleted ? "显示已完成" : "隐藏已完成"}
            className={clsx(
              "h-9 px-2.5 md:px-3 rounded-[10px] border border-[color:var(--line)] bg-[color:var(--card)] text-[13px] font-medium",
              "inline-flex items-center gap-1.5 text-[color:var(--ink2)] hover:border-[color:var(--ink)]",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
            )}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {hideCompleted ? (
                <>
                  <path d="M3 3l18 18" />
                  <path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
                  <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
                </>
              ) : (
                <>
                  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
                  <circle cx="12" cy="12" r="3" />
                </>
              )}
            </svg>
            <span className="hidden sm:inline">{hideCompleted ? "显示已完成" : "隐藏已完成"}</span>
          </button>
        </div>
      </div>

      {emptyTimeline ??
        (displayedRowItems.length > 0 ? (
          <div className="relative">
            {/* Grid, weekend shading, version band and the "now" line sit behind the rows. */}
            <div className="hidden md:block absolute inset-y-0 left-[300px] lg:left-[320px] right-[112px] pointer-events-none" aria-hidden="true">
              {versionBand ? (
                <div className="absolute inset-y-0" style={{ left: `${versionBand.left}%`, width: `${versionBand.width}%`, background: "var(--version-band)" }} />
              ) : null}
              {axis.ticks.map((tick) => (
                <div
                  key={tick.key}
                  className="absolute inset-y-0 border-l border-[color:var(--line-soft)]"
                  style={{
                    left: `${tick.startPct}%`,
                    width: `${tick.widthPct}%`,
                    background: tick.isToday ? "var(--accent-soft)" : tick.isWeekend ? "var(--weekend)" : undefined,
                  }}
                />
              ))}
              {isNowInRange ? (
                <div className="absolute top-[44px] bottom-0 w-[2px] -ml-px bg-[color:var(--accent)] z-10" style={{ left: `${nowPct}%` }} />
              ) : null}
            </div>

            <div className="hidden md:flex relative h-[52px] border-b border-[color:var(--line)]">
              <div className="w-[300px] lg:w-[320px] shrink-0 px-5 flex items-center text-xs font-semibold text-[color:var(--muted)]">活动</div>
              <div className="relative flex-1">
                {axis.ticks.map((tick) =>
                  tick.widthPct >= 4 ? (
                    <div
                      key={tick.key}
                      className={clsx("absolute inset-y-0 flex flex-col justify-center gap-0.5", isHome ? "items-center" : "items-start pl-2")}
                      style={{ left: `${tick.startPct}%`, width: `${tick.widthPct}%` }}
                    >
                      {tick.sub ? (
                        <span className={clsx("text-[11px]", tick.isToday ? "text-[color:var(--accent)] font-semibold" : "text-[color:var(--muted)]")}>
                          {tick.sub}
                        </span>
                      ) : null}
                      <span
                        className={clsx(
                          "h-[22px] min-w-[26px] px-1.5 rounded-full inline-flex items-center justify-center text-[13px] font-semibold font-mono",
                          tick.isToday ? "bg-[color:var(--accent)] text-[color:var(--on-accent)]" : "text-[color:var(--ink2)]"
                        )}
                      >
                        {tick.label}
                      </span>
                    </div>
                  ) : null
                )}
                {versionBand && currentVersion ? (
                  <span
                    className="absolute top-1 text-[10px] font-bold font-mono whitespace-nowrap"
                    style={{ left: `calc(${versionBand.left}% + 4px)`, color: gameInkVar(primaryGameId) }}
                  >
                    {splitVersionLabel(currentVersion).num ?? ""} 版本
                  </span>
                ) : null}
                {isNowInRange ? (
                  <span
                    className="absolute bottom-0 translate-y-1/2 -translate-x-1/2 z-20 px-1.5 rounded-md bg-[color:var(--accent)] text-[color:var(--on-accent)] text-[10px] font-bold font-mono whitespace-nowrap"
                    style={{ left: `${nowPct}%` }}
                  >
                    {now.format("HH:mm")}
                  </span>
                ) : null}
              </div>
              <div className="w-[112px] shrink-0 pr-5 flex items-center justify-end text-xs font-semibold text-[color:var(--muted)]">剩余</div>
            </div>

            <div className="relative py-1 md:py-0">{renderRows()}</div>
          </div>
        ) : null)}

      {visibleResetGroups.map(renderResetGroup)}
    </section>
  );

  const detailPanel = selectedEvent ? (
    <div ref={detailPanelRef} className="rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)] shadow-ink overflow-hidden scroll-mt-3">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[color:var(--line)] bg-[color:var(--surface2)]">
        <div className="text-sm font-semibold">活动详情</div>
        <div className="flex items-center gap-1">
          {canCompleteTimelineEvent(selectedEvent) ? (
            <label className="flex items-center gap-2 text-xs text-[color:var(--muted)] cursor-pointer select-none px-2">
              <span>已完成</span>
              <input
                type="checkbox"
                checked={isTimelineEventCompleted(selectedEvent)}
                onChange={() => toggleTimelineEventCompleted(selectedEvent)}
                className="w-5 h-5 rounded border-[color:var(--line)] bg-transparent accent-[color:var(--ink)] cursor-pointer"
              />
            </label>
          ) : null}
          <button
            type="button"
            onClick={() => setSelectedKey(null)}
            aria-label="关闭活动详情"
            className="w-9 h-9 rounded-lg inline-flex items-center justify-center text-[color:var(--muted)] hover:text-[color:var(--ink)] hover:bg-[color:var(--tile)]"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </div>
      <EventDetail
        event={selectedEvent}
        checked={isTimelineEventCompleted(selectedEvent)}
        now={now}
        variant={EVENT_DETAIL_VARIANT_BY_GAME[selectedEvent.sourceGameId]}
        showGameMeta={showGameMeta}
      />
    </div>
  ) : null;

  const recurringSettingsPanel = showRecurringSettingsPanel ? (
    <section className="rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)] shadow-ink overflow-hidden">
      <div className="px-4 py-3 border-b border-[color:var(--line)] bg-[color:var(--surface2)] flex items-center justify-between gap-3">
        <div className="flex items-end gap-2 min-w-0">
          <div className="text-sm font-semibold">循环活动配置</div>
          {editingRecurringId ? (
            <div className="text-xs text-[color:var(--accent)] whitespace-nowrap leading-none">正在编辑循环活动</div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={toggleRecurringSettings}
          aria-label="关闭循环活动配置"
          className="w-9 h-9 rounded-lg inline-flex items-center justify-center text-[color:var(--muted)] hover:text-[color:var(--ink)] hover:bg-[color:var(--tile)]"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
            <div className="px-4 py-3 bg-[color:var(--wash)]/40">
              <form
                className="grid gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSubmitRecurring();
                }}
              >
                <div className="grid gap-2 md:grid-cols-2">
                  <label className="grid gap-1">
                    <span className="text-xs text-[color:var(--muted)]">活动名称</span>
                    <input
                      id="event_title"
                      name="event_title"
                      type="text"
                      value={recurringForm.title}
                      onChange={(e) => {
                        setRecurringForm((prev) => ({ ...prev, title: e.target.value }));
                        if (recurringFormError) setRecurringFormError(null);
                      }}
                      placeholder="例如：深境螺旋"
                      className="w-full px-2 py-2 rounded-xl border border-[color:var(--line)] bg-transparent text-sm"
                    />
                  </label>

                  <label className="grid gap-1">
                    <span className="text-xs text-[color:var(--muted)]">刷新时间（{recurringTzLabel}）</span>
                    <input
                      type="time"
                      value={recurringForm.time}
                      disabled={recurringForm.kind === "cron"}
                      onChange={(e) => {
                        setRecurringForm((prev) => ({ ...prev, time: e.target.value }));
                        if (recurringFormError) setRecurringFormError(null);
                      }}
                      className={clsx(
                        "w-full px-2 py-2 rounded-xl border border-[color:var(--line)] bg-transparent text-sm",
                        recurringForm.kind === "cron" && "opacity-70 cursor-not-allowed"
                      )}
                    />
                  </label>
                </div>

                <div className="grid gap-2 md:grid-cols-2">
                  <label className={clsx("grid gap-1", recurringForm.kind === "cron" && "md:col-span-2")}>
                    <span className="text-xs text-[color:var(--muted)]">循环方式</span>
                    <select
                      value={recurringForm.kind}
                      onChange={(e) => {
                        const kind = e.target.value as RecurringFormRuleKind;
                        setRecurringForm((prev) => {
                          if (kind !== "cron") return { ...prev, kind };
                          const nextCron = prev.customCron.trim() ? prev.customCron : buildCronFromForm(prev);
                          return { ...prev, kind, customCron: nextCron };
                        });
                        if (recurringFormError) setRecurringFormError(null);
                      }}
                      className="w-full px-2 py-2 rounded-xl border border-[color:var(--line)] bg-transparent text-sm"
                    >
                      <option value="monthly">每月</option>
                      <option value="weekly">每周</option>
                      <option value="interval">固定天数</option>
                      <option value="cron">自定义 Cron</option>
                    </select>
                  </label>

                  {recurringForm.kind === "monthly" ? (
                    <label className="grid gap-1">
                      <span className="text-xs text-[color:var(--muted)]">每月几号</span>
                      <input
                        type="number"
                        min="1"
                        max="31"
                        value={recurringForm.monthlyDay}
                        onChange={(e) => {
                          setRecurringForm((prev) => ({ ...prev, monthlyDay: e.target.value }));
                          if (recurringFormError) setRecurringFormError(null);
                        }}
                        className="w-full px-2 py-2 rounded-xl border border-[color:var(--line)] bg-transparent text-sm"
                      />
                    </label>
                  ) : recurringForm.kind === "weekly" ? (
                    <label className="grid gap-1">
                      <span className="text-xs text-[color:var(--muted)]">每周几</span>
                      <select
                        value={recurringForm.weeklyWeekday}
                        onChange={(e) => {
                          setRecurringForm((prev) => ({ ...prev, weeklyWeekday: e.target.value }));
                          if (recurringFormError) setRecurringFormError(null);
                        }}
                        className="w-full px-2 py-2 rounded-xl border border-[color:var(--line)] bg-transparent text-sm"
                      >
                        {WEEKDAY_OPTIONS.map((opt) => (
                          <option key={opt.value} value={String(opt.value)}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : recurringForm.kind === "interval" ? (
                    <label className="grid gap-1">
                      <span className="text-xs text-[color:var(--muted)]">开始日期</span>
                      <input
                        type="date"
                        value={recurringForm.intervalStartDate}
                        onChange={(e) => {
                          setRecurringForm((prev) => ({ ...prev, intervalStartDate: e.target.value }));
                          if (recurringFormError) setRecurringFormError(null);
                        }}
                        className="w-full px-2 py-2 rounded-xl border border-[color:var(--line)] bg-transparent text-sm"
                      />
                    </label>
                  ) : null}
                </div>

                <div className="grid gap-2 md:grid-cols-2">
                  {recurringForm.kind === "interval" ? (
                    <label className="grid gap-1">
                      <span className="text-xs text-[color:var(--muted)]">循环天数</span>
                      <input
                        type="number"
                        min="1"
                        max="3650"
                        value={recurringForm.intervalDays}
                        onChange={(e) => {
                          setRecurringForm((prev) => ({ ...prev, intervalDays: e.target.value }));
                          if (recurringFormError) setRecurringFormError(null);
                        }}
                        className="w-full px-2 py-2 rounded-xl border border-[color:var(--line)] bg-transparent text-sm"
                      />
                    </label>
                  ) : (
                    <label className="grid gap-1">
                      <span className="text-xs text-[color:var(--muted)]">Cron表达式</span>
                      <input
                        type="text"
                        value={recurringCronPreview}
                        readOnly={recurringForm.kind !== "cron"}
                        placeholder="例如：0 4 * * 1"
                        onChange={(e) => {
                          if (recurringForm.kind !== "cron") return;
                          const nextCron = e.target.value;
                          setRecurringForm((prev) => {
                            const nextTime = deriveTimeFromCronExpression(nextCron);
                            if (!nextTime) return { ...prev, customCron: nextCron };
                            return { ...prev, customCron: nextCron, time: nextTime };
                          });
                          if (recurringFormError) setRecurringFormError(null);
                        }}
                        className={clsx(
                          "w-full px-2 py-2 rounded-xl border border-[color:var(--line)] bg-transparent text-sm font-mono",
                          recurringForm.kind === "cron" && recurringCronValidationError && "border-red-400",
                          recurringForm.kind !== "cron" && "opacity-70 cursor-not-allowed"
                        )}
                      />
                    </label>
                  )}

                  <label className="grid gap-1">
                    <span className="text-xs text-[color:var(--muted)]">持续天数（可选）</span>
                    <input
                      type="number"
                      min="1"
                      max="3650"
                      value={recurringForm.durationDays}
                      placeholder="留空为连续循环"
                      onChange={(e) => {
                        setRecurringForm((prev) => ({ ...prev, durationDays: e.target.value }));
                        if (recurringFormError) setRecurringFormError(null);
                      }}
                      className="w-full px-2 py-2 rounded-xl border border-[color:var(--line)] bg-transparent text-sm"
                    />
                  </label>
                </div>

                {recurringForm.kind === "cron" && recurringCronValidationError ? (
                  <div className="text-xs text-red-500">{recurringCronValidationError}</div>
                ) : null}

                <div className="grid gap-2 md:grid-cols-[3fr_1fr] md:items-start">
                  <div className="min-w-0 text-left text-xs text-[color:var(--muted)] break-words md:pr-2 md:min-h-[36px] md:flex md:items-center">
                    {recurringForm.kind === "interval"
                      ? `自 ${recurringForm.intervalStartDate || "（未设置）"} 起每 ${recurringForm.intervalDays || "N"
                      } 天 ${recurringForm.time || "00:00"} 刷新（${recurringTzLabel}）`
                      : recurringCronPreview
                        ? formatCronHumanReadable(recurringCronPreview)
                        : "（空）"}
                  </div>
                  <div className="flex items-center gap-2 md:justify-end">
                    {editingRecurringId ? (
                      <button
                        type="button"
                        onClick={resetRecurringForm}
                        className="px-3 py-2 rounded-xl text-sm border border-[color:var(--line)] transition hover:border-[color:var(--ink)] hover:bg-[color:var(--tile)] whitespace-nowrap"
                      >
                        取消
                      </button>
                    ) : null}
                    <button
                      type="submit"
                      disabled={isRecurringSubmitDisabled}
                      className={clsx(
                        "px-3 py-2 rounded-xl text-sm border border-[color:var(--line)] transition whitespace-nowrap",
                        !editingRecurringId && "w-full",
                        "hover:border-[color:var(--ink)] hover:bg-[color:var(--tile)]",
                        isRecurringSubmitDisabled && "opacity-50 cursor-not-allowed hover:border-[color:var(--line)] hover:bg-transparent"
                      )}
                    >
                      {editingRecurringId ? "保存" : "添加循环活动"}
                    </button>
                  </div>
                </div>

                {recurringFormError ? (
                  <div className="text-xs text-red-500">{recurringFormError}</div>
                ) : null}
              </form>

              <div className="mt-3 pt-3 border-t border-[color:var(--line)] grid gap-2">
                <div className="text-xs text-[color:var(--muted)]">已配置项目</div>
                {recurringDefinitionsSorted.length > 0 ? (
                  recurringDefinitionsSorted.map((activity) => (
                    <div
                      key={activity.id}
                      className="rounded-xl border border-[color:var(--line)] px-2 py-2 flex items-start justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium break-words">{activity.title}</div>
                        <div className="text-xs text-[color:var(--muted)] mt-1">
                          {formatRecurringRule(primaryGameId, activity.rule, activity.durationDays)}
                        </div>
                      </div>
                      <div className="shrink-0 flex items-center gap-2">
                        <button
                          type="button"
                          className={clsx(
                            "text-xs px-2 py-1 rounded-lg border transition",
                            editingRecurringId === activity.id
                              ? "border-[color:var(--accent)] text-[color:var(--accent)] bg-[color:var(--tile)]/40"
                              : "border-[color:var(--line)] hover:border-[color:var(--ink)] hover:bg-[color:var(--tile)]"
                          )}
                          onClick={() => {
                            setIsRecurringSettingsOpen(true);
                            if (editingRecurringId === activity.id) {
                              if (!hasUnsavedEditingChanges) {
                                resetRecurringForm();
                                return;
                              }
                              // Never discard silently: point at the form's own 保存/取消
                              // buttons instead of a native confirm dialog.
                              setRecurringFormError("有未保存的修改：请点击“保存”提交，或点击“取消”放弃修改");
                              return;
                            }
                            setEditingRecurringId(activity.id);
                            setRecurringForm(makeRecurringFormStateFromActivity(activity));
                            setRecurringFormError(null);
                            setPendingDeleteRecurringId(null);
                          }}
                        >
                          修改
                        </button>
                        <button
                          type="button"
                          data-recurring-delete-id={activity.id}
                          className={clsx(
                            "text-xs px-2 py-1 rounded-lg border transition",
                            pendingDeleteRecurringId === activity.id
                              ? "border-red-500 text-red-500 bg-red-500/10 hover:bg-red-500/15"
                              : "border-[color:var(--line)] hover:border-red-400 hover:text-red-500"
                          )}
                          onClick={() => {
                            if (pendingDeleteRecurringId !== activity.id) {
                              setPendingDeleteRecurringId(activity.id);
                              return;
                            }
                            if (editingRecurringId === activity.id) resetRecurringForm();
                            removeRecurringActivity(primaryGameId, activity.id);
                            setPendingDeleteRecurringId(null);
                          }}
                        >
                          {pendingDeleteRecurringId === activity.id ? "确认" : "删除"}
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-xs text-[color:var(--muted)]">当前游戏尚未配置循环活动</div>
                )}
              </div>
            </div>
    </section>
  ) : null;

  const versionScroller =
    isHome && versionRows.length > 0 ? (
      <div className="lg:hidden -mx-4 md:-mx-8 px-4 md:px-8 overflow-x-auto no-scrollbar">
        <div className="flex gap-2.5 w-max">
          {versionRows.map((row) => {
            const meta = GAME_REGISTRY_BY_ID[row.gameId];
            const urgent = row.valid && row.remainingMs <= DAY_MS;
            return (
              <Link
                key={row.gameId}
                to={meta.route}
                className="w-[220px] shrink-0 rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)] px-3.5 py-3 grid gap-2.5"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <img src={meta.icon} alt={meta.name} className="w-[30px] h-[30px] rounded-[9px] object-cover" referrerPolicy="no-referrer" />
                  <div className="min-w-0 flex-1">
                    {row.valid ? (
                      <div className="flex items-center gap-1.5 min-w-0">
                        {row.name ? <span className="text-[13px] font-semibold truncate">{row.name}</span> : null}
                        {row.num ? (
                          <span className="shrink-0 px-1.5 py-px rounded-md border border-[color:var(--line)] bg-[color:var(--surface2)] font-mono text-[11px] leading-4 text-[color:var(--ink2)]">
                            {row.num}
                          </span>
                        ) : null}
                      </div>
                    ) : (
                      <div className="text-xs text-[color:var(--muted)]">暂无版本数据</div>
                    )}
                  </div>
                </div>
                {row.valid ? (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 rounded-full bg-[color:var(--line-soft)] overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${row.pct}%`, background: urgent ? "var(--urgent)" : gameColorVar(row.gameId) }} />
                    </div>
                    <span
                      className="inline-flex items-center gap-1 text-xs font-semibold font-mono whitespace-nowrap"
                      style={{ color: urgent ? "var(--urgent)" : "var(--ink2)" }}
                    >
                      {urgent ? <ClockIcon /> : null}
                      剩 {formatRemainingShort(row.remainingMs)}
                    </span>
                  </div>
                ) : null}
              </Link>
            );
          })}
        </div>
      </div>
    ) : null;

  const versionCard =
    isHome && versionRows.length > 0 ? (
      <div className="hidden lg:block">
        <SideCard title="版本进度">
          {versionRows.map((row) => {
            const meta = GAME_REGISTRY_BY_ID[row.gameId];
            const urgent = row.valid && row.remainingMs <= DAY_MS;
            return (
              <Link
                key={row.gameId}
                to={meta.route}
                className="grid gap-2 py-2.5 border-t border-[color:var(--line-soft)] rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
              >
                <div className="flex items-center gap-2.5">
                  <img src={meta.icon} alt={meta.name} className="w-7 h-7 shrink-0 rounded-lg object-cover" referrerPolicy="no-referrer" />
                  <div className="min-w-0 flex-1">
                    {row.valid ? (
                      <div className="flex items-center gap-1.5 min-w-0">
                        {row.name ? <span className="text-[13px] font-semibold truncate">{row.name}</span> : null}
                        {row.num ? (
                          <span className="shrink-0 px-1.5 py-px rounded-md border border-[color:var(--line)] bg-[color:var(--surface2)] font-mono text-[11px] leading-4 text-[color:var(--ink2)]">
                            {row.num}
                          </span>
                        ) : null}
                      </div>
                    ) : (
                      <div className="text-xs text-[color:var(--muted)]">暂无版本数据</div>
                    )}
                  </div>
                  <span
                    className="inline-flex items-center gap-1 text-xs font-semibold font-mono whitespace-nowrap"
                    style={{ color: !row.valid ? "var(--muted)" : urgent ? "var(--urgent)" : "var(--ink2)" }}
                  >
                    {urgent ? <ClockIcon /> : null}
                    {row.valid ? `剩 ${formatRemainingShort(row.remainingMs)}` : "—"}
                  </span>
                </div>
                {row.valid ? (
                  <div className="h-1.5 rounded-full bg-[color:var(--line-soft)] overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${row.pct}%`, background: urgent ? "var(--urgent)" : gameColorVar(row.gameId) }} />
                  </div>
                ) : null}
              </Link>
            );
          })}
        </SideCard>
      </div>
    ) : null;

  // Remaining time with the end time underneath, matching the 即将结束 rows.
  const gachaRemaining = (remaining: ReturnType<typeof describeRemaining>) => (
    <span className="shrink-0 max-w-[128px] text-right">
      <span className="flex items-center justify-end gap-1 text-xs font-semibold font-mono whitespace-nowrap" style={{ color: toneColor(remaining.tone) }}>
        {remaining.tone === "urgent" ? <ClockIcon /> : null}
        {remaining.primary}
      </span>
      <span className="block font-mono text-[10px] text-[color:var(--muted)] truncate" title={remaining.secondary}>
        {remaining.secondary}
      </span>
    </span>
  );
  const gachaCard = (
    <SideCard title="卡池" meta={isHome ? undefined : `${gachaGroups.length} 个`}>
      {gachaGroups.length > 0 ? (
        <div className={clsx(isHome ? "" : "grid gap-2 pt-1 pb-2")}>
          {gachaGroups.map((group) => {
            const first = group.events[0]!;
            const meta = GAME_META[first.sourceGameId];
            const remaining = describeRemaining(first, false);
            const isSelected = group.events.some((event) => event.eventKey === selectedKey);
            const title = gachaGroupTitle(group.events);
            if (!isHome) {
              return (
                <button
                  key={group.key}
                  type="button"
                  aria-expanded={isSelected}
                  onClick={() => toggleSelected(first.eventKey)}
                  className={clsx(
                    "text-left grid gap-1 px-3.5 py-3 rounded-xl transition",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]",
                    isSelected ? "ring-2 ring-[color:var(--accent)]" : ""
                  )}
                  style={{ background: `color-mix(in srgb, ${gameColorVar(first.sourceGameId)} 16%, transparent)` }}
                >
                  <span className="flex items-center justify-between gap-3">
                    <span className="min-w-0 text-sm font-semibold leading-snug">{title}</span>
                    {gachaRemaining(remaining)}
                  </span>
                </button>
              );
            }
            // The divider sits on the wrapper so the selected highlight can be a rounded pill
            // that extends slightly past the content instead of a hard-edged strip.
            return (
              <div key={group.key} className="border-t border-[color:var(--line-soft)] py-1">
                <button
                  type="button"
                  aria-expanded={isSelected}
                  onClick={() => toggleSelected(first.eventKey)}
                  className={clsx(
                    "-mx-2 w-[calc(100%+1rem)] px-2 py-1.5 rounded-xl text-left flex items-center gap-2.5 transition-colors",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]",
                    isSelected ? "bg-[color:var(--accent-soft)]" : "hover:bg-[color:var(--tile)]"
                  )}
                >
                  <img src={meta.icon} alt={meta.name} className="w-7 h-7 shrink-0 rounded-lg object-cover" referrerPolicy="no-referrer" />
                  <div className="min-w-0 flex-1 text-[13px] font-semibold truncate">{title}</div>
                  {gachaRemaining(remaining)}
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="py-3 text-xs text-[color:var(--muted)]">暂无进行中的卡池</div>
      )}
    </SideCard>
  );

  const codesCard =
    codeEvents.length > 0 ? (
      <SideCard title="兑换码" meta={`${codeEvents.length} 组可用`}>
        <div className="grid gap-3 pt-1 pb-3">
          {codeEvents.map((event) => (
            <div key={event.eventKey} className="grid gap-1.5">
              <div className="flex items-center gap-2 text-[13px] font-semibold min-w-0">
                {showGameMeta ? (
                  <img src={GAME_META[event.sourceGameId].icon} alt="" className="w-5 h-5 rounded-md object-cover" referrerPolicy="no-referrer" />
                ) : null}
                <span className="truncate">{event.title}</span>
              </div>
              <RedeemCodeList codes={event.redeem_codes ?? []} />
              <div className="text-[11px] font-mono text-[color:var(--muted)]">{event._e.format("MM/DD HH:mm")} 失效</div>
            </div>
          ))}
        </div>
      </SideCard>
    ) : (
      <section className="rounded-2xl border border-dashed border-[color:var(--line)] px-4 py-3.5 flex items-center gap-3">
        <svg className="w-[18px] h-[18px] shrink-0 text-[color:var(--muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 12v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8" />
          <rect x="2" y="7" width="20" height="5" rx="1" />
          <path d="M12 21V7M12 7H7.5a2.5 2.5 0 1 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 1 0 0-5C13 2 12 7 12 7z" />
        </svg>
        <div className="grid gap-0.5">
          <span className="text-[13px] font-semibold">暂无可用兑换码</span>
          <span className="text-[11px] text-[color:var(--muted)]">前瞻直播后会出现在这里，点击即可复制</span>
        </div>
      </section>
    );

  const recurringCard = !isHome ? (
    <SideCard
      title="循环活动"
      action={
        <button
          type="button"
          onClick={toggleRecurringSettings}
          aria-expanded={isRecurringSettingsOpen}
          className={clsx(
            "h-8 px-2.5 rounded-lg border text-xs font-semibold transition",
            isRecurringSettingsOpen
              ? "border-[color:var(--accent)] text-[color:var(--accent)]"
              : "border-[color:var(--line)] text-[color:var(--ink2)] hover:border-[color:var(--ink)]"
          )}
        >
          {isRecurringSettingsOpen ? "完成" : "编辑"}
        </button>
      }
    >
      {recurringDefinitionsSorted.length > 0 ? (
        <div className="pb-2">
          {recurringDefinitionsSorted.map((activity) => (
            <div key={activity.id} className="py-2 border-t border-[color:var(--line-soft)]">
              <div className="text-[13px] font-semibold">{activity.title}</div>
              <div className="text-[11px] text-[color:var(--muted)]">
                {formatRecurringRule(primaryGameId, activity.rule, activity.durationDays)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="py-3 text-xs text-[color:var(--muted)]">当前游戏尚未配置循环活动</div>
      )}
    </SideCard>
  ) : null;

  const homeSummary =
    isHome && homeStats ? (
      <section className="flex flex-col md:flex-row md:items-end md:justify-between gap-3 md:gap-6">
        <div className="grid gap-1">
          <h1 className="text-2xl md:text-[30px] font-bold tracking-tight leading-tight">{formatDayLabel(now)}</h1>
          <div className="text-xs md:text-[13px] text-[color:var(--muted)]">
            现在 {now.format("HH:mm")} · {formatLocalUtcOffsetLabel(now.toDate())}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 md:flex md:gap-2.5">
          <div className="rounded-xl bg-[color:var(--urgent-soft)] px-3 md:px-4 py-2.5 grid gap-0.5 md:min-w-[120px]">
            <span className="text-[11px] md:text-xs font-semibold text-[color:var(--urgent)]">24 小时内结束</span>
            <span className="text-xl md:text-[22px] font-bold font-mono text-[color:var(--urgent)]">{homeStats.urgent}</span>
          </div>
          <div className="rounded-xl border border-[color:var(--line)] bg-[color:var(--card)] px-3 md:px-4 py-2.5 grid gap-0.5 md:min-w-[120px]">
            <span className="text-[11px] md:text-xs font-semibold text-[color:var(--muted)]">48 小时内结束</span>
            <span className="text-xl md:text-[22px] font-bold font-mono">{homeStats.soon}</span>
          </div>
          <div className="rounded-xl border border-[color:var(--line)] bg-[color:var(--card)] px-3 md:px-4 py-2.5 grid gap-0.5 md:gap-1.5 md:min-w-[180px]">
            <span className="text-[11px] md:text-xs font-semibold text-[color:var(--muted)]">已完成</span>
            <div className="flex items-center gap-2.5">
              <span className="text-xl md:text-[22px] font-bold font-mono">
                {homeStats.done}
                <span className="text-[13px] md:text-[22px] text-[color:var(--muted)] md:text-[color:var(--ink)]">/{homeStats.total}</span>
              </span>
              <div className="hidden md:block flex-1 h-1.5 rounded-full bg-[color:var(--line-soft)] overflow-hidden">
                <div
                  className="h-full rounded-full bg-[color:var(--ink)]"
                  style={{ width: `${homeStats.total > 0 ? (homeStats.done / homeStats.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      </section>
    ) : null;

  const versionProgress = (() => {
    if (!currentVersion) return null;
    const s = parseDateTime(currentVersion.start_time);
    const e = parseDateTime(currentVersion.end_time);
    if (!s.isValid() || !e.isValid() || !e.isAfter(s)) return null;
    const pct = clamp(((now.valueOf() - s.valueOf()) / (e.valueOf() - s.valueOf())) * 100, 0, 100);
    const elapsedMs = Math.max(0, now.valueOf() - s.valueOf());
    const remainingMs = Math.max(0, e.valueOf() - now.valueOf());
    return { s, e, pct, elapsedMs, remainingMs, label: splitVersionLabel(currentVersion) };
  })();

  const gameHero = !isHome ? (
    <section className="rounded-2xl border border-[color:var(--line)] bg-[color:var(--card)] shadow-ink p-4 md:px-6 md:py-5 flex flex-col md:flex-row md:items-center gap-4 md:gap-7">
      <div className="flex items-start md:items-center gap-3 md:gap-5 flex-1 min-w-0">
        <img src={gameMeta.icon} alt="" className="w-12 h-12 md:w-16 md:h-16 rounded-xl md:rounded-2xl object-cover shrink-0" referrerPolicy="no-referrer" />
        <div className="flex-1 min-w-0 grid gap-2.5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h1 className="text-xl md:text-[26px] font-bold leading-tight">{gameMeta.name}</h1>
            {versionProgress?.label.num ? (
              <span className="text-[15px] font-semibold font-mono" style={{ color: gameInkVar(primaryGameId) }}>
                {versionProgress.label.num}
              </span>
            ) : null}
            {versionProgress?.label.name ? <span className="text-[15px] text-[color:var(--ink2)]">{versionProgress.label.name}</span> : null}
          </div>
          {versionProgress ? (
            <div className="grid gap-1.5">
              <div className="h-2.5 rounded-full bg-[color:var(--line-soft)]">
                <div className="h-full rounded-full" style={{ width: `${versionProgress.pct}%`, background: gameColorVar(primaryGameId) }} />
              </div>
              <div className="flex justify-between gap-2 text-[11px] md:text-xs font-mono text-[color:var(--muted)]">
                <span className="hidden md:inline">{versionProgress.s.format("MM/DD HH:mm")} 开始</span>
                <span className="font-semibold text-[color:var(--ink2)]">
                  已进行 {formatRemainingShort(versionProgress.elapsedMs)} · 剩 {formatRemainingShort(versionProgress.remainingMs)}（
                  {Math.round(versionProgress.pct)}%）
                </span>
                <span className="hidden md:inline">{versionProgress.e.format("MM/DD HH:mm")} 结束</span>
              </div>
            </div>
          ) : (
            <div className="text-xs text-[color:var(--muted)]">
              {props.currentVersionState?.status === "loading" ? "版本信息加载中..." : "暂无版本数据"}
            </div>
          )}
        </div>
      </div>
      <div className="hidden md:block w-px self-stretch bg-[color:var(--line)]" aria-hidden="true" />
      <div className="flex md:flex-col items-center md:items-start justify-between gap-2 md:shrink-0 md:min-w-[84px]">
        <span className="text-xs font-semibold text-[color:var(--muted)]">月卡剩余</span>
        {isMonthlyCardEditing ? (
          <div className="flex items-center gap-2">
            <input
              ref={monthlyCardInputRef}
              type="text"
              inputMode="numeric"
              aria-label="月卡剩余天数"
              value={monthlyCardDraft}
              onChange={(e) => {
                const next = e.target.value;
                if (/^\d*$/.test(next)) setMonthlyCardDraft(next);
              }}
              onBlur={commitMonthlyCardEditing}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitMonthlyCardEditing();
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  cancelMonthlyCardEditing();
                }
              }}
              placeholder="天数"
              className="w-16 h-10 px-2.5 rounded-xl border border-[color:var(--line)] bg-[color:var(--surface2)] text-[15px] font-mono text-[color:var(--ink)]"
            />
            <span className="text-sm text-[color:var(--muted)]">天</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={startMonthlyCardEditing}
            title="点击直接输入月卡剩余天数"
            className={clsx(
              "h-10 px-3.5 rounded-xl border border-[color:var(--line)] bg-[color:var(--surface2)] text-[15px] font-mono font-semibold",
              "hover:border-[color:var(--ink)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]",
              isMonthlyCardUrgent ? "text-[color:var(--urgent)]" : monthlyCardRemainingDays == null ? "text-[color:var(--muted)]" : "text-[color:var(--ink)]"
            )}
          >
            {monthlyCardRemainingDays == null ? "未设置" : `${monthlyCardRemainingDays} 天`}
          </button>
        )}
      </div>
    </section>
  ) : null;

  return (
    <div className="grid grid-cols-1 gap-4 md:gap-6">
      {homeSummary}
      {gameHero}
      {versionScroller}
      <div className="grid gap-4 md:gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <div className="grid grid-cols-1 gap-4 min-w-0">
          {timelineCard}
          {detailPanel}
          {recurringSettingsPanel}
        </div>
        <aside className="grid grid-cols-1 gap-4 md:gap-5 min-w-0 content-start">
          {versionCard}
          {gachaCard}
          {recurringCard}
          {codesCard}
        </aside>
      </div>
    </div>
  );
}
