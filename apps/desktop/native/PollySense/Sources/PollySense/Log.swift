import os

/// Launched through `open`, the helper has no terminal: logs go to the unified log
/// (`log stream --predicate 'subsystem == "ai.polly.sense"'`).
enum Log {
    private static let logger = Logger(subsystem: "ai.polly.sense", category: "sense")

    static func info(_ message: String) { logger.info("\(message, privacy: .public)") }
    static func error(_ message: String) { logger.error("\(message, privacy: .public)") }
}
