"""Static file server for local development.

Same as `python -m http.server`, except responses are sent with `no-store` so an
edited file is never served from the browser cache. Needed because the page loads
its model with fetch(), which browsers block on file:// URLs.

    python serve.py [port]
"""

import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = 8080


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        if not args or not str(args[0]).startswith("GET /assets"):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    print(f"serving {sys.path[0] or '.'} at http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler).serve_forever()
