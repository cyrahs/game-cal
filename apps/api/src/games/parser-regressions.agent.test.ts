import { strict as assert } from "node:assert";
import test from "node:test";

import {
  compareEndfieldVersionNoticeOrder,
  getEndfieldVersionNoticePriority,
  isEndfieldVersionNoticeCandidate,
  parseEndfieldWindowText,
} from "./endfield.js";
import { extractStarRailTimeRangeFromContent } from "./starrail.js";

test("Star Rail rejects unresolved version-relative starts instead of using list metadata", () => {
  const range = extractStarRailTimeRangeFromContent(
    "<p>活动时间</p><p>4.2版本更新后 - 4.4版本结束前</p><p>参与条件</p>",
    {
      title: "「千星旅伴」：登录领取旅伴金灵*1",
      versionMaintenanceEndByLabel: new Map(),
      singleVersionMaintenanceEndIso: null,
      listEndIso: "2026-08-26T06:00:00+08:00",
    }
  );

  assert.equal(range.startIso, null);
  assert.equal(range.unresolvedVersionStart, true);
});

test("Star Rail preserves an explicit long-term start alongside version wording", () => {
  const range = extractStarRailTimeRangeFromContent(
    "<p>活动时间</p><p>4.2版本更新后，2026/07/24 12:00:00 后长期开放</p><p>参与条件</p>",
    {
      title: "长期开放活动",
      versionMaintenanceEndByLabel: new Map(),
      singleVersionMaintenanceEndIso: null,
      listEndIso: "2036-07-03T00:00:00+08:00",
    }
  );

  assert.deepEqual(range, {
    startIso: "2026-07-24T12:00:00+08:00",
    endIso: null,
    endText: "长期开放",
  });
});

test("Endfield uses maintenance previews to resolve version-relative returner events", () => {
  const window = parseEndfieldWindowText(
    "「向渊行」版本更新维护后，激活「协议重连」活动当天至激活起第14天的次日04:00（服务器时间）结束"
  );

  assert.equal(
    isEndfieldVersionNoticeCandidate("「向渊行」版本更新维护预告", undefined),
    true
  );
  assert.equal(window.start, null);
  assert.equal(
    window.endText,
    "激活「协议重连」活动当天至激活起第14天的次日04:00（服务器时间）结束"
  );
});

test("Endfield prefers a full version notice over its maintenance preview", () => {
  const notices = [
    {
      title: "「向渊行」版本更新维护预告",
      version: "「向渊行」",
      priority: getEndfieldVersionNoticePriority("「向渊行」版本更新维护预告", undefined),
      maintenanceEndOrder: 2,
    },
    {
      title: "「向渊行」版本更新说明",
      version: "「向渊行」",
      priority: getEndfieldVersionNoticePriority("「向渊行」版本更新说明", undefined),
      maintenanceEndOrder: 1,
    },
  ].sort(compareEndfieldVersionNoticeOrder);

  assert.equal(notices[0]?.title, "「向渊行」版本更新说明");
});
