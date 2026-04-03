from datetime import datetime, timezone

from social_copilot.visual_monitor.core.output_gateway import OutputGateway
from social_copilot.visual_monitor.core.preprocess import FramePreprocessor
from social_copilot.visual_monitor.models.events import MessageEvent
from social_copilot.visual_monitor.observability.metrics import MonitorMetrics
from social_copilot.visual_monitor.service import EventBus


def test_preprocessor_normalizes_roi_bounds() -> None:
    preprocessor = FramePreprocessor()
    roi = preprocessor.normalize_roi(
        screen={"x": 0, "y": 0, "w": 100, "h": 100},
        roi={"x": -10, "y": 20, "w": 200, "h": 200},
    )
    assert roi == {"x": 0, "y": 20, "w": 100, "h": 80}


def test_preprocessor_computes_center_x() -> None:
    preprocessor = FramePreprocessor()
    center_x = preprocessor.center_x({"x": 100, "y": 0, "w": 300, "h": 200})
    assert center_x == 250


def test_preprocessor_encodes_rgb_bytes_to_png() -> None:
    preprocessor = FramePreprocessor()
    # 2x1 RGB pixels: red and green.
    raw = bytes([255, 0, 0, 0, 255, 0])
    encoded = preprocessor.rgb_bytes_to_png(raw, width=2, height=1)
    assert encoded.startswith(b"\x89PNG\r\n\x1a\n")


def test_output_gateway_publishes_events_to_bus() -> None:
    metrics = MonitorMetrics()
    bus = EventBus(metrics=metrics)
    gateway = OutputGateway(bus)

    event = MessageEvent(
        event_id="m1",
        timestamp=datetime.now(tz=timezone.utc),
        session_id="sess1",
        session_key="微信::测试",
        window_id="win1",
        roi={"x": 0, "y": 0, "w": 10, "h": 10},
        frame_id="f1",
        sender="contact",
        text="hello",
        box=[0, 0, 10, 10],
        extraction_confidence=0.9,
        extraction_engine="vlm_structured_litellm",
        frame_hash="hash",
        similarity_score=0.9,
        dedup_reason="new_line_detected",
        monitor_profile="adaptive_default",
    )

    gateway.push([event])
    polled = bus.poll(limit=10)
    assert len(polled) == 1
    assert polled[0].text == "hello"
