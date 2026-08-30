"""Read the extension's live decision state straight out of its IndexedDB.

The extension is the source of truth for keep/skip, and it has no export the
assistant can call. Anything that writes decisions back therefore needs a way
to read the CURRENT state first, so a queued batch can be compared against what
the user believes is true rather than against a snapshot taken minutes ago.

Read-only: the profile database is copied to a temporary directory before it is
opened, so a running Firefox is never touched.

  py -3 scripts/curator_state.py                 # counts by status
  py -3 scripts/curator_state.py 41339 148853    # status of specific mods

The decoding is two layers deep because Firefox stores a large storage.local
value as an external file: Snappy *framing format* on the outside, a structured
clone on the inside.
"""
import json, os, shutil, sqlite3, struct, sys, tempfile, glob
from urllib.parse import unquote

PROFILES = os.path.join(os.environ['APPDATA'], 'Mozilla', 'Firefox', 'Profiles')
DB_NAME = '3647222921wleabcEoxlt-eengsairo.sqlite'   # storage-local-data
GAME = 'skyrimspecialedition'


# ---------------------------------------------------------------- snappy ----
def _snappy_raw(data):
    shift = length = pos = 0
    while True:
        b = data[pos]; pos += 1
        length |= (b & 0x7F) << shift
        if not (b & 0x80):
            break
        shift += 7
    out = bytearray()
    while pos < len(data) and len(out) < length:
        tag = data[pos]; pos += 1
        kind = tag & 3
        if kind == 0:
            n = (tag >> 2) + 1
            if n > 60:
                width = n - 60
                n = int.from_bytes(data[pos:pos + width], 'little') + 1
                pos += width
            out += data[pos:pos + n]; pos += n
            continue
        if kind == 1:
            n = ((tag >> 2) & 7) + 4
            off = ((tag >> 5) << 8) | data[pos]; pos += 1
        elif kind == 2:
            n = (tag >> 2) + 1
            off = int.from_bytes(data[pos:pos + 2], 'little'); pos += 2
        else:
            n = (tag >> 2) + 1
            off = int.from_bytes(data[pos:pos + 4], 'little'); pos += 4
        for _ in range(n):
            out.append(out[-off])
    return bytes(out)


def _snappy_framed(raw):
    """Snappy framing format: 4-byte chunk headers, each body prefixed by CRC."""
    pos, out = 0, bytearray()
    while pos < len(raw):
        kind = raw[pos]
        size = int.from_bytes(raw[pos + 1:pos + 4], 'little')
        pos += 4
        body = raw[pos:pos + size]; pos += size
        if kind == 0x00:
            out += _snappy_raw(body[4:])
        elif kind == 0x01:
            out += body[4:]
    return bytes(out)


# ------------------------------------------------------- structured clone ----
T_NULL, T_UNDEF, T_BOOL, T_INT32 = 0xFFFF0000, 0xFFFF0001, 0xFFFF0002, 0xFFFF0003
T_STRING, T_ARRAY, T_OBJECT = 0xFFFF0004, 0xFFFF0007, 0xFFFF0008
T_BACKREF, T_EOK = 0xFFFF000D, 0xFFFF0013


class _Clone:
    def __init__(self, buf):
        self.b, self.p, self.objs = buf, 0, []

    def pair(self):
        d, t = struct.unpack_from('<II', self.b, self.p); self.p += 8
        return d, t

    def string(self, d):
        latin, n = bool(d & 0x80000000), d & 0x7FFFFFFF
        nbytes = n if latin else n * 2
        raw = self.b[self.p:self.p + nbytes]
        self.p += (nbytes + 7) & ~7
        return raw.decode('latin1') if latin else raw.decode('utf-16-le')

    def value(self, d, t):
        if t in (T_NULL, T_UNDEF):
            return None
        if t == T_BOOL:
            return bool(d)
        if t == T_INT32:
            return struct.unpack('<i', struct.pack('<I', d))[0]
        if t == T_STRING:
            return self.string(d)
        if t == T_BACKREF:
            return self.objs[d] if d < len(self.objs) else None
        if t == T_ARRAY:
            arr = []; self.objs.append(arr)
            while True:
                kd, kt = self.pair()
                if kt == T_EOK:
                    return arr
                idx = self.value(kd, kt)
                vd, vt = self.pair()
                v = self.value(vd, vt)
                if isinstance(idx, int):
                    while len(arr) <= idx:
                        arr.append(None)
                    arr[idx] = v
                else:
                    arr.append(v)
        if t == T_OBJECT:
            obj = {}; self.objs.append(obj)
            while True:
                kd, kt = self.pair()
                if kt == T_EOK:
                    return obj
                k = self.value(kd, kt)
                vd, vt = self.pair()
                obj[k] = self.value(vd, vt)
        if t < 0xFFF00000:
            return struct.unpack('<d', struct.pack('<II', d, t))[0]
        raise ValueError('unknown structured-clone tag 0x%08X' % t)


