import CoreGraphics
import Vision

/// Apple Vision text recognition over a window capture.
enum OCR {
    /// Text in `image`, a capture of the window at `frame`, with frames in global top-left points.
    static func recognize(_ image: CGImage, windowFrame frame: CGRect) -> [TextBlock] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.automaticallyDetectsLanguage = true
        do {
            try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        } catch {
            Log.error("text recognition failed: \(error.localizedDescription)")
            return []
        }
        return (request.results ?? []).compactMap { observation in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            // Vision boxes are normalized with a bottom-left origin.
            let box = observation.boundingBox
            let rect = CGRect(x: frame.minX + box.minX * frame.width,
                              y: frame.minY + (1 - box.maxY) * frame.height,
                              width: box.width * frame.width,
                              height: box.height * frame.height)
            return TextBlock(text: candidate.string, frame: Rect(rect), source: .ocr, role: nil, confidence: Double(candidate.confidence))
        }
    }
}
