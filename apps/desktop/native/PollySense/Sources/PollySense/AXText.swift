import ApplicationServices
import Foundation

/// Walks a window's accessibility tree for its visible text and its form fields.
///
/// The walk is breadth-first so a capped walk covers the whole window shallowly instead of one
/// corner deeply. Each node remembers its path from the window; sorting by path afterwards puts
/// the text back in document (reading) order.
enum AXText {
    struct Result {
        var blocks: [TextBlock]
        var chars: Int
        var fields: [FormField]
    }

    struct Limits {
        var maxNodes = 1500
        var budget: TimeInterval = 0.4
        var maxChars = 24_000
        var maxFields = 60
    }

    private static let labelledRoles: Set<String> = ["AXHeading", "AXLink", "AXButton", "AXCell", "AXMenuButton", "AXCheckBox", "AXRadioButton"]
    private static let fieldRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXCheckBox", "AXRadioButton", "AXPopUpButton"]
    private static let toggleRoles: Set<String> = ["AXCheckBox", "AXRadioButton"]
    // Their children repeat what they already said, or say nothing.
    private static let leafRoles: Set<String> = ["AXStaticText", "AXTextField", "AXTextArea", "AXComboBox", "AXSecureTextField",
                                                 "AXPopUpButton", "AXImage", "AXScrollBar", "AXValueIndicator", "AXSlider",
                                                 "AXIncrementor", "AXProgressIndicator", "AXBusyIndicator"]
    private static let windowControls: Set<String> = ["AXCloseButton", "AXMinimizeButton", "AXZoomButton", "AXFullScreenButton"]
    private static let names = [kAXRoleAttribute, kAXSubroleAttribute, kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
                                kAXPlaceholderValueAttribute, kAXPositionAttribute, kAXSizeAttribute,
                                kAXVisibleChildrenAttribute, kAXVisibleRowsAttribute, "AXEditableAncestor"]

    private typealias Path = [Int32]

    private struct Found {
        var path: Path
        var block: TextBlock
    }

    private struct FoundField {
        var path: Path
        var element: AXUIElement
        /// Its token is filled in once the field is known to be kept.
        var field: FormField
        var hasOwnLabel: Bool
        var inWebPage: Bool
    }

    static func read(window: AXUIElement, frame windowFrame: CGRect?, limits: Limits = Limits()) -> Result {
        var queue: [(element: AXUIElement, path: Path, inWebPage: Bool)] = [(window, [], false)]
        var sawWebPage = false
        var head = 0
        var texts: [Found] = []
        var fields: [FoundField] = []
        let deadline = Date().addingTimeInterval(limits.budget)

        while head < queue.count, head < limits.maxNodes, Date() < deadline {
            let (element, path, parentInWebPage) = queue[head]
            head += 1
            let v = element.values(names)
            let role = v[0] as? String ?? ""
            let subrole = v[1] as? String
            let frame = AXConvert.frame(position: v[6], size: v[7])

            // Off-window content (scrolled away, other tabs) is skipped with everything under it.
            if let frame, let windowFrame, frame.width > 0, frame.height > 0, !frame.intersects(windowFrame) { continue }
            if let subrole, windowControls.contains(subrole) { continue }
            let secure = AXReader.isSecure(role: role, subrole: subrole)
            let inWebPage = parentInWebPage || role == "AXWebArea"
            sawWebPage = sawWebPage || inWebPage

            let text = secure ? nil : self.text(role: role, value: v[2], title: v[3], description: v[4])
            // Visually hidden labels (1-point boxes) are left out; their children may still show.
            let visible = frame.map { $0.width > 1 && $0.height > 1 } ?? true
            if let text, visible {
                texts.append(Found(path: path, block: TextBlock(text: String(text.prefix(limits.maxChars)), frame: frame.map(Rect.init),
                                                                source: .ax, role: role)))
            }
            if !secure, isField(element, role: role, value: v[2], editableRoot: v[10]) {
                let label = [v[3], v[4], v[5]].lazy.compactMap { ($0 as? String).map(tidy) }.first { !$0.isEmpty }
                let field = FormField(label: label.map(shortLabel) ?? "", role: role,
                                      value: fieldValue(role: role, value: v[2], title: v[3]),
                                      frame: frame.map(Rect.init), token: "")
                fields.append(FoundField(path: path, element: element, field: field, hasOwnLabel: label != nil, inWebPage: inWebPage))
            }

            if leafRoles.contains(role) || (text != nil && labelledRoles.contains(role)) { continue }
            let room = limits.maxNodes - queue.count
            guard room > 0 else { continue }
            let children = (v[8] as? [AXUIElement]) ?? (v[9] as? [AXUIElement]) ?? element.children(limit: room)
            for (index, child) in children.prefix(room).enumerated() {
                queue.append((child, path + [Int32(index)], inWebPage))
            }
        }

        texts.sort { precedes($0.path, $1.path) }
        // In a browser or web app the form is the page; tabs and toolbar buttons around it are not.
        if sawWebPage { fields.removeAll { !$0.inWebPage } }
        fields.sort { precedes($0.path, $1.path) }
        labelFromPrecedingText(&fields, texts: texts)

        var blocks: [TextBlock] = []
        var chars = 0
        for found in texts where chars < limits.maxChars && found.block.text != blocks.last?.text {
            var block = found.block
            if chars + block.text.count > limits.maxChars { block.text = String(block.text.prefix(limits.maxChars - chars)) }
            chars += block.text.count
            blocks.append(block)
        }

        // Top to bottom, then left to right within a 6-point row.
        let kept = fields.sorted { a, b in
            let ya = a.field.frame.map { ($0.y / 6).rounded() } ?? .infinity, yb = b.field.frame.map { ($0.y / 6).rounded() } ?? .infinity
            return ya != yb ? ya < yb : (a.field.frame?.x ?? 0) < (b.field.frame?.x ?? 0)
        }.prefix(limits.maxFields)
        let formFields = kept.map { found -> FormField in
            var field = found.field
            field.token = Tokens.shared.token(for: found.element)
            return field
        }
        return Result(blocks: blocks, chars: chars, fields: formFields)
    }

