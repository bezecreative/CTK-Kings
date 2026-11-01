#!/usr/bin/env python3
"""Run the check-in app on this computer (no install needed).

    python3 run_local.py            -> http://localhost:8000
    python3 run_local.py --port 9000

Data is kept in data/checkin.db (SQLite). On Vercel the same code uses Postgres.
"""
import argparse
import mimetypes
import os
import sys
from socketserver import ThreadingMixIn
from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)
from lib.app import app as api_app  # noqa: E402

PUBLIC = os.path.join(ROOT, "public")
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/manifest+json", ".webmanifest")


class ThreadingWSGIServer(ThreadingMixIn, WSGIServer):
    daemon_threads = True


class Handler(WSGIRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.command, self.path))


def static(environ, start_response):
    path = environ.get("PATH_INFO", "/")
    if path in ("", "/"):
        path = "/index.html"
    target = os.path.normpath(os.path.join(PUBLIC, path.lstrip("/")))
    if not target.startswith(PUBLIC):
        return not_found(start_response)
    if not os.path.isfile(target) and os.path.isfile(target + ".html"):
        target += ".html"  # same as Vercel's cleanUrls
    if not os.path.isfile(target):
        return not_found(start_response)
    ctype = mimetypes.guess_type(target)[0] or "application/octet-stream"
    if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
        ctype += "; charset=utf-8"
    with open(target, "rb") as f:
        data = f.read()
    start_response("200 OK", [("Content-Type", ctype), ("Content-Length", str(len(data))), ("Cache-Control", "no-store")])
    return [data]


def not_found(start_response):
    body = b"Not found"
    start_response("404 Not Found", [("Content-Type", "text/plain"), ("Content-Length", str(len(body)))])
    return [body]


def dispatch(environ, start_response):
    if environ.get("PATH_INFO", "").startswith("/api"):
        return api_app(environ, start_response)
    return static(environ, start_response)


def main():
    parser = argparse.ArgumentParser(description="Kids check-in local server")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()
    server = make_server(args.host, args.port, dispatch, server_class=ThreadingWSGIServer, handler_class=Handler)
    print("Kids Check-In running at http://localhost:%d  (admin: http://localhost:%d/admin)" % (args.port, args.port))
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
