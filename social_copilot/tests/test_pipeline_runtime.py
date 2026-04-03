from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from time import sleep
from uuid import uuid4

import pytest

from social_copilot.visual_monitor.core.assembler import StreamAssembler
from social_copilot.visual_monitor.core.change_detector import ChangeDetector
from social_copilot.visual_monitor.core.output_gateway import OutputGateway
from social_copilot.visual_monitor.core.pipeline import VisualMonitorPipeline
from social_copilot.visual_monitor.core.preprocess import FramePreprocessor
from social_copilot.visual_monitor.core.scheduler import CaptureScheduler
from social_copilot.visual_monitor.models.config import ExclusionRegionConfig, MonitorConfig
from social_copilot.visual_monitor.models.events import FrameEvent
from social_copilot.visual_monitor.models.vlm_structured import VLMStructuredMessage
from social_copilot.visual_monitor.observability.metrics import MonitorMetrics
from social_copilot.visual_monitor.security.debug_storage import DebugFrameStorage
from social_copilot.visual_monitor.service import EventBus


class _FakeCapture:
    def __init__(self, frames: list[bytes], width: int = 200, height: int = 100) -> None:
        self.frames = frames
        self.width = width
        self.height = height
        self.calls = 0
        self.last_roi: dict[str, int] | None = None

    def capture(self, roi: dict[str, int]):
        self.last_roi = dict(roi)
        frame = self.frames[min(self.calls, len(self.frames) - 1)]
        self.calls += 1

        class _Result:
            raw = frame
            width = self.width
            height = self.height

        return _Result()


class _FakeOCR:
    def __init__(self, tokens: list[object]) -> None:
        self.tokens = tokens
        self.calls = 0

    def extract(self, image: bytes):
        _ = image
        self.calls += 1
        return self.tokens, "rapidocr", False


class _FakeWindowProbe:
    def __init__(
        self,
        app_name: str | None,
        bounds=None,
        title: str | None = None,
        app_names: list[str] | None = None,
        titles: list[str | None] | None = None,
    ) -> None:
        self._app_name = app_name
        self._bounds = bounds
        self._title = title
        self._app_names = app_names or []
        self._titles = titles or []
        self._app_name_idx = 0
        self._title_idx = 0
        self.app_queries = 0
        self.bounds_queries = 0
        self.title_queries = 0

    def frontmost_app_name(self) -> str | None:
        self.app_queries += 1
        if self._app_names:
            value = self._app_names[min(self._app_name_idx, len(self._app_names) - 1)]
            self._app_name_idx += 1
            return value
        return self._app_name

    def frontmost_window_bounds(self, app_name: str):
        _ = app_name
        self.bounds_queries += 1
        return self._bounds

    def frontmost_window_title(self, app_name: str) -> str | None:
        _ = app_name
        self.title_queries += 1
        if self._titles:
            value = self._titles[min(self._title_idx, len(self._titles) - 1)]
            self._title_idx += 1
            return value
        return self._title


class _FakeVLMResult:
    def __init__(
        self,
        messages: list[VLMStructuredMessage],
        conversation_title: str | None = None,
        parse_ok: bool = True,
        roundtrip_ms: float = 5.0,
    ) -> None:
        self.messages = messages
        self.raw_content = "{}"
        self.parse_ok = parse_ok
        self.roundtrip_ms = roundtrip_ms
        self.litellm_duration_ms = None
        self.provider_duration_ms = None
        self.conversation_title = conversation_title
        self.error = None


class _FakeVLMStructured:
    def __init__(self, delays: list[float], titles: list[str | None] | None = None) -> None:
        self.delays = delays
        self.titles = titles or []
        self._index = 0
        self._lock = Lock()
        self.full_calls = 0
        self.incremental_calls: list[tuple[bytes, bytes]] = []
        self.title_hints: list[str | None] = []

    def extract_structured(self, image_png: bytes, expected_conversation_title: str | None = None) -> _FakeVLMResult:
        _ = image_png
        self.full_calls += 1
        self.title_hints.append(expected_conversation_title)
        return self._next_result()

    def extract_structured_incremental(
        self,
        older_image_png: bytes,
        newer_image_png: bytes,
        expected_conversation_title: str | None = None,
    ) -> _FakeVLMResult:
        self.incremental_calls.append((older_image_png, newer_image_png))
        _ = newer_image_png
        self.title_hints.append(expected_conversation_title)
        return self._next_result()

    def _next_result(self) -> _FakeVLMResult:
        with self._lock:
            idx = self._index
            self._index += 1
        delay = self.delays[min(idx, len(self.delays) - 1)] if self.delays else 0.0
        if delay > 0:
            sleep(delay)
        title = self.titles[min(idx, len(self.titles) - 1)] if self.titles else None
        return _FakeVLMResult(
            messages=[
                VLMStructuredMessage(
                    sender="contact",
                    text=f"msg_{idx}",
                    content_type="text",
                    non_text_description=None,
                    confidence=0.9,
                )
            ],
            conversation_title=title,
            parse_ok=True,
            roundtrip_ms=delay * 1000.0,
        )


class _FakeVLMStructuredEmpty:
    def extract_structured(self, image_png: bytes, expected_conversation_title: str | None = None) -> _FakeVLMResult:
        _ = image_png
        _ = expected_conversation_title
        result = _FakeVLMResult(messages=[], parse_ok=False, roundtrip_ms=5.0)
        result.error = "parse_failed"
        return result

    def extract_structured_incremental(
        self,
        older_image_png: bytes,
        newer_image_png: bytes,
        expected_conversation_title: str | None = None,
    ) -> _FakeVLMResult:
        _ = older_image_png
        _ = expected_conversation_title
        return self.extract_structured(newer_image_png)


class _FakeVLMStructuredWithMessages:
    def __init__(self, messages: list[VLMStructuredMessage], conversation_title: str | None = None) -> None:
        self._messages = messages
        self._conversation_title = conversation_title

    def extract_structured(self, image_png: bytes, expected_conversation_title: str | None = None) -> _FakeVLMResult:
        _ = image_png
        _ = expected_conversation_title
        return _FakeVLMResult(
            messages=self._messages,
            conversation_title=self._conversation_title,
            parse_ok=True,
            roundtrip_ms=5.0,
        )

    def extract_structured_incremental(
        self,
        older_image_png: bytes,
        newer_image_png: bytes,
        expected_conversation_title: str | None = None,
    ) -> _FakeVLMResult:
        _ = older_image_png
        return self.extract_structured(newer_image_png, expected_conversation_title)


