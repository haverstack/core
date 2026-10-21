/**
 * A value loaded on first use and shared after — how one operation reads a
 * set at most once. A failed load is not kept, so the next use asks again,
 * and clear() drops the value for a holder that outlives one operation.
 */
export class Lazy<T> {
  private loading: Promise<T> | null = null;

  constructor(private readonly load: () => Promise<T>) {}

  get(): Promise<T> {
    if (this.loading) return this.loading;
    const loading = this.load();
    this.loading = loading;
    loading.catch(() => {
      if (this.loading === loading) this.loading = null;
    });
    return loading;
  }

  clear(): void {
    this.loading = null;
  }
}
