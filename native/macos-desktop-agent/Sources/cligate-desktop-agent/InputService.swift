import Foundation
import CoreGraphics
import AppKit

// Low-level input via CGEvent. Coordinates are global, top-left origin (the same
// space CGWindowList bbox values use), matching the Windows agent's screen space.
//
// NOTE: this is the foreground CGEvent path — it may briefly require the target
// window to be frontmost. Background (focus-free) posting via SkyLight
// (SLEventPostToPid) is a later phase; see README.
enum InputService {
    static func cursorInfo() -> [String: Any] {
        let loc = currentMouse()
        // macOS exposes no simple global cursor-shape query; report "unknown" so
        // the LLM's verify_hover path degrades gracefully rather than blocking.
        return [
            "cursor_x": Int(loc.x),
            "cursor_y": Int(loc.y),
            "shape": "unknown",
            "visible": true
        ]
    }

    static func currentMouse() -> CGPoint {
        if let e = CGEvent(source: nil) { return e.location }
        return .zero
    }

    static func move(_ p: Payload) throws -> [String: Any] {
        let x = p.double("x"), y = p.double("y")
        warpCursor(CGPoint(x: x, y: y))
        Thread.sleep(forTimeInterval: 0.03)
        let actual = currentMouse()
        let moved = abs(actual.x - x) < 2 && abs(actual.y - y) < 2
        return [
            "ok": true,
            "action": "move",
            "moved": moved,
            "moved_to_actual": [Int(actual.x), Int(actual.y)],
            "target": [Int(x), Int(y)]
        ]
    }

    static func click(_ p: Payload) throws -> [String: Any] {
        let x = p.double("x"), y = p.double("y")
        let button = p.str("button", "left")
        let clicks = max(1, p.int("clicks", 1))
        let point = CGPoint(x: x, y: y)
        warpCursor(point)
        Thread.sleep(forTimeInterval: 0.03)
        for i in 0..<clicks {
            postMouseClick(at: point, button: button, clickState: Int64(i + 1))
        }
        return [
            "ok": true,
            "action": "click",
            "button": button,
            "target": [Int(x), Int(y)]
        ]
    }

    static func typeText(_ p: Payload) throws -> [String: Any] {
        let text = p.str("text")
        postUnicodeString(text)
        return ["ok": true, "action": "type", "chars": text.count, "method": "cgevent_unicode"]
    }

    static func press(_ p: Payload) throws -> [String: Any] {
        let key = p.str("key")
        guard let code = Keymap.code(for: key) else {
            throw AgentError("UNKNOWN_KEY", "unknown key: \(key)", status: 500)
        }
        postKey(code, flags: [])
        return ["ok": true, "action": "press", "key": key]
    }

    static func hotkey(_ p: Payload) throws -> [String: Any] {
        let keys = p.stringArray("keys")
        var flags: CGEventFlags = []
        var mainCode: CGKeyCode? = nil
        for k in keys {
            if let f = Keymap.modifier(for: k) {
                flags.insert(f)
            } else if let c = Keymap.code(for: k) {
                mainCode = c
            }
        }
        if let code = mainCode {
            postKey(code, flags: flags)
        }
        return ["ok": true, "action": "hotkey", "keys": keys]
    }

    static func scroll(_ p: Payload) throws -> [String: Any] {
        let amount = p.int("amount")
        if let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1,
                           wheel1: Int32(amount), wheel2: 0, wheel3: 0) {
            e.post(tap: .cghidEventTap)
        }
        return ["ok": true, "action": "scroll", "amount": amount]
    }

    // MARK: - CGEvent primitives

    private static func warpCursor(_ p: CGPoint) {
        CGWarpMouseCursorPosition(p)
        CGAssociateMouseAndMouseCursorPosition(1)
    }

    private static func postMouseClick(at p: CGPoint, button: String, clickState: Int64) {
        let down: CGEventType, up: CGEventType, btn: CGMouseButton
        switch button {
        case "right":
            (down, up, btn) = (.rightMouseDown, .rightMouseUp, .right)
        default:
            (down, up, btn) = (.leftMouseDown, .leftMouseUp, .left)
        }
        let downEvent = CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: p, mouseButton: btn)
        downEvent?.setIntegerValueField(.mouseEventClickState, value: clickState)
        downEvent?.post(tap: .cghidEventTap)
        let upEvent = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: p, mouseButton: btn)
        upEvent?.setIntegerValueField(.mouseEventClickState, value: clickState)
        upEvent?.post(tap: .cghidEventTap)
    }

    private static func postKey(_ code: CGKeyCode, flags: CGEventFlags) {
        let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
        down?.flags = flags
        down?.post(tap: .cghidEventTap)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
        up?.flags = flags
        up?.post(tap: .cghidEventTap)
    }

    // Used by AX send_keys: treat a recognised key name (incl. "{Enter}") as a
    // keystroke, otherwise type the literal text.
    static func sendKeys(_ s: String) {
        if let code = Keymap.code(for: s) {
            postKey(code, flags: [])
        } else {
            postUnicodeString(s)
        }
    }

    private static func postUnicodeString(_ text: String) {
        for ch in text {
            let utf16 = Array(String(ch).utf16)
            let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
            down?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
            down?.post(tap: .cghidEventTap)
            let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
            up?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
            up?.post(tap: .cghidEventTap)
        }
    }
}
