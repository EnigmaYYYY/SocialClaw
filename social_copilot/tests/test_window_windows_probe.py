from __future__ import annotations

from social_copilot.visual_monitor.adapters.window_windows import WindowBounds, WindowsWindowProbe


class _NoopUser32:
    pass


def _probe() -> WindowsWindowProbe:
    return WindowsWindowProbe(user32=_NoopUser32(), configure_user32=False)


def test_frontmost_app_name_returns_none_when_no_foreground_window(monkeypatch) -> None:
    probe = _probe()
    monkeypatch.setattr(probe, "_foreground_hwnd", lambda: 0)
    assert probe.frontmost_app_name() is None


def test_frontmost_app_name_returns_process_name(monkeypatch) -> None:
    probe = _probe()
    monkeypatch.setattr(probe, "_foreground_hwnd", lambda: 100)
    monkeypatch.setattr(probe, "_process_id_for_hwnd", lambda hwnd: 4321)
    monkeypatch.setattr(probe, "_process_name_from_pid", lambda pid: "WeChat")
    assert probe.frontmost_app_name() == "WeChat"


def test_frontmost_window_bounds_returns_none_when_app_mismatch(monkeypatch) -> None:
    probe = _probe()
    monkeypatch.setattr(probe, "_foreground_hwnd", lambda: 100)
    monkeypatch.setattr(probe, "_app_matches", lambda hwnd, app_name: False)
    assert probe.frontmost_window_bounds("WeChat") is None


def test_frontmost_window_bounds_returns_bounds_when_valid(monkeypatch) -> None:
    probe = _probe()
    monkeypatch.setattr(probe, "_foreground_hwnd", lambda: 100)
    monkeypatch.setattr(probe, "_app_matches", lambda hwnd, app_name: True)
    monkeypatch.setattr(probe, "_window_rect_for_hwnd", lambda hwnd: (10, 20, 410, 520))

    bounds = probe.frontmost_window_bounds("WeChat")

    assert bounds == WindowBounds(x=10, y=20, w=400, h=500)


def test_frontmost_window_title_returns_stripped_title(monkeypatch) -> None:
    probe = _probe()
    monkeypatch.setattr(probe, "_foreground_hwnd", lambda: 100)
    monkeypatch.setattr(probe, "_app_matches", lambda hwnd, app_name: True)
    monkeypatch.setattr(probe, "_window_title_for_hwnd", lambda hwnd: "  三个臭皮匠 - WeChat  ")

    title = probe.frontmost_window_title("WeChat")

    assert title == "三个臭皮匠 - WeChat"


def test_normalize_app_name_strips_exe_suffix() -> None:
    assert WindowsWindowProbe._normalize_app_name("WeChat.EXE") == "wechat"
