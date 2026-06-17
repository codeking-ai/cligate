// swift-tools-version:5.7
import PackageDescription

// Native macOS desktop-control helper for CliGate. Single self-contained
// executable; no external package dependencies (only system frameworks:
// Foundation, AppKit, ApplicationServices (AX), CoreGraphics, Vision,
// ScreenCaptureKit). See README.md.
let package = Package(
    name: "cligate-desktop-agent",
    platforms: [
        .macOS(.v12)
    ],
    targets: [
        .executableTarget(
            name: "cligate-desktop-agent",
            path: "Sources/cligate-desktop-agent"
        )
    ]
)
