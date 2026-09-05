"""Reconcile Nexus Keep decisions with one enabled MO2 profile.

Keep means that at least one file from the Nexus mod page is enabled in the
selected profile. Skip remains an explicit rejection. A previously kept mod
that is not enabled is cleared to ``unreviewed``; it is never converted to
Skip. The queued batch is guarded by a second live-state comparison so it
cannot overwrite a decision that changed after the plan was generated.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import re
import sys
import tempfile
import urllib.request


GAME = "skyrimspecialedition"
HERE = pathlib.Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
DEFAULT_INSTANCE = REPO_ROOT.parent / "mo2-instances" / "skyrim-se"
DEFAULT_LEDGER = REPO_ROOT.parent / "skyrim-mod-assistant" / "records" / "installed-mods.json"
DEFAULT_KEY_FILE = REPO_ROOT.parent / "crusader-de-tweaker" / "scripts" / "nexus" / "nexus.local.json"
DEFAULT_SPOOL = pathlib.Path(os.environ.get("TEMP", ".")) / "nlc-relay"

sys.path.insert(0, str(HERE))
import curator_state  # noqa: E402
from decision_queue import stamp_batch  # noqa: E402


def enabled_names(instance: pathlib.Path, profile: str) -> list[str]:
    modlist = instance / "profiles" / profile / "modlist.txt"
    return [line[1:].strip() for line in modlist.read_text(encoding="utf-8-sig").splitlines()
            if line.startswith("+") and line[1:].strip()]


def active_nexus_ids(instance: pathlib.Path, profile: str, ledger_path: pathlib.Path) -> set[int]:
    ledger = json.loads(ledger_path.read_text(encoding="utf-8-sig")).get("mods", [])
    by_name: dict[str, set[int]] = {}
    for row in ledger:
        try:
            mod_id = int(row.get("modId") or 0)
        except (TypeError, ValueError):
            continue
        name = str(row.get("modName") or "")
        if name and mod_id > 0:
            by_name.setdefault(name, set()).add(mod_id)

    result: set[int] = set()
    for name in enabled_names(instance, profile):
        result.update(by_name.get(name, ()))
        meta = instance / "mods" / name / "meta.ini"
        if not meta.exists():
            continue
        match = re.search(r"^installationFile=(.*)$", meta.read_text(
            encoding="utf-8-sig", errors="replace"), re.MULTILINE)
        if not match:
            continue
        archive_name = pathlib.PurePath(match.group(1).strip()).name
        leading = re.match(r"^(\d+)-\d+\.", archive_name)
        if leading:
            result.add(int(leading.group(1)))
    return result


def resolve_api_key() -> str:
    key = os.environ.get("NEXUS_API_KEY", "").strip()
    if not key and DEFAULT_KEY_FILE.exists():
        key = str(json.loads(DEFAULT_KEY_FILE.read_text(encoding="utf-8-sig")).get("ApiKey") or "").strip()
    if not key or "PASTE-YOUR" in key.upper():
        raise RuntimeError("No usable Nexus API key is available for active-mod metadata.")
    return key


def nexus_metadata(mod_id: int, api_key: str) -> dict:
    url = f"https://api.nexusmods.com/v1/games/{GAME}/mods/{mod_id}.json"
    request = urllib.request.Request(url, headers={
        "apikey": api_key,
        "application-name": "NexusLocalCurator",
        "application-version": "0.15.0",
        "User-Agent": "NexusLocalCurator/0.15.0",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(request, timeout=60) as response:
        data = json.load(response)
    profile_url = str(data.get("uploaded_users_profile_url") or "")
    user_id = ""
    user_match = re.search(r"/users/(\d+)", profile_url)
    if user_match:
        user_id = user_match.group(1)
    author = str(data.get("uploaded_by") or data.get("author") or "")
    return {
        "game": GAME,
        "modId": str(mod_id),
        "title": str(data.get("name") or mod_id),
        "author": author,
        "authorUserId": user_id,
        "authorProfileUrl": profile_url,
        "sourceUrl": f"https://www.nexusmods.com/{GAME}/mods/{mod_id}",
    }


def build_plan(instance: pathlib.Path, profile: str, ledger: pathlib.Path) -> dict:
    rows = [row for row in curator_state.decisions()
            if row.get("game") == GAME and row.get("modId")]
    current = {int(row["modId"]): row for row in rows}
    active = active_nexus_ids(instance, profile, ledger)
    stale_keeps = sorted(mod_id for mod_id, row in current.items()
                         if row.get("status") == "keep" and mod_id not in active)
    missing_keeps = sorted(mod_id for mod_id in active
                           if current.get(mod_id, {}).get("status") != "keep")

    changes: list[dict] = []
    for mod_id in stale_keeps:
        row = current[mod_id]
        changes.append({
            "observedStatus": "keep",
            "desiredStatus": "unreviewed",
            "mod": {
                "game": GAME,
                "modId": str(mod_id),
                "title": str(row.get("title") or mod_id),
                "author": str(row.get("author") or ""),
                "authorUserId": str(row.get("authorUserId") or ""),
                "authorProfileUrl": str(row.get("authorProfileUrl") or ""),
                "sourceUrl": str(row.get("sourceUrl") or
                                 f"https://www.nexusmods.com/{GAME}/mods/{mod_id}"),
            },
        })

    api_key = resolve_api_key() if missing_keeps else ""
    for mod_id in missing_keeps:
        changes.append({
            "observedStatus": str(current.get(mod_id, {}).get("status") or "unreviewed"),
            "desiredStatus": "keep",
            "mod": nexus_metadata(mod_id, api_key),
        })

    return {
        "schemaVersion": 1,
        "generatedUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "game": GAME,
        "instance": str(instance),
        "profile": profile,
        "semantics": {
            "keep": "At least one file from this Nexus mod page is enabled in the selected MO2 profile.",
            "skip": "The user explicitly rejected the mod for the current list.",
            "unreviewed": "Not installed; may be deferred, weighted, or awaiting a decision.",
        },
        "counts": {
            "activeNexusIds": len(active),
            "liveKeepBefore": sum(1 for row in current.values() if row.get("status") == "keep"),
            "clearInactiveKeeps": len(stale_keeps),
            "setActiveKeeps": len(missing_keeps),
            "liveKeepAfter": len(active),
        },
        "activeNexusIds": sorted(active),
        "changes": changes,
    }


def atomic_json(path: pathlib.Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent,
                                     delete=False, suffix=".tmp") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary = pathlib.Path(handle.name)
    os.replace(temporary, path)


def queue_plan(plan: dict, spool: pathlib.Path, *, now: dt.datetime | None = None) -> pathlib.Path:
    pending = spool / "decisions-pending.json"
    if pending.exists():
        raise RuntimeError(f"A curator batch is already pending: {pending}")
    live = curator_state.status_map(GAME)
    drift = []
    for change in plan["changes"]:
        mod_id = int(change["mod"]["modId"])
        actual = str(live.get(mod_id) or "unreviewed")
        if actual != change["observedStatus"]:
            drift.append((mod_id, change["observedStatus"], actual))
    if drift:
        detail = "; ".join(f"{mod_id}: expected {expected}, found {actual}"
                           for mod_id, expected, actual in drift[:10])
        raise RuntimeError(f"Live curator state drifted; refusing the entire batch. {detail}")
    batch = stamp_batch([
        {"status": change["desiredStatus"], "mod": change["mod"]}
        for change in plan["changes"]
    ], now=now)
    atomic_json(pending, batch)
    return pending


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--instance", type=pathlib.Path, default=DEFAULT_INSTANCE)
    parser.add_argument("--profile", default="Default")
    parser.add_argument("--ledger", type=pathlib.Path, default=DEFAULT_LEDGER)
    parser.add_argument("--plan-out", type=pathlib.Path)
    parser.add_argument("--queue", action="store_true")
    parser.add_argument("--spool", type=pathlib.Path, default=DEFAULT_SPOOL)
    args = parser.parse_args()

    plan = build_plan(args.instance.resolve(), args.profile, args.ledger.resolve())
    if args.plan_out:
        atomic_json(args.plan_out.resolve(), plan)
    print(json.dumps(plan["counts"], indent=2))
    if args.queue:
        queued = queue_plan(plan, args.spool.resolve())
        print(f"queued {len(plan['changes'])} guarded decisions -> {queued}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
