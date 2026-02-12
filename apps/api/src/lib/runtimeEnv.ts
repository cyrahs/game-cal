export interface RuntimeEnv {
  // Upstream override URLs (optional).
  GENSHIN_API_URL?: string;
  GENSHIN_CONTENT_API_URL?: string;
  STARRAIL_API_URL?: string;
  STARRAIL_CONTENT_API_URL?: string;
  ZZZ_API_URL?: string;
  ZZZ_ACTIVITY_API_URL?: string;
  ZZZ_CONTENT_API_URL?: string;
  SNOWBREAK_ANNOUNCE_API_URL?: string;
  WW_NOTICE_API_URL?: string;

  // Endfield (Hypergryph bulletin) overrides (optional).
  // If ENDFIELD_CODE is set, we won't scrape the webview bundle to discover it.
  ENDFIELD_WEBVIEW_URL?: string;
  ENDFIELD_AGGREGATE_API_URL?: string;
  ENDFIELD_CODE?: string;
}
