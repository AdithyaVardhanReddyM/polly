import ApplicationServices
import Foundation

/// Thin, typed access to the Accessibility API.
enum AX {
    static let systemWide = AXUIElementCreateSystemWide()

    /// A hung app would otherwise stall a call for the 6 s default. Set on the system-wide
    /// element, the timeout applies to every element this process queries.
    static func configure() {
        AXUIElementSetMessagingTimeout(systemWide, 0.3)
    }

    static func application(_ pid: pid_t) -> AXUIElement {
        let element = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(element, 0.3)
        return element
    }

    private static let webLock = NSLock()
    nonisolated(unsafe) private static var webEnabled = Set<pid_t>()

    /// Chromium and Electron build their accessibility tree only when an assistive app asks.
    /// AXManualAccessibility asks without AXEnhancedUserInterface, which makes Chromium replay keystrokes.
    /// Apps that are not Chromium reject the attribute, which is harmless.
    static func enableWebAccessibility(_ app: AXUIElement, pid: pid_t) {
        webLock.lock()
        let isNew = webEnabled.insert(pid).inserted
        webLock.unlock()
        guard isNew else { return }
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    }
}

extension AXUIElement {
    func attribute(_ name: String) -> AnyObject? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(self, name as CFString, &value) == .success else { return nil }
        return value
    }

    func string(_ name: String) -> String? { attribute(name) as? String }

    func element(_ name: String) -> AXUIElement? { AXConvert.element(attribute(name)) }

    /// One round trip for several attributes; missing ones come back nil.
    func values(_ names: [String]) -> [AnyObject?] {
        var array: CFArray?
        let error = AXUIElementCopyMultipleAttributeValues(self, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &array)
        guard error == .success, let values = array as [AnyObject]?, values.count == names.count else {
            return Array(repeating: nil, count: names.count)
        }
        return values.map { value in
            if value is NSNull { return nil }
            if CFGetTypeID(value) == AXValueGetTypeID(), AXValueGetType(value as! AXValue) == .axError { return nil }
            return value
        }
    }

    /// The first `limit` children, without copying a huge list whole.
    func children(limit: Int) -> [AXUIElement] {
        guard limit > 0 else { return [] }
        var values: CFArray?
        guard AXUIElementCopyAttributeValues(self, kAXChildrenAttribute as CFString, 0, limit, &values) == .success else { return [] }
        return (values as? [AXUIElement]) ?? []
    }

    func isSettable(_ name: String) -> Bool {
        var settable: DarwinBoolean = false
        return AXUIElementIsAttributeSettable(self, name as CFString, &settable) == .success && settable.boolValue
    }

    @discardableResult
    func set(_ name: String, _ value: AnyObject) -> Bool {
        AXUIElementSetAttributeValue(self, name as CFString, value) == .success
    }

    func parameterized(_ name: String, _ parameter: AnyObject) -> AnyObject? {
        var value: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(self, name as CFString, parameter, &value) == .success else { return nil }
        return value
    }

    @discardableResult
    func perform(_ action: String) -> Bool {
        AXUIElementPerformAction(self, action as CFString) == .success
    }

    var pid: pid_t? {
        var pid: pid_t = 0
        return AXUIElementGetPid(self, &pid) == .success ? pid : nil
    }
}

enum AXConvert {
    static func element(_ value: AnyObject?) -> AXUIElement? {
        guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    private static func axValue(_ value: AnyObject?, _ type: AXValueType) -> AXValue? {
        guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        let axValue = value as! AXValue
        return AXValueGetType(axValue) == type ? axValue : nil
    }

    static func point(_ value: AnyObject?) -> CGPoint? {
        guard let axValue = axValue(value, .cgPoint) else { return nil }
        var point = CGPoint.zero
        return AXValueGetValue(axValue, .cgPoint, &point) ? point : nil
    }

    static func size(_ value: AnyObject?) -> CGSize? {
        guard let axValue = axValue(value, .cgSize) else { return nil }
        var size = CGSize.zero
        return AXValueGetValue(axValue, .cgSize, &size) ? size : nil
    }

    static func rect(_ value: AnyObject?) -> CGRect? {
        guard let axValue = axValue(value, .cgRect) else { return nil }
        var rect = CGRect.zero
        guard AXValueGetValue(axValue, .cgRect, &rect), rect != .zero else { return nil }
        return rect
    }

    static func range(_ value: AnyObject?) -> CFRange? {
        guard let axValue = axValue(value, .cfRange) else { return nil }
        var range = CFRange()
        return AXValueGetValue(axValue, .cfRange, &range) ? range : nil
    }

    static func value(_ range: CFRange) -> AXValue? {
        var range = range
        return AXValueCreate(.cfRange, &range)
    }

    static func frame(position: AnyObject?, size: AnyObject?) -> CGRect? {
        guard let origin = point(position), let size = self.size(size) else { return nil }
        return CGRect(origin: origin, size: size)
    }
}

/// Short-lived handles to elements, so `write` can reach a field after focus moved on.
final class Tokens: @unchecked Sendable {
    static let shared = Tokens()

    // A full form's fields plus recent focus and selections.
    private let capacity = 256
    private let lock = NSLock()
    private var entries: [(token: String, element: AXUIElement)] = []

    func token(for element: AXUIElement) -> String {
        lock.lock()
        defer { lock.unlock() }
        if let index = entries.firstIndex(where: { CFEqual($0.element, element) }) {
            let entry = entries.remove(at: index)
            entries.append(entry)
            return entry.token
        }
        let token = "ax_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(16).lowercased()
        entries.append((token, element))
        if entries.count > capacity { entries.removeFirst(entries.count - capacity) }
        return token
    }

    func element(for token: String) -> AXUIElement? {
        lock.lock()
        defer { lock.unlock() }
        guard let index = entries.firstIndex(where: { $0.token == token }) else { return nil }
        let entry = entries.remove(at: index)
        entries.append(entry)
        return entry.element
    }
}
