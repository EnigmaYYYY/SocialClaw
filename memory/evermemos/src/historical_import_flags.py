"""Helpers for resolving historical import semantics from process-chat payloads."""

from __future__ import annotations

from typing import Any, Mapping


def resolve_historical_import_flag(request: Mapping[str, Any]) -> bool:
    """Return whether a request should bypass pending-boundary handling.

    Historical chat import and memory backfill are the same operational mode for
    EverMemOS profile initialization, so the legacy `force_memory_backfill`
    field is accepted as an alias for `is_historical_import`.
    """

    if bool(request.get("is_historical_import", False)):
        return True
    return bool(request.get("force_memory_backfill", False))
