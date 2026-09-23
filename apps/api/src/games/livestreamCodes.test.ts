import assert from "node:assert/strict";
import test from "node:test";

import { fetchEventsForGame } from "./index.js";
import {
  extractRedeemCodeExpiry,
  extractRedeemCodes,
  fetchLivestreamCodeEvents,
  fetchMiyousheLivestreamCodeEventsForGame,
  fetchWwLivestreamCodeEvents,
} from "./livestreamCodes.js";

// Captured from the official 米游社 post 78287359 (2026-09-20).
const starRailPostText = [
  "《崩坏：星穹铁道》4.6版本「月升之前，与兽共舞」将于2026年9月28日正式上线，快来看看都有哪些内容帕！",
  "",
  "本次前瞻特别节目兑换码（星琼*300）：",
  "KXHN8W7FGB6U",
  "XEZNQE6FZSNY",
  "ZXH68F7WYTN4",
  "*兑换码将于2026年9月21日23:59:59失效，记得尽快兑换哦~",
  "",
].join("\n");

// Captured from the official 库街区 publisher comment on post 1550916937441083392.
const wwCodeComment =
  " 《鸣潮》3.7版本前瞻通讯兑换码：【FALLINGSANCTUM】、【FINDSENTINEL】、【WAKINGMOON】请查收，漂泊者们可前往游戏内兑换领取，兑换码有效期至2026年9月21日23:59。";

const STARRAIL_POST_CREATED_AT = 1789908010; // 2026-09-20 20:40:10 +08:00
// 库街区 createTimestamp is the draft time; postTime is the publish time.
const WW_POST_CREATED_MS = 1789809012000; // 2026-09-19 17:10:12 +08:00
const WW_POST_TIME = "2026-09-19 20:05";
const NOW_MS = Date.UTC(2026, 8, 20, 12, 0, 0);

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

type MiyoushePostFixture = {
  post_id: string;
  subject: string;
  text: string;
  created_at: number;
  cover?: string;
  links?: string[];
};

function miyousheUserPostFixture(posts: MiyoushePostFixture[]): unknown {
  return {
    retcode: 0,
    message: "OK",
    data: {
      list: posts.map((post) => ({
        post: {
          post_id: post.post_id,
          subject: post.subject,
          // List responses truncate `content`; the full text lives in structured_content.
          content: post.text.slice(0, 40),
          structured_content: JSON.stringify([
            { insert: post.text },
            ...(post.links ?? []).map((link) => ({ insert: "点击前往", attributes: { link } })),
            { insert: { vod: { id: "1" } } },
          ]),
          cover: post.cover,
          created_at: post.created_at,
        },
      })),
      is_last: false,
      next_offset: "",
    },
  };
}

const STARRAIL_ACT_ID = "ea202609141754373603";
const STARRAIL_LIVE_PAGE = `https://webstatic.mihoyo.com/bbs/event/live/index.html?act_id=${STARRAIL_ACT_ID}&game_biz=hkrpg`;

function starRailPosts(): MiyoushePostFixture[] {
  return [
    {
      post_id: "78287359",
      subject: "4.6版本前瞻节目速览",
      text: starRailPostText,
      cover: "https://upload-bbs.miyoushe.com/upload/2026/09/20/288909600/cover.jpg",
      created_at: STARRAIL_POST_CREATED_AT,
    },
    {
      post_id: "78287085",
      subject: "4.6版本「月升之前，与兽共舞」前瞻特别节目",
      text: "亲爱的开拓者，本次特别节目中的兑换码将于2026年9月21日23:59:59失效，记得尽快兑换哦~",
      created_at: STARRAIL_POST_CREATED_AT - 600,
    },
    {
      post_id: "78164947",
      subject: "【转发抽奖】4.6版本「月升之前，与兽共舞」前瞻特别节目预告",
      text: "前瞻特别节目将于2026年9月20日19:30正式播出。节目播送期间，帕姆也会在直播间送上兑换码福利。\n2026年9月14日 - 2026年9月20日 18:00",
      created_at: STARRAIL_POST_CREATED_AT - 6 * 24 * 3600,
    },
  ];
}

