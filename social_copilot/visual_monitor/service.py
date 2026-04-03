from __future__ import annotations

import asyncio
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator, Callable

from dotenv import load_dotenv

from social_copilot.visual_monitor.adapters.capture_mss import MSSCaptureAdapter
from social_copilot.visual_monitor.adapters.vision_litellm_structured import (
    LiteLLMStructuredVisionAdapter,
    LiteLLMStructuredVisionConfig,
)
from social_copilot.visual_monitor.adapters.window_probe_factory import create_window_probe
from social_copilot.visual_monitor.core.assembler import StreamAssembler
from social_copilot.visual_monitor.core.change_detector import ChangeDetector
from social_copilot.visual_monitor.core.frame_cache import FrameCacheManager
from social_copilot.visual_monitor.core.output_gateway import OutputGateway
from social_copilot.visual_monitor.core.pipeline import VisualMonitorPipeline
from social_copilot.visual_monitor.core.preprocess import FramePreprocessor
from social_copilot.visual_monitor.core.roi_resolver import RoiResolver
from social_copilot.visual_monitor.core.scheduler import CaptureScheduler
from social_copilot.visual_monitor.models.config import MonitorConfig
from social_copilot.visual_monitor.models.events import MessageEvent
from social_copilot.visual_monitor.observability.metrics import MonitorMetrics
from social_copilot.visual_monitor.security.debug_storage import DebugFrameStorage


def _load_project_env() -> None:
    env_candidates = [
        Path(__file__).resolve().parents[2] / ".env",
        Path(__file__).resolve().parents[1] / ".env",
    ]
    for env_path in env_candidates:
        if env_path.exists():
            load_dotenv(env_path)
            return
    load_dotenv()


@dataclass(slots=True)
class MonitorStatus:
    running: bool
    last_error: str | None = None


