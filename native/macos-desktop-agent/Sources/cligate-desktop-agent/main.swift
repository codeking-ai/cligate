import Foundation

// Entry point for the macOS desktop-agent helper.
//
// Mirrors the Windows Python agent: parse --port/--token, bind a localhost HTTP
// server, and serve the same endpoint contract. The process is meant to be
// spawned as a child of CliGate (see src/desktop-agent/backends/macos-native.js)
// and to die with it — there is no daemonisation here on purpose.

func parseArgs(_ argv: [String]) -> (port: UInt16, token: String) {
    var port: UInt16 = 8765
    var token = ""
    var i = 0
    while i < argv.count {
        let arg = argv[i]
        switch arg {
        case "--port":
            if i + 1 < argv.count, let p = UInt16(argv[i + 1]) { port = p; i += 1 }
        case "--token":
            if i + 1 < argv.count { token = argv[i + 1]; i += 1 }
        default:
            break
        }
        i += 1
    }
    // Env fallbacks so the helper is also runnable standalone for debugging.
    if token.isEmpty, let envToken = ProcessInfo.processInfo.environment["DESKTOP_AGENT_TOKEN"] {
        token = envToken
    }
    return (port, token)
}

let args = parseArgs(Array(CommandLine.arguments.dropFirst()))
let server = AgentServer(token: args.token)

let http = HTTPServer(host: "127.0.0.1", port: args.port) { request in
    server.handle(request)
}

do {
    try http.start()
    FileHandle.standardError.write(
        "cligate-desktop-agent listening on 127.0.0.1:\(args.port)\n".data(using: .utf8)!
    )
} catch {
    FileHandle.standardError.write("failed to start: \(error)\n".data(using: .utf8)!)
    exit(1)
}

// Terminate cleanly on SIGTERM/SIGINT (CliGate's manager.kill()).
signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }

// The accept loop runs on its own background thread inside HTTPServer.start();
// keep the process (and the main run loop, which some AppKit/AX paths rely on)
// alive here.
dispatchMain()
