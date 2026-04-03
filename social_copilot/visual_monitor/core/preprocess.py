from __future__ import annotations


class FramePreprocessor:
    """Geometry helpers for ROI normalization and parser alignment."""

    @staticmethod
    def normalize_roi(screen: dict[str, int], roi: dict[str, int]) -> dict[str, int]:
        sx, sy, sw, sh = screen["x"], screen["y"], screen["w"], screen["h"]

        x = max(roi["x"], sx)
        y = max(roi["y"], sy)
        right = min(roi["x"] + roi["w"], sx + sw)
        bottom = min(roi["y"] + roi["h"], sy + sh)

        width = max(right - x, 0)
        height = max(bottom - y, 0)
        return {"x": x, "y": y, "w": width, "h": height}

    @staticmethod
    def center_x(roi: dict[str, int]) -> int:
        return roi["x"] + roi["w"] // 2

    @staticmethod
    def rgb_bytes_to_png(image: bytes, width: int, height: int) -> bytes:
        if width <= 0 or height <= 0:
            return image

        expected_size = width * height * 3
        if len(image) != expected_size:
            # Already encoded or unknown format; keep original bytes.
            return image

        try:
            from mss.tools import to_png
        except Exception:
            return image

        encoded = to_png(image, (width, height))
        if isinstance(encoded, bytes):
            return encoded
        return image
