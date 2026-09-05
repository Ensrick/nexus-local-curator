"""Local curation relay bridging the extension and any assistant.

Loopback-only HTTP server on 127.0.0.1:38492. The Firefox extension POSTs the
visible listing page to /page and polls /decisions for queued keep/skip calls.
An assistant (any model, any tool) reads the spool directory and writes
decisions-pending.json; see RELAY.md and ASSISTANT_PROMPT.md beside this file.

Run:  py -3 scripts/curation-relay.py [spool_dir]
Normally started by the NexusCurationRelay Scheduled Task (relay-ensure.ps1),
not by hand. Safe to invoke while another instance is up: it probes the port
and exits 0 instead of double-binding.

Endpoints
  POST /page        extension -> spool/page-latest.json (+ pages.log.jsonl)
  GET  /decisions   serves decisions-pending.json and renames it to
                    decisions-applied-<stamp>.json. CONSUMES the queue: never
                    call it as a health probe.
  GET  /health      JSON status, side-effect free. Use this to probe.
  GET  /ping        legacy probe, {"ok": true}

Files in the spool: relay.log (rotated at 1 MB), relay.pid.
"""
import json, os, socket, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 38492
SPOOL = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.environ.get("TEMP", "."), "nlc-relay")
os.makedirs(SPOOL, exist_ok=True)
PAGE_LATEST = os.path.join(SPOOL, "page-latest.json")
PAGE_LOG = os.path.join(SPOOL, "pages.log.jsonl")
PENDING = os.path.join(SPOOL, "decisions-pending.json")
LOG = os.path.join(SPOOL, "relay.log")
PIDFILE = os.path.join(SPOOL, "relay.pid")
LAST_SIG = [""]
STARTED = time.time()
STATS = {"pages": 0, "decisions_served": 0, "last_page_at": None,
         "last_decisions_at": None, "errors": 0}


def log(msg):
    """Append to relay.log; also print when a console exists (pyw has none)."""
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n"
    try:
        if os.path.exists(LOG) and os.path.getsize(LOG) > 1_000_000:
            os.replace(LOG, LOG + ".1")
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass
    if sys.stdout:
        try:
            sys.stdout.write(line)
            sys.stdout.flush()
        except Exception:
            pass


def port_in_use():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1.0)
    try:
        s.connect(("127.0.0.1", PORT))
        return True
    except OSError:
        return False
    finally:
        s.close()


def take_pending():
    if not os.path.exists(PENDING):
        return None
    try:
        body = open(PENDING, "rb").read()
        json.loads(body)
    except Exception:
        return None
    os.replace(PENDING, os.path.join(
        SPOOL, time.strftime("decisions-applied-%Y%m%d-%H%M%S.json")))
    return body


def page_summary():
    try:
        page = json.load(open(PAGE_LATEST, encoding="utf-8"))
    except Exception:
        return None
    return {"url": page.get("url"), "reportedAt": page.get("reportedAt"),
            "receivedAt": page.get("receivedAt"),
            "mods": len(page.get("mods") or [])}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _reply(self, code, body=b"", content_type="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):
        self._reply(204)

    def do_POST(self):
        try:
            self._post()
        except Exception as e:
            STATS["errors"] += 1
            log(f"[error] POST {self.path}: {e!r}")
            try:
                self._reply(500)
            except Exception:
                pass

    def _post(self):
        if self.path != "/page":
            return self._reply(404)
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 4_000_000:
            return self._reply(400)
        raw = self.rfile.read(length)
        try:
            page = json.loads(raw)
        except Exception:
            return self._reply(400)
        page["receivedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        sig = str(page.get("url", "")) + "|" + ",".join(
            "%s:%s" % (m.get("modId"), m.get("decision")) for m in page.get("mods") or [])
        if sig != LAST_SIG[0]:
            LAST_SIG[0] = sig
            tmp = PAGE_LATEST + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(page, f, ensure_ascii=False)
            os.replace(tmp, PAGE_LATEST)
            with open(PAGE_LOG, "a", encoding="utf-8") as f:
                f.write(json.dumps(page, ensure_ascii=False) + "\n")
            STATS["pages"] += 1
            STATS["last_page_at"] = page["receivedAt"]
            log(f"[page] {len(page.get('mods') or [])} mods  {page.get('url','')[:100]}")
        # Pending decisions are served only via GET /decisions: piggybacking on
        # this response would be silently discarded by extensions before 0.14.3.
        return self._reply(204)

    def do_GET(self):
        try:
            self._get()
        except Exception as e:
            STATS["errors"] += 1
            log(f"[error] GET {self.path}: {e!r}")
            try:
                self._reply(500)
            except Exception:
                pass

    def _get(self):
        if self.path == "/ping":
            return self._reply(200, b'{"ok": true}')
        if self.path == "/health":
            body = {"ok": True, "pid": os.getpid(), "port": PORT, "spool": SPOOL,
                    "started": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(STARTED)),
                    "uptime_s": int(time.time() - STARTED),
                    "pending": os.path.exists(PENDING),
                    "page_latest": page_summary(), **STATS}
            return self._reply(200, json.dumps(body).encode("utf-8"))
        if self.path != "/decisions":
            return self._reply(404)
        body = take_pending()
        if body is None:
            return self._reply(200, b"[]")
        n = len(json.loads(body))
        STATS["decisions_served"] += n
        STATS["last_decisions_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        log(f"[decisions] served {n}")
        return self._reply(200, body)


class Server(ThreadingHTTPServer):
    # HTTPServer sets allow_reuse_address; on Windows that lets a second
    # process bind the same port and silently steal traffic. Fail instead.
    allow_reuse_address = False
    daemon_threads = True


def main():
    if port_in_use():
        log(f"relay already listening on 127.0.0.1:{PORT}; exiting (pid {os.getpid()})")
        return 0
    try:
        srv = Server(("127.0.0.1", PORT), Handler)
    except OSError as e:
        log(f"bind failed on 127.0.0.1:{PORT}: {e}")
        return 1
    try:
        with open(PIDFILE, "w", encoding="utf-8") as f:
            f.write(str(os.getpid()))
    except Exception:
        pass
    log(f"curation relay on 127.0.0.1:{PORT}  spool={SPOOL}  pid={os.getpid()}")
    try:
        srv.serve_forever()
    except Exception as e:
        log(f"server died: {e!r}")
        raise
    finally:
        try:
            if open(PIDFILE, encoding="utf-8").read().strip() == str(os.getpid()):
                os.remove(PIDFILE)
        except Exception:
            pass
        log("relay stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
