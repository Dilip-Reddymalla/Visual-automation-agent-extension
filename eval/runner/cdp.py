"""A very small raw CDP client, for the two things Playwright will not hand over.

Playwright's CDP session attaches to pages. The service worker's heap and the browser's
own process table are neither, and both are needed:

  Runtime.getHeapUsage on the worker target    the service worker has no
                                               `performance.memory`, so its heap is only
                                               readable over the protocol.

  SystemInfo.getProcessInfo on the browser     which pid is the GPU process, and how much
                                               CPU each process has used. Chrome tags its
                                               children with `--type=`, but the mapping
                                               from a Chrome process type to a pid is far
                                               more reliable read from the browser itself
                                               than guessed from a command line.

Deliberately tiny: one request, one reply, no event plumbing. Anything that needs events
should be using Playwright.
"""

from __future__ import annotations

import json
import urllib.request
from typing import Any

from websocket import create_connection


def targets(port: int) -> list[dict]:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=5) as reply:
        return json.loads(reply.read())


def browser_ws(port: int) -> str:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=5) as reply:
        return json.loads(reply.read())["webSocketDebuggerUrl"]


class Cdp:
    """One websocket, opened and closed around a handful of commands."""

    def __init__(self, ws_url: str, timeout: float = 10.0) -> None:
        self.ws = create_connection(
            ws_url, timeout=timeout, suppress_origin=True, max_size=64 * 1024 * 1024
        )
        self.next_id = 0

    def send(self, method: str, params: dict | None = None) -> dict[str, Any]:
        self.next_id += 1
        request_id = self.next_id
        self.ws.send(json.dumps({"id": request_id, "method": method, "params": params or {}}))
        while True:
            message = json.loads(self.ws.recv())
            # Events arrive on the same socket and are not what anyone here asked for.
            if message.get("id") != request_id:
                continue
            if "error" in message:
                raise RuntimeError(f"{method}: {message['error'].get('message', message['error'])}")
            return message.get("result", {})

    def close(self) -> None:
        try:
            self.ws.close()
        except Exception:
            pass

    def __enter__(self) -> "Cdp":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()


def worker_heap_bytes(port: int, extension_id: str) -> int:
    """Used JS heap of the extension's service worker, or 0 if it is not running.

    A stopped worker is normal -- MV3 terminates it while idle -- and reporting 0 for a
    context that does not exist is more honest than starting one to measure it.
    """
    for target in targets(port):
        if target.get("type") != "service_worker" or extension_id not in target.get("url", ""):
            continue
        try:
            with Cdp(target["webSocketDebuggerUrl"]) as cdp:
                usage = cdp.send("Runtime.getHeapUsage")
                return int(usage.get("usedSize", 0))
        except Exception:
            return 0
    return 0


def process_info(port: int) -> list[dict]:
    """Chrome's own process table: type, id and accumulated CPU time."""
    try:
        with Cdp(browser_ws(port)) as cdp:
            return cdp.send("SystemInfo.getProcessInfo").get("processInfo", [])
    except Exception:
        return []


def gpu_info(port: int) -> dict:
    """What the GPU actually is, for the report's header. Not a memory figure."""
    try:
        with Cdp(browser_ws(port)) as cdp:
            info = cdp.send("SystemInfo.getInfo")
    except Exception:
        return {}
    devices = info.get("gpu", {}).get("devices", [])
    primary = devices[0] if devices else {}
    return {
        "vendor": primary.get("vendorString", ""),
        "device": primary.get("deviceString", ""),
        "driver": primary.get("driverVersion", ""),
        "model": info.get("modelName", ""),
    }
