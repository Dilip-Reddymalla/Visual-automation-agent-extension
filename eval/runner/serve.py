"""Serving the corpus over http, because file:// is not an option.

The extension's content script matches `http://localhost/*` and its host permissions say
the same. M4 narrowed that set deliberately -- `file:///*` was dropped -- so a corpus
page opened from disk gets no content script and the harness measures an empty page
while reporting no error at all.

Bound to `localhost` rather than `127.0.0.1` on purpose: Chrome match patterns treat the
two as different hosts, and `http://localhost/*` does not match `http://127.0.0.1/`.
Any port matches.
"""

from __future__ import annotations

import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class _QuietHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args) -> None:
        return

    def handle_one_request(self) -> None:
        """Closing the browser resets sockets. That is not an error worth printing.

        Chrome keeps keep-alive connections open and drops them all when it exits, so the
        end of every run used to print a screenful of ConnectionResetError tracebacks
        after the results -- which is exactly where a real failure would have been.
        """
        try:
            super().handle_one_request()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            self.close_connection = True

    def end_headers(self) -> None:
        # A cached page is a page whose layout might be a previous build's. The labels
        # were measured against this build.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


class CorpusServer:
    def __init__(self, root: Path, port: int = 0) -> None:
        handler = partial(_QuietHandler, directory=str(root.resolve()))
        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def url_for(self, name: str) -> str:
        return f"http://localhost:{self.port}/{name}"

    def __enter__(self) -> "CorpusServer":
        self.thread.start()
        return self

    def __exit__(self, *_exc) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
