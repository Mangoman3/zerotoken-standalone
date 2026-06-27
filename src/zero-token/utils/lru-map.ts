/**
 * Simple LRU Map that evicts oldest entries when capacity is exceeded.
 * Prevents unbounded memory growth in long-running processes.
 */
export class LruMap<K, V> extends Map<K, V> {
  private readonly capacity: number;

  constructor(capacity: number = 50) {
    super();
    this.capacity = capacity;
  }

  override set(key: K, value: V): this {
    // If key exists, delete first to refresh insertion order
    if (super.has(key)) {
      super.delete(key);
    }
    super.set(key, value);

    // Evict oldest entries if over capacity
    while (super.size > this.capacity) {
      const oldest = super.keys().next().value;
      if (oldest !== undefined) {
        super.delete(oldest);
      } else {
        break;
      }
    }

    return this;
  }

  override get(key: K): V | undefined {
    if (!super.has(key)) return undefined;
    // Refresh access order
    const value = super.get(key)!;
    super.delete(key);
    super.set(key, value);
    return value;
  }
}
