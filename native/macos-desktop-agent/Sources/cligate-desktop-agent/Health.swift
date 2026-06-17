import Foundation
import AppKit
import CoreGraphics

// /health payload. Field names mirror the Windows agent so service.js /
// handlers/desktop.js need no platform branching; macOS-specific gates
// (accessibility / screen_recording) are added on top.
enum Health {
    static func payload(activeLeaseId: String) -> [String: Any] {
        let screen = NSScreen.main?.frame ?? .zero
        let height = screen.height
        // NSEvent.mouseLocation is bottom-left origin; convert to the top-left
        // origin the rest of the contract uses.
        let mouse = NSEvent.mouseLocation
        let cursorX = Int(mouse.x)
        let cursorY = Int(height - mouse.y)

        return [
            "ok": true,
            "screen_width": Int(screen.width),
            "screen_height": Int(height),
            "cursor_x": cursorX,
            "cursor_y": cursorY,
            "active_window": WindowsService.activeWindowInfo() as Any,
            "version": "0.1-macos",
            "active_lease_id": activeLeaseId,
            "platform": "darwin",
            // macOS analogues of the Windows diagnostic fields. There is no
            // elevation / RDP / secure-desktop concept here, so these are static;
            // they keep the /health shape stable for the existing LLM prompts.
            "elevated": false,
            "integrity_level": "n/a",
            "remote_session": false,
            "interactive": true,
            "session_locked": false,
            // The macOS-specific signal: TCC permission state. When either is
            // false, input/capture will silently fail until the user grants it.
            "accessibility": Permissions.accessibilityTrusted(),
            "screen_recording": Permissions.screenRecordingGranted()
        ]
    }
}
