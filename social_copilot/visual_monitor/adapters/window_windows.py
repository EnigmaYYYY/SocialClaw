from __future__ import annotations

import ctypes
import os
from dataclasses import dataclass

import psutil


@dataclass(slots=True)
class WindowBounds:
    x: int
    y: int
    w: int
    h: int


class WindowsWindowProbe:
    """Uses Win32 APIs to query foreground app/window on Windows."""
    _DEFAULT_WECHAT_ALIASES = ("wechat", "weixin", "wechatappex", "\u5fae\u4fe1")

    def __init__(self, user32: object | None = None, configure_user32: bool = True) -> None:
        self._user32 = user32 or self._load_user32()
        if configure_user32:
            self._configure_user32()
        self._set_dpi_awareness()

    def frontmost_app_name(self) -> str | None:
        hwnd = self._foreground_hwnd()
        if hwnd == 0:
            return None
        pid = self._process_id_for_hwnd(hwnd)
        if pid is None:
            return None
        return self._process_name_from_pid(pid)

    def frontmost_window_bounds(self, app_name: str) -> WindowBounds | None:
        hwnd = self._foreground_hwnd()
        if hwnd == 0:
            return None
        if not self._app_matches(hwnd=hwnd, app_name=app_name):
            return None
        rect = self._window_rect_for_hwnd(hwnd)
        if rect is None:
            return None
        left, top, right, bottom = rect
        width = right - left
        height = bottom - top
        if width <= 0 or height <= 0:
            return None
        return WindowBounds(x=left, y=top, w=width, h=height)

    def frontmost_window_title(self, app_name: str) -> str | None:
        hwnd = self._foreground_hwnd()
        if hwnd == 0:
            return None
        if not self._app_matches(hwnd=hwnd, app_name=app_name):
            return None
        title = self._window_title_for_hwnd(hwnd)
        if title is None:
            return None
        clean = title.strip()
        return clean or None

    @staticmethod
    def _normalize_app_name(value: str) -> str:
        base = value.strip().lower()
        if base.endswith(".exe"):
            return base[:-4]
        return base

    @classmethod
    def _expand_aliases(cls, app_name: str) -> set[str]:
        normalized = cls._normalize_app_name(app_name)
        aliases = {normalized}
        if normalized in cls._DEFAULT_WECHAT_ALIASES:
            aliases.update(cls._DEFAULT_WECHAT_ALIASES)
        return aliases

    @staticmethod
    def _matches_alias(front_name: str, alias: str) -> bool:
        if front_name == alias:
            return True
        return (
            front_name.startswith(f"{alias} ")
            or front_name.startswith(f"{alias}-")
            or front_name.startswith(f"{alias}_")
        )

    def _app_matches(self, hwnd: int, app_name: str) -> bool:
        if not app_name.strip():
            return True
        pid = self._process_id_for_hwnd(hwnd)
        if pid is None:
            return False
        front_name = self._process_name_from_pid(pid)
        if not front_name:
            return False
        normalized_front = self._normalize_app_name(front_name)
        aliases = self._expand_aliases(app_name)
        return any(self._matches_alias(normalized_front, alias) for alias in aliases)

    def _foreground_hwnd(self) -> int:
        try:
            return int(self._user32.GetForegroundWindow())
        except Exception:
            return 0

    def _process_id_for_hwnd(self, hwnd: int) -> int | None:
        pid = ctypes.c_ulong(0)
        try:
            self._user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        except Exception:
            return None
        if pid.value <= 0:
            return None
        return int(pid.value)

    def _window_rect_for_hwnd(self, hwnd: int) -> tuple[int, int, int, int] | None:
        class RECT(ctypes.Structure):
            _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long), ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

        rect = RECT()
        try:
            ok = bool(self._user32.GetWindowRect(hwnd, ctypes.byref(rect)))
        except Exception:
            return None
        if not ok:
            return None
        return int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)

    def _window_title_for_hwnd(self, hwnd: int) -> str | None:
        try:
            length = int(self._user32.GetWindowTextLengthW(hwnd))
        except Exception:
            return None
        if length <= 0:
            return None
        buf = ctypes.create_unicode_buffer(length + 1)
        try:
            copied = int(self._user32.GetWindowTextW(hwnd, buf, length + 1))
        except Exception:
            return None
        if copied <= 0:
            return None
        return str(buf.value)

    @staticmethod
    def _process_name_from_pid(pid: int) -> str | None:
        try:
            name = psutil.Process(pid).name()
        except Exception:
            return None
        clean = name.strip()
        if not clean:
            return None
        return clean[:-4] if clean.lower().endswith(".exe") else clean

    @staticmethod
    def _load_user32() -> object:
        if os.name != "nt":
            raise RuntimeError("WindowsWindowProbe can only be created on Windows.")
        return ctypes.WinDLL("user32", use_last_error=True)

    def _configure_user32(self) -> None:
        try:
            self._user32.GetForegroundWindow.restype = ctypes.c_void_p
            self._user32.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
            self._user32.GetWindowThreadProcessId.restype = ctypes.c_ulong
            self._user32.GetWindowRect.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
            self._user32.GetWindowRect.restype = ctypes.c_int
            self._user32.GetWindowTextLengthW.argtypes = [ctypes.c_void_p]
            self._user32.GetWindowTextLengthW.restype = ctypes.c_int
            self._user32.GetWindowTextW.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int]
            self._user32.GetWindowTextW.restype = ctypes.c_int
        except Exception:
            # Fallback to dynamic invocation when symbols/signatures are unavailable.
            return

    def _set_dpi_awareness(self) -> None:
        # Best effort: align Win32 window coordinates with screen-capture coordinates.
        try:
            if hasattr(self._user32, "SetProcessDpiAwarenessContext"):
                self._user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
                return
        except Exception:
            pass
        try:
            if hasattr(self._user32, "SetProcessDPIAware"):
                self._user32.SetProcessDPIAware()
        except Exception:
            pass
