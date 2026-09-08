/**
 * `chrome.storage.local` behind the VaultStore interface, and the operator confirm.
 *
 * Local, not session -- deliberately, and it is the only thing in the extension that
 * gets that treatment. A stored credential that vanished with the browser session would
 * be a vault nobody used, and a vault nobody uses is one where the operator types the
 * password into the page by hand while the agent watches. The cost is that this outlives
 * everything else, including the redaction gate, which is why worker/vault.ts keeps the
 * key space narrow and `forgetAll` easy to reach.
 *
 * The confirm is a real window, not a notification. A notification can be missed, can be
 * suppressed by the OS, and answering one is a single click in a corner of the screen --
 * none of which is what "the operator agreed to release a credential to this origin"
 * should look like.
 */

import type { ConfirmRelease, VaultEntry, VaultStore } from '../worker/vault';

type LocalArea = {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};

function localArea(): LocalArea {
  return chrome.storage.local as unknown as LocalArea;
}

export function chromeVaultStore(area: LocalArea = localArea()): VaultStore {
  return {
    async get(key: string): Promise<VaultEntry | undefined> {
      const bag = await area.get(key);
      return bag[key] as VaultEntry | undefined;
    },
    async set(key: string, entry: VaultEntry): Promise<void> {
      await area.set({ [key]: entry });
    },
    async remove(key: string): Promise<void> {
      await area.remove(key);
    },
    async keys(): Promise<string[]> {
      // `null` is every key in the area. The values come back too and are dropped here
      // rather than being carried around: a listing has no business holding secrets.
      return Object.keys(await area.get(null));
    },
  };
}

/**
 * Put the question in front of the operator and wait for an answer.
 *
 * Everything the operator needs to refuse is in the sentence: which field, and which
 * origin it is going to. The origin is shown in full and unabbreviated, because
 * `portal.gov.in.evil.example` is only distinguishable from `portal.gov.in` if you can
 * see the whole thing.
 */
export function chromeConfirmRelease(): ConfirmRelease {
  return async ({ origin, cls, label }) => {
    const url = new URL(chrome.runtime.getURL('confirm.html'));
    url.searchParams.set('origin', origin);
    url.searchParams.set('cls', cls);
    url.searchParams.set('label', label);

    const created = await chrome.windows.create({
      url: url.toString(),
      type: 'popup',
      width: 460,
      height: 280,
      focused: true,
    });

    const windowId = created.id;
    if (windowId === undefined) return false;

    return new Promise<boolean>((resolve) => {
      let answered = false;

      const onMessage = (message: unknown): void => {
        const reply = message as { type?: string; windowId?: number; allow?: boolean };
        if (reply?.type !== 'VAULT_CONFIRM' || reply.windowId !== windowId) return;
        answered = true;
        chrome.runtime.onMessage.removeListener(onMessage);
        chrome.windows.onRemoved.removeListener(onClosed);
        void chrome.windows.remove(windowId).catch(() => undefined);
        resolve(reply.allow === true);
      };

      // Closing the window is an answer, and the answer is no. A dialog that resolves
      // to "yes" when dismissed is not a confirm.
      const onClosed = (closed: number): void => {
        if (closed !== windowId || answered) return;
        chrome.runtime.onMessage.removeListener(onMessage);
        chrome.windows.onRemoved.removeListener(onClosed);
        resolve(false);
      };

      chrome.runtime.onMessage.addListener(onMessage);
      chrome.windows.onRemoved.addListener(onClosed);
    });
  };
}
