import Foundation
#if canImport(Darwin)
import Darwin
#endif

// A deliberately small, dependency-free blocking HTTP/1.1 server over a POSIX
// socket bound to localhost. One thread per connection; connections are
// `Connection: close`. This matches the Python agent's http.server model and is
// more than enough for a single local client (CliGate's http-client.js).

struct HTTPRequest {
    let method: String
    let path: String
    let headers: [String: String]
    let body: Data
}

final class HTTPServer {
    private let host: String
    private let port: UInt16
    private let handler: (HTTPRequest) -> (status: Int, json: [String: Any])
    private var listenFD: Int32 = -1

    init(host: String, port: UInt16, handler: @escaping (HTTPRequest) -> (status: Int, json: [String: Any])) {
        self.host = host
        self.port = port
        self.handler = handler
    }

    func start() throws {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw POSIXError(.EADDRNOTAVAIL) }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = inet_addr(host)

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.bind(fd, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else {
            close(fd)
            throw POSIXError(.EADDRINUSE)
        }
        guard listen(fd, 16) == 0 else {
            close(fd)
            throw POSIXError(.EADDRINUSE)
        }
        listenFD = fd

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.acceptLoop()
        }
    }

    private func acceptLoop() {
        while true {
            let clientFD = accept(listenFD, nil, nil)
            if clientFD < 0 { continue }
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.serve(clientFD)
            }
        }
    }

    private func serve(_ fd: Int32) {
        defer { close(fd) }
        guard let raw = readRequest(fd) else {
            writeResponse(fd, status: 400, json: ["ok": false, "error": "bad request"])
            return
        }
        let (status, json) = handler(raw)
        writeResponse(fd, status: status, json: json)
    }

    // Read headers up to \r\n\r\n, then Content-Length bytes of body.
    private func readRequest(_ fd: Int32) -> HTTPRequest? {
        var buffer = Data()
        let chunkSize = 4096
        var headerEnd: Range<Data.Index>? = nil
        let terminator = Data("\r\n\r\n".utf8)

        while headerEnd == nil {
            guard let chunk = readChunk(fd, max: chunkSize), !chunk.isEmpty else { break }
            buffer.append(chunk)
            headerEnd = buffer.range(of: terminator)
            if buffer.count > 1_048_576 { return nil } // 1MB header guard
        }
        guard let hEnd = headerEnd else { return nil }

        let headerData = buffer.subdata(in: buffer.startIndex..<hEnd.lowerBound)
        guard let headerText = String(data: headerData, encoding: .utf8) else { return nil }
        let lines = headerText.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return nil }
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else { return nil }
        let method = String(parts[0])
        let path = String(parts[1])

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let idx = line.firstIndex(of: ":") else { continue }
            let key = line[line.startIndex..<idx].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: idx)...].trimmingCharacters(in: .whitespaces)
            headers[key] = value
        }

        var body = buffer.subdata(in: hEnd.upperBound..<buffer.endIndex)
        let contentLength = Int(headers["content-length"] ?? "0") ?? 0
        while body.count < contentLength {
            guard let chunk = readChunk(fd, max: min(chunkSize, contentLength - body.count)), !chunk.isEmpty else { break }
            body.append(chunk)
        }

        return HTTPRequest(method: method, path: path, headers: headers, body: body)
    }

    private func readChunk(_ fd: Int32, max: Int) -> Data? {
        var tmp = [UInt8](repeating: 0, count: max)
        let n = read(fd, &tmp, max)
        if n <= 0 { return nil }
        return Data(tmp[0..<n])
    }

    private func writeResponse(_ fd: Int32, status: Int, json: [String: Any]) {
        let bodyData = (try? JSONSerialization.data(withJSONObject: json, options: [])) ?? Data("{}".utf8)
        var head = "HTTP/1.1 \(status) \(statusText(status))\r\n"
        head += "Content-Type: application/json\r\n"
        head += "Content-Length: \(bodyData.count)\r\n"
        head += "Connection: close\r\n\r\n"
        var out = Data(head.utf8)
        out.append(bodyData)
        out.withUnsafeBytes { ptr in
            _ = write(fd, ptr.baseAddress, out.count)
        }
    }

    private func statusText(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 400: return "Bad Request"
        case 401: return "Unauthorized"
        case 404: return "Not Found"
        case 409: return "Conflict"
        case 500: return "Internal Server Error"
        default: return "Status"
        }
    }
}
