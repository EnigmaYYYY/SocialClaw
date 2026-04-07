from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, model_validator


def _default_debug_dump_dir() -> str:
    return str(Path(tempfile.gettempdir()) / "social_copilot_debug_frames")


def _env_str(name: str, default: str) -> str:
    value = os.getenv(name, "").strip()
    return value or default


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name, "").strip().lower()
    if not value:
        return default
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    return default


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name, "").strip()
    if not value:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    value = os.getenv(name, "").strip()
    if not value:
        return default
    try:
        return float(value)
    except ValueError:
        return default


class FpsConfig(BaseModel):
    idle: int = 1
    active_min: int = 2
    active_max: int = 4
    burst: int = 5


class ThresholdConfig(BaseModel):
    hash_similarity_skip: float = 0.99
    ssim_change: float = 0.985
    message_confidence_low: float = 0.6


class VisionLiteLLMConfig(BaseModel):
    enabled: bool = Field(default_factory=lambda: _env_bool("SOCIAL_COPILOT_VLM_ENABLED", False))
    base_url: str = Field(
        default_factory=lambda: _env_str(
            "SOCIAL_COPILOT_VISION_BASE_URL",
            os.getenv("LLM_BASE_URL", "https://litellm.sii.sh.cn/v1"),
        )
    )
    model: str = Field(
        default_factory=lambda: _env_str(
            "SOCIAL_COPILOT_VISION_MODEL",
            "sii-Qwen3-VL-235B-A22B-Instruct",
        )
    )
    api_key: str = Field(
        default_factory=lambda: _env_str(
            "SOCIAL_COPILOT_VISION_API_KEY",
            os.getenv("SOCIAL_COPILOT_VLM_API_KEY", os.getenv("LLM_API_KEY", "")),
        )
    )
    api_key_env: str = "SOCIAL_COPILOT_VLM_API_KEY"
    timeout_ms: int = Field(default_factory=lambda: _env_int("SOCIAL_COPILOT_VLM_TIMEOUT_MS", 120000), ge=500)
    max_tokens: int = Field(default_factory=lambda: _env_int("SOCIAL_COPILOT_VLM_MAX_TOKENS", 2000), ge=32)
    temperature: float = Field(
        default_factory=lambda: _env_float("SOCIAL_COPILOT_VLM_TEMPERATURE", 0.0),
        ge=0.0,
        le=2.0,
    )
    disable_thinking: bool = Field(default_factory=lambda: _env_bool("SOCIAL_COPILOT_VLM_DISABLE_THINKING", True))


class VisionIncrementalConfig(BaseModel):
    enabled: bool = True
    window_frames: int = Field(default=8, ge=1, le=120)
    min_text_len: int = Field(default=2, ge=1)
    time_text_filter_enabled: bool = True


class VisionConfig(BaseModel):
    mode: Literal["vlm_structured"] = "vlm_structured"
    strict_only: bool = True
    structured_prompt: str = (
        "You are extracting chat messages from a screenshot. Return plain text only, one message per line."
    )
    incremental: VisionIncrementalConfig = Field(default_factory=VisionIncrementalConfig)
    litellm: VisionLiteLLMConfig = Field(default_factory=VisionLiteLLMConfig)

    @model_validator(mode="after")
    def normalize_mode_to_vlm_structured(self) -> "VisionConfig":
        self.mode = "vlm_structured"
        return self


class ROIConfig(BaseModel):
    x: int = 0
    y: int = 0
    w: int = 1280
    h: int = 720


class ExclusionRegionConfig(BaseModel):
    x: int = 0
    y: int = 0
    w: int = 0
    h: int = 0


class OutputConfig(BaseModel):
    sse_enabled: bool = True
    poll_enabled: bool = True


class PrivacyConfig(BaseModel):
    debug_dump_enabled: bool = False
    debug_dump_dir: str = Field(default_factory=_default_debug_dump_dir)
    debug_dump_ttl_hours: int = Field(default=24, ge=1)


