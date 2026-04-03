from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path


class DebugFrameStorage:
    def __init__(self, enabled: bool, base_dir: str | Path) -> None:
        self.enabled = enabled
        self.base_dir = Path(base_dir)

    def save(self, frame_id: str, image: bytes) -> Path | None:
        if not self.enabled:
            return None

        self.base_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%S%f")
        path = self.base_dir / f"{frame_id}_{ts}.bin"
        path.write_bytes(image)
        return path
