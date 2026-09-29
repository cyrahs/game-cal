import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";

import { getClockNowMs, subscribeClock } from "../src/lib/clock";
import { formatDuration } from "../src/lib/time";

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

test("formatDuration shows days and hours from one day up", () => {
  assert.equal(formatDuration(3 * D + 5 * H + 59 * M), "3d5h");
  assert.equal(formatDuration(D), "1d0h");
  assert.equal(formatDuration(12 * D + 23 * H + 59 * M + 59 * S), "12d23h");
});

test("formatDuration shows hours and minutes under a day", () => {
  assert.equal(formatDuration(D - 1), "23h59m");
  assert.equal(formatDuration(5 * H + 12 * M + 30 * S), "5h12m");
  assert.equal(formatDuration(H), "1h0m");
});

test("formatDuration shows minutes and seconds under an hour", () => {
  assert.equal(formatDuration(H - 1), "59m59s");
  assert.equal(formatDuration(12 * M + 30 * S + 999), "12m30s");
  assert.equal(formatDuration(9 * S), "0m9s");
  assert.equal(formatDuration(0), "0m0s");
  assert.equal(formatDuration(-5 * S), "0m0s");
});

afterEach(() => mock.timers.reset());

// Advance one second at a time: each tick schedules the next timeout.
function tickSeconds(n: number) {
  for (let i = 0; i < n; i++) mock.timers.tick(1000);
}

test("shared clock ticks every second only while subscribed", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  let calls = 0;
  const unsubscribe = subscribeClock(() => calls++);
  tickSeconds(1);
  assert.equal(calls, 1);
  assert.equal(getClockNowMs(), 11_000);
  tickSeconds(3);
  assert.equal(calls, 4);

  // A second subscriber shares the same timer.
  let other = 0;
  const unsubscribeOther = subscribeClock(() => other++);
  mock.timers.tick(1000);
  assert.equal(calls, 5);
  assert.equal(other, 1);

  unsubscribe();
  unsubscribeOther();
  tickSeconds(5);
  assert.equal(calls, 5);
  assert.equal(other, 1);
  // With no subscribers the clock falls back to the real time.
  assert.equal(getClockNowMs(), 20_000);
});

test("shared clock aligns ticks to whole seconds", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_400 });
  let calls = 0;
  const unsubscribe = subscribeClock(() => calls++);
  mock.timers.tick(599);
  assert.equal(calls, 0);
  mock.timers.tick(1);
  assert.equal(calls, 1);
  assert.equal(getClockNowMs(), 11_000);
  unsubscribe();
});
