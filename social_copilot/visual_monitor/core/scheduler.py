from __future__ import annotations

from enum import Enum


class AdaptiveState(str, Enum):
    IDLE = "IDLE"
    ACTIVE = "ACTIVE"
    ACTIVE_PEAK = "ACTIVE_PEAK"
    BURST = "BURST"


class CaptureScheduler:
    """Adaptive capture rate controller.

    Uses simple state transitions to keep CPU low when screen is stable,
    and increase sampling when message flow is active.
    """

    def __init__(
        self,
        idle_hz: int = 1,
        active_hz: int = 2,
        active_peak_hz: int = 4,
        burst_hz: int = 5,
        burst_change_threshold: int = 3,
        idle_stable_threshold: int = 4,
        high_cpu_threshold: float = 80.0,
    ) -> None:
        self.idle_hz = idle_hz
        self.active_hz = active_hz
        self.active_peak_hz = max(active_hz, active_peak_hz)
        self.burst_hz = burst_hz
        self.burst_change_threshold = burst_change_threshold
        self.idle_stable_threshold = idle_stable_threshold
        self.high_cpu_threshold = high_cpu_threshold

        self.state = AdaptiveState.IDLE
        self._consecutive_changes = 0
        self._stable_frames = 0

    def observe(self, has_change: bool, message_emitted: bool, cpu_percent: float) -> float:
        _ = message_emitted  # Reserved for future tuning.

        if cpu_percent >= self.high_cpu_threshold and self.state == AdaptiveState.BURST:
            self.state = AdaptiveState.ACTIVE_PEAK if self._consecutive_changes >= 2 else AdaptiveState.ACTIVE
            self._consecutive_changes = 2 if self.state == AdaptiveState.ACTIVE_PEAK else 1
            return self._current_interval()

        if has_change:
            self._stable_frames = 0
            self._consecutive_changes += 1
            if self._consecutive_changes >= self.burst_change_threshold:
                self.state = AdaptiveState.BURST
            elif self._consecutive_changes >= 2:
                self.state = AdaptiveState.ACTIVE_PEAK
            else:
                self.state = AdaptiveState.ACTIVE
        else:
            self._consecutive_changes = 0
            self._stable_frames += 1
            if self._stable_frames >= self.idle_stable_threshold:
                self.state = AdaptiveState.IDLE
            elif self.state == AdaptiveState.BURST:
                self.state = AdaptiveState.ACTIVE_PEAK
            elif self.state == AdaptiveState.ACTIVE_PEAK:
                self.state = AdaptiveState.ACTIVE

        return self._current_interval()

    def _current_interval(self) -> float:
        if self.state == AdaptiveState.BURST:
            return 1.0 / float(self.burst_hz)
        if self.state == AdaptiveState.ACTIVE_PEAK:
            return 1.0 / float(self.active_peak_hz)
        if self.state == AdaptiveState.ACTIVE:
            return 1.0 / float(self.active_hz)
        return 1.0 / float(self.idle_hz)
