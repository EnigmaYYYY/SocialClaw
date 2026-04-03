from __future__ import annotations

import platform

from social_copilot.visual_monitor.adapters.window_macos import MacOSWindowProbe
from social_copilot.visual_monitor.adapters.window_windows import WindowsWindowProbe


def create_window_probe(system_name: str | None = None):
    system = (system_name or platform.system()).strip().lower()
    if system == "darwin":
        return MacOSWindowProbe()
    if system == "windows":
        return WindowsWindowProbe()
    return None
