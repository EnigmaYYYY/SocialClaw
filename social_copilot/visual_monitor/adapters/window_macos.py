from __future__ import annotations

import subprocess
from dataclasses import dataclass


@dataclass(slots=True)
class WindowBounds:
    x: int
    y: int
    w: int
    h: int


class MacOSWindowProbe:
    """Uses AppleScript to query frontmost app/window on macOS."""

    def frontmost_app_name(self) -> str | None:
        script = 'tell application "System Events" to get name of first application process whose frontmost is true'
        output = self._run_osascript(script)
        if output is None:
            return None
        name = output.strip()
        return name or None

    def frontmost_window_bounds(self, app_name: str) -> WindowBounds | None:
        safe_name = app_name.replace('"', '\\"')
        script = (
            'tell application "System Events"\n'
            f'  tell application process "{safe_name}"\n'
            "    if (count of windows) is 0 then\n"
            '      return ""\n'
            "    end if\n"
            "    set p to position of front window\n"
            "    set s to size of front window\n"
            "    return (item 1 of p as string) & \",\" & (item 2 of p as string) & \",\" & (item 1 of s as string) & \",\" & (item 2 of s as string)\n"
            "  end tell\n"
            "end tell"
        )
        output = self._run_osascript(script)
        if output is None:
            return None
        text = output.strip()
        if not text:
            return None
        parts = [part.strip() for part in text.split(",")]
        if len(parts) != 4:
            return None
        try:
            x, y, w, h = (int(float(part)) for part in parts)
        except ValueError:
            return None
        if w <= 0 or h <= 0:
            return None
        return WindowBounds(x=x, y=y, w=w, h=h)

    def frontmost_window_title(self, app_name: str) -> str | None:
        safe_name = app_name.replace('"', '\\"')
        script = (
            'tell application "System Events"\n'
            f'  tell application process "{safe_name}"\n'
            "    if (count of windows) is 0 then\n"
            '      return ""\n'
            "    end if\n"
            "    try\n"
            "      return name of front window\n"
            "    on error\n"
            '      return ""\n'
            "    end try\n"
            "  end tell\n"
            "end tell"
        )
        output = self._run_osascript(script)
        if output is None:
            return None
        name = output.strip()
        return name or None

    @staticmethod
    def _run_osascript(script: str) -> str | None:
        try:
            completed = subprocess.run(
                ["osascript", "-e", script],
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=0.8,
            )
        except Exception:
            return None
        if completed.returncode != 0:
            return None
        return completed.stdout
