from __future__ import annotations

import asyncio
from difflib import SequenceMatcher
from pathlib import Path
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timezone
from time import perf_counter
from statistics import mean
from typing import Callable, Protocol
from social_copilot.visual_monitor.core.assembler import StreamAssembler
from social_copilot.visual_monitor.core.change_detector import ChangeDetector
from social_copilot.visual_monitor.core.frame_cache import FrameCacheEntry, FrameCacheManager
from social_copilot.visual_monitor.core.output_gateway import OutputGateway
from social_copilot.visual_monitor.core.preprocess import FramePreprocessor
from social_copilot.visual_monitor.core.roi_resolver import RoiResolution
from social_copilot.visual_monitor.core.scheduler import CaptureScheduler
from social_copilot.visual_monitor.models.config import MonitorConfig
from social_copilot.visual_monitor.models.events import FrameEvent, MessageEvent, ParsedMessage
from social_copilot.visual_monitor.observability.metrics import MonitorMetrics
from social_copilot.visual_monitor.security.debug_storage import DebugFrameStorage


class CaptureAdapter(Protocol):
    def capture(self, roi: dict[str, int]):
        ...


class WindowProbe(Protocol):
    def frontmost_app_name(self) -> str | None:
        ...

    def frontmost_window_bounds(self, app_name: str):
        ...

    def frontmost_window_title(self, app_name: str) -> str | None:
        ...


class VLMStructuredAdapter(Protocol):
    def extract_structured(self, image_png: bytes):
        ...

    def extract_structured_incremental(self, older_image_png: bytes, newer_image_png: bytes):
        ...


@dataclass(slots=True)
class PipelineRunResult:
    next_interval_s: float
    events_emitted: int
    changed: bool


@dataclass(slots=True)
class HeaderFingerprint:
    header_band_hash: str
    header_focus_hash: str


@dataclass(slots=True)
class AsyncVLMJobResult:
    sequence: int
    session_key: str
    frame: FrameEvent
    parsed: list[ParsedMessage]
    extraction_engine: str
    vision_mode: str
    processing_image: bytes
    used_fallback: bool
    similarity_score: float
    dedup_reason: str
    vlm_meta: dict[str, object]
    raw_cache_entry: FrameCacheEntry | None = None
    processing_cache_entry: FrameCacheEntry | None = None
    ocr_contact_evidence: list[ParsedMessage] | None = None
    header_fingerprint: HeaderFingerprint | None = None


@dataclass(slots=True)
class SessionState:
    last_vlm_image: bytes | None = None
    last_seen_ts: str = ""
    locked_contact_name: str | None = None
    group_chat_detected: bool = False
    explicit_group_contact_name_counts: dict[str, int] = field(default_factory=dict)
    last_header_fingerprint: HeaderFingerprint | None = None
    last_confirmed_title: str | None = None
    cache_session_name: str | None = None


