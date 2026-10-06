// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PollySense",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "PollySense", path: "Sources/PollySense")
    ],
    // Swift 5 mode keeps concurrency checking practical for AppKit and C callback code.
    swiftLanguageModes: [.v5]
)
