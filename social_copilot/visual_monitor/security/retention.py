from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path


def cleanup_expired_debug_frames(base_dir: str | Path, ttl_hours: int) -> int:
    root = Path(base_dir)
    if not root.exists():
        return 0

    deadline = datetime.now(tz=timezone.utc) - timedelta(hours=ttl_hours)
    removed = 0
    for file_path in root.glob("*"):
        if not file_path.is_file():
            continue
        modified = datetime.fromtimestamp(file_path.stat().st_mtime, tz=timezone.utc)
        if modified < deadline:
            file_path.unlink(missing_ok=True)
            removed += 1
    return removed