class _FakeVLMStructuredIncrementalFallback:
    def __init__(self) -> None:
        self.full_calls = 0
        self.incremental_calls: list[tuple[bytes, bytes]] = []
        self.title_hints: list[str | None] = []

    def extract_structured(self, image_png: bytes, expected_conversation_title: str | None = None) -> _FakeVLMResult:
        _ = image_png
        self.title_hints.append(expected_conversation_title)
        idx = self.full_calls
        self.full_calls += 1
        return _FakeVLMResult(
            messages=[
                VLMStructuredMessage(
                    sender="contact",
                    text=f"snapshot_{idx}",
                    content_type="text",
                    non_text_description=None,
                    confidence=0.9,
                )
            ],
            conversation_title="会话A",
            parse_ok=True,
            roundtrip_ms=5.0,
        )

    def extract_structured_incremental(
        self,
        older_image_png: bytes,
        newer_image_png: bytes,
        expected_conversation_title: str | None = None,
    ) -> _FakeVLMResult:
        _ = expected_conversation_title
        self.incremental_calls.append((older_image_png, newer_image_png))
        result = _FakeVLMResult(messages=[], conversation_title="会话A", parse_ok=False, roundtrip_ms=5.0)
        result.error = "parse_failed"
        return result


def _make_rgb_frame(
    header_seed: int,
    body_seed: int,
    width: int = 40,
    height: int = 20,
) -> bytes:
    pixels = bytearray()
    for y in range(height):
        for x in range(width):
            if y < max(2, height // 10):
                value = (header_seed + x * 3 + y * 5) % 256
                pixels.extend([value, value, value])
            else:
                value = (body_seed + x * 7 + y * 11) % 256
                pixels.extend([value, value, value])
    return bytes(pixels)


def _assert_public_frame_id(value: str, seq: int) -> None:
    assert value.startswith(f"f_{seq:06d}_")
    assert value.endswith("Z")


def _make_event_bus(metrics: MonitorMetrics) -> EventBus:
    return EventBus(metrics=metrics, db_path=Path("/tmp") / f"socialclaw-eventbus-test-{uuid4().hex}.db")


@pytest.mark.asyncio
async def test_pipeline_run_once_emits_events_when_frame_changes() -> None:
    cfg = MonitorConfig()
    cfg.monitor.roi.x = 0
    cfg.monitor.roi.y = 0
    cfg.monitor.roi.w = 100
    cfg.monitor.roi.h = 60
    cfg.monitor.vlm_async.enabled = False

    metrics = MonitorMetrics()
    bus = _make_event_bus(metrics)
    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([b"frame_a"]),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(bus),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        vlm_structured_adapter=_FakeVLMStructured(delays=[]),
    )

    result = await pipeline.run_once()

    assert result.events_emitted == 1
    events = bus.poll(limit=10)
    assert len(events) == 1
    assert events[0].text == "msg_0"


@pytest.mark.asyncio
async def test_pipeline_uses_manual_roi_when_capture_scope_is_roi() -> None:
    cfg = MonitorConfig()
    cfg.monitor.capture_scope = "roi"
    cfg.monitor.roi_strategy.mode = "manual"
    cfg.monitor.roi.x = 12
    cfg.monitor.roi.y = 34
    cfg.monitor.roi.w = 222
    cfg.monitor.roi.h = 111
    cfg.monitor.vlm_async.enabled = False

    metrics = MonitorMetrics()
    capture = _FakeCapture([b"frame_a"])
    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=capture,
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(_make_event_bus(metrics)),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=_FakeWindowProbe(app_name="WeChat", bounds={"x": 1, "y": 2, "w": 800, "h": 600}),
        vlm_structured_adapter=_FakeVLMStructured(delays=[]),
    )

    await pipeline.run_once()

    assert capture.last_roi == {"x": 12, "y": 34, "w": 222, "h": 111}


@pytest.mark.asyncio
async def test_pipeline_uses_full_window_bounds_when_capture_scope_is_full_window() -> None:
    cfg = MonitorConfig()
    cfg.monitor.capture_scope = "full_window"
    cfg.monitor.roi.x = 12
    cfg.monitor.roi.y = 34
    cfg.monitor.roi.w = 222
    cfg.monitor.roi.h = 111
    cfg.monitor.vlm_async.enabled = False

    metrics = MonitorMetrics()
    capture = _FakeCapture([b"frame_a"])
    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=capture,
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(_make_event_bus(metrics)),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=_FakeWindowProbe(app_name="WeChat", bounds={"x": 5, "y": 6, "w": 700, "h": 500}),
        vlm_structured_adapter=_FakeVLMStructured(delays=[]),
    )

    await pipeline.run_once()

    assert capture.last_roi == {"x": 5, "y": 6, "w": 700, "h": 500}


@pytest.mark.asyncio
async def test_pipeline_skips_vlm_on_unchanged_frame() -> None:
    cfg = MonitorConfig()
    cfg.monitor.vlm_async.enabled = False
    metrics = MonitorMetrics()
    fake_vlm = _FakeVLMStructured(delays=[])

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([b"same", b"same"]),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(_make_event_bus(metrics)),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        vlm_structured_adapter=fake_vlm,
    )

    await pipeline.run_once()
    await pipeline.run_once()

    assert fake_vlm.full_calls == 1
    assert fake_vlm.incremental_calls == []


@pytest.mark.asyncio
async def test_pipeline_vlm_emits_incremental_events_across_changed_frames() -> None:
    cfg = MonitorConfig()
    cfg.monitor.vlm_async.enabled = False
    metrics = MonitorMetrics()
    bus = _make_event_bus(metrics)
    fake_vlm = _FakeVLMStructured(delays=[])

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([b"frame_a", b"frame_b"]),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(bus),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=_FakeWindowProbe(app_name="WeChat", title="会话A"),
        vlm_structured_adapter=fake_vlm,
    )

    first = await pipeline.run_once()
    second = await pipeline.run_once()
    events = bus.poll(limit=10)

    assert first.events_emitted == 1
    assert second.events_emitted == 1
    assert len(events) == 2
    assert events[0].text == "msg_0"
    assert events[1].text == "msg_1"
    _assert_public_frame_id(events[0].frame_id, 1)
    _assert_public_frame_id(events[1].frame_id, 2)
    assert events[0].event_id.startswith(f"m_{events[0].frame_id}_")
    assert events[1].event_id.startswith(f"m_{events[1].frame_id}_")
    assert fake_vlm.full_calls == 1
    assert len(fake_vlm.incremental_calls) == 1