class FrameCacheConfig(BaseModel):
    enabled: bool = False
    cache_dir: str = "test/images/live_cache"
    cache_all_frames: bool = False
    keep_processed_frames: bool = False
    deduplicate_kept_frames: bool = True
    dedup_similarity_threshold: float = Field(default=0.99, ge=0.0, le=1.0)
    max_kept_frames: int = Field(default=0, ge=0)
    testing_mode: bool = False

    @model_validator(mode="after")
    def apply_testing_mode_overrides(self) -> "FrameCacheConfig":
        if not self.testing_mode:
            return self
        self.enabled = True
        self.cache_all_frames = False
        self.keep_processed_frames = True
        self.max_kept_frames = 0
        return self


class PerformanceConfig(BaseModel):
    latency_p95_ms: int = 1200
    cpu_idle_max_percent: int = 8
    cpu_active_max_percent: int = 25


class WindowGateConfig(BaseModel):
    enabled: bool = False
    app_name: str = "WeChat"
    app_aliases: list[str] = Field(
        default_factory=lambda: ["WeChat", "\u5fae\u4fe1", "WeChatAppEx", "Weixin"]
    )
    foreground_settle_seconds: float = Field(default=0.0, ge=0.0, le=5.0)
    confirmation_samples: int = Field(default=1, ge=1, le=5)
    confirmation_interval_ms: int = Field(default=0, ge=0, le=500)
    auto_roi_from_window: bool = False
    roi_left_ratio: float = Field(default=0.27, ge=0.0, le=1.0)
    roi_top_ratio: float = Field(default=0.0, ge=0.0, le=1.0)
    roi_width_ratio: float = Field(default=0.71, ge=0.1, le=1.0)
    roi_height_ratio: float = Field(default=0.92, ge=0.1, le=1.0)


class VLMAsyncConfig(BaseModel):
    enabled: bool = True
    max_concurrency: int = Field(default=2, ge=1, le=8)
    max_queue: int = Field(default=32, ge=1, le=512)
    drop_when_queue_full: bool = False


class AssistantModelConfig(BaseModel):
    enabled: bool = Field(default_factory=lambda: _env_bool("SOCIAL_COPILOT_ASSISTANT_ENABLED", True))
    base_url: str = Field(
        default_factory=lambda: _env_str("SOCIAL_COPILOT_ASSISTANT_BASE_URL", os.getenv("LLM_BASE_URL", ""))
    )
    model: str = Field(default_factory=lambda: _env_str("SOCIAL_COPILOT_ASSISTANT_MODEL", ""))
    api_key: str = Field(
        default_factory=lambda: _env_str(
            "SOCIAL_COPILOT_ASSISTANT_API_KEY",
            os.getenv("SOCIAL_COPILOT_AGENT_API_KEY", os.getenv("LLM_API_KEY", "")),
        )
    )
    api_key_env: str = "SOCIAL_COPILOT_AGENT_API_KEY"
    timeout_ms: int = Field(default_factory=lambda: _env_int("SOCIAL_COPILOT_ASSISTANT_TIMEOUT_MS", 12000), ge=500)
    temperature: float = Field(
        default_factory=lambda: _env_float("SOCIAL_COPILOT_ASSISTANT_TEMPERATURE", 0.4),
        ge=0.0,
        le=2.0,
    )
    max_tokens: int = Field(
        default_factory=lambda: _env_int("SOCIAL_COPILOT_ASSISTANT_MAX_TOKENS", 800),
        ge=32,
    )
    suggestion_count: int = Field(
        default_factory=lambda: _env_int("SOCIAL_COPILOT_ASSISTANT_SUGGESTION_COUNT", 3),
        ge=1,
        le=6,
    )
    max_messages: int = Field(
        default_factory=lambda: _env_int("SOCIAL_COPILOT_ASSISTANT_MAX_MESSAGES", 24),
        ge=4,
        le=120,
    )


class AutoRoiConfig(BaseModel):
    coarse_left_ratio: float = Field(default=0.27, ge=0.0, le=1.0)
    coarse_top_ratio: float = Field(default=0.0, ge=0.0, le=1.0)
    coarse_width_ratio: float = Field(default=0.71, ge=0.1, le=1.0)
    coarse_height_ratio: float = Field(default=0.92, ge=0.1, le=1.0)
    min_width: int = Field(default=320, ge=64)
    min_height: int = Field(default=420, ge=64)
    confidence_threshold: float = Field(default=0.72, ge=0.0, le=1.0)


