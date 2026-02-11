export class FetchError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(opts: { url: string; status: number; message: string }) {
    super(opts.message);
    this.name = "FetchError";
    this.status = opts.status;
    this.url = opts.url;
  }
}

export async function fetchJson<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number }
): Promise<T> {
  const timeoutMs = init?.timeoutMs ?? 12_000;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = new Headers(init?.headers);
    // "User-Agent" is useful for upstream hygiene, but some runtimes (Workers)
    // may treat it as a restricted header. Best-effort only.
    if (!headers.has("user-agent")) {
      try {
        headers.set("user-agent", "game-cal/0.0.0 (+https://github.com/)");
      } catch {
        // ignore
      }
    }

    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new FetchError({
        url,
        status: res.status,
        message: `Upstream error ${res.status}: ${text.slice(0, 200)}`,
      });
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchText(
  url: string,
  init?: RequestInit & { timeoutMs?: number }
): Promise<string> {
  const timeoutMs = init?.timeoutMs ?? 12_000;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = new Headers(init?.headers);
    // "User-Agent" is useful for upstream hygiene, but some runtimes (Workers)
    // may treat it as a restricted header. Best-effort only.
    if (!headers.has("user-agent")) {
      try {
        headers.set("user-agent", "game-cal/0.0.0 (+https://github.com/)");
      } catch {
        // ignore
      }
    }

    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new FetchError({
        url,
        status: res.status,
        message: `Upstream error ${res.status}: ${text.slice(0, 200)}`,
      });
    }
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}
