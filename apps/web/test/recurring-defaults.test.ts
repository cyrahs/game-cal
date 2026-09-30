import assert from "node:assert/strict";
import { test } from "node:test";

import dayjs from "dayjs";

import type { GameId } from "../src/api/types";
import {
  DEFAULT_RECURRING_ACTIVITIES_BY_GAME,
  coercePrefs,
  parseRecurringSettingsImport,
  type RecurringActivity,
} from "../src/context/prefs";
import defaultTemplate from "../src/data/default-recurring-events.json";
import type { GameVersionInfo } from "../src/api/types";
import { computeRecurringWindow, formatRecurringRule } from "../src/lib/recurring";
import { toIsoWithOffset } from "../src/lib/time";

type RawActivity = { id: string; title: string };
const rawByGame = defaultTemplate.recurringActivitiesByGame as Record<string, RawActivity[]>;

function defaultsFor(gameId: GameId): RecurringActivity[] {
  return DEFAULT_RECURRING_ACTIVITIES_BY_GAME[gameId] ?? [];
}

function findDefault(gameId: GameId, title: string): RecurringActivity {
  const activity = defaultsFor(gameId).find((a) => a.title === title);
  assert.ok(activity, `missing default ${gameId}/${title}`);
  return activity;
}

test("default template is a v1 recurring-settings export", () => {
  assert.equal(defaultTemplate.type, "game-cal.recurring-settings");
  assert.equal(defaultTemplate.v, 1);
});

test("every default activity survives import coercion unchanged", () => {
  for (const [gameId, rawList] of Object.entries(rawByGame)) {
    const parsed = defaultsFor(gameId as GameId);
    assert.deepEqual(
      parsed.map((a) => a.id),
      rawList.map((a) => a.id),
      `${gameId}: coercion dropped or reordered entries`
    );
    assert.deepEqual(
      parsed.map((a) => a.title),
      rawList.map((a) => a.title),
      `${gameId}: coercion changed titles`
    );
  }
  assert.deepEqual(parseRecurringSettingsImport(defaultTemplate), DEFAULT_RECURRING_ACTIVITIES_BY_GAME);
});

test("default activity ids are unique across games", () => {
  const ids = Object.values(rawByGame).flatMap((list) => list.map((a) => a.id));
  assert.equal(new Set(ids).size, ids.length);
});

test("every default activity yields a valid window at any point in a year", () => {
  // After the latest interval anchor (2026-04-27), so every window is a real past cycle start.
  const from = dayjs("2026-06-01T00:00:00+08:00");
  for (const [gameId, list] of Object.entries(DEFAULT_RECURRING_ACTIVITIES_BY_GAME)) {
    for (const activity of list ?? []) {
      for (let h = 0; h < 366 * 24; h += 7) {
        const now = from.add(h, "hour");
        // Version-following rules get a version that is current at `now`.
        const version: GameVersionInfo = {
          game: gameId as GameId,
          version: "x",
          start_time: toIsoWithOffset(now.subtract(3, "day")),
          end_time: toIsoWithOffset(now.add(39, "day")),
        };
        const w = computeRecurringWindow(now, gameId as GameId, activity, version);
        const label = `${gameId}/${activity.title} @ ${now.toISOString()}`;
        assert.ok(w.start.isValid() && w.end.isValid(), `${label}: invalid window`);
        assert.ok(w.end.isAfter(w.start), `${label}: empty window`);
        assert.ok(!now.isBefore(w.start), `${label}: window starts in the future`);
      }
    }
  }
});

// 2026-09-29 (Tuesday) 12:00 UTC+8.
const NOW = dayjs("2026-09-29T12:00:00+08:00");

function windowOf(gameId: GameId, title: string): [string, string] {
  const w = computeRecurringWindow(NOW, gameId, findDefault(gameId, title));
  return [toIsoWithOffset(w.start), toIsoWithOffset(w.end)];
}

test("interval defaults land on the expected cycles", () => {
  assert.deepEqual(windowOf("starrail", "末日幻影"), ["2026-08-31T04:00:00+08:00", "2026-10-12T04:00:00+08:00"]);
  assert.deepEqual(windowOf("starrail", "虚构叙事"), ["2026-09-14T04:00:00+08:00", "2026-10-26T04:00:00+08:00"]);
  assert.deepEqual(windowOf("starrail", "混沌回忆"), ["2026-09-28T04:00:00+08:00", "2026-11-09T04:00:00+08:00"]);
  assert.deepEqual(windowOf("zzz", "危局强袭战"), ["2026-09-25T04:00:00+08:00", "2026-10-09T04:00:00+08:00"]);
  assert.deepEqual(windowOf("zzz", "式舆防卫战"), ["2026-09-18T04:00:00+08:00", "2026-10-02T04:00:00+08:00"]);
  assert.deepEqual(windowOf("ww", "冥歌海墟"), ["2026-09-28T04:00:00+08:00", "2026-10-26T04:00:00+08:00"]);
  assert.deepEqual(windowOf("ww", "逆境深塔"), ["2026-09-14T04:00:00+08:00", "2026-10-12T04:00:00+08:00"]);
});

