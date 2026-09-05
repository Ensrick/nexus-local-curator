"""Shared schema helpers for durable curator decision batches."""

from __future__ import annotations

import copy
import datetime as dt
from collections.abc import Iterable, Mapping
from typing import Any


def canonical_queued_at(now: dt.datetime | None = None) -> str:
    """Return a second-precision UTC timestamp accepted by lifecycle gates."""
    instant = now if now is not None else dt.datetime.now(dt.timezone.utc)
    if instant.tzinfo is None or instant.utcoffset() is None:
        raise ValueError("queuedAt source must be timezone-aware")
    return instant.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def stamp_batch(
    entries: Iterable[Mapping[str, Any]],
    *,
    now: dt.datetime | None = None,
) -> list[dict[str, Any]]:
    """Copy a batch and apply one canonical enqueue instant to every row."""
    queued_at = canonical_queued_at(now)
    stamped: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, Mapping):
            raise TypeError("each queued decision must be an object")
        row = copy.deepcopy(dict(entry))
        row["queuedAt"] = queued_at
        stamped.append(row)
    return stamped
