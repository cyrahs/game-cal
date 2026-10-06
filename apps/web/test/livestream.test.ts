import assert from "node:assert/strict";
import { test } from "node:test";

import type { CalendarEvent } from "../src/api/types";
import {
  LIVESTREAM_RULES,
  describeLivestreamRule,
  livestreamTimeFromRule,
  predictLivestream,
  resolveLivestream,
} from "../src/lib/livestream";

const ms = (iso: string) => Date.parse(iso);

test("livestreamTimeFromRule matches past official streams", () => {
  // ZZZ 3.2 stream before the 3.1 → 3.2 update on Wed 09/09.
  assert.equal(livestreamTimeFromRule(LIVESTREAM_RULES.zzz!, ms("2026-09-09T06:59:59+08:00")), ms("2026-08-28T19:30:00+08:00"));
  // Endfield 「雪凇幽梦」 stream before its Wed 09/02 update.
  assert.equal(
    livestreamTimeFromRule(LIVESTREAM_RULES.endfield!, ms("2026-09-02T06:00:00+08:00")),
    ms("2026-08-21T19:30:00+08:00")
  );
  // WW 3.6 stream before its Thu 08/20 update.
  assert.equal(livestreamTimeFromRule(LIVESTREAM_RULES.ww!, ms("2026-08-20T03:59:59+08:00")), ms("2026-08-07T19:00:00+08:00"));
});

test("livestreamTimeFromRule uses UTC+8 weeks even when the end is the previous UTC day", () => {
  // Wed 11/04 06:00 UTC+8 is Tue 11/03 22:00 UTC.
  assert.equal(
    livestreamTimeFromRule(LIVESTREAM_RULES.genshin!, ms("2026-11-04T06:00:00+08:00")),
    ms("2026-10-23T20:00:00+08:00")
  );
  // A version ending on a Monday still counts from that Monday's week.
  assert.equal(
    livestreamTimeFromRule(LIVESTREAM_RULES.starrail!, ms("2026-09-28T07:00:00+08:00")),
    ms("2026-09-18T19:30:00+08:00")
  );
});

test("predictLivestream returns a prediction inside the current version only", () => {
  const p = predictLivestream("genshin", ms("2026-09-23T07:00:00+08:00"), ms("2026-11-04T06:00:00+08:00"));
  assert.deepEqual(p, {
    kind: "predicted",
    startMs: ms("2026-10-23T20:00:00+08:00"),
    ruleText: "版本结束前两周的周五 20:00",
  });
  // A version too short to contain the stream.
  assert.equal(predictLivestream("genshin", ms("2026-10-26T07:00:00+08:00"), ms("2026-11-04T06:00:00+08:00")), null);
  // No known pattern.
  assert.equal(predictLivestream("snowbreak", ms("2026-09-23T07:00:00+08:00"), ms("2026-11-04T06:00:00+08:00")), null);
});

test("describeLivestreamRule reads like the official wording", () => {
  assert.equal(describeLivestreamRule(LIVESTREAM_RULES.ww!), "版本结束前两周的周五 19:00");
});

function stream(id: string, title: string, start: string): CalendarEvent {
  return {
    id: `starrail:livestream-code:schedule:${id}`,
    title,
    start_time: start,
    end_time: start,
    is_livestream: true,
    linkUrl: `https://www.miyoushe.com/sr/article/${id}`,
  };
}

test("resolveLivestream prefers the announced stream of the next version", () => {
  const versionStart = ms("2026-09-28T07:00:00+08:00");
  const versionEnd = ms("2026-11-11T07:00:00+08:00");
  const events = [
    // The current version's own stream aired before it started.
    stream("1", "4.6版本前瞻特别节目", "2026-09-20T19:30:00+08:00"),
    stream("2", "4.7版本前瞻特别节目", "2026-11-01T19:30:00+08:00"),
    { ...stream("3", "not a stream", "2026-10-30T19:30:00+08:00"), is_livestream: false },
  ];
  assert.deepEqual(resolveLivestream("starrail", events, versionStart, versionEnd), {
    kind: "confirmed",
    startMs: ms("2026-11-01T19:30:00+08:00"),
    title: "4.7版本前瞻特别节目",
    linkUrl: "https://www.miyoushe.com/sr/article/2",
  });
  // Nothing announced yet: fall back to the prediction.
  assert.equal(resolveLivestream("starrail", events.slice(0, 1), versionStart, versionEnd)?.kind, "predicted");
  assert.equal(
    resolveLivestream("starrail", [], versionStart, versionEnd)?.startMs,
    ms("2026-10-30T19:30:00+08:00")
  );
});