function navigatorFixture(actIds: string[]): unknown {
  return {
    retcode: 0,
    message: "OK",
    data: {
      navigator: [
        { name: "签到福利", app_path: "https://act.mihoyo.com/bbs/event/signin/hkrpg/e202304121516551.html?act_id=e202304121516551" },
        ...actIds.map((actId) => ({
          name: "直播兑换码",
          app_path: `https://webstatic.mihoyo.com/bbs/event/live/index.html?act_id=${actId}&mhy_presentation_style=fullscreen&game_biz=hkrpg`,
        })),
        { name: "绘画征集", app_path: "https://act.mihoyo.com/bbs/event/doujin-collect/index.html?id=ea202608051830237663&act_id=ea202608051830237663" },
      ],
    },
  };
}

function miyoliveIndexFixture(opts: { title: string; aid: string; start: string; codeVer: string }): unknown {
  return {
    retcode: 0,
    message: "OK",
    data: {
      is_login: false,
      live: {
        act_type: "ActPGC",
        title: opts.title,
        start: opts.start,
        end: opts.start,
        is_end: true,
        code_ver: opts.codeVer,
      },
      streamer: { aid: opts.aid, nickname: "official" },
    },
  };
}

function miyoliveCodeFixture(codes: Array<{ code: string; reward: string; at: number }>): unknown {
  return {
    retcode: 0,
    message: "OK",
    data: {
      code_list: codes.map((entry) => ({
        title: `<p style="white-space: pre-wrap;">${entry.reward}</p>`,
        code: entry.code,
        img: "https://webstatic.mihoyo.com/upload/op-public/x.png",
        to_get_time: String(entry.at),
      })),
    },
  };
}

const STARRAIL_LIVE_CODES = [
  { code: "KXHN8W7FGB6U", reward: "星琼×<span>100</span>，信用点×50000", at: 1789903800 }, // 2026-09-20 19:30:00 +08:00
  { code: "XEZNQE6FZSNY", reward: "星琼×100，漫游指南×5", at: 1789905249 },
  { code: "ZXH68F7WYTN4", reward: "星琼×100，提纯以太×4", at: 1789905720 },
];

type MiyousheMock = {
  userPost: unknown;
  navigator?: unknown;
  index?: (actId: string) => unknown;
  codes?: (actId: string) => unknown;
};

