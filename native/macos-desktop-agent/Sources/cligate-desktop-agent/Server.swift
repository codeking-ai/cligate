import Foundation
import CoreGraphics

// Request router + cross-cutting concerns (auth, single-action lock, lease echo),
// mirroring the Windows agent's do_GET/do_POST dispatch and error envelope.

// Serializes mutating actions; returns AGENT_BUSY (409) if an action is wedged,
// matching the Python _TimedActionLock semantics.
final class ActionLock {
    private let cond = NSCondition()
    private var held = false
    private(set) var holderPath = ""
    private(set) var heldSince = Date()

    func acquire(_ path: String, timeout: TimeInterval) -> Bool {
        cond.lock(); defer { cond.unlock() }
        let deadline = Date().addingTimeInterval(timeout)
        while held {
            if !cond.wait(until: deadline) { return false }
        }
        held = true; holderPath = path; heldSince = Date()
        return true
    }

    func release() {
        cond.lock(); held = false; holderPath = ""; cond.signal(); cond.unlock()
    }

    var heldSeconds: Double { Date().timeIntervalSince(heldSince) }
}

final class AgentServer {
    private let token: String
    private let lock = ActionLock()
    private let leaseQueue = DispatchQueue(label: "cligate.lease")
    private var activeLeaseId = ""

    init(token: String) {
        self.token = token
    }

    func handle(_ request: HTTPRequest) -> (status: Int, json: [String: Any]) {
        if !authorized(request) {
            return (401, ["ok": false, "error": "authentication required", "code": "AUTH_REQUIRED", "type": "AuthError"])
        }
        let path = String(request.path.split(separator: "?").first ?? "")
        do {
            if request.method == "GET" {
                return (200, try handleGet(path))
            }
            if request.method == "POST" {
                let payload = parsePayload(request.body)
                return try handlePost(path, payload)
            }
            return (404, ["ok": false, "error": "not found"])
        } catch let err as AgentError {
            return (err.status, ["ok": false, "error": err.message, "type": "AgentError", "code": err.code])
        } catch {
            return (500, ["ok": false, "error": "\(error)", "type": "RuntimeError", "code": "RUNTIME_ERROR"])
        }
    }

    private func authorized(_ request: HTTPRequest) -> Bool {
        if token.isEmpty { return true }
        guard let header = request.headers["authorization"] else { return false }
        return header == "Bearer \(token)"
    }

    // MARK: - GET

    private func handleGet(_ path: String) throws -> [String: Any] {
        switch path {
        case "/health":
            return Health.payload(activeLeaseId: activeLeaseId)
        case "/active":
            return ["ok": true, "active_window": WindowsService.activeWindowInfo() as Any]
        case "/windows":
            return ["ok": true, "windows": WindowsService.enumWindows()]
        case "/cursor_info":
            var out: [String: Any] = ["ok": true]
            InputService.cursorInfo().forEach { out[$0.key] = $0.value }
            return out
        default:
            throw AgentError("NOT_FOUND", "not found", status: 404)
        }
    }

    // MARK: - POST

    private func handlePost(_ path: String, _ payload: Payload) throws -> (status: Int, json: [String: Any]) {
        guard lock.acquire(path, timeout: 5.0) else {
            return (409, [
                "ok": false,
                "error": "desktop agent busy: \(lock.holderPath) has held the action lock",
                "code": "AGENT_BUSY",
                "type": "AgentBusy",
                "held_seconds": lock.heldSeconds,
                "busy_path": lock.holderPath
            ])
        }
        defer { lock.release() }
        try requireLease(payload)
        defer { releaseLease(payload) }

        let result = try route(path, payload)
        return (200, withMeta(result, payload))
    }

    private func route(_ path: String, _ p: Payload) throws -> [String: Any] {
        switch path {
        case "/screenshot":  return try CaptureService.screenshot(p)
        case "/move":        return try InputService.move(p)
        case "/click":       return try InputService.click(p)
        case "/type":        return try InputService.typeText(p)
        case "/press":       return try InputService.press(p)
        case "/hotkey":      return try InputService.hotkey(p)
        case "/scroll":      return try InputService.scroll(p)
        case "/wait":
            let ms = max(0, p.int("ms"))
            Thread.sleep(forTimeInterval: Double(ms) / 1000.0)
            return ["ok": true, "action": "wait", "ms": ms]
        case "/wait_change": return try CaptureService.waitChange(p)
        case "/find_text":   return try OCRService.findText(p)
        case "/launch":      return try WindowsService.launch(p)
        case "/focus":       return try WindowsService.focus(p)
        case "/windows":
            if let title = p.optStr("title") {
                return ["ok": true, "windows": WindowsService.findWindows(title: title, match: p.str("match", "contains"))]
            }
            return ["ok": true, "windows": WindowsService.enumWindows()]
        case "/ui/find":     return try Accessibility.find(p)
        case "/ui/find_all": return try Accessibility.findAll(p)
        case "/ui/act":      return try Accessibility.act(p)
        case "/ui/tree":     return try Accessibility.tree(p)
        case "/ui/wait":     return try Accessibility.wait(p)
        default:
            throw AgentError("NOT_FOUND", "not found", status: 404)
        }
    }

    // MARK: - lease + meta echo (parity with the Python agent)

    private func requireLease(_ p: Payload) throws {
        guard let lease = p.optStr("lease_id") else { return }
        try leaseQueue.sync {
            if !activeLeaseId.isEmpty && activeLeaseId != lease {
                throw AgentError("LEASE_CONFLICT", "desktop lease busy: \(activeLeaseId)", status: 409)
            }
            activeLeaseId = lease
        }
    }

    private func releaseLease(_ p: Payload) {
        guard let lease = p.optStr("lease_id") else { return }
        leaseQueue.sync {
            if activeLeaseId == lease { activeLeaseId = "" }
        }
    }

    private func withMeta(_ result: [String: Any], _ p: Payload) -> [String: Any] {
        var out = result
        for key in ["lease_id", "session_id", "action_id"] {
            if let v = p.optStr(key) { out[key] = v }
        }
        return out
    }
}
