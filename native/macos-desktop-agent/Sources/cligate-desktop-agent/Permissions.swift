import Foundation
import ApplicationServices
import CoreGraphics

// macOS TCC permission gates. Unlike Windows there is no UAC/elevation here; the
// only thing standing between the agent and the desktop is the user's
// Accessibility + Screen Recording grants. These are surfaced in /health so
// CliGate's onboarding panel can deep-link the user to System Settings.
enum Permissions {
    static func accessibilityTrusted() -> Bool {
        AXIsProcessTrusted()
    }

    static func screenRecordingGranted() -> Bool {
        if #available(macOS 10.15, *) {
            return CGPreflightScreenCaptureAccess()
        }
        return true
    }

    // Triggers the system "allow Accessibility" prompt (idempotent; safe to call
    // when already trusted).
    static func promptAccessibility() {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    }

    static func promptScreenRecording() {
        if #available(macOS 10.15, *) {
            _ = CGRequestScreenCaptureAccess()
        }
    }
}