function installMiyousheMock(mock: MiyousheMock): {
  requests: Array<{ url: string; actId: string | null; clientType: string | null }>;
  restore: () => void;
} {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; actId: string | null; clientType: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const actId = headers.get("x-rpc-act_id");
    requests.push({ url, actId, clientType: headers.get("x-rpc-client_type") });
    if (url.includes("/post/wapi/userPost")) return jsonResponse(mock.userPost);
    if (url.includes("/apihub/api/home/new")) {
      if (mock.navigator === undefined) return new Response("Forbidden", { status: 403 });
      return jsonResponse(mock.navigator);
    }
    if (url.includes("/event/miyolive/index")) {
      const body = mock.index?.(actId ?? "");
      return body === undefined ? new Response("Forbidden", { status: 403 }) : jsonResponse(body);
    }
    if (url.includes("/event/miyolive/refreshCode")) {
      const body = mock.codes?.(actId ?? "");
      return body === undefined ? new Response("Forbidden", { status: 403 }) : jsonResponse(body);
    }
    return jsonResponse({ retcode: 0, message: "OK", data: { list: [] } });
  };
  return {
    requests,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function wwSearchFixture(): unknown {
  return {
    code: 200,
    data: {
      postList: [
        {
          postId: "1550950781250834432",
          postTitle: "鸣潮兑换码 | 鸣潮3.7版本前瞻兑换码速领！",
          userId: "10525366",
          userName: "轩儿Xuaner",
          createTimestamp: String(WW_POST_CREATED_MS + 60_000),
        },
        {
          postId: "1550916937441083392",
          // Search results wrap keyword hits in <em>.
          postTitle: "《鸣潮》3.7版本<em>前瞻通讯</em> | 回顾影像",
          userId: "10012001",
          userName: "鸣潮",
          createTimestamp: String(WW_POST_CREATED_MS),
        },
        {
          postId: "1548053613414187008",
          postTitle: "《鸣潮》3.7版本前瞻通讯将于2026年9月19日19:00正式播出",
          userId: "10012001",
          userName: "鸣潮",
          createTimestamp: String(WW_POST_CREATED_MS - 7 * 24 * 3600 * 1000),
        },
      ],
      hasNext: 1,
    },
    msg: "请求成功",
    success: true,
  };
}

function wwDetailFixture(postId: string): unknown {
  if (postId === "1550916937441083392") {
    return {
      code: 200,
      data: {
        gameId: 3,
        postDetail: {
          postId,
          postTitle: "《鸣潮》3.7版本前瞻通讯 | 回顾影像",
          postUserId: "10012001",
          createTimestamp: WW_POST_CREATED_MS,
          postTime: WW_POST_TIME,
          coverImages: [
            { url: "https://prod-alicdn-community.kurobbs.com/forum/cover.png" },
          ],
          postContent: [
            { content: "《鸣潮》3.7版本前瞻通讯完整回顾影像已送达，欢迎漂泊者前往观看。", contentType: 1 },
          ],
        },
        comment: [
          {
            commentContent: [{ content: wwCodeComment, contentType: 1 }],
            floor: 1,
            isPublisher: 1,
            userId: "10012001",
            userName: "鸣潮",
          },
        ],
      },
    };
  }
  return {
    code: 200,
    data: {
      gameId: 3,
      postDetail: {
        postId,
        postTitle: "《鸣潮》3.7版本前瞻通讯将于2026年9月19日19:00正式播出",
        postUserId: "10012001",
        createTimestamp: WW_POST_CREATED_MS - 7 * 24 * 3600 * 1000,
        postContent: [
          { content: "《鸣潮》3.7版本前瞻通讯将于2026年9月19日19:00正式播出。", contentType: 1 },
        ],
      },
      comment: [],
    },
  };
}

test("livestream codes: Star Rail plain-text codes after the 兑换码 marker", () => {
  assert.deepEqual(extractRedeemCodes(starRailPostText), [
    "KXHN8W7FGB6U",
    "XEZNQE6FZSNY",
    "ZXH68F7WYTN4",
  ]);
});

test("livestream codes: Wuthering Waves bracketed codes", () => {
  assert.deepEqual(extractRedeemCodes(wwCodeComment), [
    "FALLINGSANCTUM",
    "FINDSENTINEL",
    "WAKINGMOON",
  ]);
});

test("livestream codes: no codes without a 兑换码 marker", () => {
  assert.deepEqual(extractRedeemCodes("前瞻特别节目将于2026年9月20日19:30正式播出 ABCDEFGH1234"), []);
});

test("livestream codes: Star Rail expiry keeps seconds", () => {
  const expiry = extractRedeemCodeExpiry(starRailPostText, { fallbackYear: 2026 });
  assert.equal(expiry.iso, "2026-09-21T23:59:59+08:00");
});

test("livestream codes: Wuthering Waves expiry from 有效期至", () => {
  const expiry = extractRedeemCodeExpiry(wwCodeComment, { fallbackYear: 2026 });
  assert.equal(expiry.iso, "2026-09-21T23:59:00+08:00");
});

test("livestream codes: 24:00 rolls over to the next day", () => {
  const expiry = extractRedeemCodeExpiry("兑换码有效期至9月21日24:00。", {
    fallbackYear: 2026,
    notBeforeMs: Date.UTC(2026, 8, 19, 12),
  });
  assert.equal(expiry.iso, "2026-09-22T00:00:00+08:00");
});

test("livestream codes: a missing year rolls forward past the post date", () => {
  const expiry = extractRedeemCodeExpiry("兑换码有效期至1月2日23:59。", {
    fallbackYear: 2026,
    notBeforeMs: Date.UTC(2026, 11, 30, 12),
  });
  assert.equal(expiry.iso, "2027-01-02T23:59:00+08:00");
});

test("livestream codes: unrelated timestamps are not treated as an expiry", () => {
  const expiry = extractRedeemCodeExpiry(
    "前瞻特别节目将于2026年9月20日19:30正式播出，4.6版本将于2026年9月28日正式上线。",
    { fallbackYear: 2026 }
  );
  assert.equal(expiry.iso, null);
});

test("livestream codes: Star Rail combines the livestream API codes with the post expiry", async () => {
  const mock = installMiyousheMock({
    userPost: miyousheUserPostFixture(starRailPosts()),
    navigator: navigatorFixture([STARRAIL_ACT_ID]),
    index: (actId) =>
      actId === STARRAIL_ACT_ID
        ? miyoliveIndexFixture({
            title: "《崩坏：星穹铁道》4.6版本前瞻",
            aid: "288909600",
            start: "2026-09-20 19:10:00",
            codeVer: "50aa2d",
          })
        : { retcode: -500012, message: "活动已结束" },
    codes: (actId) => (actId === STARRAIL_ACT_ID ? miyoliveCodeFixture(STARRAIL_LIVE_CODES) : undefined),
  });

  try {
    const events = await fetchMiyousheLivestreamCodeEventsForGame("starrail", {}, NOW_MS);
    assert.ok(mock.requests.some((r) => r.url.includes("/post/wapi/userPost?uid=288909600&size=50")));
    assert.ok(mock.requests.some((r) => r.url.includes("/apihub/api/home/new?gids=6") && r.clientType === "2"));
    // Only the livestream entry is queried; the sign-in and doujin act_ids are skipped.
    assert.deepEqual(
      mock.requests.filter((r) => r.url.includes("/event/miyolive/index")).map((r) => r.actId),
      [STARRAIL_ACT_ID]
    );
    assert.ok(
      mock.requests.some((r) => r.url.includes("/event/miyolive/refreshCode?version=50aa2d&time="))
    );

    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.id, `starrail:livestream-code:${STARRAIL_ACT_ID}`);
    assert.equal(event.title, "4.6版本前瞻兑换码");
    assert.equal(event.start_time, "2026-09-20T19:30:00+08:00");
    assert.equal(event.end_time, "2026-09-21T23:59:59+08:00");
    assert.equal(event.end_time_kind, "explicit");
    assert.deepEqual(event.redeem_codes, ["KXHN8W7FGB6U", "XEZNQE6FZSNY", "ZXH68F7WYTN4"]);
    assert.equal(event.linkUrl, "https://www.miyoushe.com/sr/article/78287359");
    assert.equal(event.banner, "https://upload-bbs.miyoushe.com/upload/2026/09/20/288909600/cover.jpg");
    assert.match(event.content ?? "", /^KXHN8W7FGB6U：星琼×100，信用点×50000\n/);
    assert.match(event.content ?? "", /兑换码将于2026年9月21日23:59:59失效/);
    assert.equal(event.is_gacha, false);
  } finally {
    mock.restore();
  }
});

