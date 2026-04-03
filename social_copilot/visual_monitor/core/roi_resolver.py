from __future__ import annotations

from dataclasses import dataclass

from social_copilot.visual_monitor.models.config import AutoRoiConfig, RoiStrategyConfig


@dataclass(slots=True)
class RoiResolution:
    roi: dict[str, int]
    source: str
    confidence: float
    reason: str


class RoiResolver:
    def __init__(self, strategy: RoiStrategyConfig) -> None:
        self._strategy = strategy

    def resolve(
        self,
        manual_roi: dict[str, int],
        window_bounds: object | None,
    ) -> RoiResolution:
        mode = self._strategy.mode
        if mode == "manual":
            return self.resolve_manual_roi(manual_roi)
        if mode == "auto":
            auto = self.resolve_auto_roi(window_bounds)
            if auto is not None:
                return auto
            return RoiResolution(
                roi=dict(manual_roi),
                source="manual_fallback",
                confidence=0.0,
                reason="auto_unavailable",
            )
        return self.resolve_hybrid_roi(manual_roi=manual_roi, window_bounds=window_bounds)

    @staticmethod
    def resolve_manual_roi(manual_roi: dict[str, int]) -> RoiResolution:
        return RoiResolution(
            roi=dict(manual_roi),
            source="manual",
            confidence=1.0,
            reason="manual_mode",
        )

    def resolve_auto_roi(self, window_bounds: object | None) -> RoiResolution | None:
        auto_cfg = self._strategy.auto
        bounds = self._extract_bounds(window_bounds)
        if bounds is None:
            return None
        x, y, w, h = bounds
        if w <= 0 or h <= 0:
            return None
        coarse = {
            "x": x + int(w * auto_cfg.coarse_left_ratio),
            "y": y + int(h * auto_cfg.coarse_top_ratio),
            "w": int(w * auto_cfg.coarse_width_ratio),
            "h": int(h * auto_cfg.coarse_height_ratio),
        }
        sanitized = self._sanitize_roi(coarse, x, y, w, h, auto_cfg)
        if sanitized is None:
            return None
        confidence = self._score_auto_roi(sanitized, x, y, w, h, auto_cfg)
        if confidence < auto_cfg.confidence_threshold:
            return None
        return RoiResolution(
            roi=sanitized,
            source="auto",
            confidence=confidence,
            reason="auto_confident",
        )

    def resolve_hybrid_roi(
        self,
        manual_roi: dict[str, int],
        window_bounds: object | None,
    ) -> RoiResolution:
        auto = self.resolve_auto_roi(window_bounds=window_bounds)
        if auto is None:
            return RoiResolution(
                roi=dict(manual_roi),
                source="manual_fallback",
                confidence=0.0,
                reason="hybrid_auto_unavailable",
            )
        return auto

    @staticmethod
    def _extract_bounds(bounds: object | None) -> tuple[int, int, int, int] | None:
        if bounds is None:
            return None
        if isinstance(bounds, dict):
            return (
                int(bounds.get("x", 0)),
                int(bounds.get("y", 0)),
                int(bounds.get("w", 0)),
                int(bounds.get("h", 0)),
            )
        return (
            int(getattr(bounds, "x", 0)),
            int(getattr(bounds, "y", 0)),
            int(getattr(bounds, "w", 0)),
            int(getattr(bounds, "h", 0)),
        )

    @staticmethod
    def _sanitize_roi(
        roi: dict[str, int],
        window_x: int,
        window_y: int,
        window_w: int,
        window_h: int,
        cfg: AutoRoiConfig,
    ) -> dict[str, int] | None:
        x = max(roi["x"], window_x)
        y = max(roi["y"], window_y)
        right = min(roi["x"] + roi["w"], window_x + window_w)
        bottom = min(roi["y"] + roi["h"], window_y + window_h)
        w = right - x
        h = bottom - y
        if w < cfg.min_width or h < cfg.min_height:
            return None
        return {"x": x, "y": y, "w": w, "h": h}

    @staticmethod
    def _score_auto_roi(
        roi: dict[str, int],
        window_x: int,
        window_y: int,
        window_w: int,
        window_h: int,
        cfg: AutoRoiConfig,
    ) -> float:
        window_area = max(window_w * window_h, 1)
        area_ratio = (roi["w"] * roi["h"]) / window_area
        expected_area_ratio = cfg.coarse_width_ratio * cfg.coarse_height_ratio
        area_score = 1.0 - min(abs(area_ratio - expected_area_ratio), 0.5) / 0.5

        left_offset_ratio = (roi["x"] - window_x) / max(window_w, 1)
        # WeChat main chat area is typically in the mid-right side.
        if left_offset_ratio < 0.18:
            left_score = 0.3
        elif left_offset_ratio > 0.60:
            left_score = 0.4
        else:
            left_score = 1.0

        top_offset_ratio = (roi["y"] - window_y) / max(window_h, 1)
        top_score = 1.0 if 0.02 <= top_offset_ratio <= 0.30 else 0.6

        min_size_score = min(roi["w"] / max(cfg.min_width, 1), roi["h"] / max(cfg.min_height, 1))
        min_size_score = max(min(min_size_score, 1.0), 0.0)

        score = (0.40 * area_score) + (0.25 * left_score) + (0.20 * top_score) + (0.15 * min_size_score)
        return max(0.0, min(score, 1.0))
