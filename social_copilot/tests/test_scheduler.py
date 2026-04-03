from social_copilot.visual_monitor.core.scheduler import AdaptiveState, CaptureScheduler


def test_scheduler_transitions_idle_to_active_on_change() -> None:
    scheduler = CaptureScheduler()
    interval = scheduler.observe(has_change=True, message_emitted=False, cpu_percent=5)
    assert scheduler.state == AdaptiveState.ACTIVE
    assert interval == 0.5


def test_scheduler_enters_burst_after_consecutive_changes() -> None:
    scheduler = CaptureScheduler()
    scheduler.observe(has_change=True, message_emitted=True, cpu_percent=10)
    second_interval = scheduler.observe(has_change=True, message_emitted=True, cpu_percent=10)
    assert scheduler.state == AdaptiveState.ACTIVE_PEAK
    assert second_interval == 0.25
    interval = scheduler.observe(has_change=True, message_emitted=True, cpu_percent=10)
    assert scheduler.state == AdaptiveState.BURST
    assert interval == 0.2


def test_scheduler_forces_downgrade_under_high_cpu() -> None:
    scheduler = CaptureScheduler()
    scheduler.observe(has_change=True, message_emitted=True, cpu_percent=10)
    scheduler.observe(has_change=True, message_emitted=True, cpu_percent=10)
    scheduler.observe(has_change=True, message_emitted=True, cpu_percent=10)
    interval = scheduler.observe(has_change=True, message_emitted=True, cpu_percent=90)
    assert scheduler.state == AdaptiveState.ACTIVE_PEAK
    assert interval == 0.25


def test_scheduler_returns_to_idle_after_stable_frames() -> None:
    scheduler = CaptureScheduler()
    scheduler.observe(has_change=True, message_emitted=False, cpu_percent=5)
    for _ in range(4):
        interval = scheduler.observe(has_change=False, message_emitted=False, cpu_percent=5)
    assert scheduler.state == AdaptiveState.IDLE
    assert interval == 1.0
