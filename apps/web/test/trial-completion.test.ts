import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type CompletionId,
  areTrialUnitsDone,
  trialToggleIds,
  trialUnitsForBanner,
} from "../src/lib/trialCompletion";

function apply(completed: Set<CompletionId>, flips: CompletionId[]): Set<CompletionId> {
  const next = new Set(completed);
  for (const id of flips) {
    if (next.has(id)) next.delete(id);
    else next.add(id);
  }
  return next;
}

test("single-character banners keep the banner id", () => {
  const units = trialUnitsForBanner(21876, ["薇斯纳"]);
  assert.deepEqual(units, [{ bannerId: 21876, partId: 21876, bannerPartIds: [21876] }]);
  assert.deepEqual(trialToggleIds(new Set(), units), [21876]);
  assert.deepEqual(trialToggleIds(new Set([21876]), units), [21876]);
});

test("multi-character banners are checked off per character", () => {
  const [a, b] = trialUnitsForBanner("zzz-gacha:243", ["洛克茜", "普罗米娅"]);
  let done = apply(new Set(), trialToggleIds(new Set(), [a!]));
  assert.deepEqual([...done], ["zzz-gacha:243#洛克茜"]);
  assert.equal(areTrialUnitsDone(done, [a!]), true);
  assert.equal(areTrialUnitsDone(done, [b!]), false);
  assert.equal(areTrialUnitsDone(done, [a!, b!]), false);

  // Home's merged row checks the remaining character only, then unchecks both.
  done = apply(done, trialToggleIds(done, [a!, b!]));
  assert.equal(areTrialUnitsDone(done, [a!, b!]), true);
  done = apply(done, trialToggleIds(done, [a!, b!]));
  assert.equal(done.size, 0);
});

test("a banner checked as a whole before the split still counts, and unchecking one keeps the other", () => {
  const [a, b] = trialUnitsForBanner("zzz-gacha:243", ["洛克茜", "普罗米娅"]);
  let done = new Set<CompletionId>(["zzz-gacha:243"]);
  assert.equal(areTrialUnitsDone(done, [a!]), true);
  assert.equal(areTrialUnitsDone(done, [b!]), true);

  done = apply(done, trialToggleIds(done, [a!]));
  assert.deepEqual([...done], ["zzz-gacha:243#普罗米娅"]);
  assert.equal(areTrialUnitsDone(done, [a!]), false);
  assert.equal(areTrialUnitsDone(done, [b!]), true);
});
