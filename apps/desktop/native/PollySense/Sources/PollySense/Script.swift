import AppKit

/// Brings an app forward, then plays keys, typing, pastes and pauses in order.
enum ScriptRunner {
    static func run(_ params: ScriptParams) async throws {
        guard AXIsProcessTrusted() else { throw SenseError("Polly Sense needs Accessibility permission to send keys") }
        // Checked up front so a typo does nothing rather than half a script.
        for case .key(let key, _) in params.steps where Keyboard.code(for: key) == nil {
            throw SenseError("Unknown key: \(key)")
        }

        if let pid = params.pid ?? NSWorkspace.shared.frontmostApplication?.processIdentifier {
            await Apps.bringForward(pid)
        }
        try? await Task.sleep(nanoseconds: 150_000_000)

        for step in params.steps {
            switch step {
            case .key(let key, let modifiers):
                if let code = Keyboard.code(for: key) { Keyboard.press(code, flags: Keyboard.flags(modifiers)) }
                try? await Task.sleep(nanoseconds: 15_000_000)
            case .type(let text):
                await Keyboard.type(text)
            case .paste(let text):
                await Paste.run(text)
            case .wait(let ms):
                try? await Task.sleep(nanoseconds: UInt64(min(max(ms, 0), 30_000) * 1_000_000))
            }
        }
    }
}
