import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { FetchError } from "../lib/fetch.js";
import {
  classifyZzzSnapshotRelayError,
  getZzzSnapshotBundle,
  ZzzSnapshotTransportError,
  ZzzSnapshotValidationError,
  type ZzzSnapshotBundle,
} from "../lib/zzzSnapshot.js";
import {
  fetchEndfieldEvents,
  parseEndfieldWindowText,
} from "./endfield.js";
import { classifyGachaEvent } from "./gacha.js";
import {
  extractStarRailTimeRangeFromContent,
  fetchStarRailEvents,
  shouldIncludeStarRailAnnouncement,
} from "./starrail.js";
import {
  fetchZzzCurrentVersion,
  fetchZzzEvents,
} from "./zzz.js";

function emptyZzzSnapshot(): ZzzSnapshotBundle {
  return {
    schema_version: 1,
    game: "zzz",
    activity: {
      retcode: 0,
      message: "OK",
      data: { activity_list: [] },
    },
    list: {
      retcode: 0,
      message: "OK",
      data: { list: [] },
    },
    content: {
      retcode: 0,
      message: "OK",
      data: { list: [], pic_list: [] },
    },
  };
}

const fateLongTermContent = [
  "<p>公告发布时间：2026/07/03 20:55:00</p>",
  "<p>活动时间</p>",
  "<p>2026/07/03 20:55:00 - 2036/07/03 00:00:00</p>",
  "<p>活动介绍</p>",
  "<p>角色及光锥将加入 Fate[UBW] 联动跃迁，并于 2026/07/24 12:00:00 后长期开放。</p>",
].join("\n");

const starRailCompositeActivityContent = [
  "<h1>「幻造：圣杯战争」活动说明</h1>",
  "<p>活动期间登录即可免费领取联动限定5星角色。</p>",
  "<h1>「命运赠礼」活动说明</h1>",
  "<p>参与条件：解锁「跃迁」</p>",
  "<p>在任意跃迁活动中累计消耗星轨专票，即可选择限定5星光锥领取。</p>",
].join("\n");

test("Star Rail does not classify a composite activity notice as a warp", () => {
  assert.equal(
    classifyGachaEvent(
      "starrail",
      "「幻造：圣杯战争」活动说明",
      starRailCompositeActivityContent
    ),
    "other"
  );
});

