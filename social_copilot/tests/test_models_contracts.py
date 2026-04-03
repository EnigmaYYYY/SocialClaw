from datetime import datetime, timezone

import pytest

from social_copilot.visual_monitor.models.config import MonitorConfig
from social_copilot.visual_monitor.models.events import FrameEvent, MessageEvent, ParsedMessage, QuotedMessage


def test_frame_event_contract_builds_with_required_fields() -> None:
    event = FrameEvent(
        frame_id="f1",
        ts_capture=datetime.now(tz=timezone.utc),
        roi_id="wechat_main",
        window_id="win1",
        session_id="sess1",
        dpi_scale=2.0,
        frame_hash="abc",
        image=b"raw",
    )
    assert event.roi_id == "wechat_main"
    assert event.image == b"raw"


def test_message_event_contract_contains_abcd_fields() -> None:
    msg = MessageEvent(
        event_id="m1",
        timestamp=datetime.now(tz=timezone.utc),
        session_id="sess1",
        session_key="微信::测试",
        window_id="win1",
        roi={"x": 1, "y": 2, "w": 3, "h": 4},
        frame_id="f1",
        sender="contact",
        text="hello",
        quoted_message=QuotedMessage(text="旧消息", sender_name="Alice"),
        box=[1, 2, 3, 4],
        extraction_confidence=0.8,
        extraction_engine="vlm_structured_litellm",
        frame_hash="hash",
        similarity_score=0.99,
        dedup_reason="new_line_detected",
        monitor_profile="adaptive_default",
    )
    payload = msg.model_dump()
    for key in [
        "sender",
        "text",
        "box",
        "extraction_confidence",
        "frame_hash",
        "similarity_score",
        "session_id",
        "session_key",
        "window_id",
        "roi",
    ]:
        assert key in payload
    assert payload["quoted_message"]["text"] == "旧消息"


def test_monitor_config_defaults_to_adaptive_strategy() -> None:
    cfg = MonitorConfig()
    assert cfg.monitor.mode == "adaptive"
    assert cfg.monitor.roi_strategy.mode == "hybrid"
    assert cfg.monitor.fps.idle == 1
    assert cfg.monitor.thresholds.hash_similarity_skip == pytest.approx(0.99)
    assert cfg.monitor.vision.mode == "vlm_structured"
    assert cfg.monitor.vision.strict_only is True
    assert cfg.monitor.vision.incremental.enabled is True
    assert isinstance(cfg.monitor.vision.litellm.enabled, bool)
    assert cfg.monitor.frame_cache.enabled is False
    assert cfg.monitor.frame_cache.testing_mode is False
    assert cfg.monitor.window_gate.enabled is False
    assert cfg.monitor.vlm_async.enabled is True
    assert cfg.monitor.privacy.debug_dump_dir.endswith("social_copilot_debug_frames")


def test_parsed_message_supports_unknown_sender() -> None:
    parsed = ParsedMessage(
        sender="unknown",
        text="maybe from who",
        box=[1, 1, 2, 2],
        confidence=0.51,
        source_frame="f1",
    )
    assert parsed.sender == "unknown"


def test_monitor_config_maps_legacy_window_gate_auto_roi_ratios() -> None:
    cfg = MonitorConfig.model_validate(
        {
            "monitor": {
                "window_gate": {
                    "auto_roi_from_window": True,
                    "roi_left_ratio": 0.25,
                    "roi_top_ratio": 0.15,
                    "roi_width_ratio": 0.70,
                    "roi_height_ratio": 0.72,
                }
            }
        }
    )
    assert cfg.monitor.roi_strategy.auto.coarse_left_ratio == pytest.approx(0.25)
    assert cfg.monitor.roi_strategy.auto.coarse_top_ratio == pytest.approx(0.15)
    assert cfg.monitor.roi_strategy.auto.coarse_width_ratio == pytest.approx(0.70)
    assert cfg.monitor.roi_strategy.auto.coarse_height_ratio == pytest.approx(0.72)
