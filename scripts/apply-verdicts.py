"""Queue an assistant's verdicts from pasted text, whatever model wrote them.

The reviewer (Claude, ChatGPT, Gemini, Codex, a person) ends its reply with a
fenced block:

    ```verdicts
    skip 1772        superseded by Rich Skyrim Merchants - SkyPatched (117119)
    unreviewed 365   reverting an earlier skip
    ```

This script pulls `skip` / `unreviewed` lines out of that block (or out of the
whole text when there is no block), applies queue-decisions.py's guards, and
writes one decisions-pending.json for the extension to pick up.

  py -3 scripts/apply-verdicts.py reply.md          # from a file
  py -3 scripts/apply-verdicts.py -                 # from stdin
  py -3 scripts/apply-verdicts.py --clipboard       # from the clipboard (copy the reply first)
  py -3 scripts/apply-verdicts.py reply.md --dry-run

Accepted line shapes (bullets, backticks and colons are tolerated):
  skip 1772 [reason]      1772: skip [reason]      - `unreviewed 365`
`keep`, `maybe` and `trim` lines are reported and ignored: a review never
produces a Keep (installing a mod is what makes a Keep).
"""
import argparse, importlib.util, pathlib, re, subprocess, sys

HERE = pathlib.Path(__file__).resolve().parent
QUEUEABLE = ('skip', 'unreviewed')
IGNORED = ('keep', 'maybe', 'trim')
WORDS = '|'.join(QUEUEABLE + IGNORED)
LEAD = r'^\s*(?:[-*•]\s*)?`?\s*'
PAT_A = re.compile(LEAD + rf'({WORDS})\b`?\s*[:\-]?\s*`?(\d+)\b', re.I)
PAT_B = re.compile(LEAD + rf'(\d+)\b`?\s*[:\-]?\s*`?({WORDS})\b', re.I)
FENCE = re.compile(r'```\s*verdicts?\s*\n(.*?)```', re.S | re.I)


def read_input(a):
    if a.clipboard:
        r = subprocess.run(['powershell', '-NoProfile', '-Command', 'Get-Clipboard -Raw'],
                           capture_output=True, text=True, encoding='utf-8', errors='replace')
        return r.stdout or ''
    if a.source == '-':
        return sys.stdin.read()
    return pathlib.Path(a.source).read_text(encoding='utf-8-sig', errors='replace')


def parse(text):
    """-> (pairs [(status, id)], ignored [(status, id)], conflicts [id])"""
    blocks = FENCE.findall(text)
    body = '\n'.join(blocks) if blocks else text
    found = {}
    order = []
    for line in body.splitlines():
        m = PAT_A.match(line)
        if m:
            status, mid = m.group(1).lower(), int(m.group(2))
        else:
            m = PAT_B.match(line)
            if not m:
                continue
            mid, status = int(m.group(1)), m.group(2).lower()
        if mid not in found:
            order.append(mid)
            found[mid] = set()
        found[mid].add(status)
    pairs, ignored, conflicts = [], [], []
    for mid in order:
        statuses = found[mid] & set(QUEUEABLE)
        if len(statuses) > 1:
            conflicts.append(mid)
            continue
        if statuses:
            pairs.append((statuses.pop(), mid))
        for s in found[mid] & set(IGNORED):
            ignored.append((s, mid))
    return pairs, ignored, conflicts, bool(blocks)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('source', nargs='?', default='-', help="file path, or '-' for stdin")
    ap.add_argument('--clipboard', action='store_true')
    ap.add_argument('--dry-run', action='store_true', help='parse and report, write nothing')
    ap.add_argument('--keeps-pass', action='store_true', help='pass through to queue-decisions (Keep-list review)')
    a = ap.parse_args()

    text = read_input(a)
    pairs, ignored, conflicts, fenced = parse(text)
    print(f"source: {'clipboard' if a.clipboard else a.source}; "
          f"{'verdicts block' if fenced else 'no verdicts block, scanned whole text'}")
    for s, mid in ignored:
        print(f'  ignored {s} {mid}: a review never queues {s}')
    for mid in conflicts:
        print(f'  CONFLICT {mid}: both skip and unreviewed given; refusing the whole batch')
    if conflicts:
        return 1
    if not pairs:
        print('nothing to queue (no skip/unreviewed lines found)')
        return 1
    for s, mid in pairs:
        print(f'  {s} {mid}')
    if a.dry_run:
        print(f'dry run: {len(pairs)} would be queued')
        return 0

    spec = importlib.util.spec_from_file_location('queue_decisions', HERE / 'queue-decisions.py')
    qd = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(qd)
    return qd.queue(pairs, keeps_pass=a.keeps_pass)


if __name__ == '__main__':
    sys.exit(main())