test("livestream codes: Star Rail falls back to the plain-text post when the livestream API is gone", async () => {
  const mock = installMiyousheMock({
    userPost: miyousheUserPostFixture(starRailPosts()),
    navigator: navigatorFixture([STARRAIL_ACT_ID]),
    index: () => ({ retcode: -500012, message: "活动已结束 (-500012)" }),
  });

  try {
    const events = await fetchMiyousheLivestreamCodeEventsForGame("starrail", {}, NOW_MS);
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.id, "starrail:livestream-code:78287359");
    assert.equal(event.title, "4.6版本前瞻兑换码");
    assert.equal(event.start_time, "2026-09-20T20:40:10+08:00");
    assert.equal(event.end_time, "2026-09-21T23:59:59+08:00");
    assert.deepEqual(event.redeem_codes, ["KXHN8W7FGB6U", "XEZNQE6FZSNY", "ZXH68F7WYTN4"]);
  } finally {
    mock.restore();
  }
});

test("livestream codes: Star Rail ignores posts older than the retention window", async () => {
  const mock = installMiyousheMock({ userPost: miyousheUserPostFixture(starRailPosts()) });

  try {
    const events = await fetchMiyousheLivestreamCodeEventsForGame(
      "starrail",
      {},
      NOW_MS + 90 * 24 * 3600 * 1000
    );
    assert.equal(events.length, 0);
  } finally {
    mock.restore();
  }
});

