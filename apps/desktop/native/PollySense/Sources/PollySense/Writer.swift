import AppKit
import ApplicationServices

/// Puts text into another app: through Accessibility when the element takes it, else by pasting.
enum Writer {
    static func write(_ params: WriteParams) async throws -> WriteResult {
        guard AXIsProcessTrusted() else { throw SenseError("Polly Sense needs Accessibility permission to write") }
        guard let element = params.token.flatMap(Tokens.shared.element(for:)) ?? AXReader.focusedElement() else {
            throw SenseError("Nothing to write into")
        }
        let role = element.string(kAXRoleAttribute) ?? ""
        if params.mode == .replaceAll {
            switch role {
            case "AXCheckBox", "AXRadioButton":
                try await setToggle(element, role: role, on: params.text)
                return WriteResult(method: .ax)
            case "AXPopUpButton":
                try await choose(params.text, in: element)
                return WriteResult(method: .ax)
            default: break
            }
        }
        if await writeThroughAX(element, params) { return WriteResult(method: .ax) }
        await paste(params.text, into: element, selectAll: params.mode == .replaceAll)
        return WriteResult(method: .paste)
    }

    private static func writeThroughAX(_ element: AXUIElement, _ params: WriteParams) async -> Bool {
        let before = element.string(kAXValueAttribute)
        switch params.mode {
        case .replaceAll:
            guard element.set(kAXValueAttribute, params.text as CFString) else { return false }
        case .insert, .replaceSelection:
            if params.mode == .insert {
                guard !params.text.isEmpty else { return true }
                collapseSelection(element)
            }
            guard element.set(kAXSelectedTextAttribute, params.text as CFString) else { return false }
        }
        // Chromium contenteditables can report success and ignore the write, or apply it a moment later.
        guard let before else { return true }
        for delay: UInt64 in [0, 80, 250] {
            if delay > 0 { try? await Task.sleep(nanoseconds: delay * 1_000_000) }
            let after = element.string(kAXValueAttribute)
            if after != before { return true }
            if params.mode == .replaceAll, normalized(after) == normalized(params.text) { return true }
        }
        return false
    }

    /// Insert goes at the caret, so a selection is collapsed to its end first.
    private static func collapseSelection(_ element: AXUIElement) {
        guard let range = AXConvert.range(element.attribute(kAXSelectedTextRangeAttribute)), range.length > 0,
              let caret = AXConvert.value(CFRange(location: range.location + range.length, length: 0)) else { return }
        element.set(kAXSelectedTextRangeAttribute, caret)
    }

    private static func normalized(_ text: String?) -> String? {
        text?.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\u{00A0}", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func paste(_ text: String, into element: AXUIElement, selectAll: Bool) async {
        if let pid = element.pid { await Apps.bringForward(pid) }
        element.set(kAXFocusedAttribute, kCFBooleanTrue)
        await Paste.run(text, selectAll: selectAll)
    }

    /// Check boxes and radio buttons do not take AXValue; they are pressed when the state differs.
    private static func setToggle(_ element: AXUIElement, role: String, on text: String) async throws {
        let want = ["1", "true", "on", "yes"].contains(text.trimmingCharacters(in: .whitespaces).lowercased())
        func isOn() -> Bool { (element.attribute(kAXValueAttribute) as? NSNumber)?.intValue == 1 }
        guard isOn() != want else { return }
        if role == "AXRadioButton", !want { throw SenseError("A radio button turns off when another one in its group is chosen") }
        // The press's own result is unreliable (AppKit can report failure and still toggle), so the state decides.
        element.perform(kAXPressAction)
        for _ in 0..<10 where isOn() != want { try? await Task.sleep(nanoseconds: 30_000_000) }
        if isOn() != want { throw SenseError("The \(role == "AXCheckBox" ? "check box" : "radio button") did not change") }
    }

    /// Picks the menu item titled `title` in a pop-up button.
    private static func choose(_ title: String, in popUp: AXUIElement) async throws {
        let wanted = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if popUp.string(kAXValueAttribute) == wanted { return }
        if popUp.set(kAXValueAttribute, wanted as CFString) {
            try? await Task.sleep(nanoseconds: 80_000_000)
            if popUp.string(kAXValueAttribute) == wanted { return }
        }
        popUp.perform(kAXPressAction) // opens the menu; whether it did shows in its items
        var item: AXUIElement?
        for _ in 0..<10 where item == nil {
            try? await Task.sleep(nanoseconds: 50_000_000)
            item = menuItems(of: popUp).first { $0.string(kAXTitleAttribute)?.caseInsensitiveCompare(wanted) == .orderedSame }
        }
        guard let item else {
            for menu in menus(of: popUp) { menu.perform(kAXCancelAction) } // close the menu we opened
            throw SenseError("No option named \"\(wanted)\"")
        }
        item.perform(kAXPressAction)
        func chosen() -> Bool { popUp.string(kAXValueAttribute)?.caseInsensitiveCompare(wanted) == .orderedSame }
        for _ in 0..<10 where !chosen() { try? await Task.sleep(nanoseconds: 30_000_000) }
        if !chosen() { throw SenseError("The menu did not change") }
    }

    private static func menus(of popUp: AXUIElement) -> [AXUIElement] {
        (popUp.attribute(kAXChildrenAttribute) as? [AXUIElement] ?? []).filter { $0.string(kAXRoleAttribute) == kAXMenuRole }
    }

    private static func menuItems(of popUp: AXUIElement) -> [AXUIElement] {
        menus(of: popUp).flatMap { $0.attribute(kAXChildrenAttribute) as? [AXUIElement] ?? [] }
    }
}
