import AppKit
import Carbon.HIToolbox
import CoreGraphics

/// Synthetic key presses and typing, posted at the HID level like a real keyboard.
enum Keyboard {
    private static let codes: [String: Int] = {
        var codes: [String: Int] = [
            "return": kVK_Return, "enter": kVK_Return, "tab": kVK_Tab, "escape": kVK_Escape, "esc": kVK_Escape,
            "space": kVK_Space, "delete": kVK_Delete, "backspace": kVK_Delete, "forwarddelete": kVK_ForwardDelete,
            "up": kVK_UpArrow, "down": kVK_DownArrow, "left": kVK_LeftArrow, "right": kVK_RightArrow,
            "home": kVK_Home, "end": kVK_End, "pageup": kVK_PageUp, "pagedown": kVK_PageDown,
        ]
        let letters = [kVK_ANSI_A, kVK_ANSI_B, kVK_ANSI_C, kVK_ANSI_D, kVK_ANSI_E, kVK_ANSI_F, kVK_ANSI_G, kVK_ANSI_H, kVK_ANSI_I,
                       kVK_ANSI_J, kVK_ANSI_K, kVK_ANSI_L, kVK_ANSI_M, kVK_ANSI_N, kVK_ANSI_O, kVK_ANSI_P, kVK_ANSI_Q, kVK_ANSI_R,
                       kVK_ANSI_S, kVK_ANSI_T, kVK_ANSI_U, kVK_ANSI_V, kVK_ANSI_W, kVK_ANSI_X, kVK_ANSI_Y, kVK_ANSI_Z]
        for (letter, code) in zip("abcdefghijklmnopqrstuvwxyz", letters) { codes[String(letter)] = code }
        let digits = [kVK_ANSI_0, kVK_ANSI_1, kVK_ANSI_2, kVK_ANSI_3, kVK_ANSI_4, kVK_ANSI_5, kVK_ANSI_6, kVK_ANSI_7, kVK_ANSI_8, kVK_ANSI_9]
        for (digit, code) in digits.enumerated() { codes[String(digit)] = code }
        let functionKeys = [kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10, kVK_F11, kVK_F12]
        for (index, code) in functionKeys.enumerated() { codes["f\(index + 1)"] = code }
        return codes
    }()

    static func code(for key: String) -> CGKeyCode? {
        codes[key.lowercased()].map { CGKeyCode($0) }
    }

    static func flags(_ modifiers: [ScriptStep.Modifier]) -> CGEventFlags {
        modifiers.reduce(into: CGEventFlags()) { flags, modifier in
            switch modifier {
            case .cmd: flags.insert(.maskCommand)
            case .ctrl: flags.insert(.maskControl)
            case .alt: flags.insert(.maskAlternate)
            case .shift: flags.insert(.maskShift)
            }
        }
    }

    static func press(_ code: CGKeyCode, flags: CGEventFlags = []) {
        let source = CGEventSource(stateID: .hidSystemState)
        for isDown in [true, false] {
            let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: isDown)
            event?.flags = flags
            event?.post(tap: .cghidEventTap)
        }
    }

    /// Types `text` as Unicode, a few characters per event (the API takes at most 20 UTF-16 units).
    /// Line breaks are pressed as Return.
    static func type(_ text: String) async {
        let source = CGEventSource(stateID: .hidSystemState)
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false)
        for (index, line) in lines.enumerated() {
            if index > 0 { press(CGKeyCode(kVK_Return)) }
            var chunk: [UniChar] = []
            for character in line {
                let units = Array(String(character).utf16)
                if chunk.count + units.count > 20 {
                    post(chunk, source: source)
                    chunk.removeAll()
                    try? await Task.sleep(nanoseconds: 4_000_000)
                }
                chunk += units
            }
            if !chunk.isEmpty { post(chunk, source: source) }
        }
    }

    private static func post(_ units: [UniChar], source: CGEventSource?) {
        for isDown in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: isDown) else { continue }
            event.flags = []
            units.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress) }
            event.post(tap: .cghidEventTap)
        }
    }
}

/// Pastes through the general pasteboard and then puts back whatever was on it.
@MainActor
enum Paste {
    private static let transient = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")
    private static let concealed = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")

    static func run(_ text: String, selectAll: Bool = false) async {
        let pasteboard = NSPasteboard.general
        let saved = (pasteboard.pasteboardItems ?? []).map { item in
            Dictionary(uniqueKeysWithValues: item.types.compactMap { type in item.data(forType: type).map { (type, $0) } })
        }
        // Marked transient and concealed so clipboard managers skip it.
        pasteboard.declareTypes([.string, transient, concealed], owner: nil)
        pasteboard.setString(text, forType: .string)
        pasteboard.setData(Data(), forType: transient)
        pasteboard.setData(Data(), forType: concealed)
        let ours = pasteboard.changeCount

        if selectAll {
            Keyboard.press(CGKeyCode(kVK_ANSI_A), flags: .maskCommand)
            try? await Task.sleep(nanoseconds: 40_000_000)
        }
        Keyboard.press(CGKeyCode(kVK_ANSI_V), flags: .maskCommand)
        try? await Task.sleep(nanoseconds: 400_000_000)

        // Someone copied something else meanwhile: theirs wins.
        guard pasteboard.changeCount == ours else { return }
        pasteboard.clearContents()
        let items = saved.map { types -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in types { item.setData(data, forType: type) }
            return item
        }
        if !items.isEmpty { pasteboard.writeObjects(items) }
    }
}
