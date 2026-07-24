import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchEndfieldEvents,
  parseEndfieldWindowText,
} from "./endfield.js";
import {
  extractStarRailTimeRangeFromContent,
  fetchStarRailEvents,
  shouldIncludeStarRailAnnouncement,
} from "./starrail.js";

const fateLongTermContent = [
  "<p>公告发布时间：2026/07/03 20:55:00</p>",
  "<p>活动时间</p>",
  "<p>2026/07/03 20:55:00 - 2036/07/03 00:00:00</p>",
  "<p>活动介绍</p>",
  "<p>角色及光锥将加入 Fate[UBW] 联动跃迁，并于 2026/07/24 12:00:00 后长期开放。</p>",
].join("\n");

test("Star Rail uses a title-scoped long-term window instead of the 2036 list fallback", () => {
  const range = extractStarRailTimeRangeFromContent(
    fateLongTermContent,
    {
      title: "「Fate[UBW]」联动跃迁说明",
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

test("Star Rail emits the title-scoped long-term window in the final event", async () => {
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
                type_id: 3,
                type_label: "活动公告",
                list: [
                  {
                    ann_id: 777,
                    title: "「Fate[UBW]」联动跃迁说明",
                    start_time: "2026-07-03 20:55:00",
                    end_time: "2036-07-03 00:00:00",
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
                ann_id: 777,
                title: "「Fate[UBW]」联动跃迁说明",
                content: fateLongTermContent,
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
    assert.equal(events.length, 1);
    assert.deepEqual(
      {
        start_time: events[0]!.start_time,
        end_time: events[0]!.end_time,
        end_time_kind: events[0]!.end_time_kind,
        end_time_text: events[0]!.end_time_text,
      },
      {
        start_time: "2026-07-24T12:00:00+08:00",
        end_time: null,
        end_time_kind: "relative",
        end_time_text: "长期开放",
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Star Rail excludes external mini-program and web-service launches", () => {
  assert.equal(
    shouldIncludeStarRailAnnouncement(
      "《崩坏：星穹铁道》小程序及网页服务正式上线",
      "<p>首次绑定游戏账号后即可领取奖励，每版本均可参与。</p>"
    ),
    false
  );
});

test("Endfield preserves Protocol Reconnection as a player-relative window", () => {
  const window = parseEndfieldWindowText(
    [
      "2026/07/16 12:00 -",
      "激活「协议重连」活动当天至激活起第14天的次日04:00（服务器时间）结束",
    ].join(" ")
  );

  assert.deepEqual(window, {
    start: "2026-07-16 12:00",
    end: null,
    endText:
      "激活「协议重连」活动当天至激活起第14天的次日04:00（服务器时间）结束",
  });
});

test("Endfield emits Protocol Reconnection as a relative final event", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        code: 0,
        data: {
          list: [
            {
              cid: "protocol-reconnection",
              tab: "events",
              title: "协议重连",
              data: {
                html: [
                  "<p>活动时间</p>",
                  "<p>2026/07/16 12:00 - 激活「协议重连」活动当天至激活起第14天的次日04:00（服务器时间）结束</p>",
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
    assert.equal(events.length, 1);
    assert.deepEqual(
      {
        start_time: events[0]!.start_time,
        end_time: events[0]!.end_time,
        end_time_kind: events[0]!.end_time_kind,
        end_time_text: events[0]!.end_time_text,
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
