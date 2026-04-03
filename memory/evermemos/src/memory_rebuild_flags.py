"""Helpers for historical replay and rebuild flows."""

from __future__ import annotations

from typing import Optional


def should_force_memory_replay(
    force_memory_backfill: bool,
    current_memcell_count: Optional[int],
) -> bool:
    """Return True when the caller intends a replay of stored history."""

    if force_memory_backfill:
        return True
    return (current_memcell_count or 0) <= 0


def should_skip_duplicate_memcell(
    last_confirmed_hash: Optional[str],
    confirmed_hash: Optional[str],
    *,
    force_memory_backfill: bool = False,
    force_profile_extraction: bool = False,
) -> bool:
    """Return True when a duplicate boundary should be skipped."""

    if force_memory_backfill or force_profile_extraction:
        return False
    return bool(last_confirmed_hash and confirmed_hash and confirmed_hash == last_confirmed_hash)
