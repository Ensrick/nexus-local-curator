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
"""
import datetime, io, json, os, sys

from decision_queue import stamp_batch

VALID = {'keep', 'trim', 'maybe', 'skip', 'unreviewed'}
SPOOL = os.path.join(os.environ.get('TEMP', '.'), 'nlc-relay')
PENDING = os.path.join(SPOOL, 'decisions-pending.json')
PAGE = os.path.join(SPOOL, 'page-latest.json')


def write_batch(status, titles, ids, *, now=None):
    batch = stamp_batch([
        {'status': status,
         'mod': {'game': 'skyrimspecialedition', 'modId': str(i), 'title': titles[i],
                 'sourceUrl': f'https://www.nexusmods.com/skyrimspecialedition/mods/{i}'}}
        for i in ids
    ], now=now)
    tmp = PENDING + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as handle:
        json.dump(batch, handle, indent=1)
    os.replace(tmp, PENDING)
    for i in ids:
        print(f'  {status} {i} {titles[i]}')
    print(f'queued {len(batch)} -> {PENDING}')
    return 0


def queue_from_keeps(status, ids):
    """Demote mods that are still on the Keep list, checked against live state.

    A Keep-list review reads mods the user is not currently browsing, so the
    page guard cannot apply. The equivalent protection is that every target must
    still read `keep` in the extension right now: anything the user has already
    moved on is reported and the whole batch is refused rather than partially
    written, because a partial write is the failure mode that loses decisions.
    """
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import curator_state
    live = curator_state.status_map()
    drifted = {i: live.get(i, '(no decision)') for i in ids if live.get(i) != 'keep'}
    if drifted:
        print('live state has moved on - refusing the batch:')
        for i, s in drifted.items():
            print(f'  {i} is now {s}, not keep')
        return 1
    titles = {}
    for i in ids:
        try:
            sys.path.insert(0, r'C:\Users\danjo\source\repos\skyrim-mod-assistant\audit')
            import modasset as M
            titles[i] = M.v1(f'/mods/{i}.json').get('name') or str(i)
        except Exception:
            titles[i] = str(i)
    return write_batch(status, titles, ids)


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in VALID:
        print(f'usage: queue-decisions.py <{"|".join(sorted(VALID))}> <modId> ...')
        return 2
    argv = sys.argv[2:]
    keeps_pass = '--keeps-pass' in argv
    if keeps_pass:
        argv.remove('--keeps-pass')
    status, ids = sys.argv[1], [int(x) for x in argv]

    if os.path.exists(PENDING):
        print('a pending batch has not been picked up yet - not clobbering it')
        return 1

    if keeps_pass:
        return queue_from_keeps(status, ids)

    # Guard against every page reported today, not just the latest: a review
    # session pages through a catalogue, so by the time decisions are ready the
    # latest page is several clicks past the mods being decided.
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
    missing = [i for i in ids if i not in on_page]
    if missing:
        print(f'not sent for review today: {missing}')
        return 1

    titles = {}
    for i in ids:
        if on_page.get(i):
            titles[i] = on_page[i]
            continue
        try:
            sys.path.insert(0, r'C:\Users\danjo\source\repos\skyrim-mod-assistant\audit')
            import modasset as M
            titles[i] = M.v1(f'/mods/{i}.json').get('name') or str(i)
        except Exception:
            titles[i] = str(i)

    return write_batch(status, titles, ids)


if __name__ == '__main__':
    sys.exit(main())
