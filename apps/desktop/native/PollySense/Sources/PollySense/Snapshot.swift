import AppKit

/// One full read of the front window: accessibility text, form fields, and OCR or a screenshot when asked.
enum Snapshots {
    /// Apps and sites that draw their content on a canvas, where the accessibility tree has little text.
    private static let canvasApps: Set<String> = ["com.microsoft.Excel", "com.figma.Desktop", "com.apple.iWork.Numbers"]
    private static let canvasHosts: Set<String> = ["docs.google.com"]

    static func take(_ params: SnapshotParams) async throws -> Snapshot {
        guard let running = NSWorkspace.shared.frontmostApplication else { throw SenseError("No app is in front") }
        let at = Int64(Date().timeIntervalSince1970 * 1000)
        let context = ContextReader.read(running)
        if let reason = context.exclusion {
            return .excluded(ExcludedSnapshot(at: at, app: context.app, window: context.window, url: context.url, reason: reason))
        }

        var document: String?
        var text = AXText.Result(blocks: [], chars: 0, fields: [])
        if let window = context.windowElement {
            document = AXReader.document(of: window)
            var limits = AXText.Limits()
            if let maxNodes = params.maxAxNodes, maxNodes > 0 { limits.maxNodes = maxNodes }
            text = AXText.read(window: window, frame: context.window.frame?.cgRect, limits: limits)
        }

        var focused: FocusedElement?
        var selection: Selection?
        if let app = context.appElement, let element = AXReader.focusedElement(app: app, pid: context.app.pid) {
            let described = AXReader.describe(element)
            focused = described
            if !described.secure { selection = AXReader.selection(in: [element]) }
        }

        let host = context.url.flatMap { URL(string: $0)?.host?.lowercased() }
        let isCanvas = canvasApps.contains(context.app.bundleId) || host.map(canvasHosts.contains) == true
        let wantsOCR = params.ocr == .always || (params.ocr == .auto && (text.chars < 400 || isCanvas))

        var ocr: [TextBlock]?
        var ocrMs: Int?
        var screenshot: Screenshot?
        var hash: String?
        if wantsOCR || params.screenshot, let id = context.window.id, let frame = context.window.frame {
            let started = Date()
            if let image = await Capture.window(id, maxPixelWidth: wantsOCR ? 2560 : 1280) {
                hash = DHash.of(image).map(DHash.hex)
                if wantsOCR {
                    ocr = OCR.recognize(image, windowFrame: frame.cgRect)
                    ocrMs = Int(Date().timeIntervalSince(started) * 1000)
                }
                if params.screenshot { screenshot = Images.screenshot(image) }
            }
        }

        return .context(ContextSnapshot(
            at: at, app: context.app, window: context.window, url: context.url,
            document: document, focused: focused, selection: selection,
            ax: text.blocks, axChars: text.chars, fields: text.fields,
            ocr: ocr, ocrMs: ocrMs, screenshot: screenshot, hash: hash
        ))
    }
}