def _parse_clone(buf):
    c = _Clone(buf)
    while c.p < len(c.b):
        d, t = struct.unpack_from('<II', c.b, c.p)
        if t < 0xFFF00000 or t in (T_NULL, T_UNDEF, T_BOOL, T_INT32,
                                   T_STRING, T_ARRAY, T_OBJECT):
            c.pair()
            return c.value(d, t)
        c.pair()          # clone header / transfer map
    return None


# ------------------------------------------------------------------ read ----
def _decode_key(k):
    return bytes(b - 1 for b in k[1:]).decode('latin1', 'replace')


def _curator_idb():
    """The extension's idb directory, found by the keys it stores."""
    for db in glob.glob(os.path.join(PROFILES, '*', 'storage', 'default',
                                     'moz-extension*', 'idb', DB_NAME)):
        try:
            con = sqlite3.connect('file:' + db.replace(os.sep, '/') +
                                  '?immutable=1', uri=True)
            keys = {_decode_key(bytes(r[0]))
                    for r in con.execute('select key from object_data')}
            con.close()
        except Exception:
            continue
        if 'modDecisions' in keys:
            return os.path.dirname(db)
    raise SystemExit('curator IndexedDB not found under ' + PROFILES)


def decisions():
    """Every effective decision, including uncompacted journal deltas."""
    src = _curator_idb()
    tmp = tempfile.mkdtemp(prefix='nlc-state-')
    try:
        shutil.copytree(src, os.path.join(tmp, 'idb'))
        db = os.path.join(tmp, 'idb', DB_NAME)
        con = sqlite3.connect(db)
        rows = list(con.execute('select key, file_ids, data from object_data'))
        con.close()

        def decode_value(fids, data):
            if fids:
                # Large values live beside the database, one file per id.
                fid = str(fids).lstrip('.').split()[0]
                blob = open(os.path.join(
                    tmp, 'idb', DB_NAME.replace('.sqlite', '.files'), fid), 'rb').read()
                return _parse_clone(_snappy_framed(blob))
            return _parse_clone(_snappy_raw(bytes(data)))

        effective = {}
        journals = []
        for raw_key, fids, data in rows:
            key = _decode_key(bytes(raw_key))
            if key == 'modDecisions':
                for item in decode_value(fids, data) or []:
                    if item and item.get('game') and item.get('modId'):
                        effective[f"{item['game']}:{item['modId']}"] = item
            elif key.startswith('nlcModDecision:'):
                journals.append((unquote(key[len('nlcModDecision:'):]),
                                 decode_value(fids, data) or {}))

        # Per-mod journal values are deliberately authoritative over the large
        # compacted snapshot. They are what keeps extension clicks responsive;
        # ignoring them made compare-before-write checks read stale state.
        for key, value in journals:
            if value.get('status') == 'unreviewed':
                effective.pop(key, None)
                continue
            item = value.get('mod') or {}
            if item.get('game') and item.get('modId'):
                effective[f"{item['game']}:{item['modId']}"] = item
        return list(effective.values())
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def status_map(game=GAME):
    return {int(r['modId']): r.get('status')
            for r in decisions() if r.get('game') == game and r.get('modId')}


if __name__ == '__main__':
    live = status_map()
    if len(sys.argv) > 1:
        for a in sys.argv[1:]:
            print(f'  {a:>7}  {live.get(int(a), "(no decision)")}')
    else:
        counts = {}
        for s in live.values():
            counts[s] = counts.get(s, 0) + 1
        print(json.dumps(counts, indent=1), f'\n{len(live)} {GAME} decisions')
