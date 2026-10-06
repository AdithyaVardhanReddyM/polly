import AppKit
import ApplicationServices

enum PermissionState {
    static func current() -> Permissions {
        Permissions(accessibility: AXIsProcessTrusted(), screenRecording: CGPreflightScreenCaptureAccess())
    }

    /// Shows the system prompt and opens the matching pane of System Settings.
    /// Returns whether Settings was opened; nothing happens when the permission is already granted.
    @MainActor static func request(_ kind: PermissionKind) -> Bool {
        switch kind {
        case .accessibility:
            guard !AXIsProcessTrusted() else { return false }
            let prompt = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            _ = AXIsProcessTrustedWithOptions([prompt: true] as CFDictionary)
            return openSettings("Privacy_Accessibility")
        case .screenRecording:
            guard !CGPreflightScreenCaptureAccess() else { return false }
            _ = CGRequestScreenCaptureAccess()
            return openSettings("Privacy_ScreenCapture")
        }
    }

    @MainActor private static func openSettings(_ anchor: String) -> Bool {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") else { return false }
        return NSWorkspace.shared.open(url)
    }
}

/// Grants change in System Settings, not through us, so both are re-checked every 2 s.
@MainActor
final class PermissionMonitor {
    private var timer: Timer?
    private var last = PermissionState.current()

    func start(onChange: @escaping @MainActor (Permissions) -> Void) {
        let timer = Timer(timeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let now = PermissionState.current()
                guard now != self.last else { return }
                self.last = now
                onChange(now)
            }
        }
        timer.tolerance = 0.5
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }
}
