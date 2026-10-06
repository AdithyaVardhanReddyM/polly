import AppKit

/// Routes requests from Electron to handlers and writes responses and events back.
/// Each request runs in its own task, so a slow snapshot never holds up the rest;
/// responses can arrive out of order and are matched by id.
final class Server: EventSink, @unchecked Sendable {
    static var version: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0"
    }

    private let socket: SenseSocket
    private var watcher: Watcher!
    private var permissionMonitor: PermissionMonitor!

    init(socket: SenseSocket) { self.socket = socket }

    @MainActor
    func start() {
        watcher = Watcher(sink: self)
        permissionMonitor = PermissionMonitor()
        permissionMonitor.start { [weak self] permissions in
            guard let self else { return }
            self.emit(.permissions, permissions)
            self.watcher.refresh()
        }
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.emit(.geometry, Geometry.current()) }
        }
        socket.startReading(onLine: { [weak self] line in self?.receive(line) }, onClose: {
            Log.info("socket closed, exiting")
            exit(0)
        })
    }

    func emit<Payload: Encodable>(_ event: EventName, _ data: Payload) {
        do {
            socket.send(try encode(EventMessage(event: event, data: data)))
        } catch {
            Log.error("could not encode \(event.rawValue) event: \(error)")
        }
    }

    // MARK: Requests

    private func receive(_ line: Data) {
        guard let head = try? JSONDecoder().decode(RequestHead.self, from: line), let id = head.id else {
            Log.error("ignoring a line that is not a request")
            return
        }
        Task.detached { [self] in
            do {
                guard let method = head.method else { throw SenseError("Missing method") }
                try await handle(method, id: id, line: line)
            } catch {
                let message = (error as? SenseError)?.description ?? error.localizedDescription
                if let data = try? encode(ErrorResponse(id: id, error: .init(message: message))) { socket.send(data) }
            }
        }
    }

    private func handle(_ method: String, id: RequestID, line: Data) async throws {
        switch method {
        case "hello":
            try reply(id, HelloResult(version: Self.version, pid: getpid()))
        case "permissions":
            try reply(id, PermissionState.current())
        case "requestPermission":
            let params: RequestPermissionParams = try decodeParams(line)
            let opened = await MainActor.run { PermissionState.request(params.kind) }
            try reply(id, OpenedResult(opened: opened))
        case "geometry":
            try reply(id, await MainActor.run { Geometry.current() })
        case "setPrivacy":
            Privacy.shared.update(try decodeParams(line) as PrivacyRules)
            await MainActor.run { watcher.refresh() }
            try reply(id, OkResult(ok: true))
        case "watch":
            let params: WatchParams = try decodeParams(line)
            await MainActor.run { watcher.configure(enabled: params.enabled, visualIntervalMs: params.visualIntervalMs ?? 0) }
            try reply(id, OkResult(ok: true))
        case "snapshot":
            try reply(id, try await Snapshots.take(try decodeParams(line)))
        case "write":
            try reply(id, try await Writer.write(try decodeParams(line)))
        case "script":
            try await ScriptRunner.run(try decodeParams(line))
            try reply(id, OkResult(ok: true))
        case "appIcon":
            let params: AppIconParams = try decodeParams(line)
            try reply(id, AppIconResult(png: Apps.iconPNG(bundleId: params.bundleId, size: params.size ?? 64)))
        case "runningApps":
            try reply(id, Apps.running())
        case "activate":
            let params: ActivateParams = try decodeParams(line)
            try reply(id, OkResult(ok: await Apps.activate(pid: params.pid, bundleId: params.bundleId)))
        case "quit":
            try reply(id, OkResult(ok: true))
            exit(0)
        default:
            throw SenseError("Unknown method: \(method)")
        }
    }

    private func reply<Result: Encodable>(_ id: RequestID, _ result: Result) throws {
        socket.send(try encode(Response(id: id, result: result)))
    }

    /// The request's params; a missing `params` reads as `{}`.
    private func decodeParams<Params: Decodable>(_ line: Data) throws -> Params {
        do {
            if let params = try JSONDecoder().decode(RequestParams<Params>.self, from: line).params { return params }
            return try JSONDecoder().decode(Params.self, from: Data("{}".utf8))
        } catch let error as DecodingError {
            throw SenseError("Bad params: \(Self.describe(error))")
        }
    }

    private static func describe(_ error: DecodingError) -> String {
        switch error {
        case .keyNotFound(let key, _): return "missing \(key.stringValue)"
        case .typeMismatch(_, let context), .valueNotFound(_, let context), .dataCorrupted(let context):
            let path = context.codingPath.map(\.stringValue).filter { $0 != "params" }.joined(separator: ".")
            return path.isEmpty ? context.debugDescription : "\(path): \(context.debugDescription)"
        @unknown default: return "\(error)"
        }
    }

    private func encode<Value: Encodable>(_ value: Value) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return try encoder.encode(value)
    }
}
