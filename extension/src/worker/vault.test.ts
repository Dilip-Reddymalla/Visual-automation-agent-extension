import { describe, it, expect, vi } from 'vitest';
import {
  forgetAll,
  forgetSecret,
  listSecrets,
  readSecret,
  saveSecret,
  vaultKeyOf,
  VAULT_PREFIX,
  type VaultEntry,
  type VaultStore,
} from './vault';

/**
 * The vault is the only place the extension keeps plaintext on purpose, so these tests
 * are mostly about the paths that must not exist.
 */

function memoryStore(): VaultStore & { map: Map<string, VaultEntry> } {
  const map = new Map<string, VaultEntry>();
  return {
    map,
    get: async (k) => map.get(k),
    set: async (k, v) => void map.set(k, v),
    remove: async (k) => void map.delete(k),
    keys: async () => [...map.keys()],
  };
}

const KEY = { origin: 'https://portal.gov.in', cls: 'SECRET' as const };

describe('the key', () => {
  it('is the origin and the class, and nothing that a page controls', () => {
    // Not the element index, which changes on every walk. Not the field's name, which
    // the site chooses and could set to look like another site's.
    expect(vaultKeyOf(KEY)).toBe(`${VAULT_PREFIX}https://portal.gov.in|SECRET`);
  });

  it('separates origins that differ only by scheme', () => {
    expect(vaultKeyOf({ origin: 'http://a.in', cls: 'SECRET' })).not.toBe(
      vaultKeyOf({ origin: 'https://a.in', cls: 'SECRET' }),
    );
  });
});

describe('reading', () => {
  it('asks before releasing, naming the origin and the field', async () => {
    const store = memoryStore();
    await saveSecret(KEY, { label: 'Portal PIN', value: 'hunter2' }, { store });

    const confirm = vi.fn(async () => true);
    const read = await readSecret(KEY, { store, confirm });

    expect(read).toEqual({ ok: true, value: 'hunter2' });
    expect(confirm).toHaveBeenCalledWith({
      origin: 'https://portal.gov.in',
      cls: 'SECRET',
      label: 'Portal PIN',
    });
  });

  it('returns nothing when the operator says no', async () => {
    const store = memoryStore();
    await saveSecret(KEY, { label: 'Portal PIN', value: 'hunter2' }, { store });

    const read = await readSecret(KEY, { store, confirm: async () => false });
    expect(read).toEqual({ ok: false, reason: 'declined' });
  });

  it('has no path that skips the confirm', async () => {
    // The property, stated as a test: with a confirm that always declines, no sequence
    // of reads yields the value.
    const store = memoryStore();
    await saveSecret(KEY, { label: 'Portal PIN', value: 'hunter2' }, { store });

    const confirm = async () => false;
    for (let i = 0; i < 3; i += 1) {
      const read = await readSecret(KEY, { store, confirm });
      expect(read.ok).toBe(false);
    }
  });

  it('does not ask about a secret it does not have', async () => {
    // Prompting every time a page has a password field would train the operator to
    // click through a dialog that usually means nothing.
    const confirm = vi.fn(async () => true);
    const read = await readSecret(KEY, { store: memoryStore(), confirm });

    expect(read).toEqual({ ok: false, reason: 'not-stored' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("will not release one origin's secret to another", async () => {
    const store = memoryStore();
    await saveSecret(KEY, { label: 'Portal PIN', value: 'hunter2' }, { store });

    const read = await readSecret(
      { origin: 'https://portal.gov.in.evil.example', cls: 'SECRET' },
      { store, confirm: async () => true },
    );
    expect(read).toEqual({ ok: false, reason: 'not-stored' });
  });
});

describe('writing', () => {
  it('refuses to store an empty secret', async () => {
    // An empty entry is worse than none: it would satisfy the "is one stored?" check
    // and then type nothing, which reads as the agent silently failing.
    await expect(
      saveSecret(KEY, { label: 'Portal PIN', value: '' }, { store: memoryStore() }),
    ).rejects.toThrow(/empty/);
  });

  it('replaces rather than accumulating', async () => {
    const store = memoryStore();
    await saveSecret(KEY, { label: 'PIN', value: 'old' }, { store });
    await saveSecret(KEY, { label: 'PIN', value: 'new' }, { store });

    expect(store.map.size).toBe(1);
    const read = await readSecret(KEY, { store, confirm: async () => true });
    expect(read).toEqual({ ok: true, value: 'new' });
  });
});

describe('forgetting', () => {
  it('is reachable for one entry and for all of them', async () => {
    const store = memoryStore();
    await saveSecret(KEY, { label: 'PIN', value: 'a' }, { store });
    await saveSecret(
      { origin: 'https://b.in', cls: 'SECRET' },
      { label: 'x', value: 'b' },
      { store },
    );

    await forgetSecret(KEY, { store });
    expect(await listSecrets({ store })).toEqual([{ origin: 'https://b.in', cls: 'SECRET' }]);

    expect(await forgetAll({ store })).toBe(1);
    expect(await listSecrets({ store })).toEqual([]);
  });

  it('leaves keys that are not ours alone', async () => {
    const store = memoryStore();
    store.map.set('agent-state', { label: '', value: '', savedAt: 0 });
    await saveSecret(KEY, { label: 'PIN', value: 'a' }, { store });

    await forgetAll({ store });
    expect([...store.map.keys()]).toEqual(['agent-state']);
  });
});

describe('listing', () => {
  it('names what is stored without producing any of it', async () => {
    const store = memoryStore();
    await saveSecret(KEY, { label: 'Portal PIN', value: 'hunter2' }, { store });

    const listed = await listSecrets({ store });
    expect(JSON.stringify(listed)).not.toContain('hunter2');
    expect(listed).toEqual([{ origin: 'https://portal.gov.in', cls: 'SECRET' }]);
  });
});