test("livestream codes: Genshin discovers the act_id from the 预告 post link and reads Chinese codes", async () => {
  const actId = "ea202609041755176692";
  const mock = installMiyousheMock({
    userPost: miyousheUserPostFixture([
      {
        post_id: "78118185",
        subject: "《原神》7.1版本「往冥府的安魂歌」前瞻特别节目回顾长图",
        text: "《原神》7.1版本「往冥府的安魂歌」将于2026年9月23日上线。\n本次兑换码将于2026年9月15日12:00:00失效，记得尽快兑换哦~",
        cover: "https://upload-bbs.miyoushe.com/upload/2026/09/12/75276539/cover.jpg",
        created_at: 1789219629, // 2026-09-12 21:27:09 +08:00
      },
      {
        post_id: "78027438",
        subject: "《原神》7.1版本「往冥府的安魂歌」前瞻特别节目预告",
        text: "《原神》7.1版本「往冥府的安魂歌」前瞻特别节目将于9月12日（本周六）20:00正式开启。\n活动时间 ：2026年9月12日-2026年9月14日23:59",
        created_at: 1789219629 - 5 * 24 * 3600,
        links: [
          `https://webstatic.mihoyo.com/bbs/event/live/index.html?act_id=${actId}&mhy_presentation_style=fullscreen&game_biz=hk4e`,
          "https://live.bilibili.com/21987615",
        ],
      },
    ]),
    // The web navigator has no livestream entry once the stream is over.
    navigator: { retcode: 0, message: "OK", data: { navigator: [] } },
    index: (id) =>
      id === actId
        ? miyoliveIndexFixture({ title: "原神7.1前瞻", aid: "75276539", start: "2026-09-12 19:32:49", codeVer: "11cb71" })
        : undefined,
    codes: (id) =>
      id === actId
        ? miyoliveCodeFixture([
            { code: "往冥府的安魂歌", reward: "原石*100 精锻用魔矿*10", at: 1789214670 },
            { code: "风仙薇斯纳为你效劳", reward: "原石*100 大英雄的经验*5", at: 1789216290 },
            { code: "首席女高音沃雅妮莎", reward: "原石*100 摩拉*50000", at: 1789217130 },
          ])
        : undefined,
  });

  try {
    const events = await fetchMiyousheLivestreamCodeEventsForGame("genshin", {}, NOW_MS);
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.id, `genshin:livestream-code:${actId}`);
    assert.equal(event.title, "7.1版本前瞻兑换码");
    assert.equal(event.start_time, "2026-09-12T20:04:30+08:00");
    assert.equal(event.end_time, "2026-09-15T12:00:00+08:00");
    assert.deepEqual(event.redeem_codes, ["往冥府的安魂歌", "风仙薇斯纳为你效劳", "首席女高音沃雅妮莎"]);
    assert.equal(event.linkUrl, "https://www.miyoushe.com/ys/article/78118185");
  } finally {
    mock.restore();
  }
});

test("livestream codes: ZZZ keeps an expiry-only reminder when codes are image-only and the stream is gone", async () => {
  const mock = installMiyousheMock({
    userPost: miyousheUserPostFixture([
      {
        post_id: "77827035",
        subject: "情报总览丨《绝区零》3.2 版本「她与她的隐秘往事」",
        text: "《绝区零》3.2 版本「她与她的隐秘往事」将于9月9日正式上线！\n本次特别节目中的兑换码将于8月30日  23:59:59失效，记得及时兑换哦~",
        created_at: 1787919312, // 2026-08-28 20:15:12 +08:00
      },
      {
        post_id: "77827033",
        subject: "《绝区零》3.2 版本「她与她的隐秘往事」前瞻特别节目",
        text: "本次特别节目中的兑换码将于8月30日 23:59:59失效，记得尽快兑换哦~",
        created_at: 1787919310,
      },
      {
        post_id: "77716261",
        subject: "3.2版本「她与她的隐秘往事」前瞻特别节目预告",
        text: "前瞻特别节目，将于8月28日 19:30正式开启！节目直播期间不仅会发放兑换码福利。",
        created_at: 1787919310 - 4 * 24 * 3600,
      },
    ]),
    navigator: { retcode: 0, message: "OK", data: { navigator: [] } },
  });

  try {
    const events = await fetchMiyousheLivestreamCodeEventsForGame("zzz", {}, Date.UTC(2026, 7, 29, 12));
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.id, "zzz:livestream-code:77827033");
    assert.equal(event.title, "3.2版本前瞻兑换码");
    assert.equal(event.end_time, "2026-08-30T23:59:59+08:00");
    assert.equal(event.redeem_codes, undefined);
    assert.equal(event.linkUrl, "https://www.miyoushe.com/zzz/article/77827033");
  } finally {
    mock.restore();
  }
});

