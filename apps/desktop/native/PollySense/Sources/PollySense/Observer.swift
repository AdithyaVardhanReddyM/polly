import AppKit
import ApplicationServices

protocol EventSink: AnyObject {
    func emit<Payload: Encodable>(_ event: EventName, _ data: Payload)
}

private let observedNotifications = [
    kAXFocusedUIElementChangedNotification, kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification,
    kAXTitleChangedNotification, kAXValueChangedNotification, kAXSelectedTextChangedNotification,
    kAXCreatedNotification, kAXUIElementDestroyedNotification,
    "AXLiveRegionChanged", // how web pages announce new chat messages
]

private func observerCallback(_ observer: AXObserver, _ element: AXUIElement, _ notification: CFString, _ refcon: UnsafeMutableRawPointer?) {
    guard let refcon else { return }
    let watcher = Unmanaged<Watcher>.fromOpaque(refcon).takeUnretainedValue()
    MainActor.assumeIsolated { watcher.handle(notification as String, element) }
}

/// Watches the front app while `watch` is on and turns its accessibility notifications into
/// debounced events. Everything here runs on the main run loop; with watching off it holds nothing.
@MainActor
final class Watcher {
    private let sink: EventSink
    private(set) var enabled = false
    private var activationObserver: NSObjectProtocol?
    private var visualTimer: Timer?

    // The observed app.
    private var running: NSRunningApplication?
    private var appElement: AXUIElement?
    private var observer: AXObserver?
    /// Front window, URL and exclusion; dropped whenever the window or its title changes.
    private var context: FrontContext?

    private var focused: AXUIElement?
    private var focusedEditable = false
    private var focusedSecure = false

    private let focusTimer = Debouncer(0.4)
    private let typingTimer = Debouncer(1.2)
    private let selectionTimer = Debouncer(0.25)
    private let contentTimer = Debouncer(2.5)

    private var typingElement: AXUIElement?
    private var selectionElement: AXUIElement?
    private var lastFocusKey: String?
    private var lastTyped: [String: String] = [:]
    private var lastSelection: (text: String, token: String)?
    private var lastContentAt = Date.distantPast
    private var visualHashes: [CGWindowID: UInt64] = [:]
    private var visualBusy = false

    init(sink: EventSink) { self.sink = sink }