@pytest.mark.asyncio
async def test_pipeline_legacy_scheme_prefers_recall_for_near_duplicate_frames() -> None:
    cfg = MonitorConfig()
    cfg.monitor.capture_scheme = "legacy"
    cfg.monitor.vlm_async.enabled = False
    metrics = MonitorMetrics()
    bus = _make_event_bus(metrics)
    fake_vlm = _FakeVLMStructured(delays=[])
    near_a = bytes([0]) * 300
    near_b = bytes([0]) * 299 + bytes([1])

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([near_a, near_b]),
        change_detector=ChangeDetector(skip_near_duplicate_frames=False),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(bus),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=_FakeWindowProbe(app_name="WeChat", title="会话A"),
        vlm_structured_adapter=fake_vlm,
    )

    first = await pipeline.run_once()
    second = await pipeline.run_once()
    events = bus.poll(limit=10)

    assert first.events_emitted == 1
    assert second.events_emitted == 1
    assert [event.text for event in events] == ["msg_0", "msg_1"]
    assert pipeline.get_debug_state()["last_decision_reason"] == "sync_path"


@pytest.mark.asyncio
async def test_pipeline_falls_back_to_snapshot_when_incremental_vlm_returns_empty_or_invalid() -> None:
    cfg = MonitorConfig()
    cfg.monitor.vision.mode = "vlm_structured"
    cfg.monitor.vlm_async.enabled = False
    metrics = MonitorMetrics()
    bus = _make_event_bus(metrics)
    fake_vlm = _FakeVLMStructuredIncrementalFallback()

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([b"frame_a", b"frame_b"]),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(bus),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=_FakeWindowProbe(app_name="WeChat", title="会话A"),
        vlm_structured_adapter=fake_vlm,
    )

    first = await pipeline.run_once()
    second = await pipeline.run_once()
    events = bus.poll(limit=10)

    assert first.events_emitted == 1
    assert second.events_emitted == 1
    assert [event.text for event in events] == ["snapshot_0", "snapshot_1"]
    assert fake_vlm.full_calls == 2
    assert len(fake_vlm.incremental_calls) == 1
    assert pipeline.get_debug_state()["last_vlm_incremental_fallback_reason"] == "parse_failed"


@pytest.mark.asyncio
async def test_pipeline_skips_capture_when_window_gate_mismatch() -> None:
    cfg = MonitorConfig()
    cfg.monitor.window_gate.enabled = True
    cfg.monitor.window_gate.app_name = "WeChat"
    metrics = MonitorMetrics()
    capture = _FakeCapture([b"frame_a"])
    probe = _FakeWindowProbe(app_name="Visual Studio Code")

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=capture,
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([object()]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(_make_event_bus(metrics)),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=probe,
    )

    result = await pipeline.run_once()

    assert result.events_emitted == 0
    assert capture.calls == 0
    assert probe.app_queries == 1


@pytest.mark.asyncio
async def test_pipeline_enforces_foreground_gate_even_when_window_gate_disabled() -> None:
    cfg = MonitorConfig()
    cfg.monitor.window_gate.enabled = False
    cfg.monitor.window_gate.app_name = "WeChat"
    metrics = MonitorMetrics()
    capture = _FakeCapture([b"frame_a"])
    probe = _FakeWindowProbe(app_name="Visual Studio Code")

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=capture,
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([object()]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(_make_event_bus(metrics)),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=probe,
    )

    result = await pipeline.run_once()

    assert result.events_emitted == 0
    assert capture.calls == 0
    assert probe.app_queries == 1


@pytest.mark.asyncio
async def test_pipeline_captures_full_frontmost_window_when_bounds_available() -> None:
    cfg = MonitorConfig()
    cfg.monitor.capture_scope = "full_window"
    cfg.monitor.vision.mode = "vlm_structured"
    cfg.monitor.vlm_async.enabled = False
    cfg.monitor.window_gate.enabled = True
    cfg.monitor.window_gate.app_name = "WeChat"
    metrics = MonitorMetrics()
    capture = _FakeCapture([b"frame_auto"])
    probe = _FakeWindowProbe(app_name="WeChat", bounds={"x": 100, "y": 200, "w": 1000, "h": 700})

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=capture,
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([object()]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(_make_event_bus(metrics)),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=probe,
    )

    await pipeline.run_once()

    assert capture.last_roi == {"x": 100, "y": 200, "w": 1000, "h": 700}


@pytest.mark.asyncio
async def test_pipeline_falls_back_to_configured_capture_region_without_window_bounds() -> None:
    cfg = MonitorConfig()
    cfg.monitor.vision.mode = "vlm_structured"
    cfg.monitor.vlm_async.enabled = False
    cfg.monitor.roi.x = 12
    cfg.monitor.roi.y = 34
    cfg.monitor.roi.w = 456
    cfg.monitor.roi.h = 567
    cfg.monitor.window_gate.enabled = True
    cfg.monitor.window_gate.app_name = "WeChat"
    metrics = MonitorMetrics()
    capture = _FakeCapture([b"frame_manual"])
    probe = _FakeWindowProbe(app_name="WeChat", bounds=None)

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=capture,
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([object()]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(_make_event_bus(metrics)),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=probe,
    )

    await pipeline.run_once()

    assert capture.last_roi == {"x": 12, "y": 34, "w": 456, "h": 567}


