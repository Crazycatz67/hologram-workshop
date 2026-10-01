"""Static file server for local development.

Same as `python -m http.server`, except responses are sent with `no-store` so an
edited file is never served from the browser cache. Needed because the page loads
its model with fetch(), which browsers block on file:// URLs.

    python serve.py [port]

It also hosts the test recorder's two local-only endpoints (see testrec.js and
docs/testing/README.md):

    GET  /__commit   -> {"commit": "<short sha>" | null, "dirty": bool | null}
    POST /__testrun  -> saves one run record to docs/testing/runs/<page>/, recomputes its
                        flags against the previous run, prepends them to
                        docs/testing/runs/FLAGS.md, answers {ok, path, flags}

Both refuse anything that is not from this machine (403): the server only binds
127.0.0.1, but a web page the owner visits could still POST to localhost from their
browser, so the Host and Origin headers are checked too (DNS rebinding / cross-site).
"""

import json
import os
import re
import subprocess
import sys
import threading
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PORT = 8080

ROOT = os.path.dirname(os.path.abspath(__file__))
RUNS_DIR = os.path.join(ROOT, "docs", "testing", "runs")
FLAGS_FILE = os.path.join(RUNS_DIR, "FLAGS.md")
FLAGS_HEADER = (
    "# Test run flags (newest first)\n\n"
    "Written by serve.py on every recorded run; machine-local and git-ignored. "
    "See docs/testing/README.md.\n\n"
)
MAX_BODY = 5 * 1024 * 1024
PAGE_RE = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}$")
LOCAL_IPS = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}
LOCAL_HOSTNAMES = {"localhost", "127.0.0.1", "::1"}
MAX_LISTED = 8  # names listed in one "disappeared" / "tolerance" flag before "+N more"

# One lock for the whole read-previous / compare / write sequence, so two runs of the same
# page finishing together can't both compare against the same "previous" run.
_runs_lock = threading.Lock()


def git_commit():
    try:
        sha = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT,
                             capture_output=True, text=True, timeout=5)
        if sha.returncode != 0:
            return {"commit": None, "dirty": None}
        st = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT,
                            capture_output=True, text=True, timeout=10)
        return {"commit": sha.stdout.strip(), "dirty": bool(st.stdout.strip()) if st.returncode == 0 else None}
    except (OSError, subprocess.SubprocessError):
        return {"commit": None, "dirty": None}


def _host_name(host):
    host = (host or "").strip().lower()
    if host.startswith("["):
        return host[1:host.find("]")] if "]" in host else ""
    return host.split(":")[0]


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _listed(names):
    names = list(names)
    head = ", ".join(names[:MAX_LISTED])
    return head + (f" (+{len(names) - MAX_LISTED} more)" if len(names) > MAX_LISTED else "")


def _allowed(tol, prev):
    """A tolerance is rel (number) or {abs?, rel?}; allowed change = max(abs, rel*|prev|)."""
    if _is_number(tol):
        return abs(tol) * abs(prev)
    if isinstance(tol, dict):
        a = tol.get("abs", 0) if _is_number(tol.get("abs", 0)) else 0
        r = tol.get("rel", 0) if _is_number(tol.get("rel", 0)) else 0
        return max(abs(a), abs(r) * abs(prev))
    return None


def compute_flags(rec, prev):
    """Server-side flags. Only flags the page itself raised (source 'page') are kept from
    the client; everything automatic is recomputed here because only the server knows the
    previous run."""
    flags = [f for f in rec.get("flags") or [] if isinstance(f, dict) and f.get("source") == "page"]
    add = lambda kind, msg: flags.append({"kind": kind, "message": msg, "source": "server"})
    results = [r for r in rec.get("results") or [] if isinstance(r, dict)]

    for r in results:
        if r.get("pass") is False:
            v = r.get("value")
            text = v if isinstance(v, str) else json.dumps(v)
            add("fail", f"{r.get('name')}: {text[:160]}")

    if isinstance(prev, dict):
        prev_results = [r for r in prev.get("results") or [] if isinstance(r, dict)]
        # Only pass/fail checks count: info rows come and go with the data a lab happens to see.
        cur_names = {str(r.get("name")) for r in results if isinstance(r.get("pass"), bool)}
        prev_names = [str(r.get("name")) for r in prev_results if isinstance(r.get("pass"), bool)]
        gone = [n for n in dict.fromkeys(prev_names) if n not in cur_names]
        if gone:
            add("disappeared", f"{len(gone)} check(s) gone vs previous run: {_listed(gone)}")
        cur_n = sum(1 for r in results if isinstance(r.get("pass"), bool))
        prev_n = len(prev_names)
        if cur_n < prev_n:
            add("count-dropped", f"checks {prev_n} -> {cur_n}")

        tol = rec.get("tolerances") if isinstance(rec.get("tolerances"), dict) else {}
        if tol:
            cur_nums = {k: v for k, v in (rec.get("metrics") or {}).items() if _is_number(v)}
            prev_nums = {k: v for k, v in (prev.get("metrics") or {}).items() if _is_number(v)}
            for r in results:
                if _is_number(r.get("value")):
                    cur_nums.setdefault(str(r.get("name")), r["value"])
            for r in prev_results:
                if _is_number(r.get("value")):
                    prev_nums.setdefault(str(r.get("name")), r["value"])
            moved = []
            for name, v in cur_nums.items():
                if name not in prev_nums:
                    continue
                t = tol.get(name, tol.get("*"))
                allowed = _allowed(t, prev_nums[name]) if t is not None else None
                if allowed is not None and abs(v - prev_nums[name]) > allowed:
                    moved.append(f"{name} {prev_nums[name]:g} -> {v:g}")
            if moved:
                add("tolerance", f"{len(moved)} number(s) beyond tolerance: {_listed(moved)}")

    errs = [e for e in rec.get("consoleErrors") or [] if isinstance(e, dict)]
    if errs:
        first = str(errs[0].get("msg", "")).split("\n")[0][:200]
        add("console-error", f"{len(errs)} console error(s); first: {first}")
    if rec.get("status") != "done":
        add("ended-early", f"run ended with status '{rec.get('status')}'")
    fps, floor = rec.get("fps"), rec.get("fpsFloor")
    if _is_number(fps) and _is_number(floor) and fps < floor:
        add("low-fps", f"fps {fps:g} < floor {floor:g}")
    vis = rec.get("visibility") or []
    if rec.get("timingSensitive") and any(isinstance(v, dict) and v.get("state") == "hidden" for v in vis):
        add("hidden-tab", "tab hidden during a timing-sensitive run")
    return flags


