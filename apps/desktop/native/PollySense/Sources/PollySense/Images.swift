import AppKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

enum Images {
    private static let sRGB = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()

    /// `image` scaled down to at most `maxWidth` pixels wide (never up).
    static func fit(_ image: CGImage, maxWidth: Int) -> CGImage? {
        guard image.width > maxWidth else { return image }
        let height = max(1, Int((Double(image.height) * Double(maxWidth) / Double(image.width)).rounded()))
        return draw(image, width: maxWidth, height: height, alpha: false)
    }

    static func draw(_ image: CGImage, width: Int, height: Int, alpha: Bool) -> CGImage? {
        let info = alpha ? CGImageAlphaInfo.premultipliedLast : CGImageAlphaInfo.noneSkipLast
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: sRGB, bitmapInfo: info.rawValue) else { return nil }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()
    }

    static func encode(_ image: CGImage, as type: UTType, quality: Double? = nil) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil) else { return nil }
        let options = quality.map { [kCGImageDestinationLossyCompressionQuality: $0] as CFDictionary }
        CGImageDestinationAddImage(destination, image, options)
        return CGImageDestinationFinalize(destination) ? data as Data : nil
    }

    /// A Base64 JPEG of the window, at most 1280 pixels wide.
    static func screenshot(_ image: CGImage) -> Screenshot? {
        guard let fitted = fit(image, maxWidth: 1280), let jpeg = encode(fitted, as: .jpeg, quality: 0.7) else { return nil }
        return Screenshot(jpeg: jpeg.base64EncodedString(), width: fitted.width, height: fitted.height)
    }

    /// An app icon as a square Base64 PNG of `size` pixels.
    static func iconPNG(_ icon: NSImage, size: Int) -> String? {
        var rect = CGRect(x: 0, y: 0, width: size, height: size)
        guard let source = icon.cgImage(forProposedRect: &rect, context: nil, hints: nil),
              let square = draw(source, width: size, height: size, alpha: true),
              let png = encode(square, as: .png) else { return nil }
        return png.base64EncodedString()
    }
}

/// A 64-bit difference hash: each bit says whether a pixel of a 9×8 grey thumbnail is darker than its right neighbour.
enum DHash {
    static func of(_ image: CGImage) -> UInt64? {
        // Shrinking in two steps averages more of the image than one jump to 9×8.
        guard let small = Images.fit(image, maxWidth: 72) else { return nil }
        var pixels = [UInt8](repeating: 0, count: 9 * 8)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: 9, height: 8, bitsPerComponent: 8, bytesPerRow: 9,
                                          space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
            context.interpolationQuality = .medium
            context.draw(small, in: CGRect(x: 0, y: 0, width: 9, height: 8))
            return true
        }
        guard drawn else { return nil }
        var hash: UInt64 = 0
        for row in 0..<8 {
            for column in 0..<8 {
                hash <<= 1
                if pixels[row * 9 + column] < pixels[row * 9 + column + 1] { hash |= 1 }
            }
        }
        return hash
    }

    static func hex(_ hash: UInt64) -> String { String(format: "%016llx", hash) }

    static func distance(_ a: UInt64, _ b: UInt64) -> Int { (a ^ b).nonzeroBitCount }
}
