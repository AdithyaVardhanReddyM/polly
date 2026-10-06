import Foundation

/// The newline-delimited JSON connection to Electron. Electron listens; the helper connects.
final class SenseSocket: @unchecked Sendable {
    private let fd: Int32
    private let writeLock = NSLock()

    private init(fd: Int32) { self.fd = fd }

    /// Retries until `timeout`, since Electron may still be binding the socket.
    static func connect(path: String, timeout: TimeInterval) -> SenseSocket? {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if let fd = dial(path) { return SenseSocket(fd: fd) }
            usleep(100_000)
        } while Date() < deadline
        return nil
    }

    private static func dial(_ path: String) -> Int32? {
        var address = sockaddr_un()
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return nil }
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        // A closed peer must not kill the process with SIGPIPE; the reader notices EOF instead.
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else {
            close(fd)
            return nil
        }
        return fd
    }

    /// Reads on a background thread, handing over one line at a time; `onClose` runs at EOF.
    func startReading(onLine: @escaping (Data) -> Void, onClose: @escaping () -> Void) {
        let fd = self.fd
        let thread = Thread {
            var pending = Data()
            var buffer = [UInt8](repeating: 0, count: 65_536)
            while true {
                let count = read(fd, &buffer, buffer.count)
                if count < 0, errno == EINTR { continue }
                if count <= 0 { break }
                pending.append(buffer, count: count)
                while let newline = pending.firstIndex(of: 0x0A) {
                    var line = pending[pending.startIndex..<newline]
                    pending.removeSubrange(pending.startIndex...newline)
                    if line.last == 0x0D { line = line.dropLast() }
                    if !line.isEmpty { onLine(Data(line)) }
                }
            }
            onClose()
        }
        thread.name = "sense.socket"
        thread.start()
    }

    /// Writes one message and its newline; callers on any thread.
    func send(_ message: Data) {
        var data = message
        data.append(0x0A)
        writeLock.lock()
        defer { writeLock.unlock() }
        data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            var offset = 0
            while offset < raw.count {
                let written = write(fd, base + offset, raw.count - offset)
                if written < 0 {
                    if errno == EINTR { continue }
                    return
                }
                offset += written
            }
        }
    }
}
