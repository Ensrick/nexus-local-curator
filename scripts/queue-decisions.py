"""Queue curation decisions for the extension to apply.

  py -3 scripts/queue-decisions.py skip 40337 48059
  py -3 scripts/queue-decisions.py unreviewed 44309      # clear a decision
  py -3 scripts/queue-decisions.py skip --keeps-pass 62271 5165

Writes decisions-pending.json into the relay spool; curation-relay.py serves it
on the extension's next poll and renames it to decisions-applied-<stamp>.json.
Note the poll loop disarms after 30 idle minutes and re-arms when a page is
reported, so a queued batch can sit until the next Nexus page load.

Guards, both learned the hard way: it refuses to clobber a batch that has not
been picked up yet, and it refuses to decide a mod that was not on the page the
user actually sent for review. Titles come from page-latest.json when present,
else the Nexus API, else the id.

`--keeps-pass` is for reviewing the existing Keep list rather than a browsed
page, where the page guard can never be satisfied. It substitutes a
compare-before-write check against the extension's live state: every id must
still be a `keep` right now, so a batch cannot silently overwrite a decision the
user changed while the review was running.

Library use (apply-verdicts.py): `queue([(status, id), ...])` applies the same
guards to a mixed batch in one write.
"""
import datetime, io, json, os, sys

VALID = {'keep', 'trim', 'maybe', 'skip', 'unreviewed'}
SPOOL = os.path.join(os.environ.get('TEMP', '.'), 'nlc-relay')
PENDING = os.path.join(SPOOL, 'decisions-pending.json')
PAGE = os.path.join(SPOOL, 'page-latest.json')
AUDIT = r'C:\Users\danjo\source\repos\skyrim-mod-assistant\audit'


def write_batch(pairs, titles):
    batch = [{'status': status,
              'mod': {'game': 'skyrimspecialedition', 'modId': str(i), 'title': titles[i],
                      'sourceUrl': f'https://www.nexusmods.com/skyrimspecialedition/mods/{i}'}}
             for status, i in pairs]
    tmp = PENDING + '.tmp'
    json.dump(batch, open(tmp, 'w', encoding='utf-8'), indent=1)
    os.replace(tmp, PENDING)
    for status, i in pairs:
        print(f'  {status} {i} {titles[i]}')
    print(f'queued {len(batch)} -> {PENDING}')
    return 0


def api_title(i):
    try:
        sys.path.insert(0, AUDIT)
        import modasset as M
        return M.v1(f'/mods/{i}.json').get('name') or str(i)
    except Exception:
        return str(i)


def pages_today():
    """{id: title} for every page reported today plus the latest page.

    A review session pages through a catalogue, so by the time decisions are
    ready the latest page is several clicks past the mods being decided.
    """
    on_page = {}
    log = os.path.join(SPOOL, 'pages.log.jsonl')
    today = datetime.date.today().isoformat()
    if os.path.exists(log):
        for line in io.open(log, encoding='utf-8'):
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if not (rec.get('receivedAt') or '').startswith(today):
                continue
            for m in rec.get('mods', []):
                on_page[int(m['modId'])] = m.get('title') or ''
    if os.path.exists(PAGE):
        for m in json.load(open(PAGE, encoding='utf-8')).get('mods', []):
            on_page.setdefault(int(m['modId']), m.get('title') or '')
    return on_page


def queue(pairs, keeps_pass=False):
    """Apply the guards and write one batch. pairs = [(status, id), ...]. Returns exit code."""
    pairs = [(s, int(i)) for s, i in pairs]
    bad = [s for s, _ in pairs if s not in VALID]
    if bad:
        print(f'invalid status: {sorted(set(bad))}')
        return 2
    if os.path.exists(PENDING):
        print('a pending batch has not been picked up yet - not clobbering it')
        return 1
    ids = [i for _, i in pairs]

    if keeps_pass:
        # Demote mods still on the Keep list, checked against live state: every
        # target must still read `keep` right now, else the whole batch is refused
        # rather than partially written (a partial write loses decisions).
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import curator_state
        live = curator_state.status_map()
        drifted = {i: live.get(i, '(no decision)') for i in ids if live.get(i) != 'keep'}
        if drifted:
            print('live state has moved on - refusing the batch:')
            for i, s in drifted.items():
                print(f'  {i} is now {s}, not keep')
            return 1
        titles = {i: api_title(i) for i in ids}
        return write_batch(pairs, titles)

    on_page = pages_today()
    missing = [i for i in ids if i not in on_page]
    if missing:
        print(f'not sent for review today: {missing}')
        return 1
    titles = {i: (on_page.get(i) or api_title(i)) for i in ids}
    return write_batch(pairs, titles)


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in VALID:
        print(f'usage: queue-decisions.py <{"|".join(sorted(VALID))}> <modId> ...')
        return 2
    argv = sys.argv[2:]
    keeps_pass = '--keeps-pass' in argv
    if keeps_pass:
        argv.remove('--keeps-pass')
    status, ids = sys.argv[1], [int(x) for x in argv]
    return queue([(status, i) for i in ids], keeps_pass=keeps_pass)


if __name__ == '__main__':
    sys.exit(main())
