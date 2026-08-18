"""Local curation relay bridging the extension and an assistant session.

Loopback-only HTTP server. The extension POSTs the visible listing page to
/page and polls /decisions for queued keep/trim/skip calls. The assistant
watches the spool directory and writes decisions-pending.json.

Run:  py -3 scripts/curation-relay.py [spool_dir]
"""
import json, os, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 38492
SPOOL = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.environ.get("TEMP", "."), "nlc-relay")
os.makedirs(SPOOL, exist_ok=True)
PAGE_LATEST = os.path.join(SPOOL, "page-latest.json")
PAGE_LOG = os.path.join(SPOOL, "pages.log.jsonl")
PENDING = os.path.join(SPOOL, "decisions-pending.json")
LAST_SIG = [""]


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
            print(f"[page] {len(page.get('mods') or [])} mods  {page.get('url','')[:100]}",
                  flush=True)
        # Pending decisions are served only via GET /decisions: piggybacking on
        # this response would be silently discarded by extensions before 0.14.3.
        return self._reply(204)

    def do_GET(self):
        if self.path == "/ping":
            return self._reply(200, b'{"ok": true}')
        if self.path != "/decisions":
            return self._reply(404)
        body = take_pending()
        if body is None:
            return self._reply(200, b"[]")
        print(f"[decisions] served {len(json.loads(body))}", flush=True)
        return self._reply(200, body)


if __name__ == "__main__":
    print(f"curation relay on 127.0.0.1:{PORT}  spool={SPOOL}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