@pytest.mark.asyncio
async def test_pipeline_window_gate_settle_delays_capture() -> None:
    cfg = MonitorConfig()
    cfg.monitor.window_gate.enabled = True
    cfg.monitor.window_gate.app_name = "WeChat"
    cfg.monitor.window_gate.foreground_settle_seconds = 0.5
    metrics = MonitorMetrics()
    capture = _FakeCapture([b"frame_settle"])
    probe = _FakeWindowProbe(app_name="WeChat")

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=capture,
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([object()]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(_make_event_bus(metrics)),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=probe,
    )

    first = await pipeline.run_once()
    second = await pipeline.run_once()
    assert first.events_emitted == 0
    assert second.events_emitted == 0
    assert capture.calls == 0

    await asyncio.sleep(0.55)
    third = await pipeline.run_once()
    assert third.changed is True
    assert capture.calls == 1


@pytest.mark.asyncio
async def test_pipeline_rechecks_frontmost_app_before_capture_to_avoid_race_switch() -> None:
    cfg = MonitorConfig()
    cfg.monitor.window_gate.enabled = True
    cfg.monitor.window_gate.app_name = "WeChat"
    metrics = MonitorMetrics()
    capture = _FakeCapture([b"frame_race"])
    probe = _FakeWindowProbe(app_name=None, app_names=["WeChat", "Visual Studio Code"])

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=capture,
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([object()]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(_make_event_bus(metrics)),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=probe,
    )

    result = await pipeline.run_once()
    assert result.changed is False
    assert result.events_emitted == 0
    assert capture.calls == 0
    assert probe.app_queries == 2


@pytest.mark.asyncio
async def test_pipeline_requires_multiple_pre_capture_app_confirmations_when_configured() -> None:
    cfg = MonitorConfig()
    cfg.monitor.window_gate.enabled = True
    cfg.monitor.window_gate.app_name = "WeChat"
    cfg.monitor.window_gate.confirmation_samples = 3
    cfg.monitor.window_gate.confirmation_interval_ms = 0
    metrics = MonitorMetrics()
    capture = _FakeCapture([b"frame_multicheck"])
    probe = _FakeWindowProbe(app_name=None, app_names=["WeChat", "WeChat", "WeChat", "Visual Studio Code"])

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=capture,
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([object()]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(_make_event_bus(metrics)),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=probe,
    )

    result = await pipeline.run_once()
    assert result.changed is False
    assert result.events_emitted == 0
    assert capture.calls == 0
    # 1 initial gate check + 3 confirmation checks
    assert probe.app_queries == 4


@pytest.mark.asyncio
async def test_pipeline_drops_frame_when_postcapture_app_check_fails() -> None:
    cfg = MonitorConfig()
    cfg.monitor.window_gate.enabled = True
    cfg.monitor.window_gate.app_name = "WeChat"
    metrics = MonitorMetrics()
    capture = _FakeCapture([b"frame_postcapture_race"])
    probe = _FakeWindowProbe(app_name=None, app_names=["WeChat", "WeChat", "Visual Studio Code"])

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=capture,
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([object()]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(_make_event_bus(metrics)),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=probe,
    )

    result = await pipeline.run_once()
    assert result.changed is False
    assert result.events_emitted == 0
    assert capture.calls == 1
    assert probe.app_queries == 3


@pytest.mark.asyncio
async def test_pipeline_clears_frame_cache_after_processing_when_keep_disabled(tmp_path: Path) -> None:
    cfg = MonitorConfig()
    cfg.monitor.frame_cache.enabled = True
    cfg.monitor.frame_cache.cache_all_frames = True
    cfg.monitor.frame_cache.keep_processed_frames = False
    cfg.monitor.frame_cache.cache_dir = str(tmp_path / "cache")
    cfg.monitor.vlm_async.enabled = False
    metrics = MonitorMetrics()

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([b"same", b"same"]),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([object()]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(_make_event_bus(metrics)),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
    )

    await pipeline.run_once()
    await pipeline.run_once()

    cache_dir = Path(cfg.monitor.frame_cache.cache_dir)
    assert cache_dir.exists()
    assert [path for path in cache_dir.rglob("*") if path.is_file() and path.suffix != ".log"] == []


@pytest.mark.asyncio
async def test_pipeline_keeps_frame_cache_after_processing_when_keep_enabled(tmp_path: Path) -> None:
    cfg = MonitorConfig()
    cfg.monitor.frame_cache.enabled = True
    cfg.monitor.frame_cache.cache_all_frames = True
    cfg.monitor.frame_cache.keep_processed_frames = True
    cfg.monitor.frame_cache.cache_dir = str(tmp_path / "cache")
    cfg.monitor.vlm_async.enabled = False
    metrics = MonitorMetrics()

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([b"frame_a"]),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([object()]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(_make_event_bus(metrics)),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
    )

    await pipeline.run_once()

    cache_dir = Path(cfg.monitor.frame_cache.cache_dir)
    cached_files = sorted(path.suffix for path in cache_dir.rglob("*") if path.is_file() and path.suffix != ".log")
    assert cached_files == [".png", ".rgb"]


@pytest.mark.asyncio
async def test_pipeline_testing_mode_keeps_only_effective_png_artifacts(tmp_path: Path) -> None:
    cfg = MonitorConfig()
    cfg.monitor.frame_cache.enabled = True
    cfg.monitor.frame_cache.cache_all_frames = False
    cfg.monitor.frame_cache.keep_processed_frames = False
    cfg.monitor.frame_cache.testing_mode = True
    cfg.monitor.frame_cache.cache_dir = str(tmp_path / "cache")
    cfg.monitor.vlm_async.enabled = False
    metrics = MonitorMetrics()

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([b"frame_a"]),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([object()]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(_make_event_bus(metrics)),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
    )

    await pipeline.run_once()

    cache_dir = Path(cfg.monitor.frame_cache.cache_dir)
    cached_files = sorted(path.suffix for path in cache_dir.rglob("*") if path.is_file() and path.suffix != ".log")
    assert cached_files == [".png"]


@pytest.mark.asyncio
async def test_pipeline_masks_capture_exclusion_region_before_change_detection() -> None:
    cfg = MonitorConfig()
    cfg.monitor.roi.x = 100
    cfg.monitor.roi.y = 200
    cfg.monitor.roi.w = 4
    cfg.monitor.roi.h = 2
    cfg.monitor.vlm_async.enabled = False
    cfg.monitor.capture_exclusion_regions = [
        ExclusionRegionConfig(x=101, y=200, w=1, h=1)
    ]
    metrics = MonitorMetrics()
    fake_vlm = _FakeVLMStructured(delays=[])
    # Two frames differ only in one pixel inside exclusion region.
    first = bytes([0] * 24)
    second = bytearray(first)
    second[3:6] = bytes([255, 255, 255])  # pixel (x=1, y=0) in local frame

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([first, bytes(second)], width=4, height=2),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(_make_event_bus(metrics)),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        vlm_structured_adapter=fake_vlm,
    )

    await pipeline.run_once()
    await pipeline.run_once()

    assert fake_vlm.full_calls == 1


