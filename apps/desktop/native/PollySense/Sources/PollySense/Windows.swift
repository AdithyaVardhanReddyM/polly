import CoreGraphics
import Foundation

/// The window server's view of windows: ids for capture, and frames when Accessibility is off.
enum WindowList {
    struct Entry {
        var id: CGWindowID
        var frame: CGRect
        /// Only readable with Screen Recording.
        var title: String?
    }

    /// The app's normal (layer 0) on-screen windows, front to back.
    static func windows(of pid: pid_t) -> [Entry] {
        guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return []
        }
        return info.compactMap { window in
            guard window[kCGWindowOwnerPID as String] as? pid_t == pid,
                  window[kCGWindowLayer as String] as? Int == 0,
                  let id = window[kCGWindowNumber as String] as? CGWindowID,
                  let bounds = window[kCGWindowBounds as String] as? NSDictionary,
                  let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary)
            else { return nil }
            return Entry(id: id, frame: frame, title: window[kCGWindowName as String] as? String)
        }
    }

    /// The window at `frame` (within 4 pt), preferring one with the same title.
    static func match(pid: pid_t, frame: CGRect, title: String) -> Entry? {
        let near = windows(of: pid).filter { entry in
            abs(entry.frame.minX - frame.minX) <= 4 && abs(entry.frame.minY - frame.minY) <= 4 &&
                abs(entry.frame.width - frame.width) <= 4 && abs(entry.frame.height - frame.height) <= 4
        }
        return near.first { $0.title == title } ?? near.first
    }
}
