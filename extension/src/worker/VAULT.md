# The secret vault

The one place in the extension that persists plaintext on purpose. What follows is the
reasoning, because the code is short and the constraints are the interesting part.

## The planner cannot reach it, structurally

Not "is told not to" -- cannot. Three independent things have to hold, and each is
enforced somewhere different:

1. A `SECRET` finding is **unnumbered** (`redaction/policy.ts`), so the allocator issues
   no token for it. There is no `«SECRET_1»` for a plan to reference.
2. `content/executor.ts` refuses any `type` whose text matches a secret token, however it
   is spelled, and refuses it **before looking the element up** -- whether the field
   exists has no bearing on whether a secret may go into it.
3. The only release path, `VAULT_FILL`, is a popup-to-worker message. Nothing in the
   `Action` vocabulary reaches it.

Remove any one and the other two still hold.

## Keyed by origin and class

`http://localhost:8080` + `SECRET`. Not the element index, which changes on every walk --
see `demo/NAVIGATION.md`, where 7 of 12 indices came to mean a different element after one
navigation. Not the field's name or label, which the site controls and can set to whatever
it likes, including something that looks like another site's.

An origin is the coarsest thing that is still a real security boundary, and for a store
that must not accumulate, the coarsest correct key is the right one.

## Nothing is read without a visible confirm

Every read. Not once per session, not remembered, no "don't ask again". The confirm names
the field and shows the origin **whole and unabbreviated**, because
`portal.gov.in.evil.example` is only distinguishable from `portal.gov.in` if you can see
all of it.

It is a window rather than a notification. A notification can be missed, suppressed by the
OS, or dismissed with one click in the corner of the screen, and none of those should be
able to stand for "the operator agreed to hand a credential to this origin". Closing the
window is an answer, and the answer is no.

The lookup happens **before** the prompt: asking about a secret that is not stored would
tell the operator every time a page has a password field that we looked, and train them to
click through a dialog that usually means nothing.

## Where the value goes

Vault → worker → content script → the field. That is the entire path.

It is never returned to the caller (`VAULT_FILL` replies with an outcome, not a value),
never written to `chrome.storage.session`, never named in a note, a log line, a trace or a
`STEP_EVENT`. `VAULT_LIST` returns origins and classes only.

Verified from both ends: `router.test.ts` sweeps a whole session's trace, step log, stored
state and event stream for a value the executor rehydrated, and the same sweep run against
a live browser found the typed address on the page and in neither storage area, while the
token `«EMAIL_1»` was still in the step log -- which is what stops the sweep from passing
vacuously.

## The cost, stated plainly

`chrome.storage.local` outlives the session, the browser restart, and the redaction gate,
which cannot reach into it. That is a real cost and it is why the key space is narrow, why
`forgetAll` exists and is easy to reach, and why nothing but an explicit operator action
ever writes here.

The alternative was worse. A vault that vanished with the session is a vault nobody uses,
and a vault nobody uses is one where the operator types the password into the page by hand
while the agent watches.
