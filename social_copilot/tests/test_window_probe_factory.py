from __future__ import annotations

from social_copilot.visual_monitor.adapters import window_probe_factory
from social_copilot.visual_monitor.service import VisualMonitorService


def test_window_probe_factory_returns_none_for_unsupported_system() -> None:
    probe = window_probe_factory.create_window_probe(system_name="Linux")
    assert probe is None


def test_window_probe_factory_selects_macos_probe(monkeypatch) -> None:
    marker = object()

    class _FakeMacProbe:
        def __init__(self) -> None:
            self.marker = marker

    monkeypatch.setattr(window_probe_factory, "MacOSWindowProbe", _FakeMacProbe)

    probe = window_probe_factory.create_window_probe(system_name="Darwin")
    assert isinstance(probe, _FakeMacProbe)
    assert probe.marker is marker


def test_window_probe_factory_selects_windows_probe(monkeypatch) -> None:
    marker = object()

    class _FakeWindowsProbe:
        def __init__(self) -> None:
            self.marker = marker

    monkeypatch.setattr(window_probe_factory, "WindowsWindowProbe", _FakeWindowsProbe)

    probe = window_probe_factory.create_window_probe(system_name="Windows")
    assert isinstance(probe, _FakeWindowsProbe)
    assert probe.marker is marker


def test_visual_monitor_service_build_pipeline_uses_window_probe_factory(monkeypatch) -> None:
    sentinel_probe = object()
    captured: dict[str, object] = {}

    class _FakePipeline:
        def __init__(self, **kwargs) -> None:
            captured.update(kwargs)

    monkeypatch.setattr("social_copilot.visual_monitor.service.create_window_probe", lambda: sentinel_probe)
    monkeypatch.setattr("social_copilot.visual_monitor.service.VisualMonitorPipeline", _FakePipeline)

    service = VisualMonitorService()
    _ = service._build_pipeline(event_bus=service.event_bus, metrics=service.metrics)

    assert captured["window_probe"] is sentinel_probe
