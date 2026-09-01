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
  isStarRailVersionMaintenanceAnchorText,
} from "./starrail.js";
import {
  extractZzzTimeRangeFromContent,
  extractZzzVersionEndIsoFromContent,
  fetchZzzEvents,
  isZzzSupplementalActivityNotice,
} from "./zzz.js";

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

test("Star Rail resolves version starts from maintenance previews with expected durations", async () => {
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
                    ann_id: 1403,
                    title: "4.5版本更新维护预告",
                    start_time: "2026-08-24 14:00:00",
                    end_time: "2026-08-26 06:00:00",
                  },
                ],
              },
              {
                type_id: 3,
                type_label: "资讯",
                list: [
                  {
                    ann_id: 1330,
                    title: "4.5版本活动跃迁（其一）",
                    start_time: "2026-08-25 14:00:00",
                    end_time: "2026-09-12 11:59:00",
                  },
                  {
                    ann_id: 1335,
                    title: "「超限：狂飙大奖赛」：夺得赛事冠军，获取自塑尘脂、命运的足迹、星琼等奖励！",
                    start_time: "2026-08-25 13:00:00",
                    end_time: "2026-09-28 03:59:00",
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
                ann_id: 1403,
                title: "4.5版本更新维护预告",
                content: [
                  "<h1>更新时间</h1>",
                  "<p>2026/08/26 06:00:00 开始，预计需要<strong>5</strong>个小时。</p>",
                ].join(""),
              },
              {
                ann_id: 1330,
                title: "4.5版本活动跃迁（其一）",
                content: [
                  "<p>本期活动跃迁时间为</p>",
                  "<p>4.5版本更新后 - 2026/09/12 11:59:00</p>",
                  "<p>跃迁说明</p>",
                ].join(""),
              },
              {
                ann_id: 1335,
                title: "「超限：狂飙大奖赛」：夺得赛事冠军，获取自塑尘脂、命运的足迹、星琼等奖励！",
                content: [
                  "<p>限时活动期</p>",
                  "<p>4.5版本更新后 - 2026/09/28 03:59:00</p>",
                  "<p>参与条件</p>",
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
    assert.equal(
      isStarRailVersionMaintenanceAnchorText("4.5版本更新维护预告"),
      true
    );
    const events = await fetchStarRailEvents({
      STARRAIL_API_URL: "https://fixture.invalid/list",
      STARRAIL_CONTENT_API_URL: "https://fixture.invalid/content",
    });
    assert.deepEqual(
      events
        .filter(
          (event) =>
            String(event.id).includes("starrail:1330|") ||
            String(event.id).includes("starrail:1335|")
        )
        .map((event) => ({
          title: event.title,
          start_time: event.start_time,
          end_time: event.end_time,
        })),
      [
        {
          title: "4.5版本活动跃迁（其一）",
          start_time: "2026-08-26T11:00:00+08:00",
          end_time: "2026-09-12T11:59:00+08:00",
        },
        {
          title: "「超限：狂飙大奖赛」：夺得赛事冠军，获取自塑尘脂、命运的足迹、星琼等奖励！",
          start_time: "2026-08-26T11:00:00+08:00",
          end_time: "2026-09-28T03:59:00+08:00",
        },
      ]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("Endfield preserves permanent availability after an explicit start", async () => {
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
                  "<p>■ 活动及玩法更新</p>",
                  "<p>1. 「影拓丰碑」挑战玩法更新，开放「山中见犼」系列关卡</p>",
                  "<p>· 开放时间：2026/08/06 12:00 - 2026/08/20 04:00</p>",
                ].join(""),
              },
            },
            {
              cid: "permanent-challenge",
              tab: "events",
              title: "影拓丰碑 系列更新",
              header: "「影拓丰碑 - 山中见犼」系列更新说明",
              startAt: 1785902400,
              data: {
                html: [
                  "<p>▼//开放时间</p>",
                  "<p>2026/08/06 12:00（服务器时间）开启，系列开启后常驻开放</p>",
                  "<p>▼//玩法说明</p>",
                  "<p>· 本次「影拓丰碑」挑战玩法更新系列「山中见犼」，包含4个关卡。</p>",
                  "<p>▼//「丰碑留名·兽犼」限时挑战活动</p>",
                  "<p>· 活动时间：2026/08/06 12:00 - 2026/08/20 04:00（服务器时间）</p>",
                  "<p>· 活动说明：「影拓丰碑 - 山中见犼」系列开放后，将开启「丰碑留名·兽犼」限时活动。</p>",
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
    const matchingEvents = events.filter((item) => item.title.includes("影拓丰碑"));
    assert.equal(matchingEvents.length, 1);
    const event = matchingEvents[0];
    assert.ok(event);
    assert.deepEqual(
      {
        title: event.title,
        start_time: event.start_time,
        end_time: event.end_time,
        end_time_kind: event.end_time_kind,
        end_time_text: event.end_time_text,
      },
      {
        title: "「影拓丰碑」挑战玩法更新，开放「山中见犼」系列关卡",
        start_time: "2026-08-06T12:00:00+08:00",
        end_time: null,
        end_time_kind: "relative",
        end_time_text: "系列开启后常驻开放",
      }
    );
    const limitedEvent = events.find((item) => item.title === "丰碑留名·兽犼");
    assert.ok(limitedEvent);
    assert.deepEqual(
      {
        start_time: limitedEvent.start_time,
        end_time: limitedEvent.end_time,
      },
      {
        start_time: "2026-08-06T12:00:00+08:00",
        end_time: "2026-08-20T04:00:00+08:00",
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Endfield keeps distinct same-name permanent and limited activities", async () => {
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
                  "<p>■ 活动及玩法更新</p>",
                  "<p>1. 「同名企划」限时挑战活动</p>",
                  "<p>· 开放时间：2026/08/06 12:00 - 2026/08/20 04:00</p>",
                ].join(""),
              },
            },
            {
              cid: "permanent-challenge",
              tab: "events",
              title: "同名企划 系列更新",
              startAt: 1785902400,
              data: {
                html: [
                  "<p>▼//开放时间</p>",
                  "<p>2026/08/06 12:00（服务器时间）开启，系列开启后常驻开放</p>",
                  "<p>▼//玩法说明</p>",
                  "<p>常驻玩法说明。</p>",
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
    const matchingEvents = events.filter((item) => item.title.includes("同名企划"));
    assert.equal(matchingEvents.length, 2);
    const permanentEvent = matchingEvents.find((event) => event.end_time == null);
    const limitedEvent = matchingEvents.find((event) => event.end_time != null);
    assert.ok(permanentEvent);
    assert.ok(limitedEvent);
    assert.deepEqual(
      {
        title: permanentEvent.title,
        end_time: permanentEvent.end_time,
        end_time_text: permanentEvent.end_time_text,
      },
      {
        title: "同名企划 系列更新",
        end_time: null,
        end_time_text: "系列开启后常驻开放",
      }
    );
    assert.deepEqual(
      {
        title: limitedEvent.title,
        end_time: limitedEvent.end_time,
        end_time_text: limitedEvent.end_time_text,
      },
      {
        title: "「同名企划」限时挑战活动",
        end_time: "2026-08-20T04:00:00+08:00",
        end_time_text: undefined,
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Endfield inherits a standalone notice window for co-opened activities", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        code: 0,
        data: {
          list: [
            {
              cid: "4601",
              tab: "events",
              title: "晨星于此闪耀 特许寻访",
              startAt: 1786183200,
              data: {
                html: [
                  "<p>「晨星于此闪耀」特许寻访开放期间，6星干员获取概率提升！</p>",
                  "<p>「明耀晨星」限时签到活动同步开放，累计签到可获得【明耀晨星寻访凭证】×5等奖励。</p>",
                  "<p>同时，开放「作战演练」干员试用活动。</p>",
                  "<p>▼//「晨星于此闪耀」特许寻访说明</p>",
                  "<p>· 开放时间：2026/08/09 12:00（服务器时间） - 版本更新维护前</p>",
                  "<p>· 开放条件：完成主线任务「第一章 - 进程Ⅰ - 基地解围」</p>",
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
    assert.deepEqual(
      events
        .filter((item) => item.title === "明耀晨星" || item.title === "作战演练")
        .map((event) => ({
          title: event.title,
          start_time: event.start_time,
          end_time: event.end_time,
          end_time_kind: event.end_time_kind,
          end_time_text: event.end_time_text,
          is_gacha: event.is_gacha,
        })),
      [
        {
          title: "明耀晨星",
          start_time: "2026-08-09T12:00:00+08:00",
          end_time: null,
          end_time_kind: "relative",
          end_time_text: "版本更新维护前",
          is_gacha: false,
        },
        {
          title: "作战演练",
          start_time: "2026-08-09T12:00:00+08:00",
          end_time: null,
          end_time_kind: "relative",
          end_time_text: "版本更新维护前",
          is_gacha: false,
        },
      ]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Endfield assigns a co-opened sign-in its named section window", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        code: 0,
        data: {
          list: [
            {
              cid: "4601",
              tab: "events",
              title: "晨星于此闪耀 特许寻访",
              startAt: 1786183200,
              data: {
                html: [
                  "<p>「晨星于此闪耀」特许寻访开放期间，6星干员获取概率提升！</p>",
                  "<p>「明耀晨星」限时签到活动同步开放，累计签到可获得活动奖励。</p>",
                  "<p>▼//「作战演练」活动说明</p>",
                  "<p>■活动时间</p>",
                  "<p>2026/08/09 10:00（服务器时间） - 2026/08/09 11:00（服务器时间）</p>",
                  "<p>▼//「晨星于此闪耀」特许寻访说明</p>",
                  "<p>■活动时间</p>",
                  "<p>2026/08/09 12:00（服务器时间） - 版本更新维护前</p>",
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
    const event = events.find((item) => item.title === "明耀晨星");
    assert.ok(event);
    assert.deepEqual(
      {
        start_time: event.start_time,
        end_time: event.end_time,
        end_time_kind: event.end_time_kind,
        end_time_text: event.end_time_text,
        is_gacha: event.is_gacha,
      },
      {
        start_time: "2026-08-09T12:00:00+08:00",
        end_time: null,
        end_time_kind: "relative",
        end_time_text: "版本更新维护前",
        is_gacha: false,
      }
    );
    assert.equal(
      events.filter((item) => item.title === "作战演练" || item.title === "晨星于此闪耀")
        .length,
      2
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

test("ZZZ recognizes activity notices whose titles omit the activity suffix", () => {
  assert.equal(
    isZzzSupplementalActivityNotice(
      "3.1版本「丽都城募」说明",
      "亲爱的绳匠：活动期间，绳匠可以在「丽都城募」中，通过提升城募等级获取丰厚奖励！"
    ),
    true
  );
});

test("ZZZ deduplicates prefixed activity notices against matching activity-list events", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    const body = url.endsWith("/activity")
      ? {
          retcode: 0,
          message: "OK",
          data: {
            activity_list: [
              {
                activity_id: "1415",
                name: "见习邮差派件中",
                start_time: "1787882400",
                end_time: "1789329599",
              },
            ],
          },
        }
      : url.endsWith("/content")
        ? {
            retcode: 0,
            message: "OK",
            data: {
              list: [
                {
                  ann_id: 1277,
                  title: "「叮咚！见习邮差派件中」活动说明",
                  content:
                    "【活动时间】 2026/08/28 10:00（服务器时间） ~ 2026/09/14 03:59（服务器时间） 【活动奖励】",
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
                  type_id: 3,
                  type_label: "游戏公告",
                  list: [
                    {
                      ann_id: 1277,
                      title: "「叮咚！见习邮差派件中」活动说明",
                    },
                  ],
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
    const events = await fetchZzzEvents({
      ZZZ_ACTIVITY_API_URL: "https://fixture.invalid/activity",
      ZZZ_CONTENT_API_URL: "https://fixture.invalid/content",
      ZZZ_API_URL: "https://fixture.invalid/list",
    });

    assert.deepEqual(
      events.map((event) => ({
        id: event.id,
        title: event.title,
        start_time: event.start_time,
        end_time: event.end_time,
      })),
      [
        {
          id: "1415",
          title: "见习邮差派件中",
          start_time: "2026-08-28T10:00:00+08:00",
          end_time: "2026-09-14T03:59:59+08:00",
        },
      ]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ZZZ resolves version-relative ends for supplemental activity notices", () => {
  const versionEndByLabel = new Map([["3.1", "2026-09-09T06:00:00+08:00"]]);
  const notices = [
    {
      title: "法厄同年度大揭秘",
      content: "【活动时间】 3.1版本更新后 ~ 3.1版本结束 【活动奖励】",
    },
    {
      title: "潜能预演·狩猎游戏",
      content: "【活动时间】 3.1版本更新后 ~ 3.1版本结束 【参与条件】",
    },
    {
      title: "点映返礼",
      content: "【活动时间】 3.1版本更新后 ~3.1版本结束 【活动奖励】",
    },
  ];

  for (const notice of notices) {
    const range = extractZzzTimeRangeFromContent(notice.content, {
      versionEndByLabel,
    });
    assert.deepEqual(
      range,
      {
        startIso: null,
        endIso: "2026-09-09T06:00:00+08:00",
      },
      notice.title
    );
  }

  assert.deepEqual(
    extractZzzTimeRangeFromContent(
      "【活动时间】 2026/07/17 20:30（UTC+8）~ 3.1版本结束 【活动奖励】",
      {
        versionEndByLabel: new Map([["3.1", "2026-09-09T05:59:59+08:00"]]),
      }
    ),
    {
      startIso: "2026-07-17T20:30:00+08:00",
      endIso: "2026-09-09T05:59:59+08:00",
    },
    "「回归丽都 羽落重逢」活动说明"
  );
});

test("ZZZ prefers an explicit version end from update content", () => {
  const endIso = extractZzzVersionEndIsoFromContent(
    [
      "<p>2026/07/29 06:00（UTC+8）前绳网等级达到要求。</p>",
      "<p>领取时间截至3.1版本结束前，3.1版本结束时间为 2026/09/09 06:00（UTC+8）。</p>",
      "<p>2026/08/28 23:59前完成其他任务。</p>",
    ].join("")
  );

  assert.equal(endIso, "2026-09-09T06:00:00+08:00");
});
