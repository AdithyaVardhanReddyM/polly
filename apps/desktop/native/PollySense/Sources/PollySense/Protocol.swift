import CoreGraphics
import Foundation

// Mirrors apps/desktop/src/shared/sense.ts; keep the two in step. Property names are the wire names.
// A TS `T | null` field is `@Nullable`: always written, as null when empty.
// A TS optional `field?:` is a plain Swift optional: left out when nil.

@propertyWrapper
struct Nullable<Value> {
    var wrappedValue: Value?

    init(wrappedValue: Value?) { self.wrappedValue = wrappedValue }
}

extension Nullable: Encodable where Value: Encodable {
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        if let wrappedValue { try container.encode(wrappedValue) } else { try container.encodeNil() }
    }
}

extension Nullable: Decodable where Value: Decodable {
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        wrappedValue = container.decodeNil() ? nil : try container.decode(Value.self)
    }
}

extension KeyedDecodingContainer {
    /// A missing key reads as null, the same as an explicit null.
    func decode<Value: Decodable>(_ type: Nullable<Value>.Type, forKey key: Key) throws -> Nullable<Value> {
        try decodeIfPresent(type, forKey: key) ?? Nullable(wrappedValue: nil)
    }
}

// MARK: - Shapes

struct Rect: Codable, Equatable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double
}

extension Rect {
    init(_ rect: CGRect) {
        func finite(_ value: CGFloat) -> Double { value.isFinite ? Double(value) : 0 }
        self.init(x: finite(rect.minX), y: finite(rect.minY), width: finite(rect.width), height: finite(rect.height))
    }

    var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

struct SenseApp: Codable {
    var name: String
    var bundleId: String
    var pid: Int32
}

struct SenseWindow: Codable {
    @Nullable var id: UInt32?
    var title: String
    @Nullable var frame: Rect?
}

struct TextRange: Codable {
    var location: Int
    var length: Int
}

struct FocusedElement: Codable {
    var role: String
    @Nullable var subrole: String?
    @Nullable var label: String?
    @Nullable var value: String?
    @Nullable var selectedText: String?
    @Nullable var selectedRange: TextRange?
    var editable: Bool
    var secure: Bool
    @Nullable var frame: Rect?
    var token: String
}

struct Selection: Codable {
    var text: String
    @Nullable var bounds: Rect?
    var editable: Bool
    var token: String
}

struct TextBlock: Codable {
    enum Source: String, Codable { case ax, ocr }

    var text: String
    @Nullable var frame: Rect?
    var source: Source
    var role: String?
    var confidence: Double?
}

struct FormField: Codable {
    var label: String
    var role: String
    @Nullable var value: String?
    @Nullable var frame: Rect?
    var token: String
}

struct Screenshot: Codable {
    var jpeg: String
    var width: Int
    var height: Int
}

enum ExclusionReason: String, Codable {
    case app, domain, window
    case selfProcess = "self"
}

struct ContextSnapshot: Codable {
    var at: Int64
    var app: SenseApp
    var window: SenseWindow
    @Nullable var url: String?
    var excluded = false
    @Nullable var document: String?
    @Nullable var focused: FocusedElement?
    @Nullable var selection: Selection?
    var ax: [TextBlock]
    var axChars: Int
    var fields: [FormField]
    @Nullable var ocr: [TextBlock]?
    @Nullable var ocrMs: Int?
    @Nullable var screenshot: Screenshot?
    @Nullable var hash: String?
}

struct ExcludedSnapshot: Codable {
    var at: Int64
    var app: SenseApp
    var window: SenseWindow
    @Nullable var url: String?
    var excluded = true
    var reason: ExclusionReason
}

enum Snapshot: Encodable {
    case context(ContextSnapshot)
    case excluded(ExcludedSnapshot)

    func encode(to encoder: Encoder) throws {
        switch self {
        case .context(let snapshot): try snapshot.encode(to: encoder)
        case .excluded(let snapshot): try snapshot.encode(to: encoder)
        }
    }
}

struct NotchGeometry: Codable {
    var screen: Rect
    @Nullable var notch: Rect?
    var menuBarHeight: Double
    var hasNotch: Bool
    var scale: Double
}

struct Permissions: Codable, Equatable {
    var accessibility: Bool
    var screenRecording: Bool
}

struct PrivacyRules: Codable {
    struct HiddenWindow: Codable, Hashable {
        var bundleId: String
        var title: String
    }

    var apps: [String] = []
    var domains: [String] = []
    var windows: [HiddenWindow] = []
    var selfPids: [Int32] = []

    init() {}

    // Lenient: a missing list means an empty one.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        apps = try c.decodeIfPresent([String].self, forKey: .apps) ?? []
        domains = try c.decodeIfPresent([String].self, forKey: .domains) ?? []
        windows = try c.decodeIfPresent([HiddenWindow].self, forKey: .windows) ?? []
        selfPids = try c.decodeIfPresent([Int32].self, forKey: .selfPids) ?? []
    }
}

