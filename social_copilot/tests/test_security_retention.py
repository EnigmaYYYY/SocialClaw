from datetime import datetime, timedelta, timezone
import os
from pathlib import Path

from social_copilot.visual_monitor.security.debug_storage import DebugFrameStorage
from social_copilot.visual_monitor.security.retention import cleanup_expired_debug_frames


def test_debug_storage_respects_enabled_flag(tmp_path: Path) -> None:
    storage = DebugFrameStorage(enabled=False, base_dir=tmp_path)
    wrote = storage.save(frame_id="f1", image=b"abc")
    assert wrote is None
    assert list(tmp_path.glob("*")) == []


def test_debug_storage_writes_file_when_enabled(tmp_path: Path) -> None:
    storage = DebugFrameStorage(enabled=True, base_dir=tmp_path)
    path = storage.save(frame_id="f1", image=b"abc")
    assert path is not None
    assert path.exists()
    assert path.read_bytes() == b"abc"


def test_retention_cleanup_removes_expired_files(tmp_path: Path) -> None:
    expired = tmp_path / "old.bin"
    fresh = tmp_path / "new.bin"
    expired.write_bytes(b"old")
    fresh.write_bytes(b"new")

    old_time = datetime.now(tz=timezone.utc) - timedelta(hours=25)
    old_ts = old_time.timestamp()
    os.utime(expired, (old_ts, old_ts))

    removed = cleanup_expired_debug_frames(base_dir=tmp_path, ttl_hours=24)
    assert removed == 1
    assert not expired.exists()
    assert fresh.exists()
