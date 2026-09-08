# Demo pages

Two local pages, served over `http://localhost` so the manifests' host_permissions
cover them:

- `page-a-enrolment.html` -- an enrolment form: name, DOB, Aadhaar, photo, address.
- `page-b-application.html` -- an application that reuses the same person, so the
  demo shows placeholder numbering staying stable across steps and across pages.
  Reached by a real document load: a filled submit on page A navigates here, which is
  the boundary that invalidates every element index. `NAVIGATION.md` has the
  measurement. It also carries the custom `div` dropdown -- no `<select>`, no `value`
  to set, and no options in the DOM until it is opened -- which cannot be shortcut and
  has to be operated by click, settle, re-perceive, click.

Written in week 1 (M12) so every other module has something real to run against. The
demo script itself comes in week 3.

Keep every value fake and checksum-valid: a fake Aadhaar still has to pass Verhoeff or
the L1 layer will correctly ignore it and the demo will show nothing.

This is not hypothetical. Page A shipped with `234567890123` and `ABCDE1234F`, which are
the shapes but not the checksums, and the first real browser load produced six L0
findings and **zero** from L1 — the layer working exactly as designed, on data that was
not what it claimed to be. Values now come from `eval/corpus/identifiers.json`, which
`scripts/make-pii-fixture.py` generates with its own Verhoeff and entity-code
implementations. Take new ones from there rather than typing something that looks right.

## Serving them

```bash
python -m http.server 8080 --directory demo
```

Then open `http://localhost:8080/page-a-enrolment.html`.

**Do not open these as `file://` URLs.** M4 dropped `file:///*` from both manifests, so
the content script will not run there. That was a deliberate trade: `file:///*` requires
the user to tick "Allow access to file URLs" in the extension's settings, which is a
broad grant -- every local file on the machine -- and a worse thing to ask a judge to do
than starting a static file server. The narrower permission set is also the better
answer to "what can this extension see?", which is the question this project exists to
answer well.

If a demo ever genuinely needs `file://`, it goes back in both manifests _and_ into an
OFFLINE-CHECKLIST.md step, not into one of them.
