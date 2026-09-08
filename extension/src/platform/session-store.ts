/**
 * `chrome.storage.session` behind the KeyValueStore interface.
 *
 * Session storage, not local: the agent's state is per-browser-session and must not
 * outlive it on disk. It holds a goal, a tab id and a step log -- no page content, no
 * values, nothing the redaction gate would have had an opinion about.
 *
 * This is what makes the worker survivable. MV3 kills an idle service worker within
 * ~30 s; every wake reads its state back from here.
 */

import type { KeyValueStore } from '../shared/store';

type StorageArea = {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  onChanged: {
    addListener(listener: (changes: Record<string, { newValue?: unknown }>) => void): void;
    removeListener(listener: (changes: Record<string, { newValue?: unknown }>) => void): void;
  };
};

function sessionArea(): StorageArea {
  return chrome.storage.session as unknown as StorageArea;
}

export function chromeSessionStore(area: StorageArea = sessionArea()): KeyValueStore {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const bag = await area.get(key);
      return bag[key] as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      await area.set({ [key]: value });
    },
    async remove(key: string): Promise<void> {
      await area.remove(key);
    },
    watch<T>(key: string, onChange: (value: T | undefined) => void): () => void {
      const listener = (changes: Record<string, { newValue?: unknown }>): void => {
        if (!(key in changes)) return;
        onChange(changes[key]?.newValue as T | undefined);
      };
      area.onChanged.addListener(listener);
      return () => area.onChanged.removeListener(listener);
    },
  };
}
