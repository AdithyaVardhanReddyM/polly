import CoreGraphics
import ScreenCaptureKit

/// Screenshots of a single window through ScreenCaptureKit.
enum Capture {
    /// The window at most `maxPixelWidth` wide, without the cursor; nil without Screen Recording
    /// (asking ScreenCaptureKit would raise the system prompt) or when the window is off screen.
    static func window(_ id: CGWindowID, maxPixelWidth: Int) async -> CGImage? {
        guard CGPreflightScreenCaptureAccess() else { return nil }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let window = content.windows.first(where: { $0.windowID == id }) else { return nil }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let scale = CGFloat(filter.pointPixelScale)
            var width = filter.contentRect.width * scale
            var height = filter.contentRect.height * scale
            guard width >= 1, height >= 1 else { return nil }
            if width > CGFloat(maxPixelWidth) {
                height *= CGFloat(maxPixelWidth) / width
                width = CGFloat(maxPixelWidth)
            }
            let config = SCStreamConfiguration()
            config.width = max(1, Int(width.rounded()))
            config.height = max(1, Int(height.rounded()))
            config.showsCursor = false
            config.ignoreShadowsSingleWindow = true
            return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        } catch {
            Log.error("capture of window \(id) failed: \(error.localizedDescription)")
            return nil
        }
    }

    /// The window's 64-bit difference hash from a small capture.
    static func hash(of id: CGWindowID, width: Int) async -> UInt64? {
        guard let image = await window(id, maxPixelWidth: width) else { return nil }
        return DHash.of(image)
    }
}
