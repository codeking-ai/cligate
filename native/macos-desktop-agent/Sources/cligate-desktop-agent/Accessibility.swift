import Foundation
import ApplicationServices
import CoreGraphics

// The macOS analogue of the Windows UIA path. Walks the AX tree of a target
// application/window, matches controls by the SAME selector vocabulary the
// contract uses (control_type / name / automation_id / class_name), and performs
// semantic actions (AXPress, set AXValue, focus, send keys). Output dictionaries
// mirror the Python agent's /ui/* shapes so service.js needs no changes.
enum Accessibility {

    // MARK: - Public endpoints

    static func find(_ p: Payload) throws -> [String: Any] {
        let (root, windowFrame) = try resolveRoot(p)
        guard let el = search(root, selector: Selector(p), depth: p.int("search_depth", 32), all: false).first else {
            throw AgentError("CONTROL_NOT_FOUND", "control not found for the given selector", status: 500)
        }
        return [
            "ok": true,
            "action": "uia.find",
            "control": info(el),
            "window": ["bbox": windowFrame.map { rectArray($0) } as Any]
        ]
    }

    static func findAll(_ p: Payload) throws -> [String: Any] {
        let (root, _) = try resolveRoot(p)
        let limit = p.int("max_items", 50)
        var found = search(root, selector: Selector(p), depth: p.int("search_depth", 32), all: true)
        if found.count > limit { found = Array(found.prefix(limit)) }
        return [
            "ok": true,
            "action": "uia.find_all",
            "count": found.count,
            "controls": found.map { info($0) }
        ]
    }

