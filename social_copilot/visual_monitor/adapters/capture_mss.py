from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class CaptureResult:
    raw: bytes
    width: int
    height: int


class MSSCaptureAdapter:
    """Thin wrapper around mss to capture a configured ROI."""

    def __init__(self) -> None:
        from mss import mss

        self._mss = mss

    @staticmethod
    def to_mss_monitor(roi: dict[str, int]) -> dict[str, int]:
        return {
            "left": roi["x"],
            "top": roi["y"],
            "width": roi["w"],
            "height": roi["h"],
        }

    def capture(self, roi: dict[str, int]) -> CaptureResult:
        monitor = self.to_mss_monitor(roi)
        with self._mss() as sct:
            shot = sct.grab(monitor)
            return CaptureResult(raw=shot.rgb, width=shot.width, height=shot.height)