@pytest.mark.asyncio
async def test_pipeline_testing_mode_skips_capture_exclusion_masking() -> None:
    cfg = MonitorConfig()
    cfg.monitor.roi.x = 100
    cfg.monitor.roi.y = 200
    cfg.monitor.roi.w = 4
    cfg.monitor.roi.h = 2
    cfg.monitor.vlm_async.enabled = False
    cfg.monitor.frame_cache.testing_mode = True
    cfg.monitor.capture_exclusion_regions = [
        ExclusionRegionConfig(x=101, y=200, w=1, h=1)
    ]
    metrics = MonitorMetrics()
    fake_vlm = _FakeVLMStructured(delays=[])
    first = bytes([0] * 24)
    second = bytearray(first)
    second[3:6] = bytes([255, 255, 255])  # pixel (x=1, y=0) in local frame

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([first, bytes(second)], width=4, height=2),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(_make_event_bus(metrics)),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        vlm_structured_adapter=fake_vlm,
    )

    await pipeline.run_once()
    second_result = await pipeline.run_once()
    debug_state = pipeline.get_debug_state()

    assert second_result.changed is True
    assert fake_vlm.full_calls == 2
    assert len(fake_vlm.incremental_calls) == 0
    assert debug_state["last_exclusion_regions_applied"] == 0


@pytest.mark.asyncio
async def test_pipeline_exposes_last_vlm_error_in_debug_state() -> None:
    cfg = MonitorConfig()
    cfg.monitor.vlm_async.enabled = False
    metrics = MonitorMetrics()

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([b"frame_a"]),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(_make_event_bus(metrics)),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        vlm_structured_adapter=_FakeVLMStructuredEmpty(),
    )

    await pipeline.run_once()
    debug_state = pipeline.get_debug_state()

    assert debug_state["last_error"] == "parse_failed"
    assert debug_state["last_vlm_parse_ok"] is False
    assert debug_state["last_vlm_roundtrip_ms"] == pytest.approx(5.0)


@pytest.mark.asyncio
async def test_pipeline_async_vlm_commits_events_in_frame_order() -> None:
    cfg = MonitorConfig()
    cfg.monitor.vision.mode = "vlm_structured"
    cfg.monitor.vlm_async.enabled = True
    cfg.monitor.vlm_async.max_concurrency = 2
    cfg.monitor.vlm_async.max_queue = 8

    metrics = MonitorMetrics()
    bus = _make_event_bus(metrics)
    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([b"a", b"b", b"b"]),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(bus),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=_FakeWindowProbe(app_name="WeChat", title="会话A"),
        vlm_structured_adapter=_FakeVLMStructured(delays=[0.08, 0.01]),
    )

    await pipeline.run_once()  # enqueue f1
    await pipeline.run_once()  # enqueue f2 (may finish first)
    await asyncio.sleep(0.12)
    result = await pipeline.run_once()  # drain in-order

    assert result.events_emitted >= 2
    events = bus.poll(limit=10)
    assert len(events) >= 2
    _assert_public_frame_id(events[0].frame_id, 1)
    _assert_public_frame_id(events[1].frame_id, 2)
    await pipeline.shutdown()


@pytest.mark.asyncio
async def test_pipeline_vlm_uses_single_then_incremental_images() -> None:
    cfg = MonitorConfig()
    cfg.monitor.vision.mode = "vlm_structured"
    cfg.monitor.vlm_async.enabled = False
    metrics = MonitorMetrics()
    bus = _make_event_bus(metrics)
    fake_vlm = _FakeVLMStructured(delays=[])

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([b"a", b"b", b"c"]),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(bus),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=_FakeWindowProbe(app_name="WeChat", title="会话A"),
        vlm_structured_adapter=fake_vlm,
    )

    await pipeline.run_once()
    await pipeline.run_once()
    await pipeline.run_once()

    assert fake_vlm.full_calls == 1
    assert len(fake_vlm.incremental_calls) == 2
    assert fake_vlm.incremental_calls[0] == (b"a", b"b")
    assert fake_vlm.incremental_calls[1] == (b"b", b"c")


@pytest.mark.asyncio
async def test_pipeline_header_fingerprint_allows_incremental_with_generic_window_title() -> None:
    cfg = MonitorConfig()
    cfg.monitor.vision.mode = "vlm_structured"
    cfg.monitor.vlm_async.enabled = False
    metrics = MonitorMetrics()
    fake_vlm = _FakeVLMStructured(delays=[], titles=["A群", "A群", "A群"])
    frames = [
        _make_rgb_frame(header_seed=30, body_seed=100),
        _make_rgb_frame(header_seed=30, body_seed=140),
        _make_rgb_frame(header_seed=30, body_seed=180),
    ]

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture(frames, width=40, height=20),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(_make_event_bus(metrics)),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=_FakeWindowProbe(app_name="WeChat", title="微信"),
        vlm_structured_adapter=fake_vlm,
    )

    await pipeline.run_once()
    await pipeline.run_once()
    await pipeline.run_once()

    assert fake_vlm.full_calls == 1
    assert len(fake_vlm.incremental_calls) == 2
    assert fake_vlm.title_hints == [None, "A群", "A群"]


@pytest.mark.asyncio
async def test_pipeline_header_fingerprint_forces_snapshot_when_header_changes() -> None:
    cfg = MonitorConfig()
    cfg.monitor.vision.mode = "vlm_structured"
    cfg.monitor.vlm_async.enabled = False
    metrics = MonitorMetrics()
    fake_vlm = _FakeVLMStructured(delays=[], titles=["A群", "B群"])
    frames = [
        _make_rgb_frame(header_seed=30, body_seed=100),
        _make_rgb_frame(header_seed=200, body_seed=140),
    ]

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture(frames, width=40, height=20),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(_make_event_bus(metrics)),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=_FakeWindowProbe(app_name="WeChat", title="微信"),
        vlm_structured_adapter=fake_vlm,
    )

    await pipeline.run_once()
    await pipeline.run_once()

    assert fake_vlm.full_calls == 2
    assert fake_vlm.incremental_calls == []


