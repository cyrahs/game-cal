import type { ApiResponse } from "./types";

export async function apiGet<T>(path: string): Promise<ApiResponse<T>> {
  const res = await fetch(path, {
    headers: { accept: "application/json" },
  });
  const json = (await res.json()) as ApiResponse<T>;
  if (!res.ok || json.code >= 400) {
    throw new Error(json.msg || `Request failed: ${res.status}`);
  }
  return json;
}