def _write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=1)
    os.replace(tmp, path)  # atomic: a reader never sees half a latest.json


def save_run(rec):
    """Returns (relative path, flags). Caller has validated rec['page']."""
    os.makedirs(RUNS_DIR, exist_ok=True)
    runs_real = os.path.realpath(RUNS_DIR)
    page_dir = os.path.realpath(os.path.join(RUNS_DIR, rec["page"]))
    if not page_dir.startswith(runs_real + os.sep):
        raise ValueError("page escapes the runs folder")
    with _runs_lock:
        os.makedirs(page_dir, exist_ok=True)
        latest = os.path.join(page_dir, "latest.json")
        prev = None
        if os.path.exists(latest):
            try:
                with open(latest, encoding="utf-8") as f:
                    prev = json.load(f)
            except (OSError, ValueError):
                prev = None
        if rec.get("commit") is None:
            rec.update(git_commit())
        now = datetime.now()
        rec["receivedAt"] = now.isoformat(timespec="seconds")
        rec["flags"] = compute_flags(rec, prev)
        stamp = now.strftime("%Y-%m-%d_%H-%M-%S")
        name, n = f"{stamp}.json", 1
        while os.path.exists(os.path.join(page_dir, name)):
            n += 1
            name = f"{stamp}-{n}.json"
        _write_json(os.path.join(page_dir, name), rec)
        _write_json(latest, rec)
        prepend_flags(now, rec)
    return os.path.relpath(os.path.join(page_dir, name), ROOT), rec["flags"]


def prepend_flags(now, rec):
    if not rec["flags"]:
        return
    commit = rec.get("commit") or "?"
    if rec.get("dirty"):
        commit += "+dirty"
    when = now.strftime("%Y-%m-%d %H:%M:%S")
    clean = lambda s: " ".join(str(s).split())[:300]
    lines = "".join(f"- {when} · {rec['page']} · {commit} · {clean(f.get('kind'))} · {clean(f.get('message'))}\n"
                    for f in rec["flags"])
    body = ""
    if os.path.exists(FLAGS_FILE):
        with open(FLAGS_FILE, encoding="utf-8") as f:
            body = f.read()
        body = body[len(FLAGS_HEADER):] if body.startswith(FLAGS_HEADER) else body
    with open(FLAGS_FILE, "w", encoding="utf-8") as f:
        f.write(FLAGS_HEADER + lines + body)


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        if not args or not str(args[0]).startswith("GET /assets"):
            super().log_message(fmt, *args)

    def _send_json(self, code, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _local_only(self):
        """True when the request is from this machine and from a localhost page."""
        if self.client_address[0] not in LOCAL_IPS:
            return False
        if _host_name(self.headers.get("Host")) not in LOCAL_HOSTNAMES:
            return False
        origin = self.headers.get("Origin")
        if origin is not None:
            o = urlsplit(origin)
            if o.scheme != "http" or (o.hostname or "") not in LOCAL_HOSTNAMES:
                return False
        return True

    def do_GET(self):
        if urlsplit(self.path).path != "/__commit":
            return super().do_GET()
        if not self._local_only():
            return self._send_json(403, {"ok": False, "error": "local only"})
        self._send_json(200, git_commit())

    def do_POST(self):
        if urlsplit(self.path).path != "/__testrun":
            return self._send_json(405, {"ok": False, "error": "POST only to /__testrun"})
        if not self._local_only():
            return self._send_json(403, {"ok": False, "error": "local only"})
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self._send_json(411, {"ok": False, "error": "Content-Length required"})
        if length < 0 or length > MAX_BODY:
            # Close rather than drain: a huge body is not worth reading just to discard it.
            self.close_connection = True
            return self._send_json(413, {"ok": False, "error": f"body over {MAX_BODY} bytes"})
        try:
            rec = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self._send_json(400, {"ok": False, "error": "body is not JSON"})
        if not isinstance(rec, dict):
            return self._send_json(400, {"ok": False, "error": "record must be a JSON object"})
        if not isinstance(rec.get("page"), str) or not PAGE_RE.match(rec["page"]):
            return self._send_json(400, {"ok": False, "error": "bad page id"})
        try:
            path, flags = save_run(rec)
        except ValueError as e:
            return self._send_json(400, {"ok": False, "error": str(e)})
        except OSError as e:
            return self._send_json(500, {"ok": False, "error": f"could not save: {e}"})
        self._send_json(200, {"ok": True, "path": path, "flags": flags})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    print(f"serving {sys.path[0] or '.'} at http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler).serve_forever()