    static func act(_ p: Payload) throws -> [String: Any] {
        let (root, _) = try resolveRoot(p)
        guard let el = search(root, selector: Selector(p), depth: p.int("search_depth", 32), all: false).first else {
            throw AgentError("CONTROL_NOT_FOUND", "control not found for the given selector", status: 500)
        }
        let action = p.str("act", "click")
        switch action {
        case "click", "invoke":
            _ = AXUIElementPerformAction(el, kAXPressAction as CFString)
            return ["ok": true, "action": "uia.click", "method": "AXPress", "control": info(el)]
        case "set_value":
            let text = p.str("text")
            setFocus(el)
            let err = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, text as CFTypeRef)
            if err != .success {
                throw AgentError("SET_VALUE_FAILED", "AXValue not settable on this element (err \(err.rawValue))", status: 500)
            }
            return ["ok": true, "action": "uia.set_value", "chars": text.count, "control": info(el)]
        case "append":
            let existing = stringAttr(el, kAXValueAttribute as String) ?? ""
            let text = existing + p.str("text")
            _ = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, text as CFTypeRef)
            return ["ok": true, "action": "uia.append", "chars": text.count, "control": info(el)]
        case "get_value":
            return ["ok": true, "action": "uia.get_value", "value": stringAttr(el, kAXValueAttribute as String) as Any, "control": info(el)]
        case "get_text":
            let text = stringAttr(el, kAXValueAttribute as String)
                ?? stringAttr(el, kAXTitleAttribute as String)
                ?? stringAttr(el, kAXDescriptionAttribute as String)
                ?? ""
            return ["ok": true, "action": "uia.get_text", "text": text, "control": info(el)]
        case "focus":
            setFocus(el)
            return ["ok": true, "action": "uia.focus", "control": info(el)]
        case "send_keys":
            setFocus(el)
            InputService.sendKeys(p.str("keys"))
            return ["ok": true, "action": "uia.send_keys", "keys": p.str("keys")]
        default:
            throw AgentError("UNKNOWN_ACT", "unknown act: \(action)", status: 500)
        }
    }

    static func tree(_ p: Payload) throws -> [String: Any] {
        let (root, _) = try resolveRoot(p)
        let maxDepth = p.int("max_depth", 30)
        let maxNodes = p.int("max_nodes", 600)
        var counter = 0
        let root_node = node(root, depth: 0, maxDepth: maxDepth, maxNodes: maxNodes, counter: &counter)
        var result: [String: Any] = ["ok": true, "action": "uia.tree", "nodes": counter, "max_depth": maxDepth, "tree": root_node]
        if p.bool("inspect_window") {
            // inspect-window set-of-mark overlay (screenshot + numbered marks bound
            // to AX nodes) is a follow-up; the AX tree above is already usable.
            result["inspect_window"] = true
            result["inspect_note"] = "inspect-window mark overlay not yet implemented on macOS"
        }
        return result
    }

    static func wait(_ p: Payload) throws -> [String: Any] {
        let timeoutMs = p.int("timeout_ms", 4000)
        let pollMs = max(100, p.int("poll_ms", 250))
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
        repeat {
            if let (root, _) = try? resolveRoot(p),
               let el = search(root, selector: Selector(p), depth: p.int("search_depth", 32), all: false).first {
                return ["ok": true, "action": "uia.wait", "found": true, "control": info(el)]
            }
            Thread.sleep(forTimeInterval: Double(pollMs) / 1000.0)
        } while Date() < deadline
        return ["ok": true, "action": "uia.wait", "found": false]
    }

    // Bring an app's main window forward without changing AX matching semantics.
    static func raiseMainWindow(pid: pid_t) {
        let app = AXUIElementCreateApplication(pid)
        if let main = axCopy(app, kAXMainWindowAttribute as String) {
            _ = AXUIElementPerformAction(main as! AXUIElement, kAXRaiseAction as CFString)
        }
    }

    // MARK: - Root / window resolution

    private static func resolveRoot(_ p: Payload) throws -> (AXUIElement, CGRect?) {
        guard let pid = WindowsService.resolvePID(p), pid > 0 else {
            throw AgentError("WINDOW_NOT_FOUND", "could not resolve a window for the selector", status: 500)
        }
        if !Permissions.accessibilityTrusted() {
            throw AgentError("ACCESSIBILITY_DENIED",
                             "Accessibility permission not granted — enable it in System Settings › Privacy & Security › Accessibility.",
                             status: 500)
        }
        let app = AXUIElementCreateApplication(pid)

        // If a window title is given, scope to that AX window; otherwise search
        // the whole app (all windows).
        if let wantTitle = p.optStr("window_title") ?? p.optStr("title") {
            if let windows = axCopy(app, kAXWindowsAttribute as String) as? [AXUIElement] {
                for win in windows {
                    let t = stringAttr(win, kAXTitleAttribute as String) ?? ""
                    if t.range(of: wantTitle, options: .caseInsensitive) != nil {
                        return (win, axFrame(win))
                    }
                }
            }
        }
        // Fallback: main window frame for region helpers, root = app.
        let mainFrame = (axCopy(app, kAXMainWindowAttribute as String)).flatMap { axFrame($0 as! AXUIElement) }
        return (app, mainFrame)
    }

    // MARK: - Tree search

    private struct Selector {
        let roles: Set<String>?      // nil => any role
        let name: String?
        let nameMatch: String
        let automationId: String?
        let subrole: String?

        init(_ p: Payload) {
            self.roles = Accessibility.desiredRoles(for: p.optStr("control_type"))
            self.name = p.optStr("name")
            self.nameMatch = p.str("name_match", "contains")
            self.automationId = p.optStr("automation_id")
            self.subrole = p.optStr("class_name")
        }
    }

    private static func search(_ root: AXUIElement, selector: Selector, depth: Int, all: Bool) -> [AXUIElement] {
        var results: [AXUIElement] = []
        var nodes = 0
        func dfs(_ el: AXUIElement, _ d: Int) {
            if d > depth || nodes > 4000 { return }
            nodes += 1
            if matches(el, selector) {
                results.append(el)
                if !all { return }
            }
            for child in children(el) {
                if !all && !results.isEmpty { return }
                dfs(child, d + 1)
            }
        }
        dfs(root, 0)
        return results
    }

    private static func matches(_ el: AXUIElement, _ s: Selector) -> Bool {
        if let roles = s.roles {
            let r = stringAttr(el, kAXRoleAttribute as String) ?? ""
            if !roles.contains(r) { return false }
        }
        if let id = s.automationId {
            let elId = stringAttr(el, kAXIdentifierAttribute as String) ?? ""
            if elId != id { return false }
        }
        if let sub = s.subrole {
            let elSub = stringAttr(el, kAXSubroleAttribute as String) ?? ""
            if elSub.caseInsensitiveCompare(sub) != .orderedSame { return false }
        }
        if let name = s.name {
            let candidates = [
                stringAttr(el, kAXTitleAttribute as String),
                stringAttr(el, kAXDescriptionAttribute as String),
                stringAttr(el, kAXValueAttribute as String)
            ].compactMap { $0 }
            let hit = candidates.contains { stringMatch($0, name, s.nameMatch) }
            if !hit { return false }
        }
        return true
    }

    private static func node(_ el: AXUIElement, depth: Int, maxDepth: Int, maxNodes: Int, counter: inout Int) -> [String: Any] {
        counter += 1
        var dict = info(el)
        if depth < maxDepth && counter < maxNodes {
            var kids: [[String: Any]] = []
            for child in children(el) {
                if counter >= maxNodes { break }
                kids.append(node(child, depth: depth + 1, maxDepth: maxDepth, maxNodes: maxNodes, counter: &counter))
            }
            if !kids.isEmpty { dict["children"] = kids }
        }
        return dict
    }

    // MARK: - Element info

    private static func info(_ el: AXUIElement) -> [String: Any] {
        let role = stringAttr(el, kAXRoleAttribute as String) ?? ""
        var dict: [String: Any] = [
            "control_type": controlType(for: role),
            "role": role,
            "name": stringAttr(el, kAXTitleAttribute as String) ?? stringAttr(el, kAXDescriptionAttribute as String) ?? "",
            "automation_id": stringAttr(el, kAXIdentifierAttribute as String) ?? "",
            "class_name": stringAttr(el, kAXSubroleAttribute as String) ?? ""
        ]
        if let v = stringAttr(el, kAXValueAttribute as String) { dict["value"] = v }
        if let f = axFrame(el) { dict["bbox"] = rectArray(f) }
        if let enabled = axCopy(el, kAXEnabledAttribute as String) as? Bool { dict["is_enabled"] = enabled }
        return dict
    }

    // MARK: - AX primitives

    private static func axCopy(_ el: AXUIElement, _ attr: String) -> AnyObject? {
        var ref: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(el, attr as CFString, &ref)
        return err == .success ? ref : nil
    }

    private static func stringAttr(_ el: AXUIElement, _ attr: String) -> String? {
        if let s = axCopy(el, attr) as? String { return s }
        return nil
    }

    private static func children(_ el: AXUIElement) -> [AXUIElement] {
        if let kids = axCopy(el, kAXChildrenAttribute as String) as? [AXUIElement] { return kids }
        return []
    }

    private static func axFrame(_ el: AXUIElement) -> CGRect? {
        guard let posVal = axCopy(el, kAXPositionAttribute as String),
              let sizeVal = axCopy(el, kAXSizeAttribute as String),
              CFGetTypeID(posVal) == AXValueGetTypeID(),
              CFGetTypeID(sizeVal) == AXValueGetTypeID() else { return nil }
        var pos = CGPoint.zero
        var size = CGSize.zero
        AXValueGetValue(posVal as! AXValue, .cgPoint, &pos)
        AXValueGetValue(sizeVal as! AXValue, .cgSize, &size)
        return CGRect(origin: pos, size: size)
    }

    private static func setFocus(_ el: AXUIElement) {
        _ = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    }

    private static func rectArray(_ r: CGRect) -> [Int] {
        [Int(r.origin.x), Int(r.origin.y), Int(r.size.width), Int(r.size.height)]
    }

    private static func stringMatch(_ value: String, _ query: String, _ mode: String) -> Bool {
        switch mode {
        case "exact": return value.caseInsensitiveCompare(query) == .orderedSame
        case "regex":
            guard let re = try? NSRegularExpression(pattern: query, options: [.caseInsensitive]) else { return false }
            return re.firstMatch(in: value, options: [], range: NSRange(value.startIndex..., in: value)) != nil
        default: return value.range(of: query, options: .caseInsensitive) != nil
        }
    }

    // MARK: - control_type <-> AXRole mapping

    private static func desiredRoles(for controlType: String?) -> Set<String>? {
        guard let ct = controlType?.lowercased(), !ct.isEmpty else { return nil }
        switch ct {
        case "edit": return ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
        case "button": return ["AXButton", "AXMenuButton"]
        case "text": return ["AXStaticText"]
        case "document": return ["AXWebArea", "AXTextArea"]
        case "window": return ["AXWindow"]
        case "pane", "group": return ["AXGroup", "AXScrollArea", "AXSplitGroup"]
        case "list": return ["AXList", "AXTable", "AXOutline"]
        case "listitem": return ["AXRow", "AXCell"]
        case "checkbox": return ["AXCheckBox"]
        case "radiobutton": return ["AXRadioButton"]
        case "combobox": return ["AXComboBox", "AXPopUpButton"]
        case "menuitem": return ["AXMenuItem", "AXMenuBarItem"]
        case "hyperlink", "link": return ["AXLink"]
        case "image": return ["AXImage"]
        case "tabitem", "tab": return ["AXRadioButton", "AXTab"]
        default:
            // Fall back to "AX" + the given type so unusual control types still
            // resolve (e.g. controlType "Slider" -> "AXSlider").
            return ["AX" + (controlType ?? "")]
        }
    }

    private static func controlType(for role: String) -> String {
        switch role {
        case "AXButton", "AXMenuButton": return "Button"
        case "AXTextField", "AXSearchField": return "Edit"
        case "AXTextArea": return "Document"
        case "AXStaticText": return "Text"
        case "AXWebArea": return "Document"
        case "AXWindow": return "Window"
        case "AXGroup", "AXScrollArea", "AXSplitGroup": return "Pane"
        case "AXList", "AXTable", "AXOutline": return "List"
        case "AXRow", "AXCell": return "ListItem"
        case "AXCheckBox": return "CheckBox"
        case "AXRadioButton": return "RadioButton"
        case "AXComboBox", "AXPopUpButton": return "ComboBox"
        case "AXMenuItem", "AXMenuBarItem": return "MenuItem"
        case "AXLink": return "Hyperlink"
        case "AXImage": return "Image"
        default:
            return role.hasPrefix("AX") ? String(role.dropFirst(2)) : role
        }
    }
}
