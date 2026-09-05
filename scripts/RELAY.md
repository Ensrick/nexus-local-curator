# The curation relay: how the Ask Claude button reaches an assistant

## One paragraph

The Firefox extension cannot talk to an AI directly. Its **Ask Claude** button
POSTs the mods visible on the current Nexus listing to a tiny HTTP server on
`127.0.0.1:38492` (`curation-relay.py`). The server writes the batch to a spool
folder as JSON. Any assistant, in any tool, reads that folder, reviews the
mods, and writes its verdicts back into the same folder. The extension polls
the server every 3 seconds and applies whatever verdicts appear. The relay is
therefore **not tied to any conversation or model**: it is a mailbox. The
thing that used to tie it to one Claude Code session was only that the session
had started the server as its own background job (so it died with the session)
and was the only one that knew to look in the mailbox.

## Pieces

| Piece | Path | Role |
|---|---|---|
| Relay server | `scripts/curation-relay.py` | Loopback HTTP server. `POST /page` (extension -> spool), `GET /decisions` (spool -> extension, consumes the queue), `GET /health` (side-effect-free probe). Logs to `relay.log`. Refuses to double-bind. |
| Always-on | Scheduled Task `NexusCurationRelay` | Starts the server at logon and every 5 minutes (watchdog; the server exits at once when the port is already served). Restart on failure 3x. Registered by `relay-ensure.ps1`. |
| Ensure | `scripts/relay-ensure.ps1` | Idempotent: registers the task if missing, starts the relay if down, prints one status line. `-Status`, `-Register`, `-Stop` (stops AND disables the task). |
| Intake | `scripts/relay-batch.py` | Turns the spool batch into a Markdown brief with Nexus metadata, files, description, curator state, MO2 install state, prior mentions in the build repo. `--out`, `--clip`, `--ids`, `--no-api`, `--json`. |
| Instructions | `scripts/ASSISTANT_PROMPT.md` | Model-neutral reviewer rules and the reply format. The Claude Code skill `/ask-claude` is a thin wrapper around this file. |
| Queue | `scripts/queue-decisions.py` | Writes `decisions-pending.json` with two guards: never clobbers an undelivered batch, never decides an id that was not on a page sent today. |
| Apply pasted verdicts | `scripts/apply-verdicts.py` | Parses the `verdicts` block from any assistant's reply (file, stdin, or `--clipboard`) and queues it through the same guards. |
| Live state | `scripts/curator_state.py` | Reads the extension's IndexedDB directly: `status_map()` -> `{modId: status}`. |

Spool: `%TEMP%\nlc-relay\` (`C:\Users\danjo\AppData\Local\Temp\nlc-relay`).

| File | Meaning |
|---|---|
| `page-latest.json` | The last batch: `{url, mods[{modId, sourceUrl, title, author{username,userId}, decision}], reportedAt (UTC), receivedAt (local)}` |
| `pages.log.jsonl` | Every batch ever received, one per line |
| `decisions-pending.json` | Verdicts waiting for the extension |
| `decisions-applied-<stamp>.json` | The same file after the extension fetched it (renamed by the relay) |
| `batch-brief.md` | Output of `relay-batch.py --out` |
| `relay.log`, `relay.pid` | Server log (rotates at 1 MB) and pid |

## Using it from any assistant

**Claude Code:** type `/ask-claude`. Variants `/ask-claude status`, `/ask-claude stop`.

**Any agentic tool with a shell (Codex, Gemini CLI, Cursor, a fresh Claude
session without the skill):** give it one instruction:

```
Follow C:\Users\danjo\source\repos\nexus-local-curator\scripts\ASSISTANT_PROMPT.md
```

It runs `relay-ensure.ps1`, `relay-batch.py`, reviews, and queues with
`queue-decisions.py`.

**Any chat window (ChatGPT, Claude web, Gemini, Copilot):**

```
py -3 C:\Users\danjo\source\repos\nexus-local-curator\scripts\relay-batch.py --out --clip
```

Paste the clipboard (the brief) plus `ASSISTANT_PROMPT.md` into the chat.
Copy the reply, then:

```
py -3 C:\Users\danjo\source\repos\nexus-local-curator\scripts\apply-verdicts.py --clipboard
```

The button label says Claude; the pipeline does not care who answers.

## Timing

- The extension polls `/decisions` every 3 s while armed. Loading any Nexus
  page arms it; 30 idle minutes disarm it. A batch queued while disarmed is
  applied on the next Nexus page load.
- `relay-batch.py` prints the batch age. Older than 60 minutes means
  `WARNING: STALE batch`: a newer click never reached the relay (it was down).
  Fix is `relay-ensure.ps1` then another click.

## Rules

- Never `GET /decisions` by hand. It hands the queue to the caller and renames
  the file; the extension then never sees those verdicts. Probe `/health`.
- Never start `curation-relay.py` as a background job of a session, and never
  register or kill the task by any route other than `relay-ensure.ps1`. The
  server refuses to double-bind, so a stray start is harmless but pointless.
- Never write `keep` from a review. Installing in MO2 is what makes a Keep.
- The Nexus API key is resolved by `relay-batch.py` (arg, env
  `NEXUS_API_KEY`, `nexus.local.json` beside the scripts, then the
  crusader-de-tweaker copy). It is never printed and never committed.

## Failure history

The relay died silently at least six times between 2026-08-20 and 2026-09-05.
Causes: started as a Claude Code background job (dies with the session), or
started ad hoc with no restart. Python's `HTTPServer` also sets
`allow_reuse_address`, which on Windows lets a second copy bind the same port
and steal traffic, so two half-alive relays could coexist. The 2026-09-05
rewrite fixed all three: Scheduled Task with logon + 5 minute watchdog +
restart on failure, `allow_reuse_address = False`, and a pre-bind port probe.
Verified the same day: kill the process, the task brings it back.

## Troubleshooting

| Symptom | Check |
|---|---|
| Button shows "No relay" | `relay-ensure.ps1 -Status`; if NOT listening, run it without flags and read `relay.log` |
| Brief says STALE | The click happened while the relay was down; click again |
| Verdicts queued but nothing changes on Nexus | Poll disarmed; load any Nexus page. `relay-ensure.ps1 -Status` shows `decisions PENDING pickup` until then |
| `queue-decisions.py` refuses: pending batch | The extension has not fetched the last batch; load a Nexus page, do not delete the file |
| `queue-decisions.py` refuses: not sent today | The id was not on any page reported today; the user must send that page |
| Task exists but relay keeps dying | `relay.log` has the bind error; `Get-ScheduledTaskInfo NexusCurationRelay` has LastTaskResult |
