from __future__ import annotations

import asyncio
from time import perf_counter

import pytest

from social_copilot.visual_monitor.core.pipeline import PipelineRunResult
from social_copilot.visual_monitor.service import VisualMonitorService


class _FakePipeline:
    def __init__(self) -> None:
        self.capture_enabled = True
        self.shutdown_started = asyncio.Event()
        self.shutdown_finished = asyncio.Event()
        self.run_once_calls = 0

    def set_capture_enabled(self, enabled: bool) -> None:
        self.capture_enabled = enabled

    async def run_once(self) -> PipelineRunResult:
        self.run_once_calls += 1
        await asyncio.sleep(0.01)
        return PipelineRunResult(next_interval_s=0.01, events_emitted=0, changed=False)

    async def shutdown(self) -> None:
        self.shutdown_started.set()
        await asyncio.sleep(0.2)
        self.shutdown_finished.set()

    def get_debug_state(self) -> dict[str, object]:
        return {
            "per_session_inflight": {},
            "capture_enabled": self.capture_enabled,
        }


@pytest.mark.asyncio
async def test_service_stop_disables_capture_without_waiting_for_full_shutdown() -> None:
    fake_pipeline: _FakePipeline | None = None

    def build_pipeline(*_args, **_kwargs) -> _FakePipeline:
        nonlocal fake_pipeline
        fake_pipeline = _FakePipeline()
        return fake_pipeline

    service = VisualMonitorService(pipeline_factory=build_pipeline)

    await service.start()
    assert fake_pipeline is not None

    started = perf_counter()
    status = await service.stop()
    elapsed = perf_counter() - started

    assert status.running is False
    assert elapsed < 0.1
    assert fake_pipeline.capture_enabled is False
    assert fake_pipeline.shutdown_started.is_set() is False

    await service.close()
    assert fake_pipeline.shutdown_finished.is_set() is True
