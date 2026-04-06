type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

export class SimpleTtlCache {
  private readonly store = new Map<string, CacheEntry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly generations = new Map<string, number>();

  delete(key: string): void {
    this.store.delete(key);
    this.inflight.delete(key);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
  }

  async getOrSet<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const cached = this.store.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.value as T;
    }

    const existing = this.inflight.get(key);
    if (existing) {
      return (await existing) as T;
    }

    const generation = this.generations.get(key) ?? 0;
    const p = fn()
      .then((value) => {
        if ((this.generations.get(key) ?? 0) === generation) {
          this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
        }
        return value;
      })
      .finally(() => {
        if (this.inflight.get(key) === p) {
          this.inflight.delete(key);
        }
      });

    this.inflight.set(key, p as Promise<unknown>);
    return await p;
  }
}