test("livestream codes: a livestream from another streamer is rejected", async () => {
  const mock = installMiyousheMock({
    userPost: miyousheUserPostFixture([]),
    navigator: navigatorFixture(["ea1"]),
    index: () => miyoliveIndexFixture({ title: "某主播直播", aid: "10", start: "2026-09-20 19:10:00", codeVer: "x" }),
    codes: () => miyoliveCodeFixture([{ code: "FAKE", reward: "", at: 1 }]),
  });

  try {
    assert.deepEqual(await fetchMiyousheLivestreamCodeEventsForGame("starrail", {}, NOW_MS), []);
  } finally {
    mock.restore();
  }
});

test("livestream codes: Wuthering Waves reads the official publisher comment", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: string; source: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ url, body, source: headers.get("source") });
    if (url.endsWith("/forum/search/v2/post")) return jsonResponse(wwSearchFixture());
    const postId = new URLSearchParams(body).get("postId") ?? "";
    return jsonResponse(wwDetailFixture(postId));
  };

  try {
    const events = await fetchWwLivestreamCodeEvents({}, NOW_MS);
    const listRequests = requests.filter((r) => r.url.endsWith("/forum/search/v2/post"));
    const detailRequests = requests.filter((r) => r.url.endsWith("/forum/getPostDetail"));
    assert.equal(listRequests.length, 2);
    assert.ok(listRequests.every((r) => r.source === "android"));
    assert.ok(listRequests.every((r) => new URLSearchParams(r.body).get("gameId") === "3"));
    assert.ok(listRequests.every((r) => new URLSearchParams(r.body).get("keyword") === "前瞻通讯"));
    // Only official "前瞻" posts are opened; the community repost is skipped.
    assert.deepEqual(
      detailRequests.map((r) => new URLSearchParams(r.body).get("postId")).sort(),
      ["1548053613414187008", "1550916937441083392"]
    );

    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.id, "ww:livestream-code:1550916937441083392");
    assert.equal(event.title, "3.7版本前瞻兑换码");
    assert.equal(event.start_time, "2026-09-19T20:05:00+08:00");
    assert.equal(event.end_time, "2026-09-21T23:59:00+08:00");
    assert.deepEqual(event.redeem_codes, ["FALLINGSANCTUM", "FINDSENTINEL", "WAKINGMOON"]);
    assert.equal(event.linkUrl, "https://www.kurobbs.com/mc/post/1550916937441083392");
    assert.equal(event.banner, "https://prod-alicdn-community.kurobbs.com/forum/cover.png");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("livestream codes: upstream failures degrade to an empty list", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Forbidden", { status: 403 });

  try {
    assert.deepEqual(await fetchLivestreamCodeEvents("starrail"), []);
    assert.deepEqual(await fetchLivestreamCodeEvents("ww"), []);
    assert.deepEqual(await fetchLivestreamCodeEvents("genshin"), []);
    assert.deepEqual(await fetchLivestreamCodeEvents("zzz"), []);
    assert.deepEqual(await fetchLivestreamCodeEvents("snowbreak"), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("livestream codes: fetchEventsForGame appends code events to the notice feed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/post/wapi/userPost")) return jsonResponse(miyousheUserPostFixture(starRailPosts()));
    if (url.includes("/apihub/") || url.includes("/miyolive/")) return new Response("Forbidden", { status: 403 });
    return jsonResponse({ retcode: 0, message: "OK", data: { list: [] } });
  };

  try {
    const events = await fetchEventsForGame("starrail");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.title, "4.6版本前瞻兑换码");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