class VisualMonitorPipeline:
    _PENDING_CACHE_SUBDIR = "_pending"
    _chat_time_pattern = re.compile(r"^\d{1,2}:\d{2}$")
    _chat_unread_suffix_pattern = re.compile(r"[（(]\d+[)）]\s*$")
    _title_invisible_pattern = re.compile(r"[\u200b-\u200d\ufe0e\ufe0f]+")
    _title_text_char_pattern = re.compile(r"[A-Za-z0-9\u3400-\u9fff]")

    def __init__(
        self,
        config: MonitorConfig,
        capture_adapter: CaptureAdapter,
        change_detector: ChangeDetector,
        ocr_orchestrator,
        parser,
        assembler: StreamAssembler,
        output_gateway: OutputGateway,
        scheduler: CaptureScheduler,
        preprocessor: FramePreprocessor,
        roi_resolver: object | None,
        debug_storage: DebugFrameStorage,
        metrics: MonitorMetrics,
        session_id: str,
        window_id: str,
        cpu_provider: Callable[[], float] | None = None,
        window_probe: WindowProbe | None = None,
        vlm_structured_adapter: VLMStructuredAdapter | None = None,
        frame_cache: FrameCacheManager | None = None,
    ) -> None:
        self.config = config
        self.capture_adapter = capture_adapter
        self.change_detector = change_detector
        self.ocr_orchestrator = ocr_orchestrator
        self.parser = parser
        self.assembler = assembler
        self.output_gateway = output_gateway
        self.scheduler = scheduler
        self.preprocessor = preprocessor
        self.roi_resolver = roi_resolver
        self.debug_storage = debug_storage
        self.metrics = metrics
        self.session_id = session_id
        self.window_id = window_id
        self.cpu_provider = cpu_provider or self._default_cpu_provider
        self.window_probe = window_probe
        self.vlm_structured_adapter = vlm_structured_adapter
        self.frame_cache = frame_cache or FrameCacheManager(
            enabled=self.config.monitor.frame_cache.enabled,
            cache_dir=self.config.monitor.frame_cache.cache_dir,
            keep_processed_frames=self.config.monitor.frame_cache.keep_processed_frames,
            cache_all_frames=self.config.monitor.frame_cache.cache_all_frames,
            deduplicate_kept_frames=self.config.monitor.frame_cache.deduplicate_kept_frames,
            dedup_similarity_threshold=self.config.monitor.frame_cache.dedup_similarity_threshold,
            max_kept_frames=self.config.monitor.frame_cache.max_kept_frames,
            testing_mode=self.config.monitor.frame_cache.testing_mode,
        )

        self._frame_counter = 0
        self._previous_frame: bytes | None = None
        self._foreground_gate_stable_app: str | None = None
        self._foreground_gate_stable_since: float | None = None
        self._session_states: dict[str, SessionState] = {}
        self._active_session_key: str | None = None
        self._session_switch_count = 0
        self._async_vlm_cfg = self.config.monitor.vlm_async
        self._async_vlm_enabled = bool(
            self._async_vlm_cfg.enabled and self.config.monitor.vision.mode == "vlm_structured"
        )
        self._async_vlm_gate = asyncio.Semaphore(self._async_vlm_cfg.max_concurrency)
        self._async_vlm_jobs_by_session: dict[str, dict[int, asyncio.Task[AsyncVLMJobResult]]] = {}
        self._async_vlm_jobs_by_sequence: dict[int, tuple[str, asyncio.Task[AsyncVLMJobResult]]] = {}
        self._async_vlm_next_sequence = 1
        self._async_vlm_next_emit_sequence = 1
        self._startup_pending_recovery_complete = False
        self._pending_manifest_path = Path(self.config.monitor.frame_cache.cache_dir) / "_processed_pending_frames.log"
        self._processed_pending_frame_ids = self._load_processed_pending_frame_ids()
        self._capture_enabled = True
        self._debug_state: dict[str, object] = {
            "runs_total": 0,
            "changed_total": 0,
            "capture_enabled": True,
            "gate_skipped_total": 0,
            "events_emitted_total": 0,
            "last_run_ts": "",
            "last_frontmost_app": "",
            "last_frontmost_app_recheck": "",
            "last_frontmost_app_postcapture": "",
            "last_target_app": "",
            "last_gate_passed": None,
            "last_roi": {},
            "last_roi_source": "",
            "last_roi_reason": "",
            "last_changed": False,
            "last_events_emitted": 0,
            "last_vision_mode": "",
            "last_ocr_mode": "",
            "last_decision_reason": "",
            "last_error": "",
            "active_session_key": "",
            "session_switch_count": 0,
            "per_session_inflight": {},
            "last_gate_settle_elapsed_s": 0.0,
            "last_gate_settle_required_s": 0.0,
            "last_exclusion_regions_applied": 0,
            "last_same_session_decision": "",
            "last_header_band_similarity": 0.0,
            "last_header_focus_similarity": 0.0,
            "last_same_session_confidence": 0.0,
            "startup_pending_recovered_frames": 0,
            "startup_pending_recovery_done": False,
            "processed_pending_frames": len(self._processed_pending_frame_ids),
        }

    async def run_once(self) -> PipelineRunResult:
        self._debug_state["runs_total"] = int(self._debug_state["runs_total"]) + 1
        self._debug_state["last_run_ts"] = datetime.now(tz=timezone.utc).isoformat()
        started = perf_counter()
        events_emitted = await self._drain_async_vlm_results()
        recovered_events = await self._recover_startup_pending_frames()
        if recovered_events > 0:
            events_emitted += recovered_events
            cpu = self.cpu_provider()
            self.metrics.cpu_percent.set(cpu)
            interval = self.scheduler.observe(
                has_change=True,
                message_emitted=bool(events_emitted),
                cpu_percent=cpu,
            )
            latency = (perf_counter() - started) * 1000
            self.metrics.pipeline_latency_ms.observe(latency)
            self._debug_state["last_changed"] = True
            self._debug_state["last_events_emitted"] = events_emitted
            self._debug_state["events_emitted_total"] = int(self._debug_state["events_emitted_total"]) + int(
                events_emitted
            )
            self._debug_state["last_decision_reason"] = "startup_pending_recovery"
            return PipelineRunResult(next_interval_s=max(0.05, interval), events_emitted=events_emitted, changed=True)
        if not self._capture_enabled:
            cpu = self.cpu_provider()
            self.metrics.cpu_percent.set(cpu)
            interval = 0.05 if self._total_async_vlm_jobs() > 0 else 0.25
            latency = (perf_counter() - started) * 1000
            self.metrics.pipeline_latency_ms.observe(latency)
            self._debug_state["last_changed"] = False
            self._debug_state["last_events_emitted"] = events_emitted
            self._debug_state["events_emitted_total"] = int(self._debug_state["events_emitted_total"]) + int(
                events_emitted
            )
            self._debug_state["last_decision_reason"] = (
                "capture_disabled_drain" if self._total_async_vlm_jobs() > 0 else "capture_disabled_idle"
            )
            return PipelineRunResult(
                next_interval_s=interval,
                events_emitted=events_emitted,
                changed=bool(events_emitted),
            )
        frontmost_app: str | None = None
        window_bounds = None
        conversation_title: str | None = None

        gate_cfg = self.config.monitor.window_gate
        # Foreground-gate policy is mandatory when window probing is available.
        # This keeps capture/OCR/VLM aligned with WeChat-active-only behavior.
        target_app_name = gate_cfg.app_name or "WeChat"
        self._debug_state["last_target_app"] = target_app_name
        if self.window_probe is not None:
            frontmost_app = await asyncio.to_thread(self.window_probe.frontmost_app_name)
            self._debug_state["last_frontmost_app"] = frontmost_app or ""
            if not self._app_matches(frontmost_app, target_app_name):
                self._foreground_gate_stable_app = None
                self._foreground_gate_stable_since = None
                self.metrics.window_gate_skipped_total.inc()
                self._debug_state["gate_skipped_total"] = int(self._debug_state["gate_skipped_total"]) + 1
                self._debug_state["last_gate_passed"] = False
                self._debug_state["last_gate_settle_elapsed_s"] = 0.0
                self._debug_state["last_gate_settle_required_s"] = float(gate_cfg.foreground_settle_seconds)
                cpu = self.cpu_provider()
                self.metrics.cpu_percent.set(cpu)
                interval = self.scheduler.observe(
                    has_change=False,
                    message_emitted=bool(events_emitted),
                    cpu_percent=cpu,
                )
                latency = (perf_counter() - started) * 1000
                self.metrics.pipeline_latency_ms.observe(latency)
                self._debug_state["last_changed"] = False
                self._debug_state["last_events_emitted"] = events_emitted
                self._debug_state["events_emitted_total"] = int(self._debug_state["events_emitted_total"]) + int(
                    events_emitted
                )
                self._debug_state["last_decision_reason"] = "window_gate_skipped"
                return PipelineRunResult(next_interval_s=interval, events_emitted=events_emitted, changed=False)
            settle_required = max(0.0, float(gate_cfg.foreground_settle_seconds))
            now = perf_counter()
            if self._foreground_gate_stable_app != frontmost_app:
                self._foreground_gate_stable_app = frontmost_app
                self._foreground_gate_stable_since = now
            elapsed = now - (self._foreground_gate_stable_since or now)
            self._debug_state["last_gate_settle_elapsed_s"] = round(elapsed, 3)
            self._debug_state["last_gate_settle_required_s"] = settle_required
            if settle_required > 0.0 and elapsed < settle_required:
                self.metrics.window_gate_skipped_total.inc()
                self._debug_state["gate_skipped_total"] = int(self._debug_state["gate_skipped_total"]) + 1
                self._debug_state["last_gate_passed"] = False
                cpu = self.cpu_provider()
                self.metrics.cpu_percent.set(cpu)
                interval = self.scheduler.observe(
                    has_change=False,
                    message_emitted=bool(events_emitted),
                    cpu_percent=cpu,
                )
                latency = (perf_counter() - started) * 1000
                self.metrics.pipeline_latency_ms.observe(latency)
                self._debug_state["last_changed"] = False
                self._debug_state["last_events_emitted"] = events_emitted
                self._debug_state["events_emitted_total"] = int(self._debug_state["events_emitted_total"]) + int(
                    events_emitted
                )
                self._debug_state["last_decision_reason"] = "window_gate_settling"
                return PipelineRunResult(next_interval_s=interval, events_emitted=events_emitted, changed=False)
            self.metrics.window_gate_active_total.inc()
            self._debug_state["last_gate_passed"] = True
            # Re-check before capture with optional consecutive confirmations to
            # suppress fast app-switch jitter.
            confirmation_samples = max(1, int(gate_cfg.confirmation_samples))
            confirmation_interval_s = max(0.0, float(gate_cfg.confirmation_interval_ms) / 1000.0)
            passed_recheck, frontmost_recheck = await self._confirm_frontmost_app(
                target_app_name=target_app_name,
                samples=confirmation_samples,
                interval_s=confirmation_interval_s,
            )
            self._debug_state["last_frontmost_app_recheck"] = frontmost_recheck or ""
            if not passed_recheck:
                self._foreground_gate_stable_app = None
                self._foreground_gate_stable_since = None
                self.metrics.window_gate_skipped_total.inc()
                self._debug_state["gate_skipped_total"] = int(self._debug_state["gate_skipped_total"]) + 1
                self._debug_state["last_gate_passed"] = False
                cpu = self.cpu_provider()
                self.metrics.cpu_percent.set(cpu)
                interval = self.scheduler.observe(
                    has_change=False,
                    message_emitted=bool(events_emitted),
                    cpu_percent=cpu,
                )
                latency = (perf_counter() - started) * 1000
                self.metrics.pipeline_latency_ms.observe(latency)
                self._debug_state["last_changed"] = False
                self._debug_state["last_events_emitted"] = events_emitted
                self._debug_state["events_emitted_total"] = int(self._debug_state["events_emitted_total"]) + int(
                    events_emitted
                )
                self._debug_state["last_decision_reason"] = "window_gate_recheck_samples_skipped"
                return PipelineRunResult(next_interval_s=interval, events_emitted=events_emitted, changed=False)

            frontmost_app = frontmost_recheck or frontmost_app
            if frontmost_app:
                window_bounds = await asyncio.to_thread(self.window_probe.frontmost_window_bounds, frontmost_app)
                if hasattr(self.window_probe, "frontmost_window_title"):
                    conversation_title = await asyncio.to_thread(self.window_probe.frontmost_window_title, frontmost_app)

        roi, roi_source, roi_reason, roi_confidence = self._resolve_capture_region(window_bounds=window_bounds)
        self.metrics.roi_resolution_total.labels(
            mode=self.config.monitor.capture_scope,
            source=roi_source,
            reason=roi_reason,
        ).inc()
        self.metrics.roi_resolution_confidence.set(roi_confidence)
        self._debug_state["last_roi"] = dict(roi)
        self._debug_state["last_roi_source"] = roi_source
        self._debug_state["last_roi_reason"] = roi_reason
        if roi_source in {"window_bounds", "auto"}:
            self.metrics.window_gate_auto_roi_total.inc()

        capture_result = await asyncio.to_thread(self.capture_adapter.capture, roi)
        masked_raw = self._apply_capture_exclusion_regions(
            raw=capture_result.raw,
            width=capture_result.width,
            height=capture_result.height,
            capture_roi=roi,
        )
        if masked_raw is not capture_result.raw:
            capture_result.raw = masked_raw
        self.metrics.frame_captured_total.inc()
        self._frame_counter += 1
        capture_ts = datetime.now(tz=timezone.utc)
        frame_cache_filename_token = self._frame_cache_timestamp_token(capture_ts)
        if self.window_probe is not None:
            frontmost_postcapture = await asyncio.to_thread(self.window_probe.frontmost_app_name)
            self._debug_state["last_frontmost_app_postcapture"] = frontmost_postcapture or ""
            if not self._app_matches(frontmost_postcapture, target_app_name):
                self._foreground_gate_stable_app = None
                self._foreground_gate_stable_since = None
                self.metrics.window_gate_skipped_total.inc()
                self._debug_state["gate_skipped_total"] = int(self._debug_state["gate_skipped_total"]) + 1
                self._debug_state["last_gate_passed"] = False
                cpu = self.cpu_provider()
                self.metrics.cpu_percent.set(cpu)
                interval = self.scheduler.observe(
                    has_change=False,
                    message_emitted=bool(events_emitted),
                    cpu_percent=cpu,
                )
                latency = (perf_counter() - started) * 1000
                self.metrics.pipeline_latency_ms.observe(latency)
                self._debug_state["last_changed"] = False
                self._debug_state["last_events_emitted"] = events_emitted
                self._debug_state["events_emitted_total"] = int(self._debug_state["events_emitted_total"]) + int(
                    events_emitted
                )
                self._debug_state["last_decision_reason"] = "window_gate_postcapture_skipped"
                return PipelineRunResult(next_interval_s=interval, events_emitted=events_emitted, changed=False)

        frame_id = f"f_{self._frame_counter:06d}"
        public_frame_id = self._compose_public_frame_id(frame_id, frame_cache_filename_token)
        frame_cache_entry: FrameCacheEntry | None = None
        testing_mode = self.config.monitor.frame_cache.testing_mode
        if self.frame_cache.enabled and self.frame_cache.cache_all_frames:
            frame_cache_entry = await asyncio.to_thread(
                self.frame_cache.put,
                frame_id,
                capture_result.raw,
                ".rgb",
                self._PENDING_CACHE_SUBDIR,
                frame_cache_filename_token,
            )
        frame = FrameEvent(
            frame_id=frame_id,
            ts_capture=capture_ts,
            roi_id="default",
            window_id=frontmost_app or self.window_id,
            session_id=self.session_id,
            dpi_scale=1.0,
            frame_hash=f"hash_{self._frame_counter:06d}",
            image=capture_result.raw,
            metadata={
                "roi": roi,
                "size": {"w": capture_result.width, "h": capture_result.height},
                "frontmost_app": frontmost_app or "",
                "conversation_title": conversation_title or "",
                "frame_public_id": public_frame_id,
                "roi_resolution": {
                    "mode": self.config.monitor.capture_scope,
                    "source": roi_source,
                    "confidence": roi_confidence,
                    "reason": roi_reason,
                },
                "frame_cache_path": str(frame_cache_entry.path) if frame_cache_entry is not None else "",
                "frame_cache_filename_token": frame_cache_filename_token,
            },
        )

        ocr_image = self.preprocessor.rgb_bytes_to_png(
            capture_result.raw,
            capture_result.width,
            capture_result.height,
        )
        processing_cache_entry: FrameCacheEntry | None = None
        if (
            testing_mode
            and self.frame_cache.enabled
            and self.frame_cache.keep_processed_frames
            and self.frame_cache.cache_all_frames
        ):
            processing_cache_entry = await asyncio.to_thread(
                self.frame_cache.put,
                frame.frame_id,
                ocr_image,
                ".png",
                self._PENDING_CACHE_SUBDIR,
            )
            if processing_cache_entry is not None:
                frame.metadata["processing_cache_path"] = str(processing_cache_entry.path)

        decision = self.change_detector.detect(self._previous_frame, capture_result.raw)
        self._previous_frame = capture_result.raw

        if not decision.changed:
            await asyncio.to_thread(self.frame_cache.done, processing_cache_entry)
            await asyncio.to_thread(self.frame_cache.done, frame_cache_entry)
            events_emitted += await self._drain_async_vlm_results()
            cpu = self.cpu_provider()
            self.metrics.cpu_percent.set(cpu)
            interval = self.scheduler.observe(
                has_change=False,
                message_emitted=bool(events_emitted),
                cpu_percent=cpu,
            )
            latency = (perf_counter() - started) * 1000
            self.metrics.pipeline_latency_ms.observe(latency)
            self._debug_state["last_changed"] = False
            self._debug_state["last_events_emitted"] = events_emitted
            self._debug_state["events_emitted_total"] = int(self._debug_state["events_emitted_total"]) + int(
                events_emitted
            )
            self._debug_state["last_decision_reason"] = "no_change"
            return PipelineRunResult(next_interval_s=interval, events_emitted=events_emitted, changed=False)

        self.metrics.frame_changed_total.inc()
        self._debug_state["changed_total"] = int(self._debug_state["changed_total"]) + 1

        if self.config.monitor.privacy.debug_dump_enabled:
            await asyncio.to_thread(self.debug_storage.save, frame.frame_id, ocr_image)
        vision_mode = self.config.monitor.vision.mode
        self._debug_state["last_vision_mode"] = vision_mode
        self._debug_state["last_ocr_mode"] = vision_mode
        frame.metadata["vision_mode"] = vision_mode
        current_header_fingerprint = self._compute_header_fingerprint(
            capture_result.raw,
            capture_result.width,
            capture_result.height,
        )

        processing_image = ocr_image
        if processing_cache_entry is None:
            processing_cache_entry = await asyncio.to_thread(
                self.frame_cache.put,
                frame.frame_id,
                ocr_image,
                ".png",
                self._PENDING_CACHE_SUBDIR,
                frame_cache_filename_token,
            )
        if processing_cache_entry is not None:
            cached_bytes = await asyncio.to_thread(self.frame_cache.load, processing_cache_entry)
            if cached_bytes:
                processing_image = cached_bytes
            frame.metadata["processing_cache_path"] = str(processing_cache_entry.path)
        app_name = self._normalize_app_name(frontmost_app or self.window_id)
        frame.metadata["app_name"] = app_name
        (
            candidate_session_key,
            previous_vlm_image,
            expected_conversation_title,
        ) = self._select_incremental_baseline(
            app_name=app_name,
            window_id=frame.window_id,
            window_title=str(frame.metadata.get("conversation_title", "")),
            current_header_fingerprint=current_header_fingerprint,
        )
        frame.metadata["session_key"] = candidate_session_key or ""
        frame.metadata["same_session_locked"] = bool(
            candidate_session_key and not self._is_pending_session_key(candidate_session_key)
        )

        if self._async_vlm_enabled:
            queue_session_key = candidate_session_key or f"pending:{self._public_frame_id(frame)}"
            enqueued = await self._enqueue_async_vlm_job(
                session_key=queue_session_key,
                frame=frame,
                frame_cache_entry=frame_cache_entry,
                processing_cache_entry=processing_cache_entry,
                processing_image=processing_image,
                previous_vlm_image=previous_vlm_image,
                expected_conversation_title=expected_conversation_title,
                ocr_mode=vision_mode,
                capture_width=capture_result.width,
                capture_height=capture_result.height,
                roi=roi,
                similarity_score=decision.similarity_score,
                dedup_reason=decision.reason,
                header_fingerprint=current_header_fingerprint,
            )
            if not enqueued:
                # Queue saturation: drop current changed frame to preserve capture responsiveness.
                await asyncio.to_thread(self.frame_cache.done, processing_cache_entry)
                await asyncio.to_thread(self.frame_cache.done, frame_cache_entry)
            events_emitted += await self._drain_async_vlm_results()
            cpu = self.cpu_provider()
            self.metrics.cpu_percent.set(cpu)
            interval = self.scheduler.observe(
                has_change=True,
                message_emitted=bool(events_emitted),
                cpu_percent=cpu,
            )
            latency = (perf_counter() - started) * 1000
            self.metrics.pipeline_latency_ms.observe(latency)
            self._debug_state["last_changed"] = True
            self._debug_state["last_events_emitted"] = events_emitted
            self._debug_state["events_emitted_total"] = int(self._debug_state["events_emitted_total"]) + int(
                events_emitted
            )
            self._debug_state["last_decision_reason"] = "async_path"
            return PipelineRunResult(next_interval_s=interval, events_emitted=events_emitted, changed=True)

        try:
            ocr_contact_evidence: list[ParsedMessage] | None = None
            parsed, extraction_engine, vlm_meta = await asyncio.to_thread(
                self._run_vlm_structured_path,
                processing_image,
                self._public_frame_id(frame),
                previous_vlm_image,
                expected_conversation_title,
            )
            frame.metadata["vlm"] = vlm_meta
            vlm_title = str(vlm_meta.get("conversation_title", "")).strip()
            if vlm_title:
                frame.metadata["conversation_title"] = vlm_title
            used_fallback = False
        finally:
            await asyncio.to_thread(self.frame_cache.done, processing_cache_entry)
            await asyncio.to_thread(self.frame_cache.done, frame_cache_entry)

        resolved_session_key = await self._finalize_frame_session(frame=frame)
        if resolved_session_key:
            self._touch_session_state(
                resolved_session_key,
                processing_image,
                header_fingerprint=current_header_fingerprint,
                confirmed_title=str(frame.metadata.get("session_name", "")).strip() or None,
            )

        parsed = self._normalize_contact_identity(parsed, frame, ocr_contact_evidence)

        if used_fallback:
            self.metrics.vision_fallback_total.inc()
        events = self.assembler.assemble(
            parsed_messages=parsed,
            frame=frame,
            similarity_score=decision.similarity_score,
            dedup_reason=decision.reason,
            extraction_engine=extraction_engine,
        )
        events_emitted += await self._publish_or_buffer_events(frame=frame, events=events)
        await asyncio.to_thread(self._mark_pending_frame_processed, self._public_frame_id(frame))

        cpu = self.cpu_provider()
        self.metrics.cpu_percent.set(cpu)
        interval = self.scheduler.observe(
            has_change=True,
            message_emitted=bool(events_emitted),
            cpu_percent=cpu,
        )

        latency = (perf_counter() - started) * 1000
        self.metrics.pipeline_latency_ms.observe(latency)
        self._debug_state["last_changed"] = True
        self._debug_state["last_events_emitted"] = events_emitted
        self._debug_state["events_emitted_total"] = int(self._debug_state["events_emitted_total"]) + int(events_emitted)
        self._debug_state["last_decision_reason"] = "sync_path"
        return PipelineRunResult(next_interval_s=interval, events_emitted=events_emitted, changed=True)

    async def _enqueue_async_vlm_job(
        self,
        session_key: str,
        frame: FrameEvent,
        frame_cache_entry: FrameCacheEntry | None,
        processing_cache_entry: FrameCacheEntry | None,
        processing_image: bytes,
        previous_vlm_image: bytes | None,
        expected_conversation_title: str | None,
        ocr_mode: str,
        capture_width: int,
        capture_height: int,
        roi: dict[str, int],
        similarity_score: float,
        dedup_reason: str,
        header_fingerprint: HeaderFingerprint | None,
    ) -> bool:
        if self._total_async_vlm_jobs() >= self._async_vlm_cfg.max_queue:
            if self._async_vlm_cfg.drop_when_queue_full:
                self.metrics.vlm_async_dropped_total.inc()
                self._update_async_vlm_metrics()
                return False
            # Default path: wait for a queue slot to free instead of dropping.
            self.metrics.vlm_async_wait_total.inc()
            slot_opened = await self._wait_for_queue_slot(timeout_s=5.0)
            if not slot_opened:
                # Soft overflow — enqueue anyway to avoid data loss.
                pass

        sequence = self._async_vlm_next_sequence
        self._async_vlm_next_sequence += 1
        jobs = self._async_vlm_jobs_by_session.setdefault(session_key, {})
        task = asyncio.create_task(
            self._run_async_vlm_job(
                sequence=sequence,
                session_key=session_key,
                frame=frame,
                frame_cache_entry=frame_cache_entry,
                processing_cache_entry=processing_cache_entry,
                processing_image=processing_image,
                previous_vlm_image=previous_vlm_image,
                expected_conversation_title=expected_conversation_title,
                ocr_mode=ocr_mode,
                capture_width=capture_width,
                capture_height=capture_height,
                roi=roi,
                similarity_score=similarity_score,
                dedup_reason=dedup_reason,
                header_fingerprint=header_fingerprint,
            ),
            name=f"vlm-async-{session_key}-{sequence}",
        )
        jobs[sequence] = task
        self._async_vlm_jobs_by_sequence[sequence] = (session_key, task)
        self.metrics.vlm_async_enqueued_total.inc()
        self._update_async_vlm_metrics()
        return True

    async def _run_async_vlm_job(
        self,
        sequence: int,
        session_key: str,
        frame: FrameEvent,
        frame_cache_entry: FrameCacheEntry | None,
        processing_cache_entry: FrameCacheEntry | None,
        processing_image: bytes,
        previous_vlm_image: bytes | None,
        expected_conversation_title: str | None,
        ocr_mode: str,
        capture_width: int,
        capture_height: int,
        roi: dict[str, int],
        similarity_score: float,
        dedup_reason: str,
        header_fingerprint: HeaderFingerprint | None,
    ) -> AsyncVLMJobResult:
        parsed: list[ParsedMessage] = []
        extraction_engine = "vlm_structured_litellm"
        used_fallback = False
        vlm_meta: dict[str, object] = {}
        ocr_contact_evidence: list[ParsedMessage] | None = None
        try:
            async with self._async_vlm_gate:
                parsed, extraction_engine, vlm_meta = await asyncio.to_thread(
                    self._run_vlm_structured_path,
                    processing_image,
                    self._public_frame_id(frame),
                    previous_vlm_image,
                    expected_conversation_title,
                )
        except Exception as exc:
            parsed = []
            extraction_engine = "vlm_structured_litellm"
            used_fallback = False
            vlm_meta = {
                "parse_ok": False,
                "error": str(exc),
                "reason": "async_exception",
            }
        finally:
            await asyncio.to_thread(self.frame_cache.done, processing_cache_entry)
            await asyncio.to_thread(self.frame_cache.done, frame_cache_entry)
        return AsyncVLMJobResult(
            sequence=sequence,
            session_key=session_key,
            frame=frame,
            parsed=parsed,
            extraction_engine=extraction_engine,
            vision_mode=ocr_mode,
            processing_image=processing_image,
            used_fallback=used_fallback,
            similarity_score=similarity_score,
            dedup_reason=dedup_reason,
            vlm_meta=vlm_meta,
            raw_cache_entry=frame_cache_entry,
            processing_cache_entry=processing_cache_entry,
            ocr_contact_evidence=ocr_contact_evidence,
            header_fingerprint=header_fingerprint,
        )

    async def _drain_async_vlm_results(self) -> int:
        if not self._async_vlm_jobs_by_sequence:
            self._update_async_vlm_metrics()
            return 0

        emitted_total = 0
        while True:
            next_item = self._async_vlm_jobs_by_sequence.get(self._async_vlm_next_emit_sequence)
            if next_item is None:
                break
            session_key, task = next_item
            if not task.done():
                break

            result: AsyncVLMJobResult | None = None
            try:
                result = task.result()
            except Exception:
                result = None
            finally:
                self._async_vlm_jobs_by_sequence.pop(self._async_vlm_next_emit_sequence, None)
                jobs = self._async_vlm_jobs_by_session.get(session_key)
                if jobs is not None:
                    jobs.pop(self._async_vlm_next_emit_sequence, None)
                    if not jobs:
                        self._async_vlm_jobs_by_session.pop(session_key, None)
                self._async_vlm_next_emit_sequence += 1

            if result is None:
                continue
            if result.used_fallback:
                self.metrics.vision_fallback_total.inc()
            if result.vlm_meta:
                result.frame.metadata["vlm"] = result.vlm_meta
                vlm_title = str(result.vlm_meta.get("conversation_title", "")).strip()
                if vlm_title:
                    result.frame.metadata["conversation_title"] = vlm_title

            resolved_session_key = await self._finalize_frame_session(frame=result.frame)
            if (
                result.vision_mode == "vlm_structured"
                and resolved_session_key
                and not self._is_pending_session_key(resolved_session_key)
            ):
                self._touch_session_state(
                    resolved_session_key,
                    result.processing_image,
                    header_fingerprint=result.header_fingerprint,
                    confirmed_title=str(result.frame.metadata.get("session_name", "")).strip() or None,
                )

            result.parsed = self._normalize_contact_identity(
                result.parsed,
                result.frame,
                result.ocr_contact_evidence,
            )

            events = self.assembler.assemble(
                parsed_messages=result.parsed,
                frame=result.frame,
                similarity_score=result.similarity_score,
                dedup_reason=result.dedup_reason,
                extraction_engine=result.extraction_engine,
            )
            emitted_total += await self._publish_or_buffer_events(frame=result.frame, events=events)
            await asyncio.to_thread(self._mark_pending_frame_processed, self._public_frame_id(result.frame))

        self._update_async_vlm_metrics()
        return emitted_total

    def _update_async_vlm_metrics(self) -> None:
        total = self._total_async_vlm_jobs()
        self.metrics.vlm_async_inflight.set(float(total))
        self._debug_state["per_session_inflight"] = {
            key: len(value) for key, value in self._async_vlm_jobs_by_session.items() if value
        }

    def _resolve_capture_region(self, window_bounds: object | None) -> tuple[dict[str, int], str, str, float]:
        if self.config.monitor.capture_scope == "roi":
            resolution = self._resolve_roi_capture_region(window_bounds=window_bounds)
            return resolution.roi, resolution.source, resolution.reason, resolution.confidence
        bounds = self._extract_window_bounds(window_bounds)
        if bounds is not None:
            x, y, w, h = bounds
            if w > 0 and h > 0:
                return {"x": x, "y": y, "w": w, "h": h}, "window_bounds", "frontmost_window", 1.0
        return self.config.monitor.roi.model_dump(), "config_fallback", "window_bounds_unavailable", 0.0

    def _resolve_roi_capture_region(self, window_bounds: object | None) -> RoiResolution:
        manual_roi = self.config.monitor.roi.model_dump()
        if self.roi_resolver is not None and hasattr(self.roi_resolver, "resolve"):
            return self.roi_resolver.resolve(manual_roi=manual_roi, window_bounds=window_bounds)
        return RoiResolution(
            roi=manual_roi,
            source="manual_fallback",
            confidence=0.0,
            reason="roi_resolver_unavailable",
        )

    @staticmethod
    def _extract_window_bounds(bounds: object | None) -> tuple[int, int, int, int] | None:
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

    async def shutdown(self) -> None:
        if not self._async_vlm_jobs_by_sequence:
            return
        deadline = asyncio.get_running_loop().time() + 40.0
        while self._async_vlm_jobs_by_sequence:
            pending: list[asyncio.Task[AsyncVLMJobResult]] = [
                task
                for _, task in self._async_vlm_jobs_by_sequence.values()
                if not task.done()
            ]
            if pending:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    break
                await asyncio.wait(
                    pending,
                    timeout=min(1.0, max(0.05, remaining)),
                    return_when=asyncio.FIRST_COMPLETED,
                )
            await self._drain_async_vlm_results()

        if self._async_vlm_jobs_by_sequence:
            all_tasks: list[asyncio.Task[AsyncVLMJobResult]] = []
            for _, task in self._async_vlm_jobs_by_sequence.values():
                all_tasks.append(task)
            for task in all_tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*all_tasks, return_exceptions=True)
            self._async_vlm_jobs_by_session.clear()
            self._async_vlm_jobs_by_sequence.clear()
        self._update_async_vlm_metrics()

    def set_capture_enabled(self, enabled: bool) -> None:
        self._capture_enabled = enabled
        self._debug_state["capture_enabled"] = enabled

    def get_debug_state(self) -> dict[str, object]:
        state = dict(self._debug_state)
        state["async_vlm_inflight"] = self._total_async_vlm_jobs()
        return state

    def _total_async_vlm_jobs(self) -> int:
        return len(self._async_vlm_jobs_by_sequence)

    async def _wait_for_queue_slot(self, timeout_s: float = 5.0) -> bool:
        """Wait for at least one async VLM job to complete, freeing a queue slot."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_s
        while self._total_async_vlm_jobs() >= self._async_vlm_cfg.max_queue:
            remaining = deadline - loop.time()
            if remaining <= 0:
                return False
            pending = [
                task
                for _, task in self._async_vlm_jobs_by_sequence.values()
                if not task.done()
            ]
            if not pending:
                break
            try:
                await asyncio.wait(
                    pending,
                    timeout=min(1.0, remaining),
                    return_when=asyncio.FIRST_COMPLETED,
                )
            except Exception:
                break
            await self._drain_async_vlm_results()
        return True

    async def _finalize_frame_session(self, frame: FrameEvent) -> str:
        locked_session_key = str(frame.metadata.get("session_key", "")).strip()
        locked_conversation_title = self._resolve_session_title_alias(
            self._normalize_app_name(str(frame.metadata.get("frontmost_app", "")).strip() or frame.window_id),
            frame.window_id,
            str(frame.metadata.get("conversation_title", "")).strip(),
        )
        if (
            bool(frame.metadata.get("same_session_locked"))
            and locked_session_key
            and not self._is_pending_session_key(locked_session_key)
        ):
            locked_state = self._session_states.get(locked_session_key)
            if locked_state is not None:
                if (
                    locked_conversation_title
                    and locked_state.last_confirmed_title
                    and not self._titles_equivalent(locked_conversation_title, locked_state.last_confirmed_title)
                    and not self._window_title_is_generic(
                        self._normalize_app_name(str(frame.metadata.get("frontmost_app", "")).strip() or frame.window_id),
                        locked_conversation_title,
                    )
                ):
                    frame.metadata["same_session_locked"] = False
                else:
                    frame.metadata["session_key"] = locked_session_key
                    frame.metadata["session_name"] = (
                        locked_state.cache_session_name
                        or locked_state.last_confirmed_title
                        or self._session_key_session_name(locked_session_key)
                    )
                    self._mark_active_session(locked_session_key)
                    return locked_session_key

        app_name = self._normalize_app_name(str(frame.metadata.get("frontmost_app", "")).strip() or frame.window_id)
        normalized_title = self._resolve_session_title_alias(
            app_name,
            frame.window_id,
            str(frame.metadata.get("conversation_title", "")),
        )
        if normalized_title:
            existing_session_key = self._find_existing_session_key(app_name, normalized_title)
            if existing_session_key:
                state = self._session_states.get(existing_session_key)
                frame.metadata["session_key"] = existing_session_key
                frame.metadata["session_name"] = (
                    state.cache_session_name
                    if state is not None and state.cache_session_name
                    else normalized_title
                )
                self._mark_active_session(existing_session_key)
                return existing_session_key

            session_key = self._build_session_key(app_name, normalized_title)
            if session_key:
                frame.metadata["session_key"] = session_key
                frame.metadata["session_name"] = normalized_title
                self._mark_active_session(session_key)
                return session_key

        frame.metadata["session_key"] = ""
        frame.metadata["session_name"] = ""
        return ""

    async def _publish_or_buffer_events(self, frame: FrameEvent, events: list[MessageEvent]) -> int:
        if not events:
            return 0
        self.output_gateway.push(events)
        return len(events)

    def _touch_session_state(
        self,
        session_key: str,
        latest_vlm_image: bytes | None,
        header_fingerprint: HeaderFingerprint | None = None,
        confirmed_title: str | None = None,
    ) -> None:
        if self._is_pending_session_key(session_key):
            return
        state = self._session_states.get(session_key)
        if state is None:
            state = SessionState()
            self._session_states[session_key] = state
        if latest_vlm_image is not None:
            state.last_vlm_image = latest_vlm_image
        if header_fingerprint is not None:
            state.last_header_fingerprint = header_fingerprint
        if confirmed_title:
            state.last_confirmed_title = confirmed_title
            if not state.cache_session_name:
                state.cache_session_name = confirmed_title
        state.last_seen_ts = datetime.now(tz=timezone.utc).isoformat()

    def _mark_active_session(self, session_key: str) -> None:
        if not session_key or self._is_pending_session_key(session_key):
            return
        if self._active_session_key != session_key:
            self._session_switch_count += 1
            self._debug_state["session_switch_count"] = self._session_switch_count
        self._active_session_key = session_key
        self._debug_state["active_session_key"] = session_key

    @staticmethod
    def _is_pending_session_key(session_key: str | None) -> bool:
        return bool(session_key and str(session_key).startswith("pending:"))

    @staticmethod
    def _normalize_app_name(raw: str | None) -> str:
        value = (raw or "").strip()
        if not value:
            return "微信"
        lower = value.lower()
        if "wechat" in lower or "微信" in value:
            return "微信"
        return value

    def _build_session_key(self, app_name: str, conversation_title: str | None) -> str | None:
        title = self._canonicalize_session_title(conversation_title)
        if not title:
            return None
        return f"{self._normalize_app_name(app_name)}::{title}"

    @staticmethod
    def _frame_cache_timestamp_token(capture_ts: datetime) -> str:
        return capture_ts.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")

    @staticmethod
    def _compose_public_frame_id(frame_id: str, filename_token: str | None) -> str:
        token = (filename_token or "").strip()
        if not token:
            return frame_id
        return f"{frame_id}_{token}"

    @staticmethod
    def _parse_timestamp_token(token: str | None) -> datetime | None:
        raw = (token or "").strip()
        if not raw:
            return None
        try:
            return datetime.strptime(raw, "%Y%m%dT%H%M%S%fZ").replace(tzinfo=timezone.utc)
        except ValueError:
            return None

    @staticmethod
    def _public_frame_id(frame: FrameEvent) -> str:
        return str(frame.metadata.get("frame_public_id", "")).strip() or frame.frame_id

    async def _recover_startup_pending_frames(self) -> int:
        if self._startup_pending_recovery_complete or not self.frame_cache.enabled:
            return 0

        self._startup_pending_recovery_complete = True
        recovered_frames = 0
        emitted_total = 0
        pending_entries = await asyncio.to_thread(self.frame_cache.list_entries, self._PENDING_CACHE_SUBDIR, ".png")
        for entry in pending_entries:
            public_frame_id = self._compose_public_frame_id(entry.frame_id, entry.filename_token)
            if public_frame_id in self._processed_pending_frame_ids:
                continue
            image_png = await asyncio.to_thread(self.frame_cache.load, entry)
            if not image_png:
                continue

            capture_ts = self._parse_timestamp_token(entry.filename_token)
            if capture_ts is None:
                try:
                    capture_ts = datetime.fromtimestamp(entry.path.stat().st_mtime, tz=timezone.utc)
                except OSError:
                    capture_ts = datetime.now(tz=timezone.utc)
            frame = FrameEvent(
                frame_id=entry.frame_id,
                ts_capture=capture_ts,
                roi_id="recovered_pending",
                window_id=self.window_id,
                session_id=self.session_id,
                dpi_scale=1.0,
                frame_hash=f"recovered_{public_frame_id}",
                image=None,
                metadata={
                    "frame_public_id": public_frame_id,
                    "frontmost_app": "",
                    "conversation_title": "",
                    "processing_cache_path": str(entry.path),
                    "recovered_from_pending": True,
                },
            )
            parsed, extraction_engine, vlm_meta = await asyncio.to_thread(
                self._run_vlm_structured_path,
                image_png,
                public_frame_id,
                None,
                None,
            )
            if vlm_meta:
                frame.metadata["vlm"] = vlm_meta
                vlm_title = str(vlm_meta.get("conversation_title", "")).strip()
                if vlm_title:
                    frame.metadata["conversation_title"] = vlm_title

            resolved_session_key = await self._finalize_frame_session(frame=frame)
            if resolved_session_key:
                self._touch_session_state(
                    resolved_session_key,
                    image_png,
                    header_fingerprint=None,
                    confirmed_title=str(frame.metadata.get("session_name", "")).strip() or None,
                )

            parsed = self._normalize_contact_identity(parsed, frame, None)
            events = self.assembler.assemble(
                parsed_messages=parsed,
                frame=frame,
                similarity_score=0.0,
                dedup_reason="startup_pending_recovery",
                extraction_engine=extraction_engine,
            )
            emitted_total += await self._publish_or_buffer_events(frame=frame, events=events)
            await asyncio.to_thread(self._mark_pending_frame_processed, public_frame_id)
            recovered_frames += 1
            await asyncio.to_thread(self.frame_cache.done, entry)

        self._debug_state["startup_pending_recovered_frames"] = recovered_frames
        self._debug_state["startup_pending_recovery_done"] = True
        return emitted_total

    def _load_processed_pending_frame_ids(self) -> set[str]:
        if not self._pending_manifest_path.exists():
            return set()
        try:
            lines = self._pending_manifest_path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return set()
        return {line.strip() for line in lines if line.strip()}

    def _mark_pending_frame_processed(self, public_frame_id: str) -> None:
        if not self.frame_cache.enabled:
            return
        frame_id = public_frame_id.strip()
        if not frame_id or frame_id in self._processed_pending_frame_ids:
            return
        self._processed_pending_frame_ids.add(frame_id)
        self._debug_state["processed_pending_frames"] = len(self._processed_pending_frame_ids)
        try:
            self._pending_manifest_path.parent.mkdir(parents=True, exist_ok=True)
            with self._pending_manifest_path.open("a", encoding="utf-8") as handle:
                handle.write(f"{frame_id}\n")
        except OSError:
            return

    def _find_existing_session_key(self, app_name: str, normalized_title: str) -> str | None:
        normalized_app = self._normalize_app_name(app_name)
        active_session_key = self._active_session_key
        if active_session_key:
            active_state = self._session_states.get(active_session_key)
            if (
                active_state is not None
                and active_session_key.startswith(f"{normalized_app}::")
                and active_state.last_confirmed_title
                and self._titles_equivalent(normalized_title, active_state.last_confirmed_title)
            ):
                return active_session_key

        for session_key, state in self._session_states.items():
            if not session_key.startswith(f"{normalized_app}::"):
                continue
            if not state.last_confirmed_title:
                continue
            if self._titles_equivalent(normalized_title, state.last_confirmed_title):
                return session_key
        return None

    def _select_incremental_baseline(
        self,
        app_name: str,
        window_id: str,
        window_title: str,
        current_header_fingerprint: HeaderFingerprint | None,
    ) -> tuple[str | None, bytes | None, str | None]:
        self._debug_state["last_same_session_decision"] = "snapshot_required"
        self._debug_state["last_header_band_similarity"] = 0.0
        self._debug_state["last_header_focus_similarity"] = 0.0
        self._debug_state["last_same_session_confidence"] = 0.0

        active_session_key = self._active_session_key
        if (
            not active_session_key
            or self._is_pending_session_key(active_session_key)
            or not active_session_key.startswith(f"{self._normalize_app_name(app_name)}::")
        ):
            return None, None, None

        active_state = self._session_states.get(active_session_key)
        if active_state is None or active_state.last_vlm_image is None:
            return None, None, None

        normalized_title = self._resolve_session_title_alias(app_name, window_id, window_title)
        if (
            normalized_title
            and active_state.last_confirmed_title
            and not self._titles_equivalent(normalized_title, active_state.last_confirmed_title)
            and not self._window_title_is_generic(app_name, normalized_title)
        ):
            self._debug_state["last_same_session_decision"] = "window_title_mismatch"
            return None, None, None

        band_similarity = 0.0
        focus_similarity = 0.0
        confidence = 0.0
        decision = "uncertain"
        if current_header_fingerprint is not None and active_state.last_header_fingerprint is not None:
            band_similarity = self._hash_similarity(
                current_header_fingerprint.header_band_hash,
                active_state.last_header_fingerprint.header_band_hash,
            )
            focus_similarity = self._hash_similarity(
                current_header_fingerprint.header_focus_hash,
                active_state.last_header_fingerprint.header_focus_hash,
            )
            confidence = (focus_similarity * 0.75) + (band_similarity * 0.25)
            if focus_similarity >= 0.98 and confidence >= 0.97:
                decision = "same_session"
            elif focus_similarity < 0.92 or confidence < 0.90:
                decision = "snapshot_required"
        else:
            if (
                normalized_title
                and active_state.last_confirmed_title
                and self._titles_equivalent(normalized_title, active_state.last_confirmed_title)
                and not self._window_title_is_generic(app_name, normalized_title)
            ):
                decision = "same_session_title_fallback"

        self._debug_state["last_same_session_decision"] = decision
        self._debug_state["last_header_band_similarity"] = round(band_similarity, 4)
        self._debug_state["last_header_focus_similarity"] = round(focus_similarity, 4)
        self._debug_state["last_same_session_confidence"] = round(confidence, 4)

        if decision.startswith("same_session"):
            return active_session_key, active_state.last_vlm_image, active_state.last_confirmed_title
        return None, None, None

    def _compute_header_fingerprint(
        self,
        image: bytes,
        width: int,
        height: int,
    ) -> HeaderFingerprint | None:
        header_band_hash = self._compute_roi_average_hash(
            image,
            width,
            height,
            x_start_ratio=0.02,
            x_end_ratio=0.98,
            y_start_ratio=0.00,
            y_end_ratio=0.12,
        )
        header_focus_hash = self._compute_roi_average_hash(
            image,
            width,
            height,
            x_start_ratio=0.30,
            x_end_ratio=0.82,
            y_start_ratio=0.00,
            y_end_ratio=0.11,
        )
        if not header_band_hash or not header_focus_hash:
            return None
        return HeaderFingerprint(
            header_band_hash=header_band_hash,
            header_focus_hash=header_focus_hash,
        )

    def _compute_roi_average_hash(
        self,
        image: bytes,
        width: int,
        height: int,
        *,
        x_start_ratio: float,
        x_end_ratio: float,
        y_start_ratio: float,
        y_end_ratio: float,
        out_w: int = 16,
        out_h: int = 8,
    ) -> str | None:
        if width <= 0 or height <= 0:
            return None
        expected_size = width * height * 3
        if len(image) != expected_size:
            return None

        x0 = max(0, min(width - 1, int(width * x_start_ratio)))
        x1 = max(x0 + 1, min(width, int(width * x_end_ratio)))
        y0 = max(0, min(height - 1, int(height * y_start_ratio)))
        y1 = max(y0 + 1, min(height, int(height * y_end_ratio)))
        roi_w = x1 - x0
        roi_h = y1 - y0
        if roi_w <= 0 or roi_h <= 0:
            return None

        samples: list[int] = []
        for oy in range(out_h):
            src_y = y0 + min(roi_h - 1, int((oy + 0.5) * roi_h / out_h))
            row_offset = src_y * width * 3
            for ox in range(out_w):
                src_x = x0 + min(roi_w - 1, int((ox + 0.5) * roi_w / out_w))
                idx = row_offset + (src_x * 3)
                r = image[idx]
                g = image[idx + 1]
                b = image[idx + 2]
                gray = int((r * 299 + g * 587 + b * 114) / 1000)
                samples.append(gray)

        if not samples:
            return None
        avg = sum(samples) / len(samples)
        return "".join("1" if value >= avg else "0" for value in samples)

    @staticmethod
    def _hash_similarity(left: str, right: str) -> float:
        if not left or not right or len(left) != len(right):
            return 0.0
        matches = sum(1 for a, b in zip(left, right) if a == b)
        return matches / len(left)

    def _window_title_is_generic(self, app_name: str, title: str) -> bool:
        normalized_title = self._normalize_conversation_title(title or "")
        if not normalized_title:
            return True
        return normalized_title == self._normalize_app_name(app_name)

    @staticmethod
    def _default_cpu_provider() -> float:
        try:
            import psutil

            return float(psutil.cpu_percent(interval=None))
        except Exception:
            return 0.0

    @staticmethod
    def _app_matches(frontmost_app: str | None, target_app: str) -> bool:
        if not target_app:
            return True
        if not frontmost_app:
            return False
        target = target_app.strip().lower()
        front = frontmost_app.strip().lower()
        # WeChat app name can appear as "WeChat" or "微信" depending on locale/system.
        if target in {"wechat", "微信"}:
            if front in {"wechat", "微信"}:
                return True
            return (
                front.startswith("wechat ")
                or front.startswith("wechat-")
                or front.startswith("wechat_")
                or front.startswith("微信")
            )
        if front == target:
            return True
        if target in front:
            return True
        return False

    async def _confirm_frontmost_app(
        self,
        target_app_name: str,
        samples: int,
        interval_s: float,
    ) -> tuple[bool, str | None]:
        if self.window_probe is None:
            return True, None
        checks = max(1, int(samples))
        sleep_s = max(0.0, float(interval_s))
        last_name: str | None = None
        for idx in range(checks):
            last_name = await asyncio.to_thread(self.window_probe.frontmost_app_name)
            if not self._app_matches(last_name, target_app_name):
                return False, last_name
            if idx < checks - 1 and sleep_s > 0.0:
                await asyncio.sleep(sleep_s)
        return True, last_name

    def _run_vlm_structured_path(
        self,
        ocr_image: bytes,
        frame_id: str,
        previous_vlm_image: bytes | None = None,
        expected_conversation_title: str | None = None,
    ) -> tuple[list[ParsedMessage], str, dict[str, object]]:
        self.metrics.vision_requests_total.inc()
        engine = "vlm_structured_litellm"
        self.metrics.vision_engine_total.labels(engine=engine).inc()
        self.metrics.noise_tokens_filtered_total.inc(0)

        if self.vlm_structured_adapter is None:
            self._debug_state["last_error"] = "vlm_adapter_missing"
            self.metrics.vision_empty_total.inc()
            self.metrics.messages_extracted_total.inc(0)
            self.metrics.messages_published_from_vision_total.inc(0)
            self.metrics.vision_message_hit_rate.set(0.0)
            return [], engine, {"parse_ok": False, "error": "vlm_adapter_missing"}

        use_incremental = (
            previous_vlm_image is not None
            and hasattr(self.vlm_structured_adapter, "extract_structured_incremental")
        )
        self._debug_state["last_vlm_incremental_fallback_reason"] = ""
        if use_incremental:
            result = self.vlm_structured_adapter.extract_structured_incremental(
                older_image_png=previous_vlm_image,
                newer_image_png=ocr_image,
                expected_conversation_title=expected_conversation_title,
            )
            if (not result.parse_ok or not result.messages) and hasattr(self.vlm_structured_adapter, "extract_structured"):
                self._debug_state["last_vlm_incremental_fallback_reason"] = (
                    "parse_failed" if not result.parse_ok else "empty_incremental"
                )
                result = self.vlm_structured_adapter.extract_structured(
                    ocr_image,
                    expected_conversation_title=expected_conversation_title,
                )
        else:
            result = self.vlm_structured_adapter.extract_structured(
                ocr_image,
                expected_conversation_title=expected_conversation_title,
            )
        self._debug_state["last_error"] = result.error or ""
        self._debug_state["last_vlm_parse_ok"] = bool(result.parse_ok)
        self._debug_state["last_vlm_roundtrip_ms"] = round(float(result.roundtrip_ms), 3)
        parsed: list[ParsedMessage] = []
        for item in result.messages:
            normalized_text = item.text.strip()
            if not normalized_text:
                desc = (item.non_text_description or "").strip()
                ctype = (item.content_type or "unknown").strip()
                if desc:
                    normalized_text = f"[{ctype}] {desc}"
                else:
                    normalized_text = "[unknown_non_text]"
            time_anchor_value = None
            if item.time_anchor is not None:
                anchor_value = (item.time_anchor.value or "").strip()
                anchor_source = (item.time_anchor.source or "").strip().lower()
                if anchor_value and anchor_source not in {"capture_fallback", "unknown"}:
                    time_anchor_value = anchor_value
            non_text_signature = None
            if item.non_text_signature_parts:
                normalized_parts = sorted(
                    {
                        str(part).strip().lower()
                        for part in item.non_text_signature_parts
                        if str(part).strip()
                    }
                )
                if normalized_parts:
                    content_type = (item.content_type or "unknown").strip().lower() or "unknown"
                    non_text_signature = f"{content_type}:{'|'.join(normalized_parts)}"
            parsed.append(
                ParsedMessage(
                    sender=item.sender,
                    text=normalized_text,
                    box=[0, 0, 0, 0],
                    confidence=item.confidence,
                    source_frame=frame_id,
                    contact_name=item.contact_name,
                    contact_name_explicit=bool(
                        item.sender == "contact" and (item.contact_name or "").strip()
                    ),
                    content_type=(item.content_type or "").strip() or None,
                    non_text_description=(item.non_text_description or "").strip() or None,
                    non_text_signature=non_text_signature,
                    quoted_message=(
                        None
                        if item.quoted_message is None or not (item.quoted_message.text or "").strip()
                        else {
                            "text": item.quoted_message.text.strip(),
                            "sender_name": (item.quoted_message.sender_name or "").strip() or None,
                        }
                    ),
                    time_anchor=time_anchor_value,
                )
            )

        self.metrics.messages_extracted_total.inc(len(parsed))
        self.metrics.messages_published_from_vision_total.inc(len(parsed))
        self.metrics.vision_message_hit_rate.set(1.0 if parsed else 0.0)
        if parsed:
            avg_conf = mean(item.confidence for item in parsed)
            self.metrics.message_confidence_avg.set(avg_conf)
            for item in parsed:
                self.metrics.message_confidence.observe(item.confidence)
        else:
            self.metrics.vision_empty_total.inc()

        return (
            parsed,
            engine,
            {
                "parse_ok": bool(result.parse_ok),
                "error": result.error or "",
                "roundtrip_ms": result.roundtrip_ms,
                "litellm_duration_ms": result.litellm_duration_ms if result.litellm_duration_ms is not None else 0.0,
                "provider_duration_ms": result.provider_duration_ms if result.provider_duration_ms is not None else 0.0,
                "reason": "processed",
                "conversation_title": (result.conversation_title or "").strip(),
                "incremental_used": use_incremental,
                "expected_conversation_title": (expected_conversation_title or "").strip(),
                "schema_version": getattr(result, "schema_version", "") or "",
                "conversation": getattr(result, "conversation", None) or {},
                "window_time_context": getattr(result, "window_time_context", None) or {},
                "extraction_meta": getattr(result, "extraction_meta", None) or {},
            },
        )

    def _normalize_contact_identity(
        self,
        parsed: list[ParsedMessage],
        frame: FrameEvent,
        ocr_contact_evidence: list[ParsedMessage] | None = None,
    ) -> list[ParsedMessage]:
        if not parsed:
            return parsed

        title = self._normalize_conversation_title(str(frame.metadata.get("conversation_title", "")).strip())
        if not title:
            return parsed

        session_key = str(frame.metadata.get("session_key", "")).strip()
        state = self._session_states.setdefault(session_key, SessionState()) if session_key else None
        if state and state.group_chat_detected:
            return parsed
        if state and state.locked_contact_name:
            return self._apply_locked_contact_name(parsed, state.locked_contact_name)

        contact_messages = [item for item in parsed if item.sender == "contact"]
        if not contact_messages:
            return parsed

        explicit_group_names = self._extract_explicit_group_contact_names(
            ocr_contact_evidence or parsed,
            title,
        )
        if state is not None:
            for key in explicit_group_names:
                state.explicit_group_contact_name_counts[key] = (
                    state.explicit_group_contact_name_counts.get(key, 0) + 1
                )

        strong_group_signal = False
        if state is not None:
            explicit_name_count = sum(
                1 for count in state.explicit_group_contact_name_counts.values() if count >= 1
            )
            strong_group_signal = explicit_name_count >= 2
        if strong_group_signal:
            if state is not None:
                state.group_chat_detected = True
                state.locked_contact_name = None
            return parsed

        if state is not None:
            state.locked_contact_name = title
        return self._apply_locked_contact_name(parsed, title)

    def _apply_locked_contact_name(
        self,
        parsed: list[ParsedMessage],
        contact_name: str,
    ) -> list[ParsedMessage]:
        normalized_contact_name = contact_name.strip()
        if not normalized_contact_name:
            return parsed
        normalized: list[ParsedMessage] = []
        for item in parsed:
            next_contact_name = normalized_contact_name if item.sender == "contact" else None
            if (
                item.sender == "contact"
                and item.contact_name_explicit
                and (item.contact_name or "").strip()
                and not self._titles_equivalent(item.contact_name, normalized_contact_name)
            ):
                normalized.append(item)
                continue
            if item.contact_name == next_contact_name:
                normalized.append(item)
                continue
            normalized.append(
                item.model_copy(
                    update={
                        "contact_name": next_contact_name,
                        "contact_name_explicit": False,
                    }
                )
            )
        return normalized

    def _extract_explicit_group_contact_names(
        self,
        evidence: list[ParsedMessage],
        conversation_title: str,
    ) -> set[str]:
        names: set[str] = set()
        for item in evidence:
            if item.sender != "contact":
                continue
            if not item.contact_name_explicit:
                continue
            raw_name = (item.contact_name or "").strip()
            if not raw_name:
                continue
            normalized_name = self._normalize_conversation_title(raw_name) or raw_name
            if self._titles_equivalent(normalized_name, conversation_title):
                continue
            key = self._title_visible_form(normalized_name)
            if not key:
                continue
            names.add(key)
        return names

    def _normalize_conversation_title(self, raw: str) -> str | None:
        title = (raw or "").strip()
        if not title:
            return None
        title = self._chat_unread_suffix_pattern.sub("", title).strip()
        title = re.sub(r"\s+-\s*(微信|wechat)\s*$", "", title, flags=re.IGNORECASE).strip()
        if not title:
            return None
        lower = title.lower()
        deny_exact = {
            "微信",
            "wechat",
            "聊天信息",
            "搜索",
            "更多",
            "群公告",
            "返回",
            "消息",
        }
        if lower in deny_exact or title in deny_exact:
            return None
        if self._chat_time_pattern.match(title):
            return None
        return title

    def _canonicalize_session_title(self, raw: str | None) -> str | None:
        title = self._normalize_conversation_title(raw or "")
        if not title:
            return None

        visible = self._title_visible_form(title)
        text_core = self._title_text_fingerprint(visible)
        if text_core:
            return text_core
        return visible or None

    def _resolve_session_title_alias(self, app_name: str, window_id: str, raw: str | None) -> str | None:
        _ = app_name
        _ = window_id
        return self._normalize_conversation_title(raw or "")

    def _titles_equivalent(self, left: str | None, right: str | None) -> bool:
        left_norm = self._normalize_conversation_title(left or "")
        right_norm = self._normalize_conversation_title(right or "")
        if not left_norm or not right_norm:
            return False
        if left_norm == right_norm:
            return True

        left_visible = self._title_visible_form(left_norm)
        right_visible = self._title_visible_form(right_norm)
        if left_visible == right_visible:
            return True

        left_core = self._title_text_fingerprint(left_visible)
        right_core = self._title_text_fingerprint(right_visible)
        if left_core and right_core and left_core == right_core:
            return True
        if left_core and right_core:
            if min(len(left_core), len(right_core)) >= 4 and (left_core in right_core or right_core in left_core):
                return True
            return SequenceMatcher(None, left_core, right_core).ratio() >= 0.86

        return SequenceMatcher(None, left_visible, right_visible).ratio() >= 0.66

    def _title_visible_form(self, raw: str) -> str:
        visible = unicodedata.normalize("NFKC", raw)
        visible = self._title_invisible_pattern.sub("", visible)
        visible = re.sub(r"\s+", " ", visible).strip()
        visible = re.sub(r"\s+([._-])", r"\1", visible)
        visible = re.sub(r"([._-])\s+", r"\1", visible)
        return visible

    def _title_text_fingerprint(self, raw: str) -> str:
        if not raw:
            return ""
        if not self._title_text_char_pattern.search(raw):
            return ""
        chars: list[str] = []
        previous_was_space = False
        for ch in raw:
            category = unicodedata.category(ch)
            if category.startswith(("L", "N")):
                chars.append(ch.lower())
                previous_was_space = False
                continue
            if ch in {".", "_", "-"}:
                chars.append(ch)
                previous_was_space = False
                continue
            if ch.isspace() and not previous_was_space:
                chars.append(" ")
                previous_was_space = True
        return "".join(chars).strip()

    def _apply_capture_exclusion_regions(
        self,
        raw: bytes,
        width: int,
        height: int,
        capture_roi: dict[str, int],
    ) -> bytes:
        if self.config.monitor.frame_cache.testing_mode:
            self._debug_state["last_exclusion_regions_applied"] = 0
            return raw
        regions = self.config.monitor.capture_exclusion_regions
        if not regions or width <= 0 or height <= 0:
            self._debug_state["last_exclusion_regions_applied"] = 0
            return raw
        try:
            roi_x = int(capture_roi.get("x", 0))
            roi_y = int(capture_roi.get("y", 0))
            roi_w = int(capture_roi.get("w", width))
            roi_h = int(capture_roi.get("h", height))
        except Exception:
            self._debug_state["last_exclusion_regions_applied"] = 0
            return raw
        if roi_w <= 0 or roi_h <= 0:
            self._debug_state["last_exclusion_regions_applied"] = 0
            return raw

        mutable: bytearray | None = None
        applied = 0
        stride = width * 3
        for region in regions:
            if isinstance(region, dict):
                ex_x = int(region.get("x", 0))
                ex_y = int(region.get("y", 0))
                ex_w = int(region.get("w", 0))
                ex_h = int(region.get("h", 0))
            else:
                ex_x = int(getattr(region, "x", 0))
                ex_y = int(getattr(region, "y", 0))
                ex_w = int(getattr(region, "w", 0))
                ex_h = int(getattr(region, "h", 0))
            if ex_w <= 0 or ex_h <= 0:
                continue
            # Convert absolute exclusion region to capture-local coordinates.
            x1 = max(0, ex_x - roi_x)
            y1 = max(0, ex_y - roi_y)
            x2 = min(width, ex_x + ex_w - roi_x)
            y2 = min(height, ex_y + ex_h - roi_y)
            if x2 <= x1 or y2 <= y1:
                continue
            if mutable is None:
                mutable = bytearray(raw)
            for y in range(y1, y2):
                row_base = y * stride
                start = row_base + (x1 * 3)
                end = row_base + (x2 * 3)
                mutable[start:end] = b"\x00" * (end - start)
            applied += 1
        self._debug_state["last_exclusion_regions_applied"] = applied
        if mutable is None:
            return raw
        return bytes(mutable)
