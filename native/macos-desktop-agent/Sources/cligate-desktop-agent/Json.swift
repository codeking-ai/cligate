import Foundation

// Small typed accessors over the loosely-typed [String: Any] payloads we get
// from JSONSerialization, so the route handlers read cleanly.

typealias Payload = [String: Any]

func parsePayload(_ data: Data) -> Payload {
    guard !data.isEmpty,
          let obj = try? JSONSerialization.jsonObject(with: data, options: []),
          let dict = obj as? Payload else {
        return [:]
    }
    return dict
}

extension Dictionary where Key == String, Value == Any {
    func str(_ key: String, _ fallback: String = "") -> String {
        if let v = self[key] as? String { return v }
        if let v = self[key] { return String(describing: v) }
        return fallback
    }

    func optStr(_ key: String) -> String? {
        if let v = self[key] as? String, !v.isEmpty { return v }
        return nil
    }

    func int(_ key: String, _ fallback: Int = 0) -> Int {
        if let v = self[key] as? Int { return v }
        if let v = self[key] as? Double { return Int(v) }
        if let v = self[key] as? String, let n = Int(v) { return n }
        return fallback
    }

    func optInt(_ key: String) -> Int? {
        if let v = self[key] as? Int { return v }
        if let v = self[key] as? Double { return Int(v) }
        if let v = self[key] as? String, let n = Int(v) { return n }
        return nil
    }

    func double(_ key: String, _ fallback: Double = 0) -> Double {
        if let v = self[key] as? Double { return v }
        if let v = self[key] as? Int { return Double(v) }
        if let v = self[key] as? String, let n = Double(v) { return n }
        return fallback
    }

    func bool(_ key: String, _ fallback: Bool = false) -> Bool {
        if let v = self[key] as? Bool { return v }
        return fallback
    }

    func stringArray(_ key: String) -> [String] {
        if let v = self[key] as? [String] { return v }
        if let v = self[key] as? [Any] { return v.map { String(describing: $0) } }
        if let v = self[key] as? String {
            return v.split(whereSeparator: { $0 == "," || $0 == "+" || $0 == " " }).map(String.init)
        }
        return []
    }

    // region: accepts [x,y,w,h] or {x,y,w,h}. Returns nil unless w,h > 0.
    func region(_ key: String = "region") -> CGRect? {
        if let arr = self[key] as? [Any], arr.count == 4 {
            let nums = arr.map { ($0 as? Double) ?? Double(($0 as? Int) ?? 0) }
            if nums[2] > 0 && nums[3] > 0 {
                return CGRect(x: nums[0], y: nums[1], width: nums[2], height: nums[3])
            }
        }
        if let obj = self[key] as? Payload {
            let x = obj.double("x"), y = obj.double("y")
            let w = obj.double("w", obj.double("width")), h = obj.double("h", obj.double("height"))
            if w > 0 && h > 0 { return CGRect(x: x, y: y, width: w, height: h) }
        }
        return nil
    }
}

// Structured agent error → the {ok:false,error,type,code} contract used by the
// Python agent (handlers/desktop.js branches on `code`/`type`).
struct AgentError: Error {
    let code: String
    let message: String
    let status: Int
    init(_ code: String, _ message: String, status: Int = 500) {
        self.code = code
        self.message = message
        self.status = status
    }
}
