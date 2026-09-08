/**
 * Getting sealed bytes from the context that sealed them to the context that sends them.
 *
 * The gate runs in the offscreen document, because that is where a graphics context
 * exists. The POST runs in the service worker, because worker/receipt.ts verifies the
 * bytes *in a different process from the gate* -- and that separation is the sentence
 * invariant 1 rests on. Moving the send into the offscreen document would make the
 * verification the gate's own opinion of itself, so the bytes have to cross.
 *
 * They cannot cross the bus: `chrome.runtime.sendMessage` serialises to JSON, so a Blob
 * would have to become base64, which is the thing shared/frames.ts exists to forbid.
 *
 * IndexedDB, then. Structured clone, so a Blob goes in and a byte-identical Blob comes
 * out; same extension origin, so both contexts see the same database; no new permission.
 *
 * Measured rather than assumed: a 120,000-byte Blob written in one context and read in
 * another came back with the same length, the same MIME type and the same checksum.
 *
 * The other candidate was for the worker to fetch the offscreen document's blob: URL.
 * That works from a dedicated worker -- also measured -- but a *service* worker is a
 * different case and could not be tested here, because the harness browser refuses to
 * register one. It stays a documented optimisation to try on the first real extension
 * load, not a foundation to build on today.
 */

const DB_NAME = 'sih-frame-handoff';
const DB_VERSION = 1;
const STORE = 'frames';

/**
 * A frame is written, read once, and deleted. Anything older than this was orphaned by
 * a step that died between the two, and is swept -- a redacted frame is still a picture
 * of the user's screen and has no business outliving the step that made it.
 */
export const ORPHAN_MS = 60_000;

export interface StoredFrame {
  bytes: Blob;
  sha256: string;
  mime: string;
  width: number;
  height: number;
  storedAt: number;
}

/** The minimum of IndexedDB this module needs, so it can be faked in Node. */
export interface FrameStore {
  put(key: string, frame: StoredFrame): Promise<void>;
  take(key: string): Promise<StoredFrame | undefined>;
  sweep(olderThan: number): Promise<number>;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('frame-store: open failed'));
  });
}

function run<T>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = body(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(request.error ?? new Error('frame-store: request failed'));
        tx.oncomplete = () => db.close();
      }),
  );
}

export function createFrameStore(): FrameStore {
  return {
    async put(key, frame) {
      await run('readwrite', (store) => store.put(frame, key));
    },

    /**
     * Read and delete in one go. A frame has exactly one consumer, and leaving it
     * behind after the POST would leave a picture of the user's screen in browser
     * storage indefinitely.
     */
    async take(key) {
      const frame = await run<StoredFrame | undefined>('readonly', (store) => store.get(key));
      if (frame) await run('readwrite', (store) => store.delete(key));
      return frame;
    },

    async sweep(olderThan) {
      const db = await open();
      return new Promise<number>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const cursorRequest = store.openCursor();
        let removed = 0;

        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const value = cursor.value as StoredFrame | undefined;
          if (value && value.storedAt < olderThan) {
            cursor.delete();
            removed += 1;
          }
          cursor.continue();
        };
        cursorRequest.onerror = () =>
          reject(cursorRequest.error ?? new Error('frame-store: sweep failed'));
        tx.oncomplete = () => {
          db.close();
          resolve(removed);
        };
      });
    },
  };
}

/** In-memory, for tests and for a context with no IndexedDB. */
export function memoryFrameStore(): FrameStore {
  const frames = new Map<string, StoredFrame>();
  return {
    async put(key, frame) {
      frames.set(key, frame);
    },
    async take(key) {
      const frame = frames.get(key);
      frames.delete(key);
      return frame;
    },
    async sweep(olderThan) {
      let removed = 0;
      for (const [key, frame] of [...frames]) {
        if (frame.storedAt < olderThan) {
          frames.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
  };
}

/** One key per step, so a retry cannot collide with the frame it is retrying. */
export function frameKey(sessionId: string, stepIndex: number): string {
  return `${sessionId}#${stepIndex}`;
}