class EventBus:
    """Persistent event bus backed by SQLite WAL.

    Replaces the previous in-memory deque to prevent event loss on queue
    overflow or service restart.  The public API is unchanged:
    publish / poll / subscribe.
    """

    def __init__(self, metrics: MonitorMetrics, db_path: str | Path | None = None) -> None:
        self._metrics = metrics
        self._subscribers: set[asyncio.Queue[MessageEvent]] = set()

        if db_path is None:
            db_path = Path.home() / ".socialclaw-stack" / "eventbus.db"
        self._db_path = Path(db_path)
        self._db_path.parent.mkdir(parents=True, exist_ok=True)

        self._db = sqlite3.connect(str(self._db_path), check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS events ("
            "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "  payload TEXT NOT NULL"
            ")"
        )
        self._db.commit()

        self._buffer: list[tuple[str]] = []
        self._flush_counter = 0
        self._FLUSH_EVERY = 5

    # -- write path (buffered) --

    def publish(self, event: MessageEvent) -> None:
        self._buffer.append((event.model_dump_json(),))
        self._metrics.events_published_total.inc()
        self._flush_counter += 1
        if self._flush_counter >= self._FLUSH_EVERY:
            self.flush()
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                pass

    def flush(self) -> int:
        if not self._buffer:
            return 0
        self._db.executemany(
            "INSERT INTO events (payload) VALUES (?)",
            self._buffer,
        )
        self._db.commit()
        count = len(self._buffer)
        self._buffer.clear()
        self._flush_counter = 0
        return count

    # -- read path (poll) --

    def poll(self, limit: int = 50) -> list[MessageEvent]:
        self.flush()
        rows = self._db.execute(
            "SELECT id, payload FROM events ORDER BY id ASC LIMIT ?",
            (limit,),
        ).fetchall()
        if not rows:
            self._metrics.events_polled_total.inc(0)
            return []
        max_id = rows[-1][0]
        self._db.execute("DELETE FROM events WHERE id <= ?", (max_id,))
        self._db.commit()
        events: list[MessageEvent] = []
        for _, payload in rows:
            try:
                events.append(MessageEvent.model_validate_json(payload))
            except Exception:
                pass
        self._metrics.events_polled_total.inc(len(events))
        return events

    # -- streaming (SSE) --

    async def subscribe(self) -> AsyncIterator[MessageEvent]:
        queue: asyncio.Queue[MessageEvent] = asyncio.Queue(maxsize=200)
        self._subscribers.add(queue)
        try:
            while True:
                yield await queue.get()
        finally:
            self._subscribers.discard(queue)

    def close(self) -> None:
        self.flush()
        try:
            self._db.close()
        except Exception:
            pass


class VisualMonitorService:
    def __init__(
        self,
        metrics: MonitorMetrics | None = None,
        config: MonitorConfig | None = None,
        pipeline_factory: Callable[[EventBus, MonitorMetrics], VisualMonitorPipeline] | None = None,
    ) -> None:
        _load_project_env()
        self.metrics = metrics or MonitorMetrics()
        self.config = config or MonitorConfig()
        self.event_bus = EventBus(metrics=self.metrics)
        self._running = False
        self._last_error: str | None = None
        self._task: asyncio.Task[None] | None = None
        self._terminate_event = asyncio.Event()
        self._pipeline_factory = pipeline_factory or self._build_pipeline
        self._pipeline: VisualMonitorPipeline | None = None

    def get_config(self) -> MonitorConfig:
        return self.config

    async def update_config(self, patch: dict) -> MonitorConfig:
        merged = self.config.model_dump()
        _deep_update(merged, patch)
        self.config = MonitorConfig.model_validate(merged)
        if self._running:
            await self.stop()
            await self.start()
        return self.config

    async def calibrate_manual_roi(
        self,
        roi_patch: dict[str, int],
        enforce_frontmost_gate: bool = True,
        frontmost_app_name: str = "WeChat",
    ) -> MonitorConfig:
        return await self.update_config(
            {
                "monitor": {
                    "roi": roi_patch,
                    "roi_strategy": {"mode": "manual"},
                    "window_gate": {
                        "enabled": enforce_frontmost_gate,
                        "app_name": frontmost_app_name or "WeChat",
                        "foreground_settle_seconds": 0.0,
                        "confirmation_samples": 3,
                        "confirmation_interval_ms": 120,
                    },
                }
            }
        )

    async def start(self) -> MonitorStatus:
        if self._running:
            return self.status()
        if self._task is not None and not self._task.done():
            self._running = True
            self._last_error = None
            if self._pipeline is not None:
                self._pipeline.set_capture_enabled(True)
            return self.status()
        self._running = True
        self._last_error = None
        self._terminate_event = asyncio.Event()
        self._pipeline = self._pipeline_factory(self.event_bus, self.metrics)
        self._pipeline.set_capture_enabled(True)
        self._task = asyncio.create_task(self._run_loop(), name="visual-monitor-loop")
        return self.status()

    async def stop(self) -> MonitorStatus:
        if not self._running:
            return self.status()
        self._running = False
        if self._pipeline is not None:
            self._pipeline.set_capture_enabled(False)
        return self.status()

    async def close(self) -> MonitorStatus:
        if self._pipeline is not None:
            self._pipeline.set_capture_enabled(False)
        self._running = False
        self._terminate_event.set()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=45.0)
            except asyncio.TimeoutError:
                self._task.cancel()
                try:
                    await self._task
                except Exception:
                    pass
        self._task = None
        return self.status()

    def status(self) -> MonitorStatus:
        return MonitorStatus(running=self._running, last_error=self._last_error)

    def runtime_debug(self) -> dict[str, object]:
        pipeline_debug: dict[str, object] | None = None
        if self._pipeline is not None:
            pipeline_debug = self._pipeline.get_debug_state()
        return {
            "running": self._running,
            "last_error": self._last_error or "",
            "pipeline": pipeline_debug or {},
        }

    async def debug_vlm_image(self, image_path: str, older_image_path: str | None = None) -> dict[str, object]:
        cfg = self.config.monitor.vision.litellm
        if not cfg.enabled:
            return {"ok": False, "reason": "vlm_not_enabled"}

        image_file = Path(image_path).expanduser()
        if not image_file.exists() or not image_file.is_file():
            return {"ok": False, "reason": "image_not_found", "image_path": str(image_file)}
        image_png = await asyncio.to_thread(image_file.read_bytes)

        older_png: bytes | None = None
        older_file: Path | None = None
        if older_image_path:
            older_file = Path(older_image_path).expanduser()
            if not older_file.exists() or not older_file.is_file():
                return {"ok": False, "reason": "older_image_not_found", "older_image_path": str(older_file)}
            older_png = await asyncio.to_thread(older_file.read_bytes)

        adapter = LiteLLMStructuredVisionAdapter(
            LiteLLMStructuredVisionConfig(
                base_url=cfg.base_url,
                model=cfg.model,
                api_key=cfg.api_key,
                api_key_env=cfg.api_key_env,
                timeout_ms=cfg.timeout_ms,
                max_tokens=cfg.max_tokens,
                temperature=cfg.temperature,
            )
        )
        if older_png is not None:
            result = await asyncio.to_thread(adapter.extract_structured_incremental, older_png, image_png)
        else:
            result = await asyncio.to_thread(adapter.extract_structured, image_png)
        return {
            "ok": bool(result.parse_ok),
            "schema_version": result.schema_version,
            "conversation_title": result.conversation_title,
            "conversation": result.conversation,
            "window_time_context": result.window_time_context,
            "extraction_meta": result.extraction_meta,
            "messages": [item.model_dump(mode="json") for item in result.messages],
            "error": result.error or "",
            "roundtrip_ms": result.roundtrip_ms,
            "litellm_duration_ms": result.litellm_duration_ms,
            "provider_duration_ms": result.provider_duration_ms,
            "image_path": str(image_file),
            "older_image_path": str(older_file) if older_file is not None else "",
            "raw_content_preview": result.raw_content[:2000],
        }

    async def _run_loop(self) -> None:
        if self._pipeline is None:
            return
        try:
            while not self._terminate_event.is_set():
                result = await self._pipeline.run_once()
                if self._terminate_event.is_set():
                    break
                try:
                    await asyncio.wait_for(self._terminate_event.wait(), timeout=result.next_interval_s)
                except asyncio.TimeoutError:
                    pass
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - safety net
            self._last_error = str(exc)
        finally:
            if self._pipeline is not None:
                await self._pipeline.shutdown()
            self._running = False

    def _build_pipeline(self, event_bus: EventBus, metrics: MonitorMetrics) -> VisualMonitorPipeline:
        _load_project_env()
        vlm_structured_adapter = None
        vlm_cfg = self.config.monitor.vision.litellm
        if vlm_cfg.enabled or self.config.monitor.vision.mode == "vlm_structured":
            vlm_structured_adapter = LiteLLMStructuredVisionAdapter(
                LiteLLMStructuredVisionConfig(
                    base_url=vlm_cfg.base_url,
                    model=vlm_cfg.model,
                    api_key=vlm_cfg.api_key,
                    api_key_env=vlm_cfg.api_key_env,
                    timeout_ms=vlm_cfg.timeout_ms,
                    max_tokens=vlm_cfg.max_tokens,
                    temperature=vlm_cfg.temperature,
                )
            )
        scheduler = CaptureScheduler(
            idle_hz=self.config.monitor.fps.idle,
            active_hz=self.config.monitor.fps.active_min,
            active_peak_hz=self.config.monitor.fps.active_max,
            burst_hz=self.config.monitor.fps.burst,
        )
        debug_storage = DebugFrameStorage(
            enabled=self.config.monitor.privacy.debug_dump_enabled,
            base_dir=self.config.monitor.privacy.debug_dump_dir,
        )
        return VisualMonitorPipeline(
            config=self.config,
            capture_adapter=MSSCaptureAdapter(),
            change_detector=ChangeDetector(
                hash_similarity_skip=self.config.monitor.thresholds.hash_similarity_skip,
                histogram_similarity_skip=self.config.monitor.thresholds.ssim_change,
                enable_phash=self.config.monitor.capture_scheme == "current",
                skip_near_duplicate_frames=self.config.monitor.capture_scheme == "current",
            ),
            ocr_orchestrator=None,
            parser=None,
            assembler=StreamAssembler(),
            output_gateway=OutputGateway(event_bus),
            scheduler=scheduler,
            preprocessor=FramePreprocessor(),
            roi_resolver=RoiResolver(strategy=self.config.monitor.roi_strategy),
            vlm_structured_adapter=vlm_structured_adapter,
            frame_cache=FrameCacheManager(
                enabled=self.config.monitor.frame_cache.enabled,
                cache_dir=self.config.monitor.frame_cache.cache_dir,
                keep_processed_frames=self.config.monitor.frame_cache.keep_processed_frames,
                cache_all_frames=self.config.monitor.frame_cache.cache_all_frames,
                deduplicate_kept_frames=self.config.monitor.frame_cache.deduplicate_kept_frames,
                dedup_similarity_threshold=self.config.monitor.frame_cache.dedup_similarity_threshold,
                max_kept_frames=self.config.monitor.frame_cache.max_kept_frames,
                testing_mode=self.config.monitor.frame_cache.testing_mode,
            ),
            debug_storage=debug_storage,
            metrics=metrics,
            session_id="session-default",
            window_id="window-default",
            window_probe=create_window_probe(),
        )


def _deep_update(target: dict, patch: dict) -> None:
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            _deep_update(target[key], value)
        else:
            target[key] = value
