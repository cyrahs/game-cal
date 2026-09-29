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
import { computeRecurringWindow } from "../src/lib/recurring";
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
        const w = computeRecurringWindow(now, gameId as GameId, activity);
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