@pytest.mark.asyncio
async def test_pipeline_async_vlm_drops_when_queue_full() -> None:
    cfg = MonitorConfig()
    cfg.monitor.vision.mode = "vlm_structured"
    cfg.monitor.vlm_async.enabled = True
    cfg.monitor.vlm_async.max_concurrency = 1
    cfg.monitor.vlm_async.max_queue = 1
    cfg.monitor.vlm_async.drop_when_queue_full = True

    metrics = MonitorMetrics()
    bus = _make_event_bus(metrics)
    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([b"a", b"b", b"b"]),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(bus),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=_FakeWindowProbe(app_name="WeChat", title="会话A"),
        vlm_structured_adapter=_FakeVLMStructured(delays=[0.2, 0.2]),
    )

    await pipeline.run_once()  # enqueue f1
    await pipeline.run_once()  # f2 should be dropped due to queue full
    await asyncio.sleep(0.22)
    await pipeline.run_once()  # drain f1

    events = bus.poll(limit=10)
    assert len(events) == 1
    _assert_public_frame_id(events[0].frame_id, 1)
    assert metrics.vlm_async_dropped_total._value.get() >= 1
    await pipeline.shutdown()


@pytest.mark.asyncio
async def test_pipeline_vlm_only_does_not_fallback_to_ocr_when_vlm_empty_even_if_requested() -> None:
    cfg = MonitorConfig()
    cfg.monitor.vision.mode = "vlm_structured"
    cfg.monitor.vision.strict_only = False
    cfg.monitor.vlm_async.enabled = False
    metrics = MonitorMetrics()
    bus = _make_event_bus(metrics)

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([b"frame_a"]),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR(
            [object()]
        ),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(bus),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=_FakeWindowProbe(app_name="WeChat", title="会话A"),
        vlm_structured_adapter=_FakeVLMStructuredEmpty(),
    )

    result = await pipeline.run_once()

    assert result.events_emitted == 0
    assert bus.poll(limit=10) == []
    assert pipeline.ocr_orchestrator.calls == 0


@pytest.mark.asyncio
async def test_pipeline_session_switch_resets_incremental_baseline() -> None:
    cfg = MonitorConfig()
    cfg.monitor.vision.mode = "vlm_structured"
    cfg.monitor.vlm_async.enabled = False
    metrics = MonitorMetrics()
    fake_vlm = _FakeVLMStructured(delays=[])

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([b"a", b"b", b"c", b"d"]),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(_make_event_bus(metrics)),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=_FakeWindowProbe(app_name="WeChat", titles=["A群", "A群", "B群", "B群"]),
        vlm_structured_adapter=fake_vlm,
    )

    await pipeline.run_once()
    await pipeline.run_once()
    await pipeline.run_once()
    await pipeline.run_once()

    assert fake_vlm.full_calls == 2
    assert len(fake_vlm.incremental_calls) == 2
    assert fake_vlm.incremental_calls[0] == (b"a", b"b")
    assert fake_vlm.incremental_calls[1] == (b"c", b"d")


@pytest.mark.asyncio
async def test_pipeline_window_title_mismatch_forces_session_switch_even_when_headers_look_similar() -> None:
    cfg = MonitorConfig()
    cfg.monitor.vision.mode = "vlm_structured"
    cfg.monitor.vlm_async.enabled = False
    metrics = MonitorMetrics()
    fake_vlm = _FakeVLMStructured(delays=[])

    frame_a1 = _make_rgb_frame(header_seed=11, body_seed=21)
    frame_a2 = _make_rgb_frame(header_seed=11, body_seed=22)
    frame_b1 = _make_rgb_frame(header_seed=11, body_seed=23)
    frame_b2 = _make_rgb_frame(header_seed=11, body_seed=24)

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([frame_a1, frame_a2, frame_b1, frame_b2], width=40, height=20),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(_make_event_bus(metrics)),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=_FakeWindowProbe(app_name="WeChat", titles=["A群", "A群", "B群", "B群"]),
        vlm_structured_adapter=fake_vlm,
    )

    await pipeline.run_once()
    await pipeline.run_once()
    await pipeline.run_once()
    await pipeline.run_once()

    assert fake_vlm.full_calls == 2
    assert len(fake_vlm.incremental_calls) == 2
    assert fake_vlm.incremental_calls[0] == (
        pipeline.preprocessor.rgb_bytes_to_png(frame_a1, 40, 20),
        pipeline.preprocessor.rgb_bytes_to_png(frame_a2, 40, 20),
    )
    assert fake_vlm.incremental_calls[1] == (
        pipeline.preprocessor.rgb_bytes_to_png(frame_b1, 40, 20),
        pipeline.preprocessor.rgb_bytes_to_png(frame_b2, 40, 20),
    )


@pytest.mark.asyncio
async def test_pipeline_uses_unknown_session_when_title_missing() -> None:
    cfg = MonitorConfig()
    cfg.monitor.vision.mode = "vlm_structured"
    cfg.monitor.vlm_async.enabled = False
    metrics = MonitorMetrics()
    bus = _make_event_bus(metrics)
    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([b"frame_a"]),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(bus),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        vlm_structured_adapter=_FakeVLMStructured(delays=[]),
    )

    first = await pipeline.run_once()
    assert first.events_emitted == 1

    events = bus.poll(limit=20)
    assert len(events) == 1
    assert events[0].conversation_title is None
    assert events[0].session_key == "sess-test"
    debug_state = pipeline.get_debug_state()
    assert "title_required" not in debug_state
    assert "title_probe_id" not in debug_state


