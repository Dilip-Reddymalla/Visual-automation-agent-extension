/**
 * The secret vault.
 *
 * This is the one place in the extension that deliberately persists a user's plaintext,
 * so the constraints on it are stricter than anywhere else and are worth stating before
 * the code.
 *
 * **The planner can never reach it.** A SECRET finding is unnumbered by policy
 * (redaction/policy.ts), so no token stands for it, so a plan cannot name one. The
 * executor refuses a `type` whose text names a secret however it is spelled. Nothing in
 * this file is reachable from a plan -- the only caller is an `ask` the operator
 * answered.
 *
 * **Keyed by origin and class, never by field.** `https://portal.gov.in` + `SECRET` is
 * the key. Not the element index, which changes on every walk; not the field name,
 * which the site controls and can change to something that looks like another site's.
 * An origin is the coarsest thing that is still a real security boundary, and the
 * coarsest correct key is the right one for a store that must not accumulate.
 *
 * **Nothing is read without a visible confirm.** Not once per session, not remembered:
 * every read names the field and the origin and waits. A vault that fills silently is
 * a credential-stuffing tool that happens to be driven by a language model.
 *
 * **It lives in `chrome.storage.local`, and that is a real cost.** It survives the
 * session, the browser restart and the redaction gate, which is why it holds only what
 * the operator explicitly put there and why `forget` exists and is easy to reach.
 */

import type { PlaceholderClass } from '../shared/placeholders';

/** Where the vault lives. Its own key space, so a clear is unambiguous. */
export const VAULT_PREFIX = 'vault:';

export interface VaultKey {
  /** Scheme and host. Never a full URL: query strings routinely carry identifiers. */
  origin: string;
  cls: PlaceholderClass;
}

export interface VaultEntry {
  /** What the operator is agreeing to release, named in the confirm. */
  label: string;
  value: string;
  savedAt: number;
}

/** What a read can produce. Declining is a first-class outcome, not an error. */
export type VaultRead =
  { ok: true; value: string } | { ok: false; reason: 'not-stored' | 'declined' };

/**
 * The parts of `chrome.storage.local` this needs, and no more. Injected so the tests
 * run against a Map rather than a browser.
 */
export interface VaultStore {
  get(key: string): Promise<VaultEntry | undefined>;
  set(key: string, entry: VaultEntry): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/**
 * Asks the operator, in the browser, naming what is about to be released and to whom.
 *
 * Injected because the answer must come from a human and a test cannot be one. In the
 * extension it opens a window (platform/vault-store.ts) rather than a notification, which
 * can be missed or suppressed; what matters here is that no code path skips it.
 */
export type ConfirmRelease = (request: {
  origin: string;
  cls: PlaceholderClass;
  label: string;
}) => Promise<boolean>;

export function vaultKeyOf({ origin, cls }: VaultKey): string {
  return `${VAULT_PREFIX}${origin}|${cls}`;
}

/**
 * Read a secret, if one is stored and the operator says yes.
 *
 * The order is deliberate: look first, then ask. Asking about a secret that is not
 * stored would tell the operator, every time a page has a password field, that we
 * looked -- and train them to click through a prompt that usually means nothing.
 */
export async function readSecret(
  key: VaultKey,
  deps: { store: VaultStore; confirm: ConfirmRelease },
): Promise<VaultRead> {
  const entry = await deps.store.get(vaultKeyOf(key));
  if (!entry) return { ok: false, reason: 'not-stored' };

  const allowed = await deps.confirm({
    origin: key.origin,
    cls: key.cls,
    label: entry.label,
  });
  if (!allowed) return { ok: false, reason: 'declined' };

  return { ok: true, value: entry.value };
}

/**
 * Store one, replacing whatever was there for that origin and class.
 *
 * Only ever called from the popup, in response to the operator typing it. There is no
 * path from a page, a plan or a step.
 */
export async function saveSecret(
  key: VaultKey,
  entry: { label: string; value: string },
  deps: { store: VaultStore; now?: () => number },
): Promise<void> {
  if (entry.value === '') throw new Error('vault: refusing to store an empty secret');
  await deps.store.set(vaultKeyOf(key), {
    label: entry.label,
    value: entry.value,
    savedAt: (deps.now ?? Date.now)(),
  });
}

export async function forgetSecret(key: VaultKey, deps: { store: VaultStore }): Promise<void> {
  await deps.store.remove(vaultKeyOf(key));
}

/** Everything stored, as keys only. The values never leave for a listing. */
export async function listSecrets(deps: { store: VaultStore }): Promise<VaultKey[]> {
  const keys = await deps.store.keys();
  const entries: VaultKey[] = [];

  for (const key of keys) {
    if (!key.startsWith(VAULT_PREFIX)) continue;
    const [origin, cls] = key.slice(VAULT_PREFIX.length).split('|');
    if (origin && cls) entries.push({ origin, cls: cls as PlaceholderClass });
  }
  return entries;
}

/** Drop everything. The operator's escape hatch, and what an uninstall should do. */
export async function forgetAll(deps: { store: VaultStore }): Promise<number> {
  const keys = await deps.store.keys();
  const ours = keys.filter((k) => k.startsWith(VAULT_PREFIX));
  for (const key of ours) await deps.store.remove(key);
  return ours.length;
}
