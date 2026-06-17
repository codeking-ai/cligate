import Foundation
import AppKit
import CoreGraphics

// Window enumeration / focus / launch. The Windows agent keys windows by HWND;
// here the CGWindowID (kCGWindowNumber) plays that role, and we carry the owning
// pid alongside because AX work is per-process.
enum WindowsService {
    static func enumWindows() -> [[String: Any]] {
        let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let infoList = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
            return []
        }
        var out: [[String: Any]] = []
        for info in infoList {
            // Layer 0 == normal application windows (skip menus, the Dock, etc.)
            if let layer = info[kCGWindowLayer as String] as? Int, layer != 0 { continue }
            let number = info[kCGWindowNumber as String] as? Int ?? 0
            let ownerPID = info[kCGWindowOwnerPID as String] as? Int ?? 0
            let ownerName = info[kCGWindowOwnerName as String] as? String ?? ""
            let title = info[kCGWindowName as String] as? String ?? ""
            var bbox: [Int] = [0, 0, 0, 0]
            if let boundsDict = info[kCGWindowBounds as String] as? CFDictionary,
               let r = CGRect(dictionaryRepresentation: boundsDict) {
                bbox = [Int(r.origin.x), Int(r.origin.y), Int(r.size.width), Int(r.size.height)]
            }
            out.append([
                "hwnd": number,
                "pid": ownerPID,
                "title": title.isEmpty ? ownerName : title,
                "app": ownerName,
                "class": ownerName,
                "bbox": bbox
            ])
        }
        return out
    }

    static func findWindows(title: String, match: String) -> [[String: Any]] {
        let needle = title.lowercased()
        return enumWindows().filter { w in
            let t = (w["title"] as? String ?? "").lowercased()
            let a = (w["app"] as? String ?? "").lowercased()
            switch match {
            case "exact":
                return t == needle || a == needle
            case "regex":
                guard let re = try? NSRegularExpression(pattern: title, options: [.caseInsensitive]) else { return false }
                let range = NSRange(t.startIndex..., in: t)
                return re.firstMatch(in: t, options: [], range: range) != nil
            default:
                return t.contains(needle) || a.contains(needle)
            }
        }
    }

    static func activeWindowInfo() -> [String: Any]? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        let pid = Int(app.processIdentifier)
        var info: [String: Any] = [
            "pid": pid,
            "app": app.localizedName ?? "",
            "title": app.localizedName ?? ""
        ]
        if let w = enumWindows().first(where: { ($0["pid"] as? Int) == pid }) {
            info["hwnd"] = w["hwnd"] ?? 0
            info["title"] = w["title"] ?? info["title"]!
            info["bbox"] = w["bbox"] ?? [0, 0, 0, 0]
        }
        return info
    }

    // Resolve a payload window selector to the owning pid (used by AX too).
    static func resolvePID(_ p: Payload) -> pid_t? {
        if let hwnd = p.optInt("window_hwnd") ?? p.optInt("hwnd") {
            if let w = enumWindows().first(where: { ($0["hwnd"] as? Int) == hwnd }) {
                return pid_t(w["pid"] as? Int ?? 0)
            }
        }
        if let title = p.optStr("window_title") ?? p.optStr("title") {
            let matches = findWindows(title: title, match: p.str("window_match", p.str("match", "contains")))
            if let first = matches.first { return pid_t(first["pid"] as? Int ?? 0) }
        }
        return nil
    }

    static func focus(_ p: Payload) throws -> [String: Any] {
        guard let pid = resolvePID(p), pid > 0, let app = NSRunningApplication(processIdentifier: pid) else {
            throw AgentError("WINDOW_NOT_FOUND", "no window matches the given selector", status: 500)
        }
        app.activate(options: [.activateIgnoringOtherApps])
        Accessibility.raiseMainWindow(pid: pid)
        return ["ok": true, "action": "focus", "window": activeWindowInfo() as Any]
    }

    static func launch(_ p: Payload) throws -> [String: Any] {
        if let path = p.optStr("path") {
            let url = URL(fileURLWithPath: path)
            if !NSWorkspace.shared.open(url) {
                throw AgentError("LAUNCH_FAILED", "startfile failed for path \(path)", status: 500)
            }
            return ["ok": true, "method": "open", "target": path]
        }
        if let query = p.optStr("query") {
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            proc.arguments = ["-a", query]
            do {
                try proc.run()
            } catch {
                throw AgentError("LAUNCH_FAILED", "open -a \(query) failed: \(error)", status: 500)
            }
            return ["ok": true, "method": "open-a", "target": query]
        }
        throw AgentError("LAUNCH_FAILED", "launch requires path or query", status: 500)
    }
}
