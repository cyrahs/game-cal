// Upstream/API errors surface as raw English strings; map the known ones to
// user-facing Chinese and fall back to the original text for anything novel.
const ERROR_MESSAGE_LOCALIZATIONS: Array<{ pattern: RegExp; text: string }> = [
  { pattern: /upstream fetch failed/i, text: "上游公告接口请求失败" },
  { pattern: /no data for game/i, text: "暂无该游戏的数据" },
  { pattern: /worker mode with d1/i, text: "云端同步仅在 Worker + D1 部署下可用" },
  { pattern: /failed to fetch|networkerror|load failed|fetch failed/i, text: "网络请求失败，请检查网络连接" },
  { pattern: /timed? ?out/i, text: "请求超时，请稍后重试" },
  { pattern: /^request failed: (\d+)$/i, text: "服务端返回错误" },
  {
    pattern: /unexpected token|not valid json|unexpected end of json|failed to execute 'json'/i,
    text: "服务端返回了无法解析的数据",
  },
];

export function localizeErrorMessage(raw: string | null | undefined): string {
  const message = (raw ?? "").trim();
  if (!message) return "未知错误";
  for (const { pattern, text } of ERROR_MESSAGE_LOCALIZATIONS) {
    if (pattern.test(message)) return text;
  }
  return message;
}
