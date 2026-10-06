import AppKit
import ApplicationServices

/// The front app, its focused window and page, and whether privacy rules hide them.
struct FrontContext {
    var app: SenseApp
    var window: SenseWindow
    var url: String?
    var exclusion: ExclusionReason?
    var appElement: AXUIElement?
    var windowElement: AXUIElement?

    var base: EventBase { EventBase(app: app, window: window, excluded: exclusion != nil) }
}

enum ContextReader {
    static func read(_ running: NSRunningApplication) -> FrontContext {
        let pid = running.processIdentifier
        let app = SenseApp(name: running.localizedName ?? "", bundleId: running.bundleIdentifier ?? "", pid: pid)
        let privacy = Privacy.shared

        // Hidden apps are not touched through Accessibility at all; the window server gives id and frame.
        if let reason = privacy.processExclusion(pid: pid, bundleId: app.bundleId) {
            let front = WindowList.windows(of: pid).first
            let window = SenseWindow(id: front?.id, title: "", frame: front.map { Rect($0.frame) })
            return FrontContext(app: app, window: window, url: nil, exclusion: reason)
        }

        let isBrowser = Browsers.contains(running)
        guard AXIsProcessTrusted() else {
            let front = WindowList.windows(of: pid).first
            let window = SenseWindow(id: front?.id, title: front?.title ?? "", frame: front.map { Rect($0.frame) })
            // Without Accessibility the page URL is unknowable, so a browser could be showing a hidden site.
            let reason: ExclusionReason? = isBrowser && privacy.hasDomainRules
                ? .domain
                : privacy.contentExclusion(bundleId: app.bundleId, title: window.title, url: nil)
            return FrontContext(app: app, window: window, url: nil, exclusion: reason)
        }

        let appElement = AX.application(pid)
        AX.enableWebAccessibility(appElement, pid: pid)
        let windowElement = appElement.element(kAXFocusedWindowAttribute) ?? appElement.element(kAXMainWindowAttribute)
        var title = ""
        var frame: CGRect?
        if let windowElement {
            let v = windowElement.values([kAXTitleAttribute, kAXPositionAttribute, kAXSizeAttribute])
            title = v[0] as? String ?? ""
            frame = AXConvert.frame(position: v[1], size: v[2])
        }
        let id = frame.flatMap { WindowList.match(pid: pid, frame: $0, title: title)?.id }
        let window = SenseWindow(id: id, title: title, frame: frame.map(Rect.init))
        let url = isBrowser ? windowElement.flatMap(AXReader.pageURL(in:)) : nil
        return FrontContext(app: app, window: window, url: url,
                            exclusion: privacy.contentExclusion(bundleId: app.bundleId, title: title, url: url),
                            appElement: appElement, windowElement: windowElement)
    }
}

/// Apps that open web links, plus well-known browsers in case Launch Services misses one.
enum Browsers {
    private static let known: Set<String> = [
        "com.apple.Safari", "com.apple.SafariTechnologyPreview", "com.google.Chrome", "com.google.Chrome.canary",
        "com.microsoft.edgemac", "com.brave.Browser", "company.thebrowser.Browser", "org.mozilla.firefox",
        "com.operasoftware.Opera", "com.vivaldi.Vivaldi", "org.chromium.Chromium", "com.kagi.kagimacOS",
        "app.zen-browser.zen", "com.duckduckgo.macos.browser",
    ]
    private static let lock = NSLock()
    nonisolated(unsafe) private static var handlers = Set<String>()
    nonisolated(unsafe) private static var checkedAt = Date.distantPast

    static func contains(_ app: NSRunningApplication) -> Bool {
        guard let id = app.bundleIdentifier else { return false }
        if known.contains(id) { return true }
        lock.lock()
        defer { lock.unlock() }
        if !handlers.contains(id), Date().timeIntervalSince(checkedAt) > 60, let probe = URL(string: "https://example.com") {
            handlers = Set(NSWorkspace.shared.urlsForApplications(toOpen: probe).compactMap { Bundle(url: $0)?.bundleIdentifier })
            checkedAt = Date()
        }
        return handlers.contains(id)
    }
}