@pytest.mark.asyncio
async def test_pipeline_keeps_cache_in_pending_when_title_missing(tmp_path: Path) -> None:
    cfg = MonitorConfig()
    cfg.monitor.vision.mode = "vlm_structured"
    cfg.monitor.vlm_async.enabled = False
    cfg.monitor.frame_cache.enabled = True
    cfg.monitor.frame_cache.cache_all_frames = True
    cfg.monitor.frame_cache.keep_processed_frames = True
    cfg.monitor.frame_cache.testing_mode = True
    cfg.monitor.frame_cache.cache_dir = str(tmp_path / "cache")
    metrics = MonitorMetrics()
    bus = _make_event_bus(metrics)
    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([b"frame_a"]),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(bus),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        vlm_structured_adapter=_FakeVLMStructured(delays=[]),
    )

    await pipeline.run_once()

    cache_dir = Path(cfg.monitor.frame_cache.cache_dir)
    assert len(list((cache_dir / "_pending").glob("*.png"))) == 1
    assert len(list((cache_dir / "_pending").glob("*.rgb"))) == 0
    assert not (cache_dir / "微信" / "unknown_session").exists()


@pytest.mark.asyncio
async def test_pipeline_recovers_startup_pending_pngs_in_timestamp_order(tmp_path: Path) -> None:
    cfg = MonitorConfig()
    cfg.monitor.vlm_async.enabled = False
    cfg.monitor.frame_cache.enabled = True
    cfg.monitor.frame_cache.keep_processed_frames = True
    cfg.monitor.frame_cache.testing_mode = True
    cfg.monitor.frame_cache.cache_dir = str(tmp_path / "cache")

    cache_dir = Path(cfg.monitor.frame_cache.cache_dir)
    pending_dir = cache_dir / "_pending"
    pending_dir.mkdir(parents=True, exist_ok=True)
    first_path = pending_dir / "f_000001_20260402T104011351282Z.png"
    second_path = pending_dir / "f_000001_20260402T104023647578Z.png"
    first_path.write_bytes(b"older")
    second_path.write_bytes(b"newer")

    metrics = MonitorMetrics()
    bus = _make_event_bus(metrics)
    capture = _FakeCapture([b"frame_live"])
    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=capture,
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(bus),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        vlm_structured_adapter=_FakeVLMStructured(delays=[], titles=["学习群", "学习群", "学习群"]),
    )

    result = await pipeline.run_once()

    assert result.events_emitted == 2
    assert capture.calls == 0
    events = bus.poll(limit=10)
    assert [event.frame_id for event in events] == [
        "f_000001_20260402T104011351282Z",
        "f_000001_20260402T104023647578Z",
    ]
    assert [event.text for event in events] == ["msg_0", "msg_1"]
    debug_state = pipeline.get_debug_state()
    assert debug_state["startup_pending_recovered_frames"] == 2
    assert debug_state["startup_pending_recovery_done"] is True

    second_result = await pipeline.run_once()

    assert second_result.events_emitted == 1
    assert capture.calls == 1
    follow_up_events = bus.poll(limit=10)
    assert [event.text for event in follow_up_events] == ["msg_2"]


@pytest.mark.asyncio
async def test_pipeline_preserves_explicit_group_contact_name_when_only_one_speaker_is_visible() -> None:
    cfg = MonitorConfig()
    cfg.monitor.vlm_async.enabled = False
    metrics = MonitorMetrics()
    bus = _make_event_bus(metrics)
    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([b"frame_a"]),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(bus),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="WeChat",
        window_probe=_FakeWindowProbe("WeChat", title="学习群"),
        vlm_structured_adapter=_FakeVLMStructuredWithMessages(
            messages=[
                VLMStructuredMessage(
                    sender="contact",
                    contact_name="Alice",
                    text="收到",
                    content_type="text",
                    non_text_description=None,
                    confidence=0.92,
                )
            ],
            conversation_title="学习群",
        ),
    )

    await pipeline.run_once()

    events = bus.poll(limit=20)
    assert len(events) == 1
    assert events[0].contact_name == "Alice"


@pytest.mark.asyncio
async def test_pipeline_vlm_strict_only_does_not_fallback_to_ocr_by_default() -> None:
    cfg = MonitorConfig()
    cfg.monitor.vision.mode = "vlm_structured"
    cfg.monitor.vlm_async.enabled = False
    metrics = MonitorMetrics()
    bus = _make_event_bus(metrics)
    fake_ocr = _FakeOCR([object()])

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([b"frame_a"]),
        change_detector=ChangeDetector(),
        ocr_orchestrator=fake_ocr,
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(bus),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=_FakeWindowProbe(app_name="WeChat", title="会话A"),
        vlm_structured_adapter=_FakeVLMStructuredEmpty(),
    )

    result = await pipeline.run_once()
    assert result.events_emitted == 0
    assert fake_ocr.calls == 0


@pytest.mark.asyncio
async def test_pipeline_async_vlm_emits_results_in_capture_order() -> None:
    cfg = MonitorConfig()
    cfg.monitor.vision.mode = "vlm_structured"
    cfg.monitor.vlm_async.enabled = True
    cfg.monitor.vlm_async.max_concurrency = 2
    cfg.monitor.vlm_async.max_queue = 8
    metrics = MonitorMetrics()
    bus = _make_event_bus(metrics)
    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([b"a", b"b", b"b", b"b"]),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(bus),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=_FakeWindowProbe(app_name="WeChat", titles=["A群", "B群", "B群", "B群"]),
        vlm_structured_adapter=_FakeVLMStructured(delays=[0.2, 0.01]),
    )

    await pipeline.run_once()  # A, slow
    await pipeline.run_once()  # B, fast
    await asyncio.sleep(0.06)
    await pipeline.run_once()  # fast B already done, but A should still hold emission order
    first_batch = bus.poll(limit=20)
    assert first_batch == []

    await asyncio.sleep(0.2)
    await pipeline.run_once()  # now A and B can drain together in capture order
    second_batch = bus.poll(limit=20)
    assert len(second_batch) >= 2
    _assert_public_frame_id(second_batch[0].frame_id, 1)
    assert second_batch[0].conversation_title == "A群"
    _assert_public_frame_id(second_batch[1].frame_id, 2)
    assert second_batch[1].conversation_title == "B群"
    await pipeline.shutdown()