class RoiStrategyConfig(BaseModel):
    mode: Literal["manual", "auto", "hybrid"] = "hybrid"
    auto: AutoRoiConfig = Field(default_factory=AutoRoiConfig)


class MonitorSettings(BaseModel):
    mode: str = "adaptive"
    capture_scheme: Literal["legacy", "current"] = "legacy"
    capture_scope: Literal["roi", "full_window"] = "roi"
    roi: ROIConfig = Field(default_factory=ROIConfig)
    capture_exclusion_regions: list[ExclusionRegionConfig] = Field(default_factory=list)
    roi_strategy: RoiStrategyConfig = Field(default_factory=RoiStrategyConfig)
    fps: FpsConfig = Field(default_factory=FpsConfig)
    thresholds: ThresholdConfig = Field(default_factory=ThresholdConfig)
    vision: VisionConfig = Field(default_factory=VisionConfig)
    output: OutputConfig = Field(default_factory=OutputConfig)
    privacy: PrivacyConfig = Field(default_factory=PrivacyConfig)
    frame_cache: FrameCacheConfig = Field(default_factory=FrameCacheConfig)
    performance: PerformanceConfig = Field(default_factory=PerformanceConfig)
    window_gate: WindowGateConfig = Field(default_factory=WindowGateConfig)
    vlm_async: VLMAsyncConfig = Field(default_factory=VLMAsyncConfig)
    assistant: AssistantModelConfig = Field(default_factory=AssistantModelConfig)

    @model_validator(mode="before")
    @classmethod
    def migrate_legacy_ocr_settings(cls, data: object) -> object:
        if not isinstance(data, dict):
            return data
        payload = dict(data)
        legacy_ocr = payload.pop("ocr", None)
        payload.pop("noise_filter", None)
        if legacy_ocr is not None and "vision" not in payload:
            if isinstance(legacy_ocr, dict):
                migrated = dict(legacy_ocr)
                strict_only = migrated.pop("vlm_strict_only", None)
                if strict_only is not None:
                    migrated["strict_only"] = strict_only
                structured_prompt = migrated.pop("vision_prompt", None)
                if structured_prompt is not None:
                    migrated["structured_prompt"] = structured_prompt
                incremental = migrated.pop("incremental_filter", None)
                if incremental is not None:
                    migrated["incremental"] = incremental
                litellm = migrated.pop("litellm_vlm", None)
                if litellm is not None:
                    migrated["litellm"] = litellm
                migrated.pop("primary", None)
                migrated.pop("fallback", None)
                migrated.pop("enable_vision_fallback", None)
                migrated.pop("novelty_filter", None)
                migrated.pop("ollama", None)
                migrated.pop("api", None)
                payload["vision"] = migrated
            else:
                payload["vision"] = legacy_ocr
        return payload

    @model_validator(mode="after")
    def apply_legacy_window_gate_auto_roi(self) -> "MonitorSettings":
        defaults = AutoRoiConfig()
        auto_cfg = self.roi_strategy.auto
        using_auto_defaults = (
            auto_cfg.coarse_left_ratio == defaults.coarse_left_ratio
            and auto_cfg.coarse_top_ratio == defaults.coarse_top_ratio
            and auto_cfg.coarse_width_ratio == defaults.coarse_width_ratio
            and auto_cfg.coarse_height_ratio == defaults.coarse_height_ratio
        )
        if self.window_gate.auto_roi_from_window and using_auto_defaults:
            auto_cfg.coarse_left_ratio = self.window_gate.roi_left_ratio
            auto_cfg.coarse_top_ratio = self.window_gate.roi_top_ratio
            auto_cfg.coarse_width_ratio = self.window_gate.roi_width_ratio
            auto_cfg.coarse_height_ratio = self.window_gate.roi_height_ratio
        return self


class MonitorConfig(BaseModel):
    monitor: MonitorSettings = Field(default_factory=MonitorSettings)
