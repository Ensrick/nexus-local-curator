"""Print a Markdown brief of the batch the Ask Claude button sent.

Assistant-neutral intake: any model or tool that can run a command (or any
chat window the user pastes into) gets the same brief. It reads the relay
spool, enriches every mod from the Nexus API, and annotates page decision,
live curator state, MO2 install state and prior mentions in the build repo.

  py -3 scripts/relay-batch.py                 # brief to stdout
  py -3 scripts/relay-batch.py --out           # also write %TEMP%\nlc-relay\batch-brief.md
  py -3 scripts/relay-batch.py --out my.md --clip    # custom path, copy to clipboard
  py -3 scripts/relay-batch.py --ids 1090,718  # subset of the page
  py -3 scripts/relay-batch.py --no-api        # offline: spool + local state only
  py -3 scripts/relay-batch.py --json out.json # raw data alongside the brief

Exit 0 ok, 2 no page-latest.json (nothing ever received; ask for a click),
3 no Nexus API key (use --no-api or supply one). A relay that is down is a
warning, not an error: the spool is still readable, but the click that
follows will fail until relay-ensure.ps1 has run.

API key resolution (NEXUS_API.md): --api-key, then NEXUS_API_KEY, then
nexus.local.json beside this script, then the crusader-de-tweaker copy. The
key is never printed.
"""
import argparse, datetime, glob, html, importlib.util, json, os, pathlib, re, subprocess, sys
import urllib.error, urllib.request

HERE = pathlib.Path(__file__).resolve().parent
SPOOL = pathlib.Path(os.environ.get('TEMP', '.')) / 'nlc-relay'
PAGE = SPOOL / 'page-latest.json'
PENDING = SPOOL / 'decisions-pending.json'
BRIEF_DEFAULT = SPOOL / 'batch-brief.md'
BUILD = pathlib.Path(r'C:\Users\danjo\source\repos\skyrim-mod-assistant')
MO2_MODLIST = pathlib.Path(r'C:\Users\danjo\source\repos\mo2-instances\skyrim-se\profiles\Default\modlist.txt')
GAME = 'skyrimspecialedition'
API = 'https://api.nexusmods.com/v1'
UA = 'NexusLocalCurator-relay-batch/1.0'
KEY_FILES = [HERE / 'nexus.local.json',
             pathlib.Path(r'C:\Users\danjo\source\repos\crusader-de-tweaker\scripts\nexus\nexus.local.json')]
STALE_MIN = 60      # click did not reach the relay if the batch is older than this
DISARM_MIN = 30     # extension poll disarms after this much idle time
RATE = {}


def resolve_key(arg):
    if arg:
        return arg
    if os.environ.get('NEXUS_API_KEY'):
        return os.environ['NEXUS_API_KEY']
    for p in KEY_FILES:
        try:
            k = json.loads(p.read_text(encoding='utf-8-sig')).get('ApiKey')
            if k:
                return k
        except Exception:
            continue
    return None


