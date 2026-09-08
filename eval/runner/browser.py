"""Launching Chrome with the extension in it, which is harder than it should be.

`--load-extension` does not work. Chrome 151 removed it as a command-line switch and
`--disable-features=DisableLoadExtensionCommandLineSwitch` does not bring it back; the
flag is accepted and silently ignored, which is the worst of the three possible
behaviours because the browser starts and everything downstream reports zero.

The route that works is the CDP `Extensions` domain, which
`--enable-unsafe-extension-debugging` unlocks. Playwright connects over CDP to a Chrome
we launched ourselves, opens a browser-level session, and calls
`Extensions.loadUnpacked` with the path to `dist/chrome`. This is the route the first
browser load session proved (demo/LOAD-SESSION.md) and it is not worth re-deriving.

Two things that session learned and that this module encodes:

  - Order matters. Loading the extension orphans any content script already in a tab
    ("Extension context invalidated"), so the extension is loaded before any corpus page
    is opened, and a page open at load time is reloaded.
  - MV3 kills the service worker after about thirty seconds of idleness. Anything that
    expects the worker to answer wakes it first.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


def find_chrome(explicit: str | None = None) -> str:
    if explicit:
        return explicit
    for path in CHROME_CANDIDATES:
        if Path(path).exists():
            return path
    found = shutil.which("chrome") or shutil.which("google-chrome") or shutil.which("chromium")
    if found:
        return found
    raise SystemExit(
        "no Chrome found. Pass --chrome with a path; Playwright's bundled Chromium "
        "will not do, because it does not ship the extension machinery this needs."
    )


@dataclass
class Launched:
    process: subprocess.Popen
    port: int
    profile: Path
    executable: str

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
        shutil.rmtree(self.profile, ignore_errors=True)


def launch_chrome(*, port: int = 9222, headless: bool = False,
                  executable: str | None = None) -> Launched:
    """Start Chrome with remote debugging and the unsafe-extension-debugging switch."""
    exe = find_chrome(executable)
    profile = Path(tempfile.mkdtemp(prefix="sih-eval-profile-"))

    args = [
        exe,
        f"--user-data-dir={profile}",
        # The switch that makes Extensions.loadUnpacked available at all.
        "--enable-unsafe-extension-debugging",
        f"--remote-debugging-port={port}",
        "--remote-allow-origins=*",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        # Deterministic geometry: the labels were measured at this size, and a window
        # that opens at some other size makes every box wrong by a constant nobody
        # notices until the IoU number is inexplicable.
        "--window-size=1280,900",
        "--window-position=0,0",
        "--force-device-scale-factor=1",
        "--hide-scrollbars",
        "about:blank",
    ]
    if headless:
        # The new headless mode, which does run extensions. The old one did not.
        args.insert(1, "--headless=new")

    process = subprocess.Popen(
        args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    _wait_for_devtools(port, process)
    return Launched(process=process, port=port, profile=profile, executable=exe)


def _wait_for_devtools(port: int, process: subprocess.Popen, timeout: float = 30.0) -> None:
    deadline = time.time() + timeout
    url = f"http://127.0.0.1:{port}/json/version"
    while time.time() < deadline:
        if process.poll() is not None:
            raise SystemExit(f"Chrome exited before DevTools came up (code {process.returncode})")
        try:
            with urllib.request.urlopen(url, timeout=1) as reply:
                json.loads(reply.read())
                return
        except (urllib.error.URLError, OSError, json.JSONDecodeError):
            time.sleep(0.2)
    raise SystemExit(f"DevTools did not come up on port {port} within {timeout:.0f}s")


def load_unpacked(browser, dist: Path) -> str:
    """Install the built extension and return its id.

    `Extensions.loadUnpacked` is a browser-level command, so it needs a browser CDP
    session rather than a page one.
    """
    session = browser.new_browser_cdp_session()
    try:
        result = session.send("Extensions.loadUnpacked", {"path": str(dist.resolve())})
    except Exception as err:  # pragma: no cover -- the message is the whole point
        raise SystemExit(
            "Extensions.loadUnpacked failed. Chrome must be started with "
            f"--enable-unsafe-extension-debugging for this domain to exist.\n  {err}"
        ) from err
    finally:
        session.detach()

    extension_id = result.get("id")
    if not extension_id:
        raise SystemExit(f"Extensions.loadUnpacked returned no id: {result}")
    return extension_id


def wake_worker(context, extension_id: str, timeout: float = 20.0):
    """Return the extension's service worker, starting it if MV3 has stopped it.

    A stopped worker is the normal state, not a fault: MV3 terminates it after about
    thirty seconds of idleness and restarts it when a message arrives. Everything here
    needs one that is running *now*, so this pokes it and waits.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        for worker in context.service_workers:
            if extension_id in worker.url:
                return worker
        # Fetching a page from the extension's own origin is enough to start it.
        try:
            page = context.new_page()
            page.goto(f"chrome-extension://{extension_id}/popup.html", wait_until="load")
            page.close()
        except Exception:
            pass
        time.sleep(0.3)
    raise SystemExit(
        f"the extension service worker for {extension_id} never started. "
        "Check that dist/chrome is a current build (npm run build)."
    )
