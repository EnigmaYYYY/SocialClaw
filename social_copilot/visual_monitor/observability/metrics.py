from __future__ import annotations

from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram, generate_latest


class MonitorMetrics:
    def __init__(self) -> None:
        self.registry = CollectorRegistry(auto_describe=True)
        self.frame_captured_total = Counter(
            "visual_monitor_frame_captured_total",
            "Total number of frames captured from ROI",
            registry=self.registry,
        )
        self.frame_changed_total = Counter(
            "visual_monitor_frame_changed_total",
            "Total number of frames considered changed and sent to VLM extraction",
            registry=self.registry,
        )
        self.vision_requests_total = Counter(
            "visual_monitor_vision_requests_total",
            "Total number of VLM extraction requests",
            registry=self.registry,
        )
        self.vision_fallback_total = Counter(
            "visual_monitor_vision_fallback_total",
            "Total number of VLM fallback executions",
            registry=self.registry,
        )
        self.vision_engine_total = Counter(
            "visual_monitor_vision_engine_total",
            "Total VLM extraction executions by engine",
            labelnames=("engine",),
            registry=self.registry,
        )
        self.messages_extracted_total = Counter(
            "visual_monitor_messages_extracted_total",
            "Total number of structured messages produced by VLM extraction",
            registry=self.registry,
        )
        self.vision_empty_total = Counter(
            "visual_monitor_vision_empty_total",
            "Total VLM extraction runs with zero messages",
            registry=self.registry,
        )
        self.message_confidence_avg = Gauge(
            "visual_monitor_message_confidence_avg",
            "Average confidence of extracted messages in the latest VLM run",
            registry=self.registry,
        )
        self.message_confidence = Histogram(
            "visual_monitor_message_confidence",
            "Distribution of extracted message confidence values",
            registry=self.registry,
            buckets=(0.1, 0.3, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0),
        )
        self.messages_published_from_vision_total = Counter(
            "visual_monitor_messages_published_from_vision_total",
            "Total number of extracted messages accepted for event publishing",
            registry=self.registry,
        )
        self.vision_message_hit_rate = Gauge(
            "visual_monitor_vision_message_hit_rate",
            "Extracted-message hit rate for the latest VLM run",
            registry=self.registry,
        )
        self.events_published_total = Counter(
            "visual_monitor_events_published_total",
            "Total number of message events published to the output bus",
            registry=self.registry,
        )
        self.events_polled_total = Counter(
            "visual_monitor_events_polled_total",
            "Total number of message events consumed via poll API",
            registry=self.registry,
        )
        self.window_gate_skipped_total = Counter(
            "visual_monitor_window_gate_skipped_total",
            "Total monitor loops skipped because target app is not foreground",
            registry=self.registry,
        )
        self.window_gate_active_total = Counter(
            "visual_monitor_window_gate_active_total",
            "Total monitor loops where foreground app matched target app",
            registry=self.registry,
        )
        self.window_gate_auto_roi_total = Counter(
            "visual_monitor_window_gate_auto_roi_total",
            "Total monitor loops where ROI was auto-derived from frontmost app window",
            registry=self.registry,
        )
        self.roi_resolution_total = Counter(
            "visual_monitor_roi_resolution_total",
            "Total ROI resolution decisions by mode/source/reason",
            labelnames=("mode", "source", "reason"),
            registry=self.registry,
        )
        self.roi_resolution_confidence = Gauge(
            "visual_monitor_roi_resolution_confidence",
            "Confidence score from the latest ROI resolution",
            registry=self.registry,
        )
        self.noise_tokens_filtered_total = Counter(
            "visual_monitor_noise_tokens_filtered_total",
            "Total pre-parser noise tokens filtered before VLM extraction",
            registry=self.registry,
        )
        self.vlm_async_enqueued_total = Counter(
            "visual_monitor_vlm_async_enqueued_total",
            "Total changed frames enqueued to async VLM processing queue",
            registry=self.registry,
        )
        self.vlm_async_dropped_total = Counter(
            "visual_monitor_vlm_async_dropped_total",
            "Total changed frames dropped due to async VLM queue pressure",
            registry=self.registry,
        )
        self.vlm_async_wait_total = Counter(
            "visual_monitor_vlm_async_wait_total",
            "Total times async VLM enqueue waited for queue slot to free",
            registry=self.registry,
        )
        self.vlm_async_inflight = Gauge(
            "visual_monitor_vlm_async_inflight",
            "Current in-flight + buffered async VLM jobs",
            registry=self.registry,
        )
        self.pipeline_latency_ms = Histogram(
            "visual_monitor_pipeline_latency_ms",
            "Latency for producing message events",
            registry=self.registry,
            buckets=(50, 100, 200, 500, 700, 1200, 2000),
        )
        self.cpu_percent = Gauge(
            "visual_monitor_cpu_percent",
            "Current CPU usage percent sampled by monitor loop",
            registry=self.registry,
        )

    def render(self) -> bytes:
        return generate_latest(self.registry)
