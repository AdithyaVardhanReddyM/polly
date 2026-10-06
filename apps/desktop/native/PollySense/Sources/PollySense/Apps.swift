import AppKit
import ApplicationServices

enum Apps {
    private static let iconLock = NSLock()
    nonisolated(unsafe) private static var iconCache: [String: String] = [:]

    /// Apps with a Dock presence, by name.
    static func running() -> [RunningApp] {
        NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .map { app in
                let bundleId = app.bundleIdentifier ?? ""
                return RunningApp(name: app.localizedName ?? bundleId, bundleId: bundleId, pid: app.processIdentifier,
                                  icon: icon(cacheKey: bundleId.isEmpty ? nil : "\(bundleId)@64", size: 64) { app.icon })
            }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    static func iconPNG(bundleId: String, size: Int) -> String? {
        let size = min(max(size, 16), 1024)
        return icon(cacheKey: "\(bundleId)@\(size)", size: size) {
            NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId).map { NSWorkspace.shared.icon(forFile: $0.path) }
        }
    }

    private static func icon(cacheKey: String?, size: Int, image: () -> NSImage?) -> String? {
        if let cacheKey {
            iconLock.lock()
            let cached = iconCache[cacheKey]
            iconLock.unlock()
            if let cached { return cached }
        }
        guard let png = image().flatMap({ Images.iconPNG($0, size: size) }) else { return nil }
        if let cacheKey {
            iconLock.lock()
            iconCache[cacheKey] = png
            iconLock.unlock()
        }
        return png
    }

    /// A running app by pid or bundle id, else launches it by bundle id.
    static func activate(pid: pid_t?, bundleId: String?) async -> Bool {
        if let pid { return await bringForward(pid) }
        guard let bundleId, !bundleId.isEmpty else { return false }
        if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first {
            return await bringForward(app.processIdentifier)
        }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else { return false }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        return (try? await NSWorkspace.shared.openApplication(at: url, configuration: configuration)) != nil
    }

    /// Brings an app to the front and waits (up to 0.5 s) until it is.
    @discardableResult
    static func bringForward(_ pid: pid_t) async -> Bool {
        guard let app = NSRunningApplication(processIdentifier: pid) else { return false }
        if isFront(pid) { return true }
        app.activate(options: [])
        // Since macOS 14 a background app's activation request can be declined; raising
        // through Accessibility is what assistive apps use instead.
        if AXIsProcessTrusted() { AX.application(pid).set(kAXFrontmostAttribute, kCFBooleanTrue) }
        for _ in 0..<25 {
            if isFront(pid) { return true }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return isFront(pid)
    }

    static func isFront(_ pid: pid_t) -> Bool {
        NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
    }
}
