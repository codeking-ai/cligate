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


def cursor_pos() -> tuple[int, int]:
    if is_windows():
        point = POINT()
        ctypes.windll.user32.GetCursorPos(ctypes.byref(point))
        return int(point.x), int(point.y)
    import pyautogui  # type: ignore
    pos = pyautogui.position()
    return int(pos.x), int(pos.y)


def set_cursor(x: int, y: int) -> None:
    if is_windows():
        ctypes.windll.user32.SetCursorPos(int(x), int(y))
        return
    import pyautogui  # type: ignore
    pyautogui.moveTo(int(x), int(y))


def mouse_event(flag: int, data: int = 0) -> None:
    ctypes.windll.user32.mouse_event(flag, 0, 0, int(data), 0)


def click_at(x: int, y: int, button: str = "left", clicks: int = 1) -> None:
    set_cursor(x, y)
    if is_windows():
        constants = {
            "left": (0x0002, 0x0004),
            "right": (0x0008, 0x0010),
            "middle": (0x0020, 0x0040),
        }
        down, up = constants.get(button, constants["left"])
        for _ in range(max(int(clicks), 1)):
            mouse_event(down)
            time.sleep(0.04)
            mouse_event(up)
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
    ctypes.windll.user32.keybd_event(int(vk), 0, 0 if down else 0x0002, 0)


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
        mouse_event(0x0800, int(amount) * 120)
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
        preview_width = int(payload.get("preview_width") or DEFAULT_PREVIEW_WIDTH)
        preview_height = int(payload.get("preview_height") or 0)
        if preview_height <= 0:
            preview_height = int(round(height * (preview_width / width)))
        rx = int(round(float(x) * (width / preview_width)))
        ry = int(round(float(y) * (height / preview_height)))
        meta.update({"preview_width": preview_width, "preview_height": preview_height})
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
            })
            return
        if path == "/active":
            json_response(self, 200, {"ok": True, "active_window": active_window_info()})
            return
        if path == "/windows":
            json_response(self, 200, {"ok": True, "windows": enum_windows()})
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
                    set_cursor(x, y)
                    result = _with_meta({"ok": True, "action": "move", **meta}, payload)
                elif path == "/click":
                    x, y, meta = resolve_point(payload)
                    click_at(x, y, str(payload.get("button") or "left"), int(payload.get("clicks") or 1))
                    result = _with_meta({"ok": True, "action": "click", "button": str(payload.get("button") or "left"), **meta}, payload)
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


def main() -> None:
    global AUTH_TOKEN
    parser = argparse.ArgumentParser(description="Run local desktop-control HTTP agent.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--token", default="")
    args = parser.parse_args()
    AUTH_TOKEN = str(args.token or "").strip()

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
