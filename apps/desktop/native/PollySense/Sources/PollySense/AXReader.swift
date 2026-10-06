import ApplicationServices
import Foundation

/// Reads the focused element, the selection, the page URL and the document of a window.
enum AXReader {
    static let textInputRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
    static let maxValueLength = 20_000

    struct Traits {
        var role: String
        var subrole: String?
        var editable: Bool
        var secure: Bool
    }

    static func isSecure(role: String?, subrole: String?) -> Bool {
        role == kAXSecureTextFieldSubrole || subrole == kAXSecureTextFieldSubrole
    }

    /// The element with keyboard focus in the app with `pid`: system-wide first, then the app's own.
    static func focusedElement(app: AXUIElement? = nil, pid: pid_t? = nil) -> AXUIElement? {
        if let element = AX.systemWide.element(kAXFocusedUIElementAttribute), pid == nil || element.pid == pid {
            return element
        }
        return app?.element(kAXFocusedUIElementAttribute)
    }

    static func traits(of element: AXUIElement) -> Traits {
        let v = element.values([kAXRoleAttribute, kAXSubroleAttribute, "AXEditableAncestor"])
        let role = v[0] as? String ?? "AXUnknown"
        let subrole = v[1] as? String
        let secure = isSecure(role: role, subrole: subrole)
        let editable = textInputRoles.contains(role) || v[2] != nil || element.isSettable(kAXValueAttribute)
        return Traits(role: role, subrole: subrole, editable: editable || secure, secure: secure)
    }

    static func describe(_ element: AXUIElement) -> FocusedElement {
        let traits = traits(of: element)
        // A secure field's value and selection are never even requested.
        let textNames = traits.secure ? [] : [kAXValueAttribute, kAXSelectedTextAttribute, kAXSelectedTextRangeAttribute]
        let v = element.values([kAXTitleAttribute, kAXDescriptionAttribute, kAXPlaceholderValueAttribute,
                                kAXPositionAttribute, kAXSizeAttribute] + textNames)
        let label = v[0...2].lazy.compactMap { ($0 as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) }.first { !$0.isEmpty }
        let range = traits.secure ? nil : AXConvert.range(v[7])
        return FocusedElement(
            role: traits.role,
            subrole: traits.subrole,
            label: label,
            value: traits.secure ? nil : (v[5] as? String).map(clip),
            selectedText: traits.secure ? nil : (v[6] as? String).map(clip),
            selectedRange: range.map { TextRange(location: $0.location, length: $0.length) },
            editable: traits.editable,
            secure: traits.secure,
            frame: AXConvert.frame(position: v[3], size: v[4]).map(Rect.init),
            token: Tokens.shared.token(for: element)
        )
    }

    /// The selected text, looked up on each candidate and up to 3 of its parents.
    /// Web views that keep no AXSelectedText are read through their text markers.
    static func selection(in candidates: [AXUIElement]) -> Selection? {
        let names = [kAXSelectedTextAttribute, kAXSelectedTextRangeAttribute, kAXRoleAttribute, kAXSubroleAttribute,
                     "AXSelectedTextMarkerRange", kAXParentAttribute]
        for candidate in candidates {
            var current: AXUIElement? = candidate
            for _ in 0...3 {
                guard let element = current else { break }
                let v = element.values(names)
                if isSecure(role: v[2] as? String, subrole: v[3] as? String) { return nil }
                let text = v[0] as? String
                if let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    let bounds = v[1].flatMap { AXConvert.rect(element.parameterized(kAXBoundsForRangeParameterizedAttribute, $0)) }
                    return makeSelection(element, text: text, bounds: bounds)
                }
                if let marker = v[4],
                   let marked = element.parameterized("AXStringForTextMarkerRange", marker) as? String,
                   !marked.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    let bounds = AXConvert.rect(element.parameterized("AXBoundsForTextMarkerRange", marker))
                    return makeSelection(element, text: marked, bounds: bounds)
                }
                if text != nil { return nil } // the element keeps a selection, and it is empty
                current = AXConvert.element(v[5])
            }
        }
        return nil
    }

    private static func makeSelection(_ element: AXUIElement, text: String, bounds: CGRect?) -> Selection {
        Selection(text: clip(text), bounds: bounds.map(Rect.init), editable: traits(of: element).editable,
                  token: Tokens.shared.token(for: element))
    }

    /// Whether `ancestor` is `element` or one of its first `levels` parents.
    static func isSelfOrAncestor(_ ancestor: AXUIElement, of element: AXUIElement, levels: Int) -> Bool {
        var current: AXUIElement? = element
        for _ in 0...levels {
            guard let node = current else { return false }
            if CFEqual(node, ancestor) { return true }
            current = node.element(kAXParentAttribute)
        }
        return false
    }

    /// The page URL of a browser window: its web area's AXURL, else the address bar's text.
    static func pageURL(in window: AXUIElement) -> String? {
        var queue: [(element: AXUIElement, depth: Int)] = [(window, 0)]
        var head = 0
        var addressBar: String?
        let deadline = Date().addingTimeInterval(0.2)
        while head < queue.count, head < 800, Date() < deadline {
            let (element, depth) = queue[head]
            head += 1
            let v = element.values([kAXRoleAttribute, kAXDescriptionAttribute, kAXChildrenAttribute])
            let role = v[0] as? String
            if role == "AXWebArea" {
                if let url = webURL(element.attribute(kAXURLAttribute)) { return url }
                continue
            }
            // Chrome's "Address and search bar", Firefox's "…enter address".
            if role == kAXTextFieldRole, addressBar == nil,
               let description = v[1] as? String, description.localizedCaseInsensitiveContains("address") {
                addressBar = element.string(kAXValueAttribute)
                continue
            }
            guard depth < 14, let children = v[2] as? [AXUIElement] else { continue }
            queue.append(contentsOf: children.map { ($0, depth + 1) })
        }
        return addressBar.flatMap(addressURL)
    }

    private static func webURL(_ value: AnyObject?) -> String? {
        let string = (value as? URL)?.absoluteString ?? (value as? String)
        guard let string, let scheme = URL(string: string)?.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        return string
    }

    private static func addressURL(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains(where: \.isWhitespace) else { return nil }
        let candidate = trimmed.contains("://") ? trimmed : "https://" + trimmed
        guard let url = URL(string: candidate), url.host?.contains(".") == true else { return nil }
        return webURL(url as AnyObject)
    }

    /// The file a window shows, as a path.
    static func document(of window: AXUIElement) -> String? {
        guard let raw = window.string(kAXDocumentAttribute), !raw.isEmpty else { return nil }
        if let url = URL(string: raw), url.isFileURL { return url.path }
        return raw.hasPrefix("/") ? raw : nil
    }

    static func clip(_ text: String) -> String {
        text.count > maxValueLength ? String(text.prefix(maxValueLength)) : text
    }
}
