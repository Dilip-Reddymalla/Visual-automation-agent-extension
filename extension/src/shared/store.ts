/**
 * The little key-value interface the worker keeps its state in.
 *
 * MV3 kills idle service workers, so anything that must outlive a step lives here --
 * backed by `chrome.storage.session` in the browser (platform/session-store.ts) and by
 * a Map in tests. Module-level variables in the worker are for listeners, never state.
 *
 * Node-pure: no chrome, no storage API, just the shape.
 */

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  /** Fires when someone else writes the key. Returns an unsubscribe. Event-driven. */
  watch<T>(key: string, onChange: (value: T | undefined) => void): () => void;
}

/** In-memory store for unit tests and for a context with nothing to persist. */
export function memoryStore(initial?: Record<string, unknown>): KeyValueStore {
  const data = new Map<string, unknown>(Object.entries(initial ?? {}));
  const watchers = new Map<string, Set<(value: unknown) => void>>();

  function notify(key: string, value: unknown): void {
    for (const cb of watchers.get(key) ?? []) cb(value);
  }

  return {
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      data.set(key, value);
      notify(key, value);
    },
    async remove(key: string): Promise<void> {
      data.delete(key);
      notify(key, undefined);
    },
    watch<T>(key: string, onChange: (value: T | undefined) => void): () => void {
      const cb = (value: unknown) => onChange(value as T | undefined);
      const set = watchers.get(key) ?? new Set();
      set.add(cb);
      watchers.set(key, set);
      return () => {
        set.delete(cb);
      };
    },
  };
}