struct RunningApp: Codable {
    var name: String
    var bundleId: String
    var pid: Int32
    @Nullable var icon: String?
}

enum ScriptStep: Codable {
    enum Modifier: String, Codable { case cmd, ctrl, alt, shift }

    case key(String, modifiers: [Modifier])
    case paste(String)
    case type(String)
    case wait(Double)

    private enum CodingKeys: String, CodingKey { case key, modifiers, paste, type, wait }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let key = try c.decodeIfPresent(String.self, forKey: .key) {
            self = .key(key, modifiers: try c.decodeIfPresent([Modifier].self, forKey: .modifiers) ?? [])
        } else if let text = try c.decodeIfPresent(String.self, forKey: .paste) {
            self = .paste(text)
        } else if let text = try c.decodeIfPresent(String.self, forKey: .type) {
            self = .type(text)
        } else if let ms = try c.decodeIfPresent(Double.self, forKey: .wait) {
            self = .wait(ms)
        } else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "A step needs key, paste, type or wait"))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .key(let key, let modifiers):
            try c.encode(key, forKey: .key)
            if !modifiers.isEmpty { try c.encode(modifiers, forKey: .modifiers) }
        case .paste(let text): try c.encode(text, forKey: .paste)
        case .type(let text): try c.encode(text, forKey: .type)
        case .wait(let ms): try c.encode(ms, forKey: .wait)
        }
    }
}

// MARK: - Request params and results

struct HelloResult: Codable {
    var version: String
    var pid: Int32
}

enum PermissionKind: String, Codable { case accessibility, screenRecording }

struct RequestPermissionParams: Codable { var kind: PermissionKind }

struct OpenedResult: Codable { var opened: Bool }

struct OkResult: Codable { var ok: Bool }

struct WatchParams: Codable {
    var enabled: Bool
    var visualIntervalMs: Int?
}

enum OCRMode: String, Codable { case auto, always, never }

struct SnapshotParams: Codable {
    var ocr: OCRMode = .auto
    var screenshot = false
    var maxAxNodes: Int?

    init(ocr: OCRMode = .auto, screenshot: Bool = false, maxAxNodes: Int? = nil) {
        self.ocr = ocr
        self.screenshot = screenshot
        self.maxAxNodes = maxAxNodes
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ocr = try c.decodeIfPresent(OCRMode.self, forKey: .ocr) ?? .auto
        screenshot = try c.decodeIfPresent(Bool.self, forKey: .screenshot) ?? false
        maxAxNodes = try c.decodeIfPresent(Int.self, forKey: .maxAxNodes)
    }
}

enum WriteMode: String, Codable { case replaceSelection, replaceAll, insert }

struct WriteParams: Codable {
    var token: String?
    var mode: WriteMode
    var text: String
}

struct WriteResult: Codable {
    enum Method: String, Codable { case ax, paste }
    var method: Method
}

struct ScriptParams: Codable {
    var pid: Int32?
    var steps: [ScriptStep]
}

struct AppIconParams: Codable {
    var bundleId: String
    var size: Int?
}

struct AppIconResult: Codable { @Nullable var png: String? }

struct ActivateParams: Codable {
    var pid: Int32?
    var bundleId: String?
}

// MARK: - Events

enum EventName: String, Codable {
    case app, focus, typing, selection, content, visual, permissions, geometry
}

struct EventBase: Codable {
    var app: SenseApp
    var window: SenseWindow
    var excluded: Bool
}

/// `EventBase & { …more }`: both halves are written into one JSON object.
struct EventData<More: Encodable>: Encodable {
    var base: EventBase
    var more: More

    func encode(to encoder: Encoder) throws {
        try base.encode(to: encoder)
        try more.encode(to: encoder)
    }
}

struct FocusMore: Codable { @Nullable var focused: FocusedElement? }
struct TypingMore: Codable { var focused: FocusedElement }
struct SelectionMore: Codable { @Nullable var selection: Selection? }
struct VisualMore: Codable {
    var hash: String
    var distance: Int
}

// MARK: - Envelope

enum RequestID: Codable {
    case int(Int)
    case string(String)

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let int = try? c.decode(Int.self) { self = .int(int) } else { self = .string(try c.decode(String.self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .int(let int): try c.encode(int)
        case .string(let string): try c.encode(string)
        }
    }
}

struct RequestHead: Decodable {
    var id: RequestID?
    var method: String?
}

struct RequestParams<Params: Decodable>: Decodable {
    var params: Params?
}

struct Response<Result: Encodable>: Encodable {
    var id: RequestID
    var result: Result
}

struct ErrorResponse: Encodable {
    struct Message: Encodable { var message: String }
    var id: RequestID
    var error: Message
}

struct EventMessage<Payload: Encodable>: Encodable {
    var event: EventName
    var data: Payload
}

struct SenseError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
