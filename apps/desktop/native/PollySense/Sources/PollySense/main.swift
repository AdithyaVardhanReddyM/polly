import AppKit

// Polly Sense: the screen-reading helper for Polly's notch copilot.
//   PollySense --socket <path>   connect to Electron and serve requests until the socket closes
//   PollySense --selftest        print one pass of the read-only methods as JSON and exit

signal(SIGPIPE, SIG_IGN)
AX.configure()

let arguments = CommandLine.arguments
let application = NSApplication.shared
// No Dock icon, and a real run loop for AX observers, workspace notifications and timers.
application.setActivationPolicy(.accessory)

var server: Server?
if arguments.contains("--selftest") {
    MainActor.assumeIsolated { SelfTest.start() }
} else if let flag = arguments.firstIndex(of: "--socket"), arguments.indices.contains(flag + 1) {
    guard let socket = SenseSocket.connect(path: arguments[flag + 1], timeout: 5) else {
        Log.error("could not connect to \(arguments[flag + 1]) within 5 s")
        exit(0)
    }
    let connected = Server(socket: socket)
    server = connected
    MainActor.assumeIsolated { connected.start() }
} else {
    FileHandle.standardError.write(Data("usage: PollySense --socket <path> | --selftest\n".utf8))
    exit(64)
}

application.run()
