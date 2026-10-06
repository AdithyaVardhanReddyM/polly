import AppKit

/// `--selftest`: one pass over the read-only methods, printed as JSON, without a socket.
enum SelfTest {
    private struct Report: Encodable {
        var hello: HelloResult
        var permissions: Permissions
        var geometry: NotchGeometry
        var runningApps: Int
        @Nullable var snapshot: Snapshot?
        var snapshotError: String?
    }

    @MainActor
    static func start() {
        Task { @MainActor in
            var report = Report(hello: HelloResult(version: Server.version, pid: getpid()), permissions: PermissionState.current(),
                                geometry: Geometry.current(), runningApps: 0, snapshot: nil)
            report.runningApps = await Task.detached { Apps.running().count }.value
            do {
                report.snapshot = try await Task.detached { try await Snapshots.take(SnapshotParams(ocr: .auto, screenshot: false)) }.value
            } catch {
                report.snapshotError = (error as? SenseError)?.description ?? error.localizedDescription
            }
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
            do {
                FileHandle.standardOutput.write(try encoder.encode(report) + Data("\n".utf8))
                exit(0)
            } catch {
                FileHandle.standardError.write(Data("selftest could not encode its report: \(error)\n".utf8))
                exit(1)
            }
        }
    }
}
