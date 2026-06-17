import Foundation
import CoreGraphics
import AppKit

// Screen capture. Writes a PNG to the shared desktop-control dir (so the Node
// side registers it as an artifact, exactly like the Windows path) and can also
// return an inline base64 preview for the model to see.
//
// Uses CGWindowListCreateImage / CGDisplayCreateImage. These are deprecated in
// favour of ScreenCaptureKit on macOS 14+; migrating to SCK (for crisper window
// capture and to satisfy the newer Screen Recording model) is a follow-up.
enum CaptureService {
    static func screenshotsDir() -> URL {
        let base: URL
        if let override = ProcessInfo.processInfo.environment["DESKTOP_CONTROL_DIR"], !override.isEmpty {
            base = URL(fileURLWithPath: override)
        } else {
            base = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".cligate")
                .appendingPathComponent("desktop-control")
        }
        let dir = base.appendingPathComponent("screenshots")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func captureCGImage(region: CGRect?) -> CGImage? {
        if let r = region {
            return CGWindowListCreateImage(r, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution])
        }
        return CGDisplayCreateImage(CGMainDisplayID())
    }

    static func pngData(_ cg: CGImage) -> Data? {
        let rep = NSBitmapImageRep(cgImage: cg)
        return rep.representation(using: .png, properties: [:])
    }

    static func scaled(_ cg: CGImage, toWidth targetWidth: Int) -> CGImage? {
        guard targetWidth > 0, cg.width > targetWidth else { return cg }
        let scale = Double(targetWidth) / Double(cg.width)
        let w = targetWidth
        let h = Int(Double(cg.height) * scale)
        guard let ctx = CGContext(
            data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return cg }
        ctx.interpolationQuality = .medium
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage()
    }

    static func screenshot(_ p: Payload) throws -> [String: Any] {
        if !Permissions.screenRecordingGranted() {
            throw AgentError("SCREEN_RECORDING_DENIED",
                             "Screen Recording permission not granted — enable it in System Settings › Privacy & Security › Screen Recording.",
                             status: 500)
        }
        let region = p.region()
        guard let cg = captureCGImage(region: region) else {
            throw AgentError("CAPTURE_FAILED", "screen capture returned no image", status: 500)
        }

        // Persist the full-resolution PNG to disk for artifact registration.
        var result: [String: Any] = [
            "ok": true,
            "action": "screenshot",
            "width": cg.width,
            "height": cg.height,
            "active_window": WindowsService.activeWindowInfo() as Any
        ]
        if let png = pngData(cg) {
            let url = screenshotsDir().appendingPathComponent("screen-\(Int(Date().timeIntervalSince1970 * 1000)).png")
            try? png.write(to: url)
            result["path"] = url.path
        }
        if let r = region {
            result["window_region"] = [Int(r.origin.x), Int(r.origin.y), Int(r.size.width), Int(r.size.height)]
        }

        // Inline preview for the model (default: downscaled "preview").
        let inline = p.bool("inline", true)
        if inline {
            let target = p.str("inline_target", "preview")
            let previewWidth = p.int("preview_width", 1280)
            let image = target == "preview" ? (scaled(cg, toWidth: previewWidth) ?? cg) : cg
            if let png = pngData(image) {
                result["inline_b64"] = png.base64EncodedString()
                result["preview_width"] = image.width
                result["preview_height"] = image.height
            }
        }
        return result
    }

    // Basic pixel-change detector. Samples the region (or full screen) into a
    // small signature and polls until it differs beyond `threshold` or the
    // timeout elapses. Good enough to confirm "did the click do something";
    // refine the signature on-device if false positives show up.
    static func waitChange(_ p: Payload) throws -> [String: Any] {
        let region = p.region()
        let timeoutMs = p.int("timeout_ms", 1500)
        let pollMs = max(50, p.int("poll_ms", 150))
        let threshold = p.double("threshold", 0.02)

        guard let baseline = signature(region: region) else {
            return ["ok": true, "action": "wait_change", "changed": false, "reason": "no_baseline"]
        }
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
        while Date() < deadline {
            Thread.sleep(forTimeInterval: Double(pollMs) / 1000.0)
            guard let current = signature(region: region) else { continue }
            let diff = difference(baseline, current)
            if diff >= threshold {
                return ["ok": true, "action": "wait_change", "changed": true, "diff": diff]
            }
        }
        return ["ok": true, "action": "wait_change", "changed": false]
    }

    // 32x32 grayscale signature.
    private static func signature(region: CGRect?) -> [UInt8]? {
        guard let cg = captureCGImage(region: region) else { return nil }
        let side = 32
        guard let ctx = CGContext(
            data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return nil }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: side, height: side))
        guard let data = ctx.data else { return nil }
        let buf = data.bindMemory(to: UInt8.self, capacity: side * side)
        return Array(UnsafeBufferPointer(start: buf, count: side * side))
    }

    private static func difference(_ a: [UInt8], _ b: [UInt8]) -> Double {
        guard a.count == b.count, !a.isEmpty else { return 0 }
        var changed = 0
        for i in 0..<a.count where abs(Int(a[i]) - Int(b[i])) > 12 { changed += 1 }
        return Double(changed) / Double(a.count)
    }
}