    func configure(enabled: Bool, visualIntervalMs: Int) {
        guard enabled else { return stop() }
        if !self.enabled {
            self.enabled = true
            activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
            ) { [weak self] note in
                let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
                MainActor.assumeIsolated {
                    if let app { self?.attach(app) }
                }
            }
            if let front = NSWorkspace.shared.frontmostApplication { attach(front) }
        }
        setVisualInterval(visualIntervalMs)
    }

    func stop() {
        guard enabled else { return }
        enabled = false
        detach()
        if let activationObserver { NSWorkspace.shared.notificationCenter.removeObserver(activationObserver) }
        activationObserver = nil
        setVisualInterval(0)
        visualHashes.removeAll()
        lastTyped.removeAll()
    }

    /// Permissions or privacy rules changed: look at the front app afresh.
    func refresh() {
        guard enabled, let front = NSWorkspace.shared.frontmostApplication else { return }
        attach(front, announce: false)
    }

    // MARK: Attaching

    private func attach(_ app: NSRunningApplication, announce: Bool = true) {
        detach()
        running = app
        guard let context = currentContext() else { return }
        if announce { sink.emit(.app, context.base) }
        focusTimer.schedule { [weak self] in self?.emitFocus() }

        // Hidden apps and Polly itself are not observed at all.
        guard AXIsProcessTrusted(), context.exclusion != .app, context.exclusion != .selfProcess else { return }
        let pid = app.processIdentifier
        let element = context.appElement ?? AX.application(pid)
        var created: AXObserver?
        guard AXObserverCreate(pid, observerCallback, &created) == .success, let created else { return }
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        for name in observedNotifications {
            AXObserverAddNotification(created, element, name as CFString, refcon) // unsupported ones fail quietly
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .commonModes)
        observer = created
        appElement = element
        updateFocused(element.element(kAXFocusedUIElementAttribute))
    }

    private func detach() {
        if let observer {
            if let appElement {
                for name in observedNotifications { AXObserverRemoveNotification(observer, appElement, name as CFString) }
            }
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        }
        observer = nil
        appElement = nil
        running = nil
        context = nil
        updateFocused(nil)
        for timer in [focusTimer, typingTimer, selectionTimer, contentTimer] { timer.cancel() }
        typingElement = nil
        selectionElement = nil
        lastFocusKey = nil
        lastSelection = nil
    }

    private func currentContext() -> FrontContext? {
        if context == nil, let running { context = ContextReader.read(running) }
        return context
    }

    private func updateFocused(_ element: AXUIElement?) {
        focused = element
        let traits = element.map(AXReader.traits(of:))
        focusedEditable = traits?.editable ?? false
        focusedSecure = traits?.secure ?? false
    }

    // MARK: Notifications

    func handle(_ notification: String, _ element: AXUIElement) {
        guard enabled else { return }
        switch notification {
        case kAXFocusedUIElementChangedNotification:
            updateFocused(element)
            focusTimer.schedule { [weak self] in self?.emitFocus() }
        case kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification:
            context = nil
            focusTimer.schedule { [weak self] in self?.emitFocus() }
        case kAXTitleChangedNotification:
            // Buttons and tabs retitle themselves all the time; only a window's title is context.
            guard element.string(kAXRoleAttribute) == kAXWindowRole else { return }
            context = nil
            focusTimer.schedule { [weak self] in self?.emitFocus() }
        case kAXValueChangedNotification:
            if isTyping(in: element) {
                typingElement = focused
                typingTimer.schedule { [weak self] in self?.emitTyping() }
            } else {
                contentChanged(element)
            }
        case kAXSelectedTextChangedNotification:
            selectionElement = element
            selectionTimer.schedule { [weak self] in self?.emitSelection() }
        case kAXCreatedNotification, "AXLiveRegionChanged":
            contentChanged(element)
        case kAXUIElementDestroyedNotification:
            if let focused, CFEqual(focused, element) {
                updateFocused(nil)
                focusTimer.schedule { [weak self] in self?.emitFocus() }
            }
        default:
            break
        }
    }

    /// A value change in (or just inside) the focused editable, non-secure element.
    private func isTyping(in element: AXUIElement) -> Bool {
        guard focusedEditable, !focusedSecure, let focused else { return false }
        return AXReader.isSelfOrAncestor(focused, of: element, levels: 3)
    }

    /// Something changed in the focused window outside the focused element.
    private func contentChanged(_ element: AXUIElement) {
        guard !contentTimer.isPending, let context = currentContext(), context.exclusion == nil,
              let window = context.windowElement, let owner = element.element(kAXWindowAttribute), CFEqual(owner, window)
        else { return }
        contentTimer.schedule { [weak self] in self?.emitContent() }
    }

    // MARK: Events

    private func emitFocus() {
        context = nil
        guard let context = currentContext() else { return }
        var described: FocusedElement?
        if context.exclusion == nil, let appElement {
            updateFocused(appElement.element(kAXFocusedUIElementAttribute))
            described = focused.map(AXReader.describe)
        }
        let key = [String(context.app.pid), context.window.id.map(String.init) ?? "-", context.window.title,
                   described?.token ?? "-", context.exclusion?.rawValue ?? "-"].joined(separator: "|")
        guard key != lastFocusKey else { return }
        lastFocusKey = key
        sink.emit(.focus, EventData(base: context.base, more: FocusMore(focused: described)))
    }

    private func emitTyping() {
        guard let element = typingElement, let context = currentContext(), context.exclusion == nil else { return }
        let described = AXReader.describe(element)
        guard described.editable, !described.secure, let value = described.value, lastTyped[described.token] != value else { return }
        if lastTyped.count >= 64 { lastTyped.removeAll() }
        lastTyped[described.token] = value
        sink.emit(.typing, EventData(base: context.base, more: TypingMore(focused: described)))
    }

    private func emitSelection() {
        guard let context = currentContext() else { return }
        var selection: Selection?
        if context.exclusion == nil {
            if focusedSecure { return }
            selection = AXReader.selection(in: [selectionElement, focused].compactMap { $0 })
        }
        if let selection {
            if let last = lastSelection, last.text == selection.text, last.token == selection.token { return }
            lastSelection = (selection.text, selection.token)
        } else {
            // Only a selection that was announced gets a "cleared".
            guard lastSelection != nil else { return }
            lastSelection = nil
        }
        sink.emit(.selection, EventData(base: context.base, more: SelectionMore(selection: selection)))
    }

    private func emitContent() {
        let wait = 5 - Date().timeIntervalSince(lastContentAt)
        if wait > 0 {
            contentTimer.schedule(after: wait) { [weak self] in self?.emitContent() }
            return
        }
        guard let context = currentContext(), context.exclusion == nil else { return }
        lastContentAt = Date()
        sink.emit(.content, context.base)
    }

    // MARK: Visual checks

    private func setVisualInterval(_ ms: Int) {
        visualTimer?.invalidate()
        visualTimer = nil
        guard ms > 0, enabled else { return }
        let interval = max(Double(ms), 250) / 1000
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkVisual() }
        }
        timer.tolerance = interval * 0.2
        RunLoop.main.add(timer, forMode: .common)
        visualTimer = timer
    }

    private func checkVisual() {
        guard !visualBusy, CGPreflightScreenCaptureAccess(), let context = currentContext(), context.exclusion == nil,
              let id = context.window.id else { return }
        visualBusy = true
        let base = context.base
        Task { [weak self] in
            let hash = await Capture.hash(of: id, width: 160)
            self?.visualChecked(hash, window: id, base: base)
        }
    }

    private func visualChecked(_ hash: UInt64?, window: CGWindowID, base: EventBase) {
        visualBusy = false
        guard enabled, let hash else { return }
        guard let previous = visualHashes[window] else {
            if visualHashes.count >= 64 { visualHashes.removeAll() }
            visualHashes[window] = hash
            return
        }
        let distance = DHash.distance(previous, hash)
        guard distance >= 10 else { return }
        visualHashes[window] = hash
        sink.emit(.visual, EventData(base: base, more: VisualMore(hash: DHash.hex(hash), distance: distance)))
    }
}

/// Runs an action once things have been quiet for `delay`.
@MainActor
final class Debouncer {
    private let delay: TimeInterval
    private var work: DispatchWorkItem?

    init(_ delay: TimeInterval) { self.delay = delay }

    var isPending: Bool { work != nil }

    func schedule(after delay: TimeInterval? = nil, _ action: @escaping @MainActor () -> Void) {
        work?.cancel()
        let item = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                self?.work = nil
                action()
            }
        }
        work = item
        DispatchQueue.main.asyncAfter(deadline: .now() + (delay ?? self.delay), execute: item)
    }

    func cancel() {
        work?.cancel()
        work = nil
    }
}
