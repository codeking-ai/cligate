import Foundation
import CoreGraphics

// Maps the key names used by CliGate (Windows-style: "enter", "esc", "ctrl",
// "{Enter}", etc.) to macOS virtual key codes and modifier flags. Names are
// normalised case-insensitively and tolerate the Windows "{Key}" wrapper.
enum Keymap {
    private static func normalize(_ raw: String) -> String {
        var k = raw.trimmingCharacters(in: .whitespaces).lowercased()
        if k.hasPrefix("{") && k.hasSuffix("}") { k = String(k.dropFirst().dropLast()) }
        return k
    }

    static func modifier(for raw: String) -> CGEventFlags? {
        switch normalize(raw) {
        case "ctrl", "control": return .maskControl
        case "cmd", "command", "win", "meta", "super": return .maskCommand
        case "alt", "option", "opt": return .maskAlternate
        case "shift": return .maskShift
        default: return nil
        }
    }

    // Common virtual key codes (US layout). Extend as needed during on-device
    // bring-up; letters/digits cover the frequent "ctrl+a / cmd+s" shortcuts.
    static func code(for raw: String) -> CGKeyCode? {
        let k = normalize(raw)
        if let special = specials[k] { return special }
        if k.count == 1, let scalar = k.unicodeScalars.first {
            if let c = letters[Character(String(scalar))] { return c }
            if let c = digits[Character(String(scalar))] { return c }
        }
        return nil
    }

    private static let specials: [String: CGKeyCode] = [
        "enter": 36, "return": 36,
        "tab": 48,
        "space": 49, "spacebar": 49,
        "esc": 53, "escape": 53,
        "backspace": 51, "delete": 51,
        "forwarddelete": 117,
        "up": 126, "down": 125, "left": 123, "right": 124,
        "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
        "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111
    ]

    private static let letters: [Character: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
        "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46
    ]

    private static let digits: [Character: CGKeyCode] = [
        "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25, "0": 29
    ]
}
