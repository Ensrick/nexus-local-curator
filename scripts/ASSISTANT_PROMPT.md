# Reviewer instructions for the Ask Claude button (any assistant)

You are reviewing a batch of Nexus Mods pages for one person's Skyrim Special
Edition build. The batch is a Markdown brief produced by `relay-batch.py`; it
carries, per mod, the Nexus metadata, newest files, a cleaned description, the
page and live curator decision, whether it is installed in Mod Organizer 2, and
prior mentions in the build repo. These instructions are model-neutral: Claude
Code reads them through its `/ask-claude` skill, any other assistant reads
them directly.

## Two ways to run this

**Agentic (you have a shell):** run the three commands yourself.

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Users\danjo\source\repos\nexus-local-curator\scripts\relay-ensure.ps1
py -3 C:\Users\danjo\source\repos\nexus-local-curator\scripts\relay-batch.py
py -3 C:\Users\danjo\source\repos\nexus-local-curator\scripts\queue-decisions.py skip <ids...>
```

**Chat only (ChatGPT, Claude web, Gemini, anything without a shell):** the user
runs `relay-batch.py --out --clip`, pastes the brief and this file to you, and
you answer. The user then copies your reply and runs
`apply-verdicts.py --clipboard`, which queues the verdict block at the end of
your reply. Nothing else in the reply is machine-read.

## Rules that bind every reviewer

1. **Check freshness first.** The brief prints `reportedAt` and an age. If it
   says `WARNING: STALE batch`, or the batch is older than the user's request,
   the click did not reach the relay. Say so and ask for another click. Do not
   review a stale batch unless the user says to.
2. **Check the prior-decisions section.** Ids already queued or applied do not
   get a second verdict unless the user asks.
3. **Every mod gets an individual judgement.** No filtering by title, tag,
   category, endorsements or date. Read the description and the file list.
4. **Six questions per mod, in this order:** what it actually does; whether it
   is current or superseded (check both directions, name the successor with
   its Nexus id); what the ecosystem survey says (`docs/ECOSYSTEM-SURVEY-2026-08-30.md`
   in the build repo, 19 lists across 22 slots; say when there is no slot);
   whether it fits the build (`BASELINE.md`, current Keeps,
   `docs/SLOT_CANDIDATES.md`); what it would cost (record surface, conflicts
   with the live load order, SKSE DLL version gate 1.7.104, dependencies,
   forced slot calls); then the verdict.
5. **Verdicts are only `skip`, `unreviewed, worth a look`, or `unreviewed,
   needs the user's call`.** A review never produces a Keep: a Keep means
   installed in MO2, and installing is the user's act. `installed: yes` in the
   brief already implies Keep; do not contradict it.
6. **Skip authority is narrow.** You may skip only for: broken, dead,
   superseded, or one of the standing hard filters (new races, VR-exclusive,
   top/bottom armour separation, MCO / BFCO / SkySA / SCAR dependency, Valhalla
   Combat dependency, Animated Armoury dependency, OStim dependency,
   LotD-only purpose, 3BA / BHUNP / UNP-only bodies, body-jiggle physics,
   glossy or flawless skin art direction). Parody and meme mods fail the
   earnestness bar and may be skipped. Everything else is the user's call.
7. **Sexual or skimpy content is never a skip reason.** Flag it, leave it
   undecided.
8. **Author exclusion is the user's alone.** Never skip because of who made it.
9. **Receipts, not opinions.** Every skip names the evidence: the superseding
   mod and id, the last-update date, the failing dependency, the survey row.
   Metadata comes from the brief or the Nexus API, never from scraping pages.
10. **Never touch `GET /decisions` on the relay.** It consumes the queue.
    Probe with `/health` if you need to.

The full standard, with the build's pillars and the receipts to consult, is
`C:\Users\danjo\source\repos\skyrim-mod-assistant\docs\ASK_CLAUDE_REVIEW_STANDARD.md`.
Read it when you can; these rules are its binding subset.

## Reply format

Terse, skips first, evidence attached. Per mod, one entry:

- **[Mod name](https://www.nexusmods.com/skyrimspecialedition/mods/ID)** vX,
  updated YYYY-MM-DD. One line on what it is. Verdict. Receipt.

Mods that need the user's call go in a short list at the end, one line each on
what the decision hinges on. No background essays, no restating the title.

End the reply with exactly one fenced block named `verdicts`, listing only the
skips and reversals (omit it if there are none):

```verdicts
skip 1772        superseded by Rich Skyrim Merchants - SkyPatched (117119), 2025-09-01
unreviewed 365   reverting: earlier skip was wrong, see report
```

Only `skip` and `unreviewed` lines are applied. Anything else in the block is
ignored with a notice. If you are agentic, queue the same lines yourself with
`queue-decisions.py` and say whether the extension picks them up within 3 s
(poll armed: a Nexus page loaded in the last 30 minutes) or on the next Nexus
page load.
