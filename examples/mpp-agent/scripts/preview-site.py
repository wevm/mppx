#!/usr/bin/env python3
"""Serve dist-site/ on http://127.0.0.1:8791 with a strict static-hosting CSP (for checking the static gallery)."""
import functools, http.server, pathlib
CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self'; connect-src 'self'"
ROOT = pathlib.Path(__file__).resolve().parent.parent / "dist-site"
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Content-Security-Policy", CSP); self.send_header("Cache-Control", "no-store"); super().end_headers()
print(f"serving {ROOT} on http://127.0.0.1:8791")
http.server.ThreadingHTTPServer(("127.0.0.1", 8791), functools.partial(H, directory=str(ROOT))).serve_forever()
