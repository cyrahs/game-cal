import type { ApiResponse } from "./types";

const UPDATED_AT_HEADER = "x-gc-updated-at";

function parseUpdatedAtMs(res: Response): number | null {
  const raw = res.headers.get(UPDATED_AT_HEADER);
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

export async function apiGetWithUpdatedAt<T>(
  path: string
): Promise<{ json: ApiResponse<T>; updatedAtMs: number | null }> {
  const res = await fetch(path, {
    headers: { accept: "application/json" },
  });
  const updatedAtMs = parseUpdatedAtMs(res);
  const json = (await res.json()) as ApiResponse<T>;
  if (!res.ok || json.code >= 400) {
    throw new Error(json.msg || `Request failed: ${res.status}`);
  }
  return { json, updatedAtMs };
}

export async function apiGet<T>(path: string): Promise<ApiResponse<T>> {
  return (await apiGetWithUpdatedAt<T>(path)).json;
}