@pytest.mark.asyncio
async def test_pipeline_shutdown_drains_pending_async_vlm_results() -> None:
    cfg = MonitorConfig()
    cfg.monitor.vision.mode = "vlm_structured"
    cfg.monitor.vlm_async.enabled = True
    cfg.monitor.vlm_async.max_concurrency = 1
    cfg.monitor.vlm_async.max_queue = 4

    metrics = MonitorMetrics()
    bus = _make_event_bus(metrics)
    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([b"a", b"b"]),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(bus),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=_FakeWindowProbe(app_name="WeChat", title="会话A"),
        vlm_structured_adapter=_FakeVLMStructured(delays=[0.15, 0.15]),
    )

    await pipeline.run_once()
    await pipeline.run_once()
    await pipeline.shutdown()

    events = bus.poll(limit=10)
    assert len(events) >= 2
    _assert_public_frame_id(events[0].frame_id, 1)
    _assert_public_frame_id(events[1].frame_id, 2)
    assert pipeline.get_debug_state()["async_vlm_inflight"] == 0


@pytest.mark.asyncio
async def test_pipeline_capture_disabled_stops_new_screenshots_but_drains_async_vlm_results() -> None:
    cfg = MonitorConfig()
    cfg.monitor.vision.mode = "vlm_structured"
    cfg.monitor.vlm_async.enabled = True
    cfg.monitor.vlm_async.max_concurrency = 1
    cfg.monitor.vlm_async.max_queue = 4

    metrics = MonitorMetrics()
    bus = _make_event_bus(metrics)
    capture = _FakeCapture([b"a", b"b", b"c"])
    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=capture,
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(bus),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=_FakeWindowProbe(app_name="WeChat", title="会话A"),
        vlm_structured_adapter=_FakeVLMStructured(delays=[0.12]),
    )

    await pipeline.run_once()
    assert capture.calls == 1

    pipeline.set_capture_enabled(False)

    drained = await pipeline.run_once()
    assert capture.calls == 1
    assert drained.events_emitted == 0

    await asyncio.sleep(0.16)
    drained = await pipeline.run_once()
    events = bus.poll(limit=10)

    assert capture.calls == 1
    assert drained.events_emitted >= 1
    assert len(events) >= 1
    assert pipeline.get_debug_state()["async_vlm_inflight"] == 0


@pytest.mark.asyncio
async def test_finalize_frame_session_honors_locked_existing_session_key() -> None:
    cfg = MonitorConfig()
    metrics = MonitorMetrics()
    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([b"a"]),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(_make_event_bus(metrics)),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=_FakeWindowProbe(app_name="WeChat", title="会话A"),
        vlm_structured_adapter=_FakeVLMStructured(delays=[]),
    )
    session_key = "微信::四个超级汪汪队"
    pipeline._touch_session_state(session_key, b"baseline", confirmed_title="四个超级汪汪队")

    frame = FrameEvent(
        frame_id="f_000002",
        ts_capture=datetime.now(timezone.utc),
        roi_id="default",
        window_id="WeChat",
        session_id="sess-test",
        frame_hash="hash_000002",
        metadata={
            "frontmost_app": "WeChat",
            "conversation_title": "四个超级汪汪队 (? #_“)",
            "session_key": session_key,
            "same_session_locked": True,
        },
    )

    resolved = await pipeline._finalize_frame_session(frame)
    assert resolved == session_key
    assert frame.metadata["session_key"] == session_key


@pytest.mark.asyncio
async def test_finalize_frame_session_breaks_locked_session_when_vlm_title_conflicts() -> None:
    cfg = MonitorConfig()
    metrics = MonitorMetrics()
    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([b"a"]),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(_make_event_bus(metrics)),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=_FakeWindowProbe(app_name="WeChat", title="四个超级汪汪队"),
        vlm_structured_adapter=_FakeVLMStructured(delays=[]),
    )
    old_session_key = "微信::四个超级汪汪队"
    pipeline._touch_session_state(old_session_key, b"baseline", confirmed_title="四个超级汪汪队")

    frame = FrameEvent(
        frame_id="f_000003",
        ts_capture=datetime.now(timezone.utc),
        roi_id="default",
        window_id="WeChat",
        session_id="sess-test",
        frame_hash="hash_000003",
        metadata={
            "frontmost_app": "WeChat",
            "conversation_title": "mcp数据合成交流",
            "session_key": old_session_key,
            "same_session_locked": True,
        },
    )

    resolved = await pipeline._finalize_frame_session(frame)
    assert resolved == "微信::mcp数据合成交流"
    assert frame.metadata["session_key"] == "微信::mcp数据合成交流"
    assert frame.metadata["session_name"] == "mcp数据合成交流"


@pytest.mark.asyncio
async def test_pipeline_preserves_quoted_message_fields_in_events() -> None:
    cfg = MonitorConfig()
    cfg.monitor.vlm_async.enabled = False
    metrics = MonitorMetrics()
    bus = _make_event_bus(metrics)
    fake_vlm = _FakeVLMStructuredWithMessages(
        [
            VLMStructuredMessage(
                sender="contact",
                contact_name="宝宝💗",
                text="快快关注 助力每一个梦想好吧😎",
                content_type="text",
                quoted_message={
                    "text": "刷到叶老师的小红书了",
                    "sender_name": "赵梓涵",
                },
                confidence=0.95,
            )
        ],
        conversation_title="测试群聊",
    )

    pipeline = VisualMonitorPipeline(
        config=cfg,
        capture_adapter=_FakeCapture([b"frame_a"]),
        change_detector=ChangeDetector(),
        ocr_orchestrator=_FakeOCR([]),
        parser=None,
        assembler=StreamAssembler(),
        output_gateway=OutputGateway(bus),
        scheduler=CaptureScheduler(),
        preprocessor=FramePreprocessor(),
        roi_resolver=None,
        debug_storage=DebugFrameStorage(enabled=False, base_dir="/tmp/social_debug_test"),
        metrics=metrics,
        session_id="sess-test",
        window_id="window-test",
        window_probe=_FakeWindowProbe(app_name="WeChat", title="测试群聊"),
        vlm_structured_adapter=fake_vlm,
    )

    result = await pipeline.run_once()
    events = bus.poll(limit=10)

    assert result.events_emitted == 1
    assert len(events) == 1
    assert events[0].quoted_message is not None
    assert events[0].quoted_message.text == "刷到叶老师的小红书了"
    assert events[0].quoted_message.sender_name == "赵梓涵"