    private static func text(role: String, value: AnyObject?, title: AnyObject?, description: AnyObject?) -> String? {
        let candidates: [AnyObject?]
        switch role {
        case "AXStaticText", "AXTextField", "AXTextArea": candidates = [value]
        case _ where labelledRoles.contains(role): candidates = [title, description, value]
        default: return nil
        }
        return candidates.lazy.compactMap { ($0 as? String).map(tidy) }.first { !$0.isEmpty }
    }

    /// The listed input roles, or the root of an editable region with a settable text value
    /// (a contenteditable that is not exposed as a text area). Chromium marks the value of plain
    /// groups settable too, so settable alone says nothing.
    private static func isField(_ element: AXUIElement, role: String, value: AnyObject?, editableRoot: AnyObject?) -> Bool {
        if fieldRoles.contains(role) { return true }
        guard value is String, let root = AXConvert.element(editableRoot), CFEqual(root, element) else { return false }
        return element.isSettable(kAXValueAttribute)
    }

    private static func fieldValue(role: String, value: AnyObject?, title: AnyObject?) -> String? {
        if toggleRoles.contains(role) {
            return (value as? NSNumber).map { String($0.intValue) }
        }
        if role == "AXPopUpButton" {
            return (value as? String) ?? (title as? String)
        }
        return (value as? String).map(AXReader.clip)
    }

    /// A field with no title, description or placeholder takes the nearest text before it.
    private static func labelFromPrecedingText(_ fields: inout [FoundField], texts: [Found]) {
        var textIndex = 0
        var lastStatic: String?
        for index in fields.indices {
            while textIndex < texts.count, precedes(texts[textIndex].path, fields[index].path) {
                if texts[textIndex].block.role == "AXStaticText" { lastStatic = texts[textIndex].block.text }
                textIndex += 1
            }
            // Each text labels one field at most, so a lone heading is not repeated down the form.
            if !fields[index].hasOwnLabel, let label = lastStatic {
                fields[index].field.label = shortLabel(tidy(label))
                lastStatic = nil
            }
        }
    }

    /// Document order: a parent before its children, siblings in order.
    private static func precedes(_ a: Path, _ b: Path) -> Bool {
        for (x, y) in zip(a, b) where x != y { return x < y }
        return a.count < b.count
    }

    private static func tidy(_ text: String) -> String {
        // U+FFFC stands in for embedded objects in web text.
        text.replacingOccurrences(of: "\u{FFFC}", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func shortLabel(_ text: String) -> String {
        text.count > 80 ? String(text.prefix(80)) : text
    }
}
