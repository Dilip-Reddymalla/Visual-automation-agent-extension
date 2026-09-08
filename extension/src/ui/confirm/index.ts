/**
 * The release confirm.
 *
 * A whole window rather than a notification, because a notification can be missed,
 * suppressed by the OS, or dismissed with a click in the corner of the screen -- none of
 * which should be able to stand for "the operator agreed to hand a credential to this
 * origin".
 *
 * It reads its subject from the query string and reports one boolean back. It has no
 * access to the vault and never sees the value: what is being released is described to
 * the operator by label, and only the worker can read the secret itself.
 */

const params = new URLSearchParams(location.search);

function fill(id: string, value: string | null): void {
  const el = document.getElementById(id);
  if (el && value) el.textContent = value;
}

fill('label', params.get('label'));
fill('origin', params.get('origin'));

async function answer(allow: boolean): Promise<void> {
  // The real window id, not WINDOW_ID_CURRENT: the worker is matching the reply against
  // the window it opened, and the sentinel would match nothing.
  const self = await chrome.windows.getCurrent();
  await chrome.runtime.sendMessage({ type: 'VAULT_CONFIRM', windowId: self.id, allow });
}

document.getElementById('allow')?.addEventListener('click', () => void answer(true));
document.getElementById('deny')?.addEventListener('click', () => void answer(false));

// Escape is a refusal, like closing the window. There is no key that releases.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') void answer(false);
});
