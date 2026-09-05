from __future__ import annotations

import datetime as dt
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))
# curator_state computes the Firefox profile root at import time.  CI runs on
# Linux without APPDATA; these tests replace its I/O function before use, so a
# deterministic inert root is sufficient and avoids coupling schema tests to
# one desktop environment.
os.environ.setdefault("APPDATA", str(ROOT / ".test-appdata"))

import decision_queue  # noqa: E402


def load_script(module_name: str, filename: str):
    spec = importlib.util.spec_from_file_location(module_name, SCRIPTS / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {filename}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


queue_decisions = load_script("queue_decisions_test", "queue-decisions.py")
reconcile = load_script("reconcile_installed_keeps_test", "reconcile-installed-keeps.py")


class DecisionQueueSchemaTests(unittest.TestCase):
    FIXED = dt.datetime(2026, 9, 4, 18, 18, 30, 987654,
                        tzinfo=dt.timezone(dt.timedelta(hours=-5)))
    EXPECTED = "2026-09-04T23:18:30Z"

    def test_stamp_batch_uses_one_canonical_utc_instant_without_mutating_input(self):
        source = [
            {"status": "keep", "mod": {"game": "skyrimspecialedition", "modId": "1"}},
            {"status": "skip", "mod": {"game": "skyrimspecialedition", "modId": "2"}},
        ]
        before = json.loads(json.dumps(source))

        stamped = decision_queue.stamp_batch(source, now=self.FIXED)

        self.assertEqual(source, before)
        self.assertEqual([row["queuedAt"] for row in stamped],
                         [self.EXPECTED, self.EXPECTED])
        self.assertIsNot(stamped[0]["mod"], source[0]["mod"])

    def test_timestamp_source_must_be_timezone_aware(self):
        with self.assertRaisesRegex(ValueError, "timezone-aware"):
            decision_queue.stamp_batch([], now=dt.datetime(2026, 9, 4, 23, 18, 30))

    def test_manual_queue_writer_publishes_timestamped_rows(self):
        with tempfile.TemporaryDirectory(prefix="curator-queue-") as raw:
            pending = pathlib.Path(raw) / "decisions-pending.json"
            original_pending = queue_decisions.PENDING
            try:
                queue_decisions.PENDING = str(pending)
                result = queue_decisions.write_batch(
                    "skip", {1772: "Rich Skyrim Merchants"}, [1772], now=self.FIXED)
            finally:
                queue_decisions.PENDING = original_pending

            self.assertEqual(result, 0)
            rows = json.loads(pending.read_text(encoding="utf-8"))
            self.assertEqual(rows[0]["queuedAt"], self.EXPECTED)
            self.assertEqual(rows[0]["status"], "skip")
            self.assertEqual(rows[0]["mod"]["modId"], "1772")

    def test_reconciliation_writer_publishes_timestamped_rows(self):
        plan = {
            "changes": [{
                "observedStatus": "unreviewed",
                "desiredStatus": "keep",
                "mod": {
                    "game": "skyrimspecialedition",
                    "modId": "42",
                    "title": "Fixture",
                },
            }],
        }
        original_status_map = reconcile.curator_state.status_map
        try:
            reconcile.curator_state.status_map = lambda _game: {}
            with tempfile.TemporaryDirectory(prefix="curator-reconcile-") as raw:
                pending = reconcile.queue_plan(plan, pathlib.Path(raw), now=self.FIXED)
                rows = json.loads(pending.read_text(encoding="utf-8"))
        finally:
            reconcile.curator_state.status_map = original_status_map

        self.assertEqual(rows[0]["queuedAt"], self.EXPECTED)
        self.assertEqual(rows[0]["status"], "keep")
        self.assertEqual(rows[0]["mod"]["modId"], "42")

    def test_relay_consumes_legacy_and_timestamped_rows_unchanged(self):
        variants = {
            "legacy": [{
                "status": "skip",
                "mod": {"game": "skyrimspecialedition", "modId": "1772"},
            }],
            "timestamped": [{
                "status": "keep",
                "mod": {"game": "skyrimspecialedition", "modId": "42"},
                "queuedAt": self.EXPECTED,
            }],
        }
        with tempfile.TemporaryDirectory(prefix="curator-relay-") as raw:
            root = pathlib.Path(raw)
            for name, rows in variants.items():
                with self.subTest(schema=name):
                    spool = root / name
                    original_argv = sys.argv[:]
                    try:
                        sys.argv = [original_argv[0], str(spool)]
                        relay = load_script(f"curation_relay_{name}_test", "curation-relay.py")
                    finally:
                        sys.argv = original_argv

                    pending = spool / "decisions-pending.json"
                    pending.write_text(json.dumps(rows), encoding="utf-8")
                    served = relay.take_pending()

                    self.assertEqual(json.loads(served), rows)
                    self.assertFalse(pending.exists())
                    archives = list(spool.glob("decisions-applied-*.json"))
                    self.assertEqual(len(archives), 1)
                    self.assertEqual(json.loads(archives[0].read_text(encoding="utf-8")), rows)


if __name__ == "__main__":
    unittest.main()
