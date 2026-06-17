import Foundation
import CoreGraphics
import Vision

// OCR via the system Vision framework (no model download, unlike the Windows
// agent's RapidOCR). Returns matches in the same shape the Node service expects:
// { text, bbox:[x,y,w,h], center:[x,y], confidence }, in SCREEN coordinates so
// desktop_click_text can click the returned center directly.
enum OCRService {
    static func findText(_ p: Payload) throws -> [String: Any] {
        if !Permissions.screenRecordingGranted() {
            throw AgentError("SCREEN_RECORDING_DENIED",
                             "Screen Recording permission not granted — required to OCR the screen.",
                             status: 500)
        }
        let region = p.region()
        guard let cg = CaptureService.captureCGImage(region: region) else {
            throw AgentError("CAPTURE_FAILED", "could not capture screen for OCR", status: 500)
        }

        let query = p.str("query")
        let matchMode = p.str("match", "contains")
        let minConfidence = p.double("min_confidence", 0.0)
        let maxResults = p.int("max_results", 50)

        // Origin of the captured image in screen space, so normalized Vision
        // boxes can be mapped back to absolute screen coordinates.
        let originX = region?.origin.x ?? 0
        let originY = region?.origin.y ?? 0
        let imgW = Double(cg.width)
        let imgH = Double(cg.height)

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        // Broad language coverage; tune on-device (e.g. add zh-Hans) as needed.
        request.recognitionLanguages = ["en-US", "zh-Hans"]

        let handler = VNImageRequestHandler(cgImage: cg, options: [:])
        do {
            try handler.perform([request])
        } catch {
            throw AgentError("OCR_FAILED", "Vision OCR failed: \(error)", status: 500)
        }

        var matches: [[String: Any]] = []
        for obs in (request.results ?? []) {
            guard let candidate = obs.topCandidates(1).first else { continue }
            let text = candidate.string
            let confidence = Double(candidate.confidence)
            if confidence < minConfidence { continue }
            if !query.isEmpty && !textMatches(text, query: query, mode: matchMode) { continue }

            // Vision boundingBox is normalized, bottom-left origin. Convert to a
            // top-left-origin screen rect.
            let bb = obs.boundingBox
            let x = originX + bb.origin.x * imgW
            let wpx = bb.size.width * imgW
            let hpx = bb.size.height * imgH
            let yTopInImage = (1.0 - bb.origin.y - bb.size.height) * imgH
            let y = originY + yTopInImage
            let center = [Int(x + wpx / 2), Int(y + hpx / 2)]
            matches.append([
                "text": text,
                "confidence": confidence,
                "bbox": [Int(x), Int(y), Int(wpx), Int(hpx)],
                "center": center
            ])
            if matches.count >= maxResults { break }
        }

        return ["ok": true, "action": "find_text", "query": query, "matches": matches]
    }

    private static func textMatches(_ text: String, query: String, mode: String) -> Bool {
        switch mode {
        case "exact":
            return text.caseInsensitiveCompare(query) == .orderedSame
        case "regex":
            guard let re = try? NSRegularExpression(pattern: query, options: [.caseInsensitive]) else { return false }
            let range = NSRange(text.startIndex..., in: text)
            return re.firstMatch(in: text, options: [], range: range) != nil
        default:
            return text.range(of: query, options: .caseInsensitive) != nil
        }
    }
}
