#!/usr/bin/env python3
"""Local desktop-control HTTP agent.

Run this manually from the user's interactive desktop session. Codex/skills can
then call localhost endpoints while the actual screenshot/mouse/keyboard work
happens in the visible desktop session.
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import json
import os
import shutil
import subprocess
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

DEFAULT_PORT = 8765
DEFAULT_PREVIEW_WIDTH = 1280
AUTH_TOKEN = ""
_action_lock = threading.Lock()
_active_lease_id = ""


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


# --- SendInput plumbing ---------------------------------------------------
#
# mouse_event/keybd_event are the legacy 1995-era API. They still *work*, but:
#   - they are not atomic: a second mouse_event call can race the first and
#     reorder its observation in a busy app's message pump
#   - some self-drawn / DirectUI apps (Dingtalk installer, parts of WeChat,
#     newer game launchers) ignore the WM_LBUTTON* messages they generate
#     because the modern path goes through HID/RAWINPUT, which only SendInput
#     populates correctly
#   - they cannot mix mouse and keyboard events in a single atomic batch,
#     which matters for "modifier + click" gestures
#
# Switching to SendInput here keeps the same external API (click_at, etc.)
# but eliminates the above failure modes. UIPI behavior is unchanged — both
# APIs are subject to the same integrity-level filter — and the fix for that
# lives in install-elevated-task.ps1.

if os.name == "nt":
    _ULONG_PTR = ctypes.c_size_t

    class _MOUSEINPUT(ctypes.Structure):
        _fields_ = [
            ("dx", ctypes.c_long),
            ("dy", ctypes.c_long),
            ("mouseData", ctypes.c_ulong),
            ("dwFlags", ctypes.c_ulong),
            ("time", ctypes.c_ulong),
            ("dwExtraInfo", _ULONG_PTR),
        ]

    class _KEYBDINPUT(ctypes.Structure):
        _fields_ = [
            ("wVk", ctypes.c_ushort),
            ("wScan", ctypes.c_ushort),
            ("dwFlags", ctypes.c_ulong),
            ("time", ctypes.c_ulong),
            ("dwExtraInfo", _ULONG_PTR),
        ]

    class _HARDWAREINPUT(ctypes.Structure):
        _fields_ = [
            ("uMsg", ctypes.c_ulong),
            ("wParamL", ctypes.c_ushort),
            ("wParamH", ctypes.c_ushort),
        ]

    class _INPUT_UNION(ctypes.Union):
        _fields_ = [
            ("mi", _MOUSEINPUT),
            ("ki", _KEYBDINPUT),
            ("hi", _HARDWAREINPUT),
        ]

    class _INPUT(ctypes.Structure):
        _anonymous_ = ("u",)
        _fields_ = [
            ("type", ctypes.c_ulong),
            ("u", _INPUT_UNION),
        ]

    INPUT_MOUSE = 0
    INPUT_KEYBOARD = 1
    KEYEVENTF_KEYUP = 0x0002
    KEYEVENTF_EXTENDEDKEY = 0x0001

    def _send_input(inputs: list) -> None:
        if not inputs:
            return
        arr_type = _INPUT * len(inputs)
        arr = arr_type(*inputs)
        ctypes.windll.user32.SendInput(len(inputs), arr, ctypes.sizeof(_INPUT))


def is_windows() -> bool:
    return os.name == "nt"


def enable_dpi_awareness() -> None:
    if not is_windows():
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
        return
    except Exception:
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


def root_dir() -> Path:
    configured = os.environ.get("DESKTOP_CONTROL_DIR")
    if configured:
        return Path(configured).expanduser()
    return Path.cwd() / ".tmp" / "desktop-control-agent"


def ensure_dirs() -> Path:
    root = root_dir()
    (root / "screenshots").mkdir(parents=True, exist_ok=True)
    return root


def screen_size() -> tuple[int, int]:
    if is_windows():
        return int(ctypes.windll.user32.GetSystemMetrics(0)), int(ctypes.windll.user32.GetSystemMetrics(1))
    import pyautogui  # type: ignore
    size = pyautogui.size()
    return int(size.width), int(size.height)


# --- Cursor shape inspection ---------------------------------------------
#
# Reading the current cursor SHAPE (not just position) is the cheapest way
# for an agent to verify "is the mouse actually over a clickable element?"
# Windows changes the cursor based on the window underneath: arrow over
# background, hand over hyperlinks/buttons, IBeam over editable text, etc.
# The shape comes from the target window's WM_SETCURSOR handler, which the
# OS dispatches purely from cursor position — UIPI does NOT filter this, so
# we get an accurate hover-state read even against an elevated installer
# that's blocking our actual click events. Combined with /wait_change this
# gives the LLM two independent signals: "did the click change pixels"
# AND "does this element advertise itself as clickable on hover".

if os.name == "nt":
    class _CURSORINFO(ctypes.Structure):
        _fields_ = [
            ("cbSize", ctypes.c_ulong),
            ("flags", ctypes.c_ulong),
            ("hCursor", ctypes.c_void_p),
            ("ptScreenPos", POINT),
        ]

    _SYSTEM_CURSOR_NAMES = {
        32512: "arrow",
        32513: "ibeam",
        32514: "wait",
        32515: "cross",
        32516: "uparrow",
        32642: "size_nwse",
        32643: "size_nesw",
        32644: "size_we",
        32645: "size_ns",
        32646: "size_all",
        32648: "no",
        32649: "hand",
        32650: "appstarting",
        32651: "help",
    }

    _SYSTEM_CURSOR_HANDLES: dict[str, int] = {}

    def _populate_system_cursor_handles() -> None:
        if _SYSTEM_CURSOR_HANDLES:
            return
        user32 = ctypes.windll.user32
        user32.LoadCursorW.restype = ctypes.c_void_p
        for cursor_id, name in _SYSTEM_CURSOR_NAMES.items():
            handle = user32.LoadCursorW(None, cursor_id)
            if handle:
                _SYSTEM_CURSOR_HANDLES[name] = int(handle)


def get_cursor_info() -> dict:
    """Return current cursor position, shape, and visibility. shape is one of
    {arrow, hand, ibeam, wait, cross, size_*, no, appstarting, help, custom,
    none}. 'custom' means the foreground window installed its own cursor
    (e.g. a game / .cur file) — we don't try to classify those by content.
    'none' means the cursor is hidden (CURSOR_SHOWING flag is off)."""
    if not is_windows():
        x, y = cursor_pos()
        return {
            "x": x,
            "y": y,
            "shape": "unknown",
            "visible": True,
            "is_clickable_hint": False,
        }
    _populate_system_cursor_handles()
    info = _CURSORINFO()
    info.cbSize = ctypes.sizeof(_CURSORINFO)
    ok = ctypes.windll.user32.GetCursorInfo(ctypes.byref(info))
    if not ok:
        x, y = cursor_pos()
        return {
            "x": x,
            "y": y,
            "shape": "unknown",
            "visible": False,
            "is_clickable_hint": False,
        }
    h_cursor = int(info.hCursor or 0)
    shape = "custom"
    for name, handle in _SYSTEM_CURSOR_HANDLES.items():
        if handle == h_cursor:
            shape = name
            break
    if h_cursor == 0:
        shape = "none"
    # CURSOR_SHOWING = 0x00000001. The cursor handle is still set when
    # hidden (e.g. games that capture the mouse), but flags reflects it.
    visible = bool(info.flags & 0x01)
    # Hint for the LLM: hand/ibeam/help are the cursors web/desktop UIs use
    # to advertise "this is interactive". Default arrow generally means
    # background. wait/appstarting mean the app is busy — clicking will
    # likely be ignored or queued. The hint is advisory only; some apps
    # use arrow on clickable elements (e.g. native Win32 push buttons).
    is_clickable_hint = shape in ("hand", "ibeam", "help")
    return {
        "x": int(info.ptScreenPos.x),
        "y": int(info.ptScreenPos.y),
        "shape": shape,
        "shape_handle": h_cursor,
        "visible": visible,
        "is_clickable_hint": is_clickable_hint,
    }


# --- Elevation / integrity-level reporting -------------------------------
#
# The single biggest cause of "click reports success but UI does not react"
# on Windows is UIPI: a medium-integrity process cannot deliver input to a
# high-integrity (elevated / "Run as administrator") window. Exposing this
# in /health and /cursor_info lets both the human user and the agent LLM
# diagnose the elevation gap in one tool call instead of guessing through
# many failed clicks.

def _is_process_elevated() -> bool:
    if not is_windows():
        return False
    try:
        TOKEN_QUERY = 0x0008
        TokenElevation = 20
        h_token = ctypes.c_void_p()
        ok = ctypes.windll.advapi32.OpenProcessToken(
            ctypes.windll.kernel32.GetCurrentProcess(),
            TOKEN_QUERY,
            ctypes.byref(h_token),
        )
        if not ok:
            return False
        try:
            elevation = ctypes.c_ulong(0)
            ret_len = ctypes.c_ulong(0)
            ok = ctypes.windll.advapi32.GetTokenInformation(
                h_token,
                TokenElevation,
                ctypes.byref(elevation),
                ctypes.sizeof(elevation),
                ctypes.byref(ret_len),
            )
            return bool(ok and elevation.value)
        finally:
            ctypes.windll.kernel32.CloseHandle(h_token)
    except Exception:
        return False


def _is_rdp_session() -> bool:
    """True if the agent is running inside a Remote Desktop session. RDP is
    the biggest reason set_cursor reports moved=true but the visible cursor
    snaps back: the RDP server continuously syncs the client's local pointer
    over our synthetic move. Surface this in /health so the LLM can stop
    looping on a doomed retry and instead tell the user to either drive
    locally or accept that pointer-precise control will be unreliable."""
    if not is_windows():
        return False
    try:
        # SM_REMOTESESSION = 0x1000. Non-zero when current session is RDP.
        return bool(ctypes.windll.user32.GetSystemMetrics(0x1000))
    except Exception:
        return False


def _process_integrity_level() -> str:
    """Best-effort string for the agent process's integrity level.
    Returns one of: 'high', 'medium', 'low', 'system', 'unknown'."""
    if not is_windows():
        return "unknown"
    try:
        # SIDs are easier to reason about than raw values, but for our purposes
        # we just need a coarse bucket. Use the same TokenIntegrityLevel as
        # icacls reports.
        TokenIntegrityLevel = 25
        TOKEN_QUERY = 0x0008
        h_token = ctypes.c_void_p()
        if not ctypes.windll.advapi32.OpenProcessToken(
            ctypes.windll.kernel32.GetCurrentProcess(),
            TOKEN_QUERY,
            ctypes.byref(h_token),
        ):
            return "unknown"
        try:
            size = ctypes.c_ulong(0)
            ctypes.windll.advapi32.GetTokenInformation(
                h_token, TokenIntegrityLevel, None, 0, ctypes.byref(size)
            )
            if size.value == 0:
                return "unknown"
            buf = (ctypes.c_byte * size.value)()
            if not ctypes.windll.advapi32.GetTokenInformation(
                h_token, TokenIntegrityLevel, buf, size.value, ctypes.byref(size)
            ):
                return "unknown"
            # TOKEN_MANDATORY_LABEL: { SID_AND_ATTRIBUTES { PSID, DWORD } }.
            # Cast the first pointer-sized field to a PSID, then read the
            # last sub-authority via GetSidSubAuthority.
            psid = ctypes.cast(buf, ctypes.POINTER(ctypes.c_void_p))[0]
            adv = ctypes.windll.advapi32
            adv.GetSidSubAuthorityCount.restype = ctypes.POINTER(ctypes.c_ubyte)
            adv.GetSidSubAuthority.restype = ctypes.POINTER(ctypes.c_ulong)
            sub_count_ptr = adv.GetSidSubAuthorityCount(psid)
            if not sub_count_ptr:
                return "unknown"
            sub_count = int(sub_count_ptr[0])
            if sub_count == 0:
                return "unknown"
            value = int(adv.GetSidSubAuthority(psid, sub_count - 1)[0])
            if value >= 0x4000:
                return "system"
            if value >= 0x3000:
                return "high"
            if value >= 0x2000:
                return "medium"
            return "low"
        finally:
            ctypes.windll.kernel32.CloseHandle(h_token)
    except Exception:
        return "unknown"


def cursor_pos() -> tuple[int, int]:
    if is_windows():
        point = POINT()
        ctypes.windll.user32.GetCursorPos(ctypes.byref(point))
        return int(point.x), int(point.y)
    import pyautogui  # type: ignore
    pos = pyautogui.position()
    return int(pos.x), int(pos.y)


def set_cursor(x: int, y: int) -> dict:
    """Move the cursor to (x, y). Returns a dict with `moved` (bool) and the
    `actual` position GetCursorPos reports after the move attempt.

    Two failure modes we explicitly diagnose for the caller:
      - SetCursorPos returns FALSE: usually the destination is outside the
        virtual screen (multi-monitor with primary not at origin), or a
        WS_EX_TOPMOST window is clipping the cursor via ClipCursor.
      - Move appears to succeed (return value TRUE) but GetCursorPos reads
        back the OLD position: classic Remote Desktop cursor-sync override.
        RDP continuously replays the client's local pointer position; any
        SetCursorPos call gets reverted within the next RDP frame. We also
        try SendInput MOUSEEVENTF_MOVE|MOUSEEVENTF_ABSOLUTE as a stronger
        synthetic-input path which RDP respects better than SetCursorPos.
    """
    target_x, target_y = int(x), int(y)
    if not is_windows():
        import pyautogui  # type: ignore
        pyautogui.moveTo(target_x, target_y)
        actual = pyautogui.position()
        ax, ay = int(actual.x), int(actual.y)
        return {"moved": (ax == target_x and ay == target_y), "actual": [ax, ay]}

    # Primary path: SendInput with absolute coordinates normalized to the
    # 0..65535 "virtual screen" space. SendInput goes through the standard
    # input dispatch and is the API real mouse drivers use — it's far less
    # likely to be overridden by RDP, accessibility tools, or input hooks
    # than the legacy SetCursorPos teleport.
    width, height = screen_size()
    if width > 1 and height > 1:
        MOUSEEVENTF_MOVE = 0x0001
        MOUSEEVENTF_ABSOLUTE = 0x8000
        # Bound to [0, screen) so absolute coords map to the primary monitor
        # cleanly. For full multi-monitor support we'd add VIRTUALDESK and
        # rescale to GetSystemMetrics(SM_CXVIRTUALSCREEN), but the current
        # screen_size() reports primary only and matches what other callers
        # already assume.
        clamped_x = max(0, min(width - 1, target_x))
        clamped_y = max(0, min(height - 1, target_y))
        norm_x = int(round(clamped_x * 65535 / (width - 1)))
        norm_y = int(round(clamped_y * 65535 / (height - 1)))
        mi = _MOUSEINPUT(
            dx=norm_x,
            dy=norm_y,
            mouseData=0,
            dwFlags=MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
            time=0,
            dwExtraInfo=0,
        )
        _send_input([_INPUT(type=INPUT_MOUSE, u=_INPUT_UNION(mi=mi))])

    # Fallback / belt-and-suspenders: SetCursorPos. Cheap, idempotent, and
    # catches the case where SendInput was dropped (e.g. UIPI when the
    # target window is at a higher integrity level).
    sp_ok = bool(ctypes.windll.user32.SetCursorPos(target_x, target_y))

    # Verify by reading back. Allow a small tolerance for sub-pixel rounding
    # in the normalized-coord path.
    ax, ay = cursor_pos()
    moved = abs(ax - target_x) <= 2 and abs(ay - target_y) <= 2
    return {
        "moved": moved,
        "actual": [ax, ay],
        "setcursorpos_ok": sp_ok,
    }


def mouse_event(flag: int, data: int = 0) -> None:
    # Kept for backward-compat in case external callers still expect this
    # symbol; the production path now goes through SendInput below.
    if is_windows():
        mi = _MOUSEINPUT(dx=0, dy=0, mouseData=int(data), dwFlags=int(flag), time=0, dwExtraInfo=0)
        _send_input([_INPUT(type=INPUT_MOUSE, u=_INPUT_UNION(mi=mi))])


def click_at(x: int, y: int, button: str = "left", clicks: int = 1, skip_move: bool = False) -> None:
    # The HTTP /click handler now moves and verifies the cursor BEFORE
    # calling click_at, so allow callers to opt out of an extra redundant
    # move (which would also fire a second SendInput MOUSEEVENTF_MOVE that
    # some apps may register as a hover-flicker). External CLI callers that
    # invoke click_at directly still want the move.
    if not skip_move:
        set_cursor(x, y)
    if is_windows():
        constants = {
            "left": (0x0002, 0x0004),
            "right": (0x0008, 0x0010),
            "middle": (0x0020, 0x0040),
        }
        down, up = constants.get(button, constants["left"])
        for _ in range(max(int(clicks), 1)):
            down_event = _MOUSEINPUT(dx=0, dy=0, mouseData=0, dwFlags=down, time=0, dwExtraInfo=0)
            up_event = _MOUSEINPUT(dx=0, dy=0, mouseData=0, dwFlags=up, time=0, dwExtraInfo=0)
            # Send down and up as one batch so the OS message pump sees a tight
            # pair — some DirectUI hit-test paths debounce based on inter-arrival
            # time, and a too-fast or split pair gets coalesced into a "hover".
            _send_input([
                _INPUT(type=INPUT_MOUSE, u=_INPUT_UNION(mi=down_event)),
            ])
            time.sleep(0.04)
            _send_input([
                _INPUT(type=INPUT_MOUSE, u=_INPUT_UNION(mi=up_event)),
            ])
            time.sleep(0.08)
        return
    import pyautogui  # type: ignore
    pyautogui.click(x, y, clicks=clicks, button=button)


KEY_ALIASES = {
    "enter": 0x0D,
    "return": 0x0D,
    "esc": 0x1B,
    "escape": 0x1B,
    "tab": 0x09,
    "space": 0x20,
    "backspace": 0x08,
    "delete": 0x2E,
    "home": 0x24,
    "end": 0x23,
    "left": 0x25,
    "up": 0x26,
    "right": 0x27,
    "down": 0x28,
    "ctrl": 0x11,
    "control": 0x11,
    "shift": 0x10,
    "alt": 0x12,
    "win": 0x5B,
    "cmd": 0x5B,
}


def key_to_vk(key: str) -> int:
    normalized = str(key).strip().lower()
    if normalized in KEY_ALIASES:
        return KEY_ALIASES[normalized]
    if len(normalized) == 1:
        return ord(normalized.upper())
    if normalized.startswith("f") and normalized[1:].isdigit():
        number = int(normalized[1:])
        if 1 <= number <= 24:
            return 0x70 + number - 1
    raise ValueError(f"Unsupported key: {key}")


def key_event(vk: int, down: bool) -> None:
    if not is_windows():
        return
    flags = 0 if down else KEYEVENTF_KEYUP
    # Extended-key bit is required for arrows, Insert/Delete, Home/End,
    # PageUp/PageDown, Right-Ctrl/Alt, and the Numpad Enter, otherwise some
    # apps see them as numpad keys instead. Keep the legacy path correct.
    EXTENDED_VKS = {
        0x21, 0x22, 0x23, 0x24,            # PageUp, PageDown, End, Home
        0x25, 0x26, 0x27, 0x28,            # Left, Up, Right, Down
        0x2D, 0x2E,                        # Insert, Delete
        0x5B, 0x5C,                        # Left Win, Right Win
    }
    if int(vk) in EXTENDED_VKS:
        flags |= KEYEVENTF_EXTENDEDKEY
    ki = _KEYBDINPUT(wVk=int(vk), wScan=0, dwFlags=flags, time=0, dwExtraInfo=0)
    _send_input([_INPUT(type=INPUT_KEYBOARD, u=_INPUT_UNION(ki=ki))])


def press_key(key: str) -> None:
    if is_windows():
        vk = key_to_vk(key)
        key_event(vk, True)
        time.sleep(0.03)
        key_event(vk, False)
        return
    import pyautogui  # type: ignore
    pyautogui.press(key)


def hotkey(keys: list[str]) -> None:
    keys = [str(k).strip() for k in keys if str(k).strip()]
    if is_windows():
        vks = [key_to_vk(k) for k in keys]
        for vk in vks:
            key_event(vk, True)
            time.sleep(0.02)
        for vk in reversed(vks):
            key_event(vk, False)
            time.sleep(0.02)
        return
    import pyautogui  # type: ignore
    pyautogui.hotkey(*keys)


def scroll(amount: int) -> None:
    if is_windows():
        # MOUSEEVENTF_WHEEL = 0x0800, one click = 120 (WHEEL_DELTA).
        mi = _MOUSEINPUT(
            dx=0,
            dy=0,
            mouseData=ctypes.c_ulong(int(amount) * 120 & 0xFFFFFFFF).value,
            dwFlags=0x0800,
            time=0,
            dwExtraInfo=0,
        )
        _send_input([_INPUT(type=INPUT_MOUSE, u=_INPUT_UNION(mi=mi))])
        return
    import pyautogui  # type: ignore
    pyautogui.scroll(amount)


def paste_text(text: str, preserve_clipboard: bool = True) -> str:
    try:
        import pyperclip  # type: ignore
    except Exception as exc:
        raise RuntimeError("pyperclip required for text input. pip install pyperclip") from exc
    backup = None
    if preserve_clipboard:
        try:
            backup = pyperclip.paste()
        except Exception:
            backup = None
    pyperclip.copy(text)
    hotkey(["ctrl", "v"])
    method = "clipboard"
    if preserve_clipboard and backup is not None:
        time.sleep(0.12)
        try:
            pyperclip.copy(backup)
            method = "clipboard-restored"
        except Exception:
            pass
    return method


# ---------- Window management ----------

_EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)


def _window_info(hwnd: int) -> dict:
    user32 = ctypes.windll.user32
    title_len = user32.GetWindowTextLengthW(hwnd)
    title_buf = ctypes.create_unicode_buffer(title_len + 1)
    user32.GetWindowTextW(hwnd, title_buf, title_len + 1)
    cls_buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, cls_buf, 256)
    pid = ctypes.c_ulong(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return {
        "hwnd": int(hwnd),
        "title": title_buf.value,
        "class": cls_buf.value,
        "pid": int(pid.value),
    }


def enum_windows(visible_only: bool = True) -> list[dict]:
    if not is_windows():
        return []
    user32 = ctypes.windll.user32
    result: list[dict] = []

    @_EnumWindowsProc
    def cb(hwnd, _lparam):
        if visible_only and not user32.IsWindowVisible(hwnd):
            return True
        info = _window_info(hwnd)
        if visible_only and not info["title"]:
            return True
        result.append(info)
        return True

    user32.EnumWindows(cb, 0)
    return result


def find_windows(query: str, match: str = "contains") -> list[dict]:
    query = (query or "").strip()
    if not query:
        return []
    out = []
    needle = query.lower()
    for w in enum_windows():
        t = (w["title"] or "").lower()
        c = (w["class"] or "").lower()
        if match == "exact":
            ok = t == needle or c == needle
        elif match == "regex":
            import re
            try:
                rx = re.compile(query)
            except re.error:
                rx = re.compile(re.escape(query))
            ok = bool(rx.search(w["title"]) or rx.search(w["class"]))
        else:  # contains
            ok = needle in t or needle in c
        if ok:
            out.append(w)
    return out


def focus_window(hwnd: int) -> dict:
    if not is_windows():
        raise RuntimeError("focus_window only on Windows")
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    SW_RESTORE = 9
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)
    cur_thread = kernel32.GetCurrentThreadId()
    fg_hwnd = user32.GetForegroundWindow()
    fg_thread = user32.GetWindowThreadProcessId(fg_hwnd, None) if fg_hwnd else 0
    attached = False
    if fg_thread and fg_thread != cur_thread:
        attached = bool(user32.AttachThreadInput(fg_thread, cur_thread, True))
    try:
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
    finally:
        if attached:
            user32.AttachThreadInput(fg_thread, cur_thread, False)
    time.sleep(0.1)
    return _window_info(hwnd)


def active_window_info() -> dict | None:
    if not is_windows():
        return None
    hwnd = ctypes.windll.user32.GetForegroundWindow()
    if not hwnd:
        return None
    return _window_info(hwnd)


# ---------- App launching ----------

def launch_app(path: str | None = None, query: str | None = None) -> dict:
    if path:
        try:
            os.startfile(path)  # handles .exe, .lnk, file associations
            return {"ok": True, "method": "startfile", "target": path}
        except Exception as exc:
            raise RuntimeError(f"startfile failed for {path!r}: {exc}") from exc
    if query:
        # Try Start menu search fallback
        press_key("win")
        time.sleep(0.6)
        method = paste_text(query, preserve_clipboard=True)
        time.sleep(0.7)
        press_key("enter")
        return {"ok": True, "method": f"start-search:{method}", "target": query}
    raise ValueError("launch requires 'path' or 'query'")


# ---------- UIA (UI Automation) ----------

_uia_lock = threading.Lock()
_uia_mod = None


def _uia():
    global _uia_mod
    if _uia_mod is not None:
        return _uia_mod
    with _uia_lock:
        if _uia_mod is None:
            import uiautomation as _au  # type: ignore
            _au.SetGlobalSearchTimeout(2)
            _uia_mod = _au
    return _uia_mod


def _control_class(auto, ctype: str | None):
    if not ctype:
        return auto.Control
    name = ctype if ctype.endswith("Control") else ctype + "Control"
    cls = getattr(auto, name, None)
    return cls if cls is not None else auto.Control


def _selector_kwargs(spec: dict) -> dict:
    kwargs: dict = {}
    name = spec.get("name")
    name_match = (spec.get("name_match") or "contains").lower()
    if name:
        if name_match == "exact":
            kwargs["Name"] = name
        elif name_match == "regex":
            kwargs["RegexName"] = name
        else:
            kwargs["SubName"] = name
    aid = spec.get("automation_id")
    if aid:
        kwargs["AutomationId"] = aid
    cls = spec.get("class_name")
    if cls:
        kwargs["ClassName"] = cls
    depth = spec.get("search_depth")
    if depth:
        kwargs["searchDepth"] = int(depth)
    return kwargs


def _find_window_ctrl(auto, spec: dict, timeout: float):
    # Direct by hwnd (most reliable; works for Pane/Window/whatever a11y type)
    hwnd = spec.get("window_hwnd")
    if hwnd:
        ctrl = auto.ControlFromHandle(int(hwnd))
        if ctrl is None:
            raise RuntimeError(f"no UIA control for hwnd={hwnd}")
        return ctrl

    wt = spec.get("window_title")
    wcls = spec.get("window_class")
    wm = (spec.get("window_match") or "contains").lower()
    if not wt and not wcls:
        raise ValueError("window_hwnd, window_title or window_class required")

    # Strategy: try WindowControl first (fast path for normal apps),
    # then fall back to scanning desktop children (catches PaneControl, etc.
    # — Electron apps with non-standard chrome are often PaneControl).
    kwargs: dict = {"searchDepth": 1}
    if wt:
        if wm == "exact":
            kwargs["Name"] = wt
        elif wm == "regex":
            kwargs["RegexName"] = wt
        else:
            kwargs["SubName"] = wt
    if wcls:
        kwargs["ClassName"] = wcls
    win = auto.WindowControl(**kwargs)
    if win.Exists(min(timeout, 1.0), 0.3):
        return win

    # Fallback: iterate desktop top-level children matching by Name/Class on any control type
    import re
    desktop = auto.GetRootControl()
    deadline = time.time() + timeout
    pat = None
    if wt and wm == "regex":
        try:
            pat = re.compile(wt)
        except re.error:
            pat = re.compile(re.escape(wt))
    while time.time() < deadline:
        for child in desktop.GetChildren():
            try:
                cn = child.Name or ""
                cc = child.ClassName or ""
            except Exception:
                continue
            ok_title = True
            if wt:
                if wm == "exact":
                    ok_title = (cn == wt)
                elif wm == "regex" and pat is not None:
                    ok_title = bool(pat.search(cn))
                else:
                    ok_title = (wt.lower() in cn.lower())
            ok_class = True if not wcls else (wcls.lower() in cc.lower())
            if ok_title and ok_class:
                return child
        time.sleep(0.2)
    raise RuntimeError(f"window not found: title={wt!r} class={wcls!r}")


def _find_control(auto, root, spec: dict, timeout: float):
    ctype = spec.get("control_type")
    Cls = _control_class(auto, ctype)
    kwargs = _selector_kwargs(spec)
    if not kwargs and not ctype:
        # No control selector at all → return the window itself
        return root
    if "searchDepth" not in kwargs:
        kwargs["searchDepth"] = 32
    ctrl = Cls(searchFromControl=root, **kwargs)
    if not ctrl.Exists(timeout, 0.3):
        raise RuntimeError(f"control not found: type={ctype!r} {kwargs}")
    return ctrl


def _find_controls(auto, root, spec: dict, timeout: float):
    ctype = spec.get("control_type")
    kwargs = _selector_kwargs(spec)
    depth = int(kwargs.pop("searchDepth", 32))
    deadline = time.time() + timeout
    matches = []

    def match_control(ctrl):
        try:
            if ctype:
                expected = ctype if ctype.endswith("Control") else ctype + "Control"
                actual = getattr(ctrl, "ControlTypeName", None)
                if actual != expected:
                    return False
            name = spec.get("name")
            if name:
                actual_name = getattr(ctrl, "Name", "") or ""
                mode = (spec.get("name_match") or "contains").lower()
                if mode == "exact" and actual_name != name:
                    return False
                if mode == "contains" and name.lower() not in actual_name.lower():
                    return False
                if mode == "regex":
                    import re
                    try:
                        if not re.search(name, actual_name):
                            return False
                    except re.error:
                        if re.escape(name) not in actual_name:
                            return False
            aid = spec.get("automation_id")
            if aid and (getattr(ctrl, "AutomationId", None) != aid):
                return False
            cls = spec.get("class_name")
            if cls and (getattr(ctrl, "ClassName", "") or "") != cls:
                return False
            return True
        except Exception:
            return False

    def walk(ctrl, level):
        if match_control(ctrl):
            matches.append(ctrl)
        if level >= depth:
            return
        try:
            for child in ctrl.GetChildren():
                walk(child, level + 1)
        except Exception:
            return

    while time.time() < deadline:
        matches.clear()
        walk(root, 0)
        if matches:
            return matches
        time.sleep(0.2)
    return []


def _control_info(ctrl) -> dict:
    try:
        r = ctrl.BoundingRectangle
        bbox = [int(r.left), int(r.top), int(r.right - r.left), int(r.bottom - r.top)]
        center = [int((r.left + r.right) // 2), int((r.top + r.bottom) // 2)]
    except Exception:
        bbox = None
        center = None
    info = {
        "control_type": getattr(ctrl, "ControlTypeName", None),
        "name": getattr(ctrl, "Name", None),
        "automation_id": getattr(ctrl, "AutomationId", None),
        "class_name": getattr(ctrl, "ClassName", None),
        "bbox": bbox,
        "center": center,
    }
    try:
        info["is_enabled"] = bool(ctrl.IsEnabled)
    except Exception:
        pass
    try:
        info["is_offscreen"] = bool(ctrl.IsOffscreen)
    except Exception:
        pass
    return info


def _try_get_value(ctrl) -> str | None:
    try:
        return ctrl.GetValuePattern().Value
    except Exception:
        return None


def _try_get_text(ctrl) -> str | None:
    try:
        return ctrl.GetTextPattern().DocumentRange.GetText(-1)
    except Exception:
        return None


def uia_find(spec: dict) -> dict:
    auto = _uia()
    timeout = float(spec.get("timeout_ms", 4000)) / 1000.0
    win = _find_window_ctrl(auto, spec, timeout)
    ctrl = _find_control(auto, win, spec, timeout)
    return {
        "ok": True,
        "action": "uia.find",
        "window": _control_info(win),
        "control": _control_info(ctrl),
    }


def uia_act(spec: dict) -> dict:
    auto = _uia()
    timeout = float(spec.get("timeout_ms", 4000)) / 1000.0
    action = (spec.get("act") or spec.get("action") or "click").lower()
    win = _find_window_ctrl(auto, spec, timeout)
    ctrl = _find_control(auto, win, spec, timeout)
    info = _control_info(ctrl)
    if action in ("click", "invoke"):
        method = None
        try:
            ctrl.GetInvokePattern().Invoke()
            method = "invoke-pattern"
        except Exception:
            try:
                ctrl.Click(simulateMove=False, waitTime=0.05)
                method = "click-simulate"
            except Exception as exc:
                raise RuntimeError(f"click failed: {exc}") from exc
        return {"ok": True, "action": "uia.click", "method": method, "control": info}
    if action == "set_value":
        text = str(spec.get("text") or "")
        try:
            ctrl.GetValuePattern().SetValue(text)
            method = "value-pattern"
        except Exception:
            try:
                ctrl.SetFocus()
            except Exception:
                pass
            time.sleep(0.05)
            hotkey(["ctrl", "a"])
            time.sleep(0.05)
            method = paste_text(text, preserve_clipboard=True)
        return {"ok": True, "action": "uia.set_value", "method": method, "chars": len(text), "control": info}
    if action == "append":
        text = str(spec.get("text") or "")
        try:
            ctrl.SetFocus()
        except Exception:
            pass
        time.sleep(0.05)
        press_key("end")
        time.sleep(0.03)
        method = paste_text(text, preserve_clipboard=True)
        return {"ok": True, "action": "uia.append", "method": method, "chars": len(text), "control": info}
    if action == "get_value":
        return {"ok": True, "action": "uia.get_value", "value": _try_get_value(ctrl), "control": info}
    if action == "get_text":
        parts = []
        v = _try_get_value(ctrl)
        if v:
            parts.append(v)
        t = _try_get_text(ctrl)
        if t and t not in parts:
            parts.append(t)
        nm = getattr(ctrl, "Name", "") or ""
        if nm and nm not in parts:
            parts.append(nm)
        return {"ok": True, "action": "uia.get_text", "text": "\n".join(parts), "control": info}
    if action == "focus":
        try:
            ctrl.SetFocus()
        except Exception as exc:
            raise RuntimeError(f"focus failed: {exc}") from exc
        return {"ok": True, "action": "uia.focus", "control": info}
    if action == "send_keys":
        keys = str(spec.get("keys") or spec.get("text") or "")
        if not keys:
            raise ValueError("send_keys requires 'keys'")
        try:
            ctrl.SetFocus()
        except Exception:
            pass
        time.sleep(0.05)
        ctrl.SendKeys(keys)
        return {"ok": True, "action": "uia.send_keys", "keys": keys, "control": info}
    raise ValueError(f"unknown uia action: {action}")


def uia_tree(spec: dict) -> dict:
    auto = _uia()
    timeout = float(spec.get("timeout_ms", 4000)) / 1000.0
    max_depth = int(spec.get("max_depth", 4))
    max_nodes = int(spec.get("max_nodes", 400))
    win = _find_window_ctrl(auto, spec, timeout)
    counter = [0]

    def walk(c, depth):
        if counter[0] >= max_nodes:
            return None
        counter[0] += 1
        node = _control_info(c)
        if depth >= max_depth:
            return node
        children = []
        try:
            for child in c.GetChildren():
                if counter[0] >= max_nodes:
                    break
                children.append(walk(child, depth + 1))
        except Exception:
            pass
        if children:
            node["children"] = [ch for ch in children if ch]
        return node

    root = walk(win, 0)
    return {"ok": True, "action": "uia.tree", "nodes": counter[0], "max_depth": max_depth, "tree": root}


def uia_wait(spec: dict) -> dict:
    auto = _uia()
    timeout = float(spec.get("timeout_ms", 4000)) / 1000.0
    started_at = time.time()
    win = _find_window_ctrl(auto, spec, timeout)
    ctrl = _find_control(auto, win, spec, timeout)
    elapsed_ms = int((time.time() - started_at) * 1000)
    return {
        "ok": True,
        "action": "uia.wait",
        "elapsed_ms": elapsed_ms,
        "window": _control_info(win),
        "control": _control_info(ctrl),
    }


def uia_find_all(spec: dict) -> dict:
    auto = _uia()
    timeout = float(spec.get("timeout_ms", 4000)) / 1000.0
    max_items = int(spec.get("max_items", 50))
    win = _find_window_ctrl(auto, spec, timeout)
    controls = _find_controls(auto, win, spec, timeout)[:max_items]
    return {
        "ok": True,
        "action": "uia.find_all",
        "window": _control_info(win),
        "count": len(controls),
        "controls": [_control_info(ctrl) for ctrl in controls]
    }


# ---------- Screenshot ----------

def _normalize_region(payload: dict, w: int, h: int) -> tuple[int, int, int, int] | None:
    region = payload.get("region")
    if not region:
        return None
    if isinstance(region, dict):
        x = int(region.get("x", 0))
        y = int(region.get("y", 0))
        rw = int(region.get("w") or region.get("width") or (w - x))
        rh = int(region.get("h") or region.get("height") or (h - y))
    elif isinstance(region, (list, tuple)) and len(region) == 4:
        x, y, rw, rh = (int(v) for v in region)
    else:
        raise ValueError("region must be [x,y,w,h] or {x,y,w,h}")
    x = max(0, min(w - 1, x))
    y = max(0, min(h - 1, y))
    rw = max(1, min(w - x, rw))
    rh = max(1, min(h - y, rh))
    return x, y, rw, rh


def screenshot_image(backend: str = "auto", region: tuple[int, int, int, int] | None = None):
    if backend in ("auto", "mss"):
        try:
            import mss  # type: ignore
            from PIL import Image  # type: ignore
            with mss.mss() as sct:
                if region is not None:
                    x, y, rw, rh = region
                    raw = sct.grab({"left": x, "top": y, "width": rw, "height": rh})
                else:
                    raw = sct.grab(sct.monitors[0])
                return Image.frombytes("RGB", raw.size, raw.rgb), "mss"
        except Exception:
            if backend == "mss":
                raise
    import pyautogui  # type: ignore
    if region is not None:
        x, y, rw, rh = region
        return pyautogui.screenshot(region=(x, y, rw, rh)), "pyautogui"
    return pyautogui.screenshot(), "pyautogui"


def add_preview(image, root: Path, preview_width: int) -> tuple[Path, dict]:
    width, height = image.size
    preview_width = int(preview_width or DEFAULT_PREVIEW_WIDTH)
    if preview_width >= width:
        preview = image
        preview_width = width
        preview_height = height
    else:
        preview_height = max(int(height * (preview_width / width)), 1)
        preview = image.resize((preview_width, preview_height))
    preview_path = root / "latest-preview.png"
    preview.save(preview_path)
    meta = {
        "preview_width": preview_width,
        "preview_height": preview_height,
        "scale_x": width / preview_width,
        "scale_y": height / preview_height,
    }
    return preview_path, meta


def _file_b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


def _grayscale_signature(image, size: int = 32) -> bytes:
    """Downsample to size x size grayscale. Returned bytes are directly diff-able
    via a per-pixel sum-of-absolute-differences. Used by /wait_change so the LLM
    gets a definitive answer to 'did the click do anything?' instead of guessing
    from two visually-identical previews."""
    from PIL import Image  # type: ignore
    small = image.convert("L").resize((size, size), Image.BILINEAR)
    return small.tobytes()


def _signature_diff(a: bytes, b: bytes) -> tuple[float, float]:
    """Returns (mean_abs_diff, similarity) where similarity in [0, 1].
    mean_abs_diff is on the [0, 255] scale per pixel."""
    if len(a) != len(b) or not a:
        return 255.0, 0.0
    total = 0
    for x, y in zip(a, b):
        total += abs(x - y)
    mean = total / len(a)
    similarity = max(0.0, 1.0 - mean / 255.0)
    return mean, similarity


def wait_change(payload: dict) -> dict:
    """Take a screenshot, wait, take a second screenshot, return whether the
    region visibly changed. This is the explicit feedback channel the LLM
    needs after a click — without it, the model can spend many turns retrying
    a click that UIPI silently dropped, because every follow-up screenshot
    looks the same and the model assumes 'maybe it just hasn't refreshed yet'.
    """
    full_w, full_h = screen_size()
    region = _normalize_region(payload, full_w, full_h)
    timeout_ms = int(payload.get("timeout_ms") or payload.get("timeoutMs") or 1500)
    poll_ms = max(50, int(payload.get("poll_ms") or payload.get("pollMs") or 200))
    threshold = float(payload.get("threshold") or 2.0)  # mean abs diff per pixel
    sig_size = max(8, min(64, int(payload.get("signature_size") or 32)))

    backend_pref = str(payload.get("backend") or "auto")
    first_image, backend = screenshot_image(backend_pref, region)
    base_sig = _grayscale_signature(first_image, sig_size)

    start = time.monotonic()
    deadline = start + max(timeout_ms, 0) / 1000.0
    last_mean = 0.0
    last_similarity = 1.0
    polls = 0
    changed = False
    while True:
        elapsed_ms = int((time.monotonic() - start) * 1000)
        if elapsed_ms >= timeout_ms:
            break
        remaining_ms = timeout_ms - elapsed_ms
        sleep_ms = min(poll_ms, remaining_ms)
        if sleep_ms > 0:
            time.sleep(sleep_ms / 1000.0)
        polls += 1
        next_image, _ = screenshot_image(backend_pref, region)
        next_sig = _grayscale_signature(next_image, sig_size)
        last_mean, last_similarity = _signature_diff(base_sig, next_sig)
        if last_mean >= threshold:
            changed = True
            break
        if time.monotonic() >= deadline:
            break

    return {
        "ok": True,
        "action": "wait_change",
        "changed": changed,
        "mean_abs_diff": round(last_mean, 3),
        "similarity": round(last_similarity, 4),
        "threshold": threshold,
        "polls": polls,
        "elapsed_ms": int((time.monotonic() - start) * 1000),
        "region": list(region) if region else None,
        "backend": backend,
        "signature_size": sig_size,
    }


_OCR_ENGINE = None
_OCR_INIT_ERROR = ""


def _get_ocr_engine():
    """Lazy-initialise RapidOCR. The first call downloads the ONNX models
    (~30 MB) into the rapidocr package cache, subsequent calls are instant.
    Returns (engine, error_message); only one of the two is non-empty."""
    global _OCR_ENGINE, _OCR_INIT_ERROR
    if _OCR_ENGINE is not None:
        return _OCR_ENGINE, ""
    if _OCR_INIT_ERROR:
        return None, _OCR_INIT_ERROR
    try:
        from rapidocr_onnxruntime import RapidOCR  # type: ignore
    except Exception as exc:
        _OCR_INIT_ERROR = (
            "rapidocr_onnxruntime is not installed. Run "
            "`pip install rapidocr-onnxruntime` in the same Python the desktop "
            f"agent uses (current import error: {exc})."
        )
        return None, _OCR_INIT_ERROR
    try:
        _OCR_ENGINE = RapidOCR()
        return _OCR_ENGINE, ""
    except Exception as exc:
        _OCR_INIT_ERROR = f"rapidocr engine failed to initialize: {exc}"
        return None, _OCR_INIT_ERROR


def find_text(payload: dict) -> dict:
    """Run OCR over (a) the whole screen, (b) a region, or (c) a window-cropped
    region, and return the bounding boxes of any matching text. This is the
    UIA-free path for self-drawn / DirectUI windows that expose no
    accessibility tree (Dingtalk installer, parts of WeChat/QQ, some game
    launchers). The model should pass the desired `query`, then click the
    returned `center` with `desktop_click_at` using `space="screen"`.
    """
    engine, err = _get_ocr_engine()
    if engine is None:
        # Return ok=False without raising so the LLM sees a recoverable error
        # body, not a 500. The handler-side wrapper turns this into a
        # tool_error with actionable next_step text.
        return {
            "ok": False,
            "error": err,
            "type": "OCREngineUnavailable",
        }
    full_w, full_h = screen_size()
    region = _normalize_region(payload, full_w, full_h)
    image, backend = screenshot_image(str(payload.get("backend") or "auto"), region)
    # RapidOCR takes a numpy array (RGB) or a file path. Persist to disk so
    # the screenshots/ directory keeps a record of what was searched, then
    # feed the file path. This also helps when debugging "why did OCR miss
    # this text" — the exact input image is on disk.
    root = ensure_dirs()
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    img_path = root / "screenshots" / f"ocr-{stamp}.png"
    image.save(img_path)
    raw_result, _elapsed = engine(str(img_path))
    raw_result = raw_result or []

    query = str(payload.get("query") or "").strip()
    match_mode = str(payload.get("match") or "contains").lower()
    min_confidence = float(payload.get("min_confidence") or 0.5)
    max_results = max(1, int(payload.get("max_results") or 20))

    offset_x = region[0] if region else 0
    offset_y = region[1] if region else 0

    matches = []
    for entry in raw_result:
        try:
            box, text, score = entry
        except Exception:
            continue
        score = float(score or 0.0)
        if score < min_confidence:
            continue
        text_str = str(text or "")
        if query:
            if match_mode == "exact" and text_str != query:
                continue
            if match_mode == "contains" and query.lower() not in text_str.lower():
                continue
            if match_mode == "regex":
                import re
                try:
                    if not re.search(query, text_str):
                        continue
                except re.error:
                    if query not in text_str:
                        continue
        # RapidOCR returns [[x0,y0],[x1,y1],[x2,y2],[x3,y3]] — clockwise polygon.
        xs = [float(p[0]) for p in box]
        ys = [float(p[1]) for p in box]
        x_min, x_max = min(xs), max(xs)
        y_min, y_max = min(ys), max(ys)
        screen_left = int(round(x_min + offset_x))
        screen_top = int(round(y_min + offset_y))
        screen_width = int(round(x_max - x_min))
        screen_height = int(round(y_max - y_min))
        matches.append({
            "text": text_str,
            "confidence": round(score, 4),
            "bbox": [screen_left, screen_top, screen_width, screen_height],
            "center": [
                int(round((x_min + x_max) / 2 + offset_x)),
                int(round((y_min + y_max) / 2 + offset_y)),
            ],
        })
        if len(matches) >= max_results:
            break

    return {
        "ok": True,
        "action": "find_text",
        "query": query,
        "match": match_mode,
        "matches": matches,
        "image_path": str(img_path),
        "backend": backend,
        "region": list(region) if region else None,
    }


# Cache of the most recent screenshot's coordinate frame. resolve_point()
# uses this so the LLM can pass coordinates in the "preview" pixel grid it
# just saw, without having to track preview_width / preview_height / region
# itself — those three were the single largest source of "click landed at
# (2406, 1041) which is OFF the target window" errors. When the LLM passes
# space="preview" and a screenshot context exists, we honor it as the source
# of truth; LLM-supplied preview_width / preview_height become hints we can
# sanity-check against, not the math we trust.
_LAST_SCREENSHOT_CTX: dict | None = None


def _record_screenshot_context(
    *,
    region: tuple[int, int, int, int] | None,
    image_size: tuple[int, int],
    preview_width: int,
    preview_height: int,
) -> None:
    global _LAST_SCREENSHOT_CTX
    full_w, full_h = screen_size()
    img_w, img_h = image_size
    _LAST_SCREENSHOT_CTX = {
        "region": list(region) if region else None,
        "image_width": int(img_w),
        "image_height": int(img_h),
        "preview_width": int(preview_width),
        "preview_height": int(preview_height),
        "screen_width": int(full_w),
        "screen_height": int(full_h),
        "captured_at": time.monotonic(),
    }


def take_screenshot(payload: dict) -> dict:
    root = ensure_dirs()
    full_w, full_h = screen_size()
    region = _normalize_region(payload, full_w, full_h)
    image, backend = screenshot_image(str(payload.get("backend") or "auto"), region)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    region_tag = "-region" if region else ""
    path = root / "screenshots" / f"screen{region_tag}-{stamp}.png"
    image.save(path)
    latest = root / "latest.png"
    if not region:
        shutil.copyfile(path, latest)
    preview, meta = add_preview(
        image,
        root,
        int(payload.get("preview_width") or DEFAULT_PREVIEW_WIDTH),
    )
    width, height = image.size
    active = active_window_info()
    result = {
        "ok": True,
        "action": "screenshot",
        "path": str(path),
        "latest": str(latest) if not region else None,
        "preview": str(preview),
        "width": width,
        "height": height,
        "backend": backend,
        "active_window": active,
        **meta,
    }
    if region:
        x, y, rw, rh = region
        result["region"] = {"x": x, "y": y, "w": rw, "h": rh}
        result["screen_width"] = full_w
        result["screen_height"] = full_h
    _record_screenshot_context(
        region=region,
        image_size=image.size,
        preview_width=int(meta.get("preview_width") or image.size[0]),
        preview_height=int(meta.get("preview_height") or image.size[1]),
    )
    if payload.get("inline"):
        which = (payload.get("inline_target") or "preview").lower()
        target_path = preview if which == "preview" else path
        result["inline_b64"] = _file_b64(target_path)
        result["inline_target"] = which
    return result


def resolve_point(payload: dict) -> tuple[int, int, dict]:
    width, height = screen_size()
    space = str(payload.get("space") or "screen")
    x = payload.get("x")
    y = payload.get("y")
    if x is None or y is None:
        raise ValueError("x and y are required")
    meta = {"space": space, "screen_width": width, "screen_height": height}
    if space == "normalized":
        rx = int(round(float(x) * width))
        ry = int(round(float(y) * height))
    elif space == "preview":
        ctx = _LAST_SCREENSHOT_CTX
        # Two coordinate frames are in play:
        #   - LLM frame: the previewWidth/previewHeight the LLM THINKS it is
        #     looking at (often echoes the previewWidth it asked the capture
        #     to use, e.g. 1200, even when the actual preview ended up only
        #     852 wide because the capture was a window crop).
        #   - Server frame: the ACTUAL preview / image / region dimensions
        #     recorded at capture time.
        # The robust resolution is to map LLM(x,y) -> fractional position
        # in LLM frame, then re-scale that fraction into the server's actual
        # image, then translate by the region offset. This corrects both
        # (a) LLM's previewWidth mismatch and (b) windowed-crop coordinate
        # interpretation, which together produced the (2406, 1041) target
        # for what should have been a (~1610, 1015) click in the Dingtalk
        # installer.
        llm_pw = int(payload.get("preview_width") or 0)
        llm_ph = int(payload.get("preview_height") or 0)
        if ctx:
            ctx_pw = int(ctx.get("preview_width") or 0) or ctx.get("image_width") or width
            ctx_ph = int(ctx.get("preview_height") or 0) or ctx.get("image_height") or height
            actual_pw = llm_pw if llm_pw > 0 else ctx_pw
            actual_ph = llm_ph if llm_ph > 0 else ctx_ph
            # Fractional position the LLM intended.
            fx = float(x) / max(actual_pw, 1)
            fy = float(y) / max(actual_ph, 1)
            img_w = int(ctx.get("image_width") or width)
            img_h = int(ctx.get("image_height") or height)
            ctx_region = ctx.get("region")
            if ctx_region:
                rx = int(round(ctx_region[0] + fx * img_w))
                ry = int(round(ctx_region[1] + fy * img_h))
                source = "last_capture_window_crop"
            else:
                rx = int(round(fx * ctx.get("screen_width", width)))
                ry = int(round(fy * ctx.get("screen_height", height)))
                source = "last_capture_fullscreen"
            meta.update({
                "preview_width": actual_pw,
                "preview_height": actual_ph,
                "preview_region_source": source,
                "preview_region": list(ctx_region) if ctx_region else None,
            })
        else:
            # No screenshot has been taken in this session — fall back to the
            # legacy behavior so callers that drive the agent without going
            # through capture (e.g. raw HTTP scripts) still get reasonable
            # math. This is also the original pre-fix codepath.
            preview_width = llm_pw or DEFAULT_PREVIEW_WIDTH
            preview_height = llm_ph or int(round(height * (preview_width / max(width, 1))))
            rx = int(round(float(x) * (width / preview_width)))
            ry = int(round(float(y) * (height / preview_height)))
            meta.update({
                "preview_width": preview_width,
                "preview_height": preview_height,
                "preview_region_source": "fallback_no_capture",
            })
    elif space == "region":
        region = payload.get("region")
        if not region:
            raise ValueError("space='region' requires region=[x,y,w,h]")
        if isinstance(region, dict):
            ox, oy = int(region.get("x", 0)), int(region.get("y", 0))
            rw = int(region.get("w") or region.get("width") or 0)
            rh = int(region.get("h") or region.get("height") or 0)
        else:
            ox, oy, rw, rh = (int(v) for v in region)
        # optional preview within region
        pw = payload.get("preview_width")
        if pw:
            pw = int(pw)
            ph = int(payload.get("preview_height") or round(rh * (pw / rw)))
            rx = ox + int(round(float(x) * (rw / pw)))
            ry = oy + int(round(float(y) * (rh / ph)))
        else:
            rx = ox + int(round(float(x)))
            ry = oy + int(round(float(y)))
        meta.update({"region": [ox, oy, rw, rh]})
    else:
        rx = int(round(float(x)))
        ry = int(round(float(y)))
    rx = max(0, min(width - 1, rx))
    ry = max(0, min(height - 1, ry))
    meta.update({"resolved_x": rx, "resolved_y": ry})
    return rx, ry, meta


# ---------- HTTP ----------

def json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _meta_from_payload(payload: dict) -> dict:
    lease_id = str(payload.get("lease_id") or payload.get("leaseId") or "").strip()
    session_id = str(payload.get("session_id") or payload.get("sessionId") or "").strip()
    action_id = str(payload.get("action_id") or payload.get("actionId") or "").strip()
    return {
        "lease_id": lease_id,
        "session_id": session_id,
        "action_id": action_id,
    }


def _with_meta(result: dict, payload: dict) -> dict:
    return {
        **result,
        **_meta_from_payload(payload)
    }


def _require_lease(payload: dict) -> None:
    global _active_lease_id
    lease_id = str(payload.get("lease_id") or payload.get("leaseId") or "").strip()
    if not lease_id:
        return
    if _active_lease_id and _active_lease_id != lease_id:
        err = RuntimeError(f"desktop lease busy: {_active_lease_id}")
        err.code = "LEASE_CONFLICT"  # type: ignore[attr-defined]
        raise err
    _active_lease_id = lease_id


def _release_lease(payload: dict) -> None:
    global _active_lease_id
    lease_id = str(payload.get("lease_id") or payload.get("leaseId") or "").strip()
    if lease_id and _active_lease_id == lease_id:
        _active_lease_id = ""


def read_json(handler: BaseHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length") or "0")
    if length <= 0:
        return {}
    raw = handler.rfile.read(length)
    return json.loads(raw.decode("utf-8"))


def _extract_bearer_token(handler: BaseHTTPRequestHandler) -> str:
    header = str(handler.headers.get("Authorization") or "").strip()
    if not header.lower().startswith("bearer "):
        return ""
    return header[7:].strip()


def require_auth(handler: BaseHTTPRequestHandler) -> bool:
    if not AUTH_TOKEN:
        return True
    if _extract_bearer_token(handler) == AUTH_TOKEN:
        return True
    json_response(handler, 401, {
        "ok": False,
        "error": "authentication required",
        "code": "AUTH_REQUIRED",
    })
    return False


class DesktopAgentHandler(BaseHTTPRequestHandler):
    server_version = "DesktopAgent/0.2"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {self.address_string()} {fmt % args}")

    def do_GET(self) -> None:
        if not require_auth(self):
            return
        path = urlparse(self.path).path
        if path == "/health":
            width, height = screen_size()
            cx, cy = cursor_pos()
            json_response(self, 200, {
                "ok": True,
                "screen_width": width,
                "screen_height": height,
                "cursor_x": cx,
                "cursor_y": cy,
                "active_window": active_window_info(),
                "version": "0.2",
                "active_lease_id": _active_lease_id,
                # The single most diagnostic field in /health: if elevated is
                # false and the click target is an elevated installer window,
                # every input will be silently dropped by UIPI. Surface this
                # up front so the LLM can refuse to retry-spam clicks and
                # instead tell the user to run install-elevated-task.ps1.
                "elevated": _is_process_elevated(),
                "integrity_level": _process_integrity_level(),
                # remote_session=true means the agent is running inside an
                # RDP session — synthetic SetCursorPos calls will fight the
                # client's pointer sync. The LLM should warn the user up
                # front instead of blaming UIPI for every failed click.
                "remote_session": _is_rdp_session(),
            })
            return
        if path == "/active":
            json_response(self, 200, {"ok": True, "active_window": active_window_info()})
            return
        if path == "/windows":
            json_response(self, 200, {"ok": True, "windows": enum_windows()})
            return
        if path == "/cursor_info":
            json_response(self, 200, {"ok": True, **get_cursor_info()})
            return
        json_response(self, 404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        if not require_auth(self):
            return
        path = urlparse(self.path).path
        try:
            payload = read_json(self)
            with _action_lock:
                _require_lease(payload)
                if path == "/screenshot":
                    result = _with_meta(take_screenshot(payload), payload)
                elif path == "/move":
                    x, y, meta = resolve_point(payload)
                    move_status = set_cursor(x, y)
                    # Brief settle so the window underneath gets a chance to
                    # service WM_SETCURSOR before we read the cursor back.
                    # 50ms is enough for native UIs and DirectUI hit-testing;
                    # on slower hardware the LLM can call /cursor_info again
                    # for a fresher read.
                    time.sleep(0.05)
                    cursor = get_cursor_info()
                    result = _with_meta({
                        "ok": True,
                        "action": "move",
                        **meta,
                        "cursor": cursor,
                        # Explicit "did the cursor actually end up where we
                        # asked?" answer — the LLM/user need this when the
                        # move is silently overridden (Remote Desktop, ClipCursor,
                        # secondary monitor at non-origin coords). When moved
                        # is false, the LLM should NOT proceed to click — the
                        # click would land on whatever's actually under the
                        # current cursor position.
                        "moved": move_status.get("moved", False),
                        "moved_to_actual": move_status.get("actual"),
                        "setcursorpos_ok": move_status.get("setcursorpos_ok"),
                        "target": [int(x), int(y)],
                    }, payload)
                elif path == "/click":
                    x, y, meta = resolve_point(payload)
                    move_status = set_cursor(x, y)
                    # Wait briefly so the underlying window can update its
                    # cursor shape via WM_SETCURSOR before we sample it.
                    time.sleep(0.05)
                    pre_cursor = get_cursor_info()
                    verify_hover = bool(payload.get("verify_hover", False))
                    # Optional safety net: when the caller says verify_hover,
                    # refuse to click if the cursor is still the default arrow
                    # or hidden. Disabled by default because plenty of native
                    # Win32 push buttons leave the cursor as arrow yet are
                    # still clickable — turning this on for every click would
                    # cause more false negatives than the existing wait_change
                    # signal. Use it specifically for ATL/DirectUI installers
                    # and web-style hyperlinks where the hand cursor is the
                    # reliable "interactive" indicator.
                    skipped = False
                    skipped_reason = None
                    if verify_hover and pre_cursor.get("shape") in ("arrow", "none", "wait", "appstarting"):
                        skipped = True
                        skipped_reason = "cursor_not_interactive"
                    # If the cursor never actually reached the target (e.g.
                    # RDP/ClipCursor reset), clicking would land somewhere
                    # else entirely. Always skip in that case, regardless of
                    # verify_hover — a misplaced click is worse than no click.
                    if not move_status.get("moved", False):
                        skipped = True
                        skipped_reason = skipped_reason or "cursor_did_not_move"
                    button = str(payload.get("button") or "left")
                    if not skipped:
                        # Cursor was already moved+verified above; tell
                        # click_at to skip its internal move to avoid a
                        # redundant SendInput that occasionally registers as
                        # a hover-flicker on DirectUI hit-testing.
                        click_at(x, y, button, int(payload.get("clicks") or 1), skip_move=True)
                        time.sleep(0.03)
                    post_cursor = get_cursor_info()
                    result = _with_meta({
                        "ok": True,
                        "action": "click",
                        "button": button,
                        "skipped_due_to_cursor": skipped,
                        "skipped_reason": skipped_reason,
                        "cursor_before": pre_cursor,
                        "cursor_after": post_cursor,
                        "moved": move_status.get("moved", False),
                        "moved_to_actual": move_status.get("actual"),
                        "setcursorpos_ok": move_status.get("setcursorpos_ok"),
                        "target": [int(x), int(y)],
                        **meta,
                    }, payload)
                elif path == "/type":
                    text = str(payload.get("text") or "")
                    preserve = payload.get("preserve_clipboard", True)
                    method = paste_text(text, preserve_clipboard=bool(preserve))
                    result = _with_meta({"ok": True, "action": "type", "chars": len(text), "method": method}, payload)
                elif path == "/press":
                    press_key(str(payload.get("key") or ""))
                    result = _with_meta({"ok": True, "action": "press", "key": str(payload.get("key") or "")}, payload)
                elif path == "/hotkey":
                    keys = payload.get("keys") or []
                    if isinstance(keys, str):
                        keys = [part.strip() for part in keys.split(",") if part.strip()]
                    hotkey(list(keys))
                    result = _with_meta({"ok": True, "action": "hotkey", "keys": keys}, payload)
                elif path == "/scroll":
                    scroll(int(payload.get("amount") or 0))
                    result = _with_meta({"ok": True, "action": "scroll", "amount": int(payload.get("amount") or 0)}, payload)
                elif path == "/wait":
                    ms = int(payload.get("ms") or 0)
                    time.sleep(max(ms, 0) / 1000)
                    result = _with_meta({"ok": True, "action": "wait", "ms": ms}, payload)
                elif path == "/wait_change":
                    result = _with_meta(wait_change(payload), payload)
                elif path == "/find_text":
                    result = _with_meta(find_text(payload), payload)
                elif path == "/launch":
                    result = _with_meta(launch_app(payload.get("path"), payload.get("query")), payload)
                elif path == "/focus":
                    hwnd = payload.get("hwnd")
                    if hwnd:
                        info = focus_window(int(hwnd))
                        result = _with_meta({"ok": True, "action": "focus", "window": info}, payload)
                    else:
                        title = payload.get("title")
                        match = str(payload.get("match") or "contains")
                        matches = find_windows(str(title or ""), match)
                        if not matches:
                            raise RuntimeError(f"no window matches title={title!r} match={match}")
                        info = focus_window(matches[0]["hwnd"])
                        result = _with_meta({"ok": True, "action": "focus", "window": info, "candidates": matches}, payload)
                elif path == "/windows":
                    title = payload.get("title")
                    if title:
                        result = _with_meta({"ok": True, "windows": find_windows(str(title), str(payload.get("match") or "contains"))}, payload)
                    else:
                        result = _with_meta({"ok": True, "windows": enum_windows()}, payload)
                elif path == "/ui/find":
                    result = _with_meta(uia_find(payload), payload)
                elif path == "/ui/find_all":
                    result = _with_meta(uia_find_all(payload), payload)
                elif path == "/ui/act":
                    result = _with_meta(uia_act(payload), payload)
                elif path == "/ui/tree":
                    result = _with_meta(uia_tree(payload), payload)
                elif path == "/ui/wait":
                    result = _with_meta(uia_wait(payload), payload)
                else:
                    json_response(self, 404, {"ok": False, "error": "not found"})
                    return
                _release_lease(payload)
            json_response(self, 200, result)
        except Exception as exc:
            payload = locals().get("payload", {}) or {}
            _release_lease(payload)
            json_response(self, 500, {
                "ok": False,
                "error": str(exc),
                "type": exc.__class__.__name__,
                "code": str(getattr(exc, "code", "") or exc.__class__.__name__.upper()),
                **_meta_from_payload(payload)
            })


def _load_token_from_file(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except Exception:
        return ""


def main() -> None:
    global AUTH_TOKEN
    parser = argparse.ArgumentParser(description="Run local desktop-control HTTP agent.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--token", default="")
    parser.add_argument(
        "--token-file",
        default="",
        help=(
            "Read auth token from this file if --token is empty. Useful when an "
            "elevated scheduled task starts the agent before CliGate is up: the "
            "token rotates inside ~/.cligate/desktop-agent.token and the agent "
            "always picks up the current value at start time."
        ),
    )
    args = parser.parse_args()
    AUTH_TOKEN = str(args.token or "").strip()
    if not AUTH_TOKEN and args.token_file:
        AUTH_TOKEN = _load_token_from_file(str(args.token_file))
    if not AUTH_TOKEN:
        default_token_file = os.path.join(
            os.path.expanduser("~"), ".cligate", "desktop-agent.token"
        )
        if os.path.exists(default_token_file):
            AUTH_TOKEN = _load_token_from_file(default_token_file)

    enable_dpi_awareness()
    root = ensure_dirs()
    width, height = screen_size()
    print(f"Desktop agent v0.2 listening on http://{args.host}:{args.port}")
    print(f"Output directory: {root}")
    print(f"Screen: {width} x {height}")
    print("New in v0.2: /launch /focus /windows /active /ui/find /ui/act /ui/tree, screenshot region+active_window+inline")
    print("Keep this window open while Codex controls the desktop. Press Ctrl+C to stop.")

    server = ThreadingHTTPServer((args.host, args.port), DesktopAgentHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping desktop agent...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
