import { strict as assert } from "node:assert";
import test from "node:test";

import {
  compareEndfieldVersionNoticeOrder,
  fetchEndfieldEvents,
  getEndfieldVersionNoticePriority,
  isEndfieldVersionNoticeCandidate,
  parseEndfieldWindowText,
} from "./endfield.js";
import {
  extractStarRailTimeRangeFromContent,
  fetchStarRailEvents,
} from "./starrail.js";
import { extractZzzTimeRangeFromContent } from "./zzz.js";

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

test("Star Rail does not infer version starts across a major boundary or beyond three versions", () => {
  const content =
    "<p>活动时间</p><p>4.2版本更新后 - 4.4版本结束前</p><p>参与条件</p>";
  const common = {
    title: "「千星旅伴」：登录领取旅伴金灵*1",
    singleVersionMaintenanceEndIso: null,
    listEndIso: "2026-08-26T06:00:00+08:00",
  };

  for (const versionMaintenanceEndByLabel of [
    new Map([["4.6", "2026-10-07T11:00:00+08:00"]]),
    new Map([["5.0", "2026-10-07T11:00:00+08:00"]]),
  ]) {
    const range = extractStarRailTimeRangeFromContent(content, {
      ...common,
      versionMaintenanceEndByLabel,
    });
    assert.equal(range.startIso, null);
    assert.equal(range.unresolvedVersionStart, true);
  }
});

test("Star Rail chooses the nearest eligible later version anchor", () => {
  const range = extractStarRailTimeRangeFromContent(
    "<p>活动时间</p><p>4.2版本更新后 - 4.4版本结束前</p><p>参与条件</p>",
    {
      title: "「千星旅伴」：登录领取旅伴金灵*1",
      versionMaintenanceEndByLabel: new Map([
        ["4.4", "2026-07-15T11:00:00+08:00"],
        ["4.6", "2026-10-07T11:00:00+08:00"],
      ]),
      singleVersionMaintenanceEndIso: null,
      listEndIso: "2026-08-26T06:00:00+08:00",
    }
  );

  assert.deepEqual(range, {
    startIso: "2026-04-22T11:00:00+08:00",
    endIso: "2026-08-26T06:00:00+08:00",
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

test("Endfield ignores example dates outside the authoritative activity-time section", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        code: 0,
        data: {
          list: [
            {
              cid: "version-update",
              tab: "notice",
              title: "「向渊行」版本更新说明",
              data: {
                html: [
                  "<p>维护时间</p>",
                  "<p>2026/07/16 06:00 - 2026/07/16 12:00</p>",
                ].join(""),
              },
            },
            {
              cid: "protocol-reconnection",
              tab: "events",
              title: "协议重连",
              data: {
                html: [
                  "<p>▼//活动时间</p>",
                  "<p>「向渊行」版本更新维护后，激活「协议重连」活动当天至激活起第14天的次日04:00（服务器时间）结束</p>",
                  "<p>※ 例：若您在2026/01/01 04:00至2026/01/02 03:59（服务器时间）期间登录并激活了「协议重连」活动，则您的活动将开放至2026/01/15 04:00（服务器时间）。</p>",
                  "<p>▼//活动说明</p>",
                  "<p>回归管理员可参与本活动。</p>",
                ].join(""),
              },
            },
          ],
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );

  try {
    const events = await fetchEndfieldEvents({
      ENDFIELD_CODE: "fixture",
      ENDFIELD_AGGREGATE_API_URL: "https://fixture.invalid/aggregate",
    });
    const event = events.find((item) => item.title === "协议重连");
    assert.ok(event);
    assert.deepEqual(
      {
        start_time: event.start_time,
        end_time: event.end_time,
        end_time_kind: event.end_time_kind,
        end_time_text: event.end_time_text,
      },
      {
        start_time: "2026-07-16T12:00:00+08:00",
        end_time: null,
        end_time_kind: "relative",
        end_time_text:
          "激活「协议重连」活动当天至激活起第14天的次日04:00（服务器时间）结束",
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Endfield fails closed when a labeled time section is unresolved instead of using an example", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        code: 0,
        data: {
          list: [
            {
              cid: "unresolved-window",
              tab: "events",
              title: "待定活动",
              data: {
                html: [
                  "<p>▼//活动时间</p>",
                  "<p>具体开放时间请关注后续公告。</p>",
                  "<p>※ 示例：2026/01/01 04:00至2026/01/02 03:59（服务器时间）。</p>",
                ].join(""),
              },
            },
          ],
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );

  try {
    const events = await fetchEndfieldEvents({
      ENDFIELD_CODE: "fixture",
      ENDFIELD_AGGREGATE_API_URL: "https://fixture.invalid/aggregate",
    });
    assert.equal(
      events.some((item) => item.title === "待定活动"),
      false
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Star Rail derives a nearby same-major version start from an explicit maintenance boundary", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    const body = url.endsWith("/list")
      ? {
          retcode: 0,
          message: "OK",
          data: {
            list: [
              {
                type_id: 4,
                type_label: "公告",
                list: [
                  {
                    ann_id: 1345,
                    title: "4.4版本「鸣笛于归寂之时」版本更新说明",
                    start_time: "2026-07-15 06:00:00",
                    end_time: "2026-08-26 06:00:00",
                  },
                ],
              },
              {
                type_id: 3,
                type_label: "活动公告",
                list: [
                  {
                    ann_id: 1232,
                    title: "「千星旅伴」：登录领取旅伴金灵*1",
                    start_time: "2026-04-10 20:55:00",
                    end_time: "2026-08-26 06:00:00",
                  },
                ],
              },
            ],
          },
        }
      : {
          retcode: 0,
          message: "OK",
          data: {
            list: [
              {
                ann_id: 1345,
                title: "4.4版本「鸣笛于归寂之时」版本更新说明",
                content: [
                  "<p>更新时间</p>",
                  "<p>2026/07/15 06:00:00 - 2026/07/15 11:00:00</p>",
                ].join(""),
              },
              {
                ann_id: 1232,
                title: "「千星旅伴」：登录领取旅伴金灵*1",
                content: [
                  "<p>活动时间</p>",
                  "<p>4.2版本更新后 - 4.4版本结束前</p>",
                  "<p>参与条件</p>",
                  "<p>开拓等级≥4级</p>",
                ].join(""),
              },
            ],
          },
        };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const events = await fetchStarRailEvents({
      STARRAIL_API_URL: "https://fixture.invalid/list",
      STARRAIL_CONTENT_API_URL: "https://fixture.invalid/content",
    });
    const event = events.find((item) => item.title.includes("千星旅伴"));
    assert.ok(event);
    assert.deepEqual(
      {
        start_time: event.start_time,
        end_time: event.end_time,
      },
      {
        start_time: "2026-04-22T11:00:00+08:00",
        end_time: "2026-08-26T06:00:00+08:00",
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ZZZ keeps a version-relative gacha end ahead of later phase dates", () => {
  const range = extractZzzTimeRangeFromContent(
    [
      "<p>活动时间：3.1版本更新后 ~ 2026/09/08 14:59（服务器时间）</p>",
      "<p>2026/08/19 11:59</p>",
    ].join("")
  );

  assert.deepEqual(range, {
    startIso: null,
    endIso: "2026-09-08T14:59:00+08:00",
  });
});
