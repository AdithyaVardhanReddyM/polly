import Foundation

/// What the user told Polly never to read.
final class Privacy: @unchecked Sendable {
    static let shared = Privacy()

    private let lock = NSLock()
    private var apps = Set<String>()
    private var domains: [String] = []
    private var windows = Set<PrivacyRules.HiddenWindow>()
    private var selfPids = Set<pid_t>()

    func update(_ rules: PrivacyRules) {
        lock.lock()
        defer { lock.unlock() }
        apps = Set(rules.apps)
        domains = rules.domains.compactMap(Self.normalizeDomain)
        windows = Set(rules.windows)
        selfPids = Set(rules.selfPids)
    }

    /// Exclusions decided before anything is read: Polly itself, and hidden apps.
    func processExclusion(pid: pid_t, bundleId: String) -> ExclusionReason? {
        lock.lock()
        defer { lock.unlock() }
        if pid == getpid() || selfPids.contains(pid) { return .selfProcess }
        if apps.contains(bundleId) { return .app }
        return nil
    }

    /// Exclusions that need the window title and page URL.
    func contentExclusion(bundleId: String, title: String, url: String?) -> ExclusionReason? {
        lock.lock()
        defer { lock.unlock() }
        if let host = url.flatMap({ URL(string: $0)?.host?.lowercased() })?.trimmingCharacters(in: CharacterSet(charactersIn: ".")),
           domains.contains(where: { host == $0 || host.hasSuffix("." + $0) }) {
            return .domain
        }
        if windows.contains(.init(bundleId: bundleId, title: title)) { return .window }
        return nil
    }

    var hasDomainRules: Bool {
        lock.lock()
        defer { lock.unlock() }
        return !domains.isEmpty
    }

    /// "https://Mail.Example.com/inbox", "*.example.com" and "example.com." all become "example.com"-style hosts.
    private static func normalizeDomain(_ raw: String) -> String? {
        var domain = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if domain.contains("://"), let host = URL(string: domain)?.host { domain = host }
        if domain.hasPrefix("*.") { domain.removeFirst(2) }
        if let slash = domain.firstIndex(of: "/") { domain = String(domain[..<slash]) }
        domain = domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))
        return domain.isEmpty ? nil : domain
    }
}