test("weekly, monthly and cron defaults land on the expected cycles", () => {
  assert.deepEqual(windowOf("starrail", "差分宇宙/货币战争"), ["2026-09-28T04:00:00+08:00", "2026-10-05T04:00:00+08:00"]);
  assert.deepEqual(windowOf("genshin", "深境螺旋"), ["2026-09-16T04:00:00+08:00", "2026-10-16T04:00:00+08:00"]);
  assert.deepEqual(windowOf("genshin", "商店兑换"), ["2026-09-01T04:00:00+08:00", "2026-10-01T04:00:00+08:00"]);
  assert.deepEqual(windowOf("snowbreak", "地下清理"), ["2026-09-16T04:00:00+08:00", "2026-10-01T04:00:00+08:00"]);
  // Friday 04:00 for 3 days: last week's run ended Monday, so NOW is between runs.
  assert.deepEqual(windowOf("snowbreak", "精神拟境 & 信源研析"), ["2026-09-25T04:00:00+08:00", "2026-09-28T04:00:00+08:00"]);
  assert.deepEqual(windowOf("endfield", "周常&兑换"), ["2026-09-28T04:00:00+08:00", "2026-10-05T04:00:00+08:00"]);
});

test("fresh prefs start from the defaults", () => {
  assert.deepEqual(coercePrefs(null).timeline.recurringActivitiesByGame, DEFAULT_RECURRING_ACTIVITIES_BY_GAME);
  assert.deepEqual(coercePrefs({ v: 1, timeline: {} }).timeline.recurringActivitiesByGame, DEFAULT_RECURRING_ACTIVITIES_BY_GAME);
});

test("stored recurring settings are kept as-is, including an emptied list", () => {
  const custom = { genshin: [{ id: "ra_custom", title: "自定义", rule: { kind: "weekly", weekday: 3, hour: 5, minute: 0 } }] };
  const kept = coercePrefs({ v: 1, timeline: { recurringActivitiesByGame: custom } }).timeline.recurringActivitiesByGame;
  assert.deepEqual(Object.keys(kept), ["genshin"]);
  assert.equal(kept.genshin?.[0]?.id, "ra_custom");

  const emptied = coercePrefs({ v: 1, timeline: { recurringActivitiesByGame: {} } }).timeline.recurringActivitiesByGame;
  assert.deepEqual(emptied, {});
});

// Wuthering Waves 3.7 as reported by the live API.
const WW_VERSION: GameVersionInfo = {
  game: "ww",
  version: "「镜锁妄世，心照红尘」",
  start_time: "2026-09-30T09:20:00+08:00",
  end_time: "2026-11-12T03:59:59+08:00",
};

test("the Wuthering Waves shop default follows the current version", () => {
  const shop = findDefault("ww", "商店兑换");
  assert.deepEqual(shop.rule, { kind: "version" });
  const now = dayjs("2026-10-05T12:00:00+08:00");
  const w = computeRecurringWindow(now, "ww", shop, WW_VERSION);
  assert.deepEqual(
    [toIsoWithOffset(w.start), toIsoWithOffset(w.end), w.cycleKey],
    ["2026-09-30T09:20:00+08:00", "2026-11-12T03:59:59+08:00", "2026-09-30T09:20:00+08:00"]
  );
  assert.equal(formatRecurringRule("ww", shop.rule), "每次版本更新时刷新");
});

test("version rules have no window without the game's version", () => {
  const activity: RecurringActivity = { id: "ra_v", title: "商店兑换", rule: { kind: "version" } };
  const now = dayjs("2026-10-05T12:00:00+08:00");
  assert.equal(computeRecurringWindow(now, "ww", activity).start.isValid(), false);
  assert.equal(computeRecurringWindow(now, "ww", activity, null).start.isValid(), false);
  assert.equal(computeRecurringWindow(now, "zzz", activity, WW_VERSION).start.isValid(), false);
});

test("version rules honour durationDays and survive import", () => {
  const activity: RecurringActivity = { id: "ra_v", title: "限时商店", rule: { kind: "version" }, durationDays: 14 };
  const w = computeRecurringWindow(dayjs("2026-10-05T12:00:00+08:00"), "ww", activity, WW_VERSION);
  assert.equal(toIsoWithOffset(w.end), "2026-10-14T09:20:00+08:00");
  const parsed = parseRecurringSettingsImport({ recurringActivitiesByGame: { ww: [activity] } });
  assert.deepEqual(parsed?.ww, [activity]);
});