def api_get(path, key):
    req = urllib.request.Request(f'{API}{path}', headers={
        'apikey': key, 'User-Agent': UA, 'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            for h in ('x-rl-hourly-remaining', 'x-rl-daily-remaining'):
                if r.headers.get(h) is not None:
                    RATE[h] = r.headers.get(h)
            return json.load(r), None
    except urllib.error.HTTPError as e:
        return None, f'HTTP {e.code}'
    except Exception as e:
        return None, str(e)


def relay_health():
    try:
        with urllib.request.urlopen('http://127.0.0.1:38492/health', timeout=3) as r:
            return json.load(r)
    except Exception:
        return None


def parse_iso(s):
    if not s:
        return None
    try:
        s = s.replace('Z', '+00:00')
        d = datetime.datetime.fromisoformat(s)
        if d.tzinfo is None:
            d = d.replace(tzinfo=datetime.timezone.utc)
        return d
    except Exception:
        return None


def fmt_age(minutes):
    m = int(minutes)
    if m < 60:
        return f'{m} min'
    if m < 60 * 48:
        return f'{m // 60} h {m % 60} min'
    return f'{m // 1440} d {(m % 1440) // 60} h'


def clean_bbcode(text, limit):
    if not text:
        return ''
    t = re.sub(r'\[img\][^\[]*\[/img\]', ' ', text, flags=re.I)
    t = re.sub(r'\[youtube\][^\[]*\[/youtube\]', ' ', t, flags=re.I)
    t = re.sub(r'\[/?[a-zA-Z*][^\]]*\]', '', t)
    t = html.unescape(t).replace('\ufeff', '')
    t = re.sub(r'<[^>]+>', '', t)
    t = re.sub(r'[ \t]+', ' ', t)
    t = re.sub(r'\s*\n\s*', '\n', t).strip()
    t = re.sub(r'\n{2,}', '\n', t)
    if limit and len(t) > limit:
        t = t[:limit].rstrip() + ' ...'
    return t


def ts(t):
    try:
        return datetime.datetime.fromtimestamp(int(t), datetime.timezone.utc).strftime('%Y-%m-%d')
    except Exception:
        return '?'


def prior_decisions(ids):
    """{id: [(status, where)]} from decisions-pending.json and decisions-applied-*.json."""
    out = {}
    files = []
    if PENDING.exists():
        files.append((PENDING, 'QUEUED, not yet picked up by the extension'))
    for f in sorted(glob.glob(str(SPOOL / 'decisions-applied-*.json'))):
        m = re.search(r'decisions-applied-(\d{8})-(\d{6})', f)
        stamp = f'{m.group(1)[:4]}-{m.group(1)[4:6]}-{m.group(1)[6:]} {m.group(2)[:2]}:{m.group(2)[2:4]}' if m else '?'
        files.append((pathlib.Path(f), f'applied {stamp} ({pathlib.Path(f).name})'))
    for path, where in files:
        try:
            batch = json.loads(path.read_text(encoding='utf-8-sig'))
        except Exception:
            continue
        for e in batch if isinstance(batch, list) else []:
            try:
                mid = int((e.get('mod') or {}).get('modId'))
            except Exception:
                continue
            if mid in ids:
                out.setdefault(mid, []).append((e.get('status'), where))
    return out


def live_curator():
    try:
        sys.path.insert(0, str(HERE))
        import curator_state
        return curator_state.status_map(GAME), None
    except Exception as e:
        return {}, str(e)


def installed_state():
    """{id: [(mo2_dir, 'enabled'|'disabled')]} via keep_coverage's resolution."""
    try:
        spec = importlib.util.spec_from_file_location('keep_coverage', BUILD / 'audit' / 'keep_coverage.py')
        kc = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(kc)
        by_dir = kc.installed_ids()
        enabled = kc.enabled_names()
    except Exception as e:
        return {}, str(e)
    out = {}
    for name, ids in by_dir.items():
        for i in ids:
            out.setdefault(i, []).append((name, 'enabled' if name in enabled else 'disabled'))
    return out, None


def prior_mentions(ids, per_id=6):
    """{id: [(relpath, lineno, snippet)]} for `mods/<id>` across the build repo docs."""
    out = {i: [] for i in ids}
    pat = re.compile(r'mods/(\d+)(?!\d)')
    roots = [BUILD / 'BASELINE.md', BUILD / 'CHANGELOG.md', BUILD / 'NEXUS_API.md']
    roots += sorted(BUILD.glob('INVENTORY*.md'))
    roots += sorted((BUILD / 'docs').rglob('*.md')) if (BUILD / 'docs').exists() else []
    roots += sorted((BUILD / 'records').rglob('*.md')) if (BUILD / 'records').exists() else []
    for f in roots:
        if not f.is_file():
            continue
        try:
            lines = f.read_text(encoding='utf-8-sig', errors='replace').splitlines()
        except Exception:
            continue
        rel = str(f.relative_to(BUILD)).replace('\\', '/')
        for n, line in enumerate(lines, 1):
            hit = {int(x) for x in pat.findall(line)} & ids
            for i in hit:
                if len(out[i]) < per_id:
                    out[i].append((rel, n, line.strip()[:140]))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--ids', help='comma-separated subset of mod ids from the page')
    ap.add_argument('--no-api', action='store_true', help='skip Nexus API calls')
    ap.add_argument('--api-key')
    ap.add_argument('--max-desc', type=int, default=1500, help='description chars per mod (0 = no limit)')
    ap.add_argument('--json', help='write raw data (page + API + local state) to this path')
    ap.add_argument('--out', nargs='?', const=str(BRIEF_DEFAULT), help='write the brief to a file (default %(const)s)')
    ap.add_argument('--clip', action='store_true', help='copy the brief to the clipboard')
    a = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

    if not PAGE.exists():
        print(f'no batch: {PAGE} does not exist. Nothing was ever received; click Ask Claude on a Nexus listing.')
        return 2
    page = json.loads(PAGE.read_text(encoding='utf-8-sig'))
    mods = page.get('mods') or []
    ids = []
    for m in mods:
        try:
            ids.append(int(m.get('modId')))
        except Exception:
            pass
    if a.ids:
        want = {int(x) for x in a.ids.split(',') if x.strip()}
        mods = [m for m in mods if int(m.get('modId') or 0) in want]
        ids = [i for i in ids if i in want]
    idset = set(ids)

    key = None
    if not a.no_api:
        key = resolve_key(a.api_key)
        if not key:
            print('no Nexus API key found (see NEXUS_API.md); rerun with --no-api or --api-key')
            return 3

    L = []
    w = L.append
    now = datetime.datetime.now(datetime.timezone.utc)
    reported = parse_iso(page.get('reportedAt'))
    age_min = (now - reported).total_seconds() / 60 if reported else None

    w('# Ask Claude batch')
    w('')
    h = relay_health()
    if h:
        w(f"- relay: ok (pid {h.get('pid')}, up {fmt_age(h.get('uptime_s', 0) / 60)}, "
          f"{'decisions PENDING pickup' if h.get('pending') else 'no pending decisions'})")
    else:
        w('- relay: NOT REACHABLE on 127.0.0.1:38492. Run scripts\\relay-ensure.ps1 before the next click. '
          'This brief is built from the spool and is still valid.')
    w(f"- page: {page.get('url', '?')}")
    if reported:
        w(f"- reportedAt: {page.get('reportedAt')} (UTC), received {page.get('receivedAt')} local, age {fmt_age(age_min)}")
        if age_min > STALE_MIN:
            w(f'- **WARNING: STALE batch** ({fmt_age(age_min)} old). A click newer than this never reached the relay. '
              'Confirm with the user before reviewing; ask for another click if the relay was just restarted.')
        if age_min > DISARM_MIN:
            w('- extension poll: probably disarmed (idle > 30 min); queued decisions apply on the next Nexus page load')
        else:
            w('- extension poll: armed; queued decisions apply within ~3 s')
    else:
        w('- reportedAt: missing')
    w(f"- mods on page: {len(mods)} (ids {', '.join(str(i) for i in ids)})")
    w('')

    w('## Prior decisions in the spool')
    pd = prior_decisions(idset)
    if pd:
        for i in ids:
            for status, where in pd.get(i, []):
                w(f'- {i} {status}: {where}')
        w('- Already decided ids do not need a second review unless the user asks.')
    else:
        w('- none for these ids')
    w('')

    live, live_err = live_curator()
    inst, inst_err = installed_state()
    mentions = prior_mentions(idset)
    if live_err:
        w(f'- live curator state unavailable: {live_err}')
    if inst_err:
        w(f'- installed state unavailable: {inst_err}')
    if live_err or inst_err:
        w('')

    raw = {'page': page, 'mods': {}}
    w('## Mods')
    w('')
    for m in mods:
        mid = int(m.get('modId'))
        url = m.get('sourceUrl') or f'https://www.nexusmods.com/{GAME}/mods/{mid}'
        title = m.get('title') or ''
        meta, files, err = None, None, None
        if key:
            meta, err = api_get(f'/games/{GAME}/mods/{mid}.json', key)
            if meta:
                files, _ = api_get(f'/games/{GAME}/mods/{mid}/files.json', key)
        raw['mods'][mid] = {'meta': meta, 'files': files, 'error': err}
        name = (meta or {}).get('name') or title or str(mid)
        w(f'### [{name}]({url}) ({mid})')
        if meta:
            w(f"- version {meta.get('version')} | created {ts(meta.get('created_timestamp'))} | "
              f"updated {ts(meta.get('updated_timestamp'))} | endorsements {meta.get('endorsement_count')} | "
              f"author {meta.get('author')} (uploader {meta.get('uploaded_by')}) | category {meta.get('category_id')} | "
              f"adult {'yes' if meta.get('contains_adult_content') else 'no'} | status {meta.get('status')}"
              f"{'' if meta.get('available', True) else ' | NOT AVAILABLE'}")
        elif err:
            w(f'- Nexus API: {err}')
        else:
            w('- Nexus API: skipped (--no-api)')
        pa = (m.get('author') or {})
        page_dec = m.get('decision') or '(unreviewed)'
        live_dec = live.get(mid, '(no decision)') if not live_err else '?'
        w(f"- page decision: {page_dec} | live curator: {live_dec} | page author: {pa.get('username', '?')} ({pa.get('userId', '?')})")
        if inst.get(mid):
            w('- installed: yes, ' + '; '.join(f'"{d}" ({s})' for d, s in inst[mid]) + ' (installed implies Keep)')
        elif not inst_err:
            w('- installed: no')
        if meta and meta.get('summary'):
            w(f"- summary: {html.unescape(meta.get('summary')).strip()}")
        if files and isinstance(files.get('files'), list):
            fl = [f for f in files['files'] if f.get('category_name') in ('MAIN', 'OPTIONAL', 'UPDATE', 'MISCELLANEOUS')]
            fl.sort(key=lambda f: -(f.get('uploaded_timestamp') or 0))
            if fl:
                w('- newest files:')
                for f in fl[:6]:
                    w(f"  - [{f.get('category_name')}] {f.get('name')} v{f.get('version')} "
                      f"{ts(f.get('uploaded_timestamp'))} {f.get('size_kb')} KB")
        if meta and meta.get('description'):
            desc = clean_bbcode(meta['description'], a.max_desc)
            w('- description:')
            for line in desc.split('\n'):
                w(f'  > {line}')
        if mentions.get(mid):
            w('- prior mentions in the build repo:')
            for rel, n, snip in mentions[mid]:
                w(f'  - {rel}:{n}: {snip}')
        else:
            w('- prior mentions in the build repo: none')
        w('')

    w('## Footer')
    if RATE:
        w(f"- Nexus API remaining: hourly {RATE.get('x-rl-hourly-remaining', '?')}, daily {RATE.get('x-rl-daily-remaining', '?')}")
    w(f"- generated {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')} local by relay-batch.py; "
      f'instructions for the reviewer: scripts\\ASSISTANT_PROMPT.md')

    brief = '\n'.join(L) + '\n'
    print(brief, end='')
    if a.out:
        p = pathlib.Path(a.out)
        p.write_text(brief, encoding='utf-8')
        print(f'[brief written to {p}]')
    if a.json:
        raw['live_curator'] = {str(k): v for k, v in live.items() if k in idset}
        raw['installed'] = {str(k): v for k, v in inst.items() if k in idset}
        pathlib.Path(a.json).write_text(json.dumps(raw, indent=1, ensure_ascii=False), encoding='utf-8')
        print(f'[raw data written to {a.json}]')
    if a.clip:
        p = pathlib.Path(a.out) if a.out else BRIEF_DEFAULT
        if not a.out:
            p.write_text(brief, encoding='utf-8')
        subprocess.run(['powershell', '-NoProfile', '-Command',
                        f'Get-Content -Raw -Encoding UTF8 "{p}" | Set-Clipboard'], check=False)
        print('[brief copied to the clipboard]')
    return 0


if __name__ == '__main__':
    sys.exit(main())