test("Star Rail emits composite activity notices as non-gacha events", async () => {
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
                type_label: "资讯",
                list: [
                  {
                    ann_id: 1338,
                    title: "「幻造：圣杯战争」活动说明",
                    start_time: "2026-07-23 11:00:00",
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
                ann_id: 1338,
                title: "「幻造：圣杯战争」活动说明",
                content: starRailCompositeActivityContent,
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
    assert.equal(events[0]!.is_gacha, false);
    assert.equal(events[0]!.gacha_kind, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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
    assert.equal(events[0]!.is_gacha, true);
    assert.equal(events[0]!.gacha_kind, "mixed");
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

test("ZZZ defaults every announcement request to the official static host", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requestedUrls.push(url);
    const data = url.pathname.endsWith("/getActivityList")
      ? { activity_list: [] }
      : { list: [], pic_list: [] };
    return new Response(
      JSON.stringify({ retcode: 0, message: "OK", data }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };

  try {
    assert.deepEqual(await fetchZzzEvents(), []);
    assert.deepEqual(
      requestedUrls.map((url) => url.pathname).sort(),
      [
        "/common/nap_cn/announcement/api/getActivityList",
        "/common/nap_cn/announcement/api/getAnnContent",
        "/common/nap_cn/announcement/api/getAnnList",
      ]
    );
    assert.ok(
      requestedUrls.every(
        (url) => url.hostname === "announcement-static.mihoyo.com"
      )
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ZZZ uses one complete configured snapshot instead of individual endpoints", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = async (input) => {
    requestedUrls.push(String(input));
    const snapshot = emptyZzzSnapshot();
    snapshot.activity.data!.activity_list!.push({
      activity_id: "immutable-canonical",
      name: "original",
    });
    return new Response(
      JSON.stringify(snapshot),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };

  try {
    const env = {
      ZZZ_SNAPSHOT_API_URL:
        "https://relay-cache.invalid/api/upstream/zzz/snapshot",
      ZZZ_API_URL: "https://should-not-run.invalid/list",
      ZZZ_ACTIVITY_API_URL: "https://should-not-run.invalid/activity",
      ZZZ_CONTENT_API_URL: "https://should-not-run.invalid/content",
    };
    const [first, second] = await Promise.all([
      getZzzSnapshotBundle(env),
      getZzzSnapshotBundle(env),
    ]);
    assert.notStrictEqual(first, second);
    assert.notStrictEqual(first.activity, second.activity);
    first.activity.data!.activity_list![0]!.name = "mutated";
    assert.equal(second.activity.data!.activity_list![0]!.name, "original");
    const third = await getZzzSnapshotBundle(env);
    assert.equal(third.activity.data!.activity_list![0]!.name, "original");
    assert.deepEqual(
      await fetchZzzEvents(env),
      []
    );
    assert.equal(await fetchZzzCurrentVersion(env), null);
    assert.deepEqual(requestedUrls, [
      "https://relay-cache.invalid/api/upstream/zzz/snapshot",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ZZZ rejects an incomplete configured snapshot without endpoint fallback", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return new Response(
      JSON.stringify({
        schema_version: 1,
        game: "zzz",
        activity: {
          retcode: 0,
          message: "OK",
          data: { activity_list: [] },
        },
        list: {
          retcode: 0,
          message: "OK",
          data: { list: [] },
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };

  try {
    const env = {
      ZZZ_SNAPSHOT_API_URL:
        "https://relay-incomplete.invalid/api/upstream/zzz/snapshot",
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        fetchZzzEvents(env),
        /Invalid ZZZ snapshot: content must be an object/
      );
    }
    assert.equal(requestCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ZZZ rejects a non-HTTP snapshot source before fetching", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    throw new Error("fetch should not run");
  };

  try {
    await assert.rejects(
      getZzzSnapshotBundle({
        ZZZ_SNAPSHOT_API_URL: "file:///tmp/zzz-snapshot.json",
      }),
      /Invalid ZZZ snapshot: configured source URL must be an absolute HTTP URL/
    );
    assert.equal(requestCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ZZZ snapshot fetch classifies malformed JSON as validation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("{not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  try {
    await assert.rejects(
      getZzzSnapshotBundle({
        ZZZ_SNAPSHOT_API_URL:
          "https://relay-malformed.invalid/api/upstream/zzz/snapshot",
      }),
      (error: unknown) =>
        error instanceof ZzzSnapshotValidationError &&
        /malformed JSON/.test(error.message)
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ZZZ snapshot fetch classifies network and timeout failures as transport", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      throw new TypeError("fixture network failure");
    }
    throw { name: "AbortError" };
  };

  try {
    await assert.rejects(
      getZzzSnapshotBundle({
        ZZZ_SNAPSHOT_API_URL:
          "https://relay-transport.invalid/api/upstream/zzz/snapshot",
      }),
      ZzzSnapshotTransportError
    );
    await assert.rejects(
      getZzzSnapshotBundle({
        ZZZ_SNAPSHOT_API_URL:
          "https://relay-timeout.invalid/api/upstream/zzz/snapshot",
      }),
      ZzzSnapshotTransportError
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ZZZ snapshot fetch preserves HTTP FetchError semantics", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("upstream overloaded", { status: 503 });

  try {
    await assert.rejects(
      getZzzSnapshotBundle({
        ZZZ_SNAPSHOT_API_URL:
          "https://relay-http.invalid/api/upstream/zzz/snapshot",
      }),
      (error: unknown) =>
        error instanceof FetchError &&
        error.status === 503 &&
        classifyZzzSnapshotRelayError(error) === 502
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ZZZ snapshot relay classifier accepts only trusted error types", () => {
  assert.equal(
    classifyZzzSnapshotRelayError(
      new ZzzSnapshotValidationError("invalid fixture")
    ),
    422
  );
  assert.equal(
    classifyZzzSnapshotRelayError(
      new ZzzSnapshotTransportError("transport fixture")
    ),
    502
  );
  assert.equal(
    classifyZzzSnapshotRelayError(
      new FetchError({ url: "https://fixture.invalid", status: 429, message: "429" })
    ),
    429
  );
  assert.equal(
    classifyZzzSnapshotRelayError(
      new FetchError({ url: "https://fixture.invalid", status: 404, message: "404" })
    ),
    424
  );
  assert.equal(classifyZzzSnapshotRelayError(new TypeError("unknown")), 422);
});

test("Node and Worker relays import the trusted ZZZ snapshot module directly", () => {
  const nodeSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const workerSource = readFileSync(
    new URL("../../../worker/src/index.ts", import.meta.url),
    "utf8"
  );

  assert.match(nodeSource, /from "\.\/lib\/zzzSnapshot\.js";/);
  assert.doesNotMatch(nodeSource, /from "\.\/games\/zzz\.js";/);
  assert.match(
    workerSource,
    /from "\.\.\/\.\.\/api\/src\/lib\/zzzSnapshot\.js";/
  );
  assert.doesNotMatch(workerSource, /api\/src\/games\/zzz\.js/);
});

test("ZZZ keeps unconfigured content and list requests tolerant", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.endsWith("/activity")) {
      return new Response(
        JSON.stringify({
          retcode: 0,
          message: "OK",
          data: { activity_list: [] },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    }
    return new Response("temporarily unavailable", { status: 503 });
  };

  try {
    assert.deepEqual(
      await fetchZzzEvents({
        ZZZ_ACTIVITY_API_URL: "https://fixture.invalid/activity",
        ZZZ_API_URL: "https://fixture.invalid/list",
        ZZZ_CONTENT_API_URL: "https://fixture.invalid/content",
      }),
      []
    );
    assert.deepEqual(requestedUrls.sort(), [
      "https://fixture.invalid/activity",
      "https://fixture.invalid/content",
      "https://fixture.invalid/list",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ZZZ keeps unconfigured version lookup list-only", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = async (input) => {
    requestedUrls.push(String(input));
    return new Response(
      JSON.stringify({
        retcode: 0,
        message: "OK",
        data: { list: [] },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };

  try {
    assert.equal(
      await fetchZzzCurrentVersion({
        ZZZ_API_URL: "https://fixture.invalid/list-only",
        ZZZ_ACTIVITY_API_URL: "https://should-not-run.invalid/activity",
        ZZZ_CONTENT_API_URL: "https://should-not-run.invalid/content",
      }),
      null
    );
    assert.deepEqual(requestedUrls, ["https://fixture.invalid/list-only"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
