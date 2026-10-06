import AppKit

/// Where the notch island goes. NSScreen frames are bottom-left based; the wire space is top-left of the primary display.
@MainActor
enum Geometry {
    static func current() -> NotchGeometry {
        let screens = NSScreen.screens
        guard let primary = screens.first else {
            return NotchGeometry(screen: Rect(.zero), notch: nil, menuBarHeight: 0, hasNotch: false, scale: 1)
        }
        let notched = screens.first { $0.safeAreaInsets.top > 0 }
        let screen = notched ?? primary
        let frame = screen.frame
        let top = primary.frame.maxY - frame.maxY

        var notch: Rect?
        if let notched, let left = notched.auxiliaryTopLeftArea, let right = notched.auxiliaryTopRightArea {
            let width = frame.width - left.width - right.width
            if width > 0 {
                notch = Rect(x: frame.midX - width / 2, y: top, width: width, height: notched.safeAreaInsets.top)
            }
        }

        var menuBarHeight = frame.maxY - screen.visibleFrame.maxY
        if menuBarHeight <= 0 { menuBarHeight = NSStatusBar.system.thickness }

        return NotchGeometry(
            screen: Rect(x: frame.minX, y: top, width: frame.width, height: frame.height),
            notch: notch,
            menuBarHeight: menuBarHeight,
            hasNotch: notch != nil,
            scale: screen.backingScaleFactor
        )
    }
}
