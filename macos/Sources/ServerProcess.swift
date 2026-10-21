// Purpose: Starts and supervises the Clamshell Node server for the Mac app (start, readiness,
//          clean stop, restart after crashes, log file).
// Depends on: src/server/main.js (run with node from the app root; SIGTERM shuts it down
//             together with the TV Chrome window and caffeinate), GET /api/apps (readiness).
// Used by: macos/Sources/AppDelegate.swift
// Notes:
// - The node path and the app root come from Info.plist (written by macos/build-app.sh): apps
//   started from Finder or Spotlight do not get the shell's PATH, so "node" alone is not found.
// - An unexpected exit restarts the server after 2 s, at most 3 times per minute, so a server
//   that cannot start does not spin forever.
// - The log is truncated past 5 MB at start so it never grows without bound.

import Foundation

final class ServerProcess {
    enum State: Equatable {
        case starting
        case running
        case stopped
        case failed(String)
    }

    static let port: Int = Int(ProcessInfo.processInfo.environment["TV_STREAM_PORT"] ?? "") ?? 8787

    var onStateChange: ((State) -> Void)?
    private(set) var state: State = .stopped {
        didSet { if state != oldValue { onStateChange?(state) } }
    }

    private let nodePath: String
    private let appRoot: String
    private let logURL: URL
    private var process: Process?
    private var stopping = false
    private var stopCompletions: [() -> Void] = []
    private var crashTimes: [Date] = []
    private var readinessTimer: Timer?

    private static let stopTimeout: TimeInterval = 8
    private static let readinessTimeout: TimeInterval = 30
    private static let maxCrashesPerMinute = 3
    private static let maxLogBytes = 5 * 1024 * 1024

    init(nodePath: String, appRoot: String, logURL: URL) {
        self.nodePath = nodePath
        self.appRoot = appRoot
        self.logURL = logURL
    }

    var isRunning: Bool { process != nil }

    func start() {
        guard process == nil else { return }
        stopping = false
        guard FileManager.default.isExecutableFile(atPath: nodePath) else {
            state = .failed("Node not found at \(nodePath). Rebuild the app with npm run app.")
            return
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = ["src/server/main.js"]
        proc.currentDirectoryURL = URL(fileURLWithPath: appRoot)
        var env = ProcessInfo.processInfo.environment
        let nodeDir = URL(fileURLWithPath: nodePath).deletingLastPathComponent().path
        env["PATH"] = [nodeDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin", env["PATH"] ?? ""].joined(separator: ":")
        proc.environment = env
        if let log = openLog() {
            proc.standardOutput = log
            proc.standardError = log
        }
        proc.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async { self?.handleExit(of: finished) }
        }

        do {
            try proc.run()
        } catch {
            state = .failed("Could not start the server: \(error.localizedDescription)")
            return
        }
        process = proc
        state = .starting
        waitUntilReady(since: Date())
    }

    /// Sends SIGTERM (the server closes the TV window itself), SIGKILL after a timeout.
    func stop(completion: @escaping () -> Void = {}) {
        guard let proc = process else {
            completion()
            return
        }
        stopping = true
        stopCompletions.append(completion)
        readinessTimer?.invalidate()
        proc.terminate()
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.stopTimeout) { [weak self] in
            guard let self, let current = self.process, current === proc, proc.isRunning else { return }
            kill(proc.processIdentifier, SIGKILL)
        }
    }

    func restart() {
        crashTimes.removeAll()
        stop { [weak self] in self?.start() }
    }

    // MARK: - Private

    private func handleExit(of proc: Process) {
        guard proc === process else { return }
        process = nil
        readinessTimer?.invalidate()

        if stopping {
            stopping = false
            state = .stopped
            let completions = stopCompletions
            stopCompletions.removeAll()
            completions.forEach { $0() }
            return
        }

        let now = Date()
        crashTimes = crashTimes.filter { now.timeIntervalSince($0) < 60 } + [now]
        if crashTimes.count > Self.maxCrashesPerMinute {
            state = .failed("The server stopped repeatedly. Details in \(logURL.path).")
            return
        }
        state = .starting
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, self.process == nil, !self.stopping else { return }
            self.start()
        }
    }

    private func waitUntilReady(since started: Date) {
        readinessTimer?.invalidate()
        readinessTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] timer in
            guard let self, self.process != nil else {
                timer.invalidate()
                return
            }
            ServerProcess.isAnswering { answering in
                guard self.state == .starting else { return }
                if answering {
                    timer.invalidate()
                    self.state = .running
                } else if Date().timeIntervalSince(started) > Self.readinessTimeout {
                    timer.invalidate()
                    self.state = .failed("The server did not answer. Details in \(self.logURL.path).")
                }
            }
        }
    }

    /// True when a Clamshell server answers on the local port (this one or one started elsewhere).
    static func isAnswering(completion: @escaping (Bool) -> Void) {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/apps") else { return completion(false) }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { _, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { completion(ok) }
        }.resume()
    }

    private func openLog() -> FileHandle? {
        let fm = FileManager.default
        try? fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let size = (try? fm.attributesOfItem(atPath: logURL.path))?[.size] as? Int, size > Self.maxLogBytes {
            try? fm.removeItem(at: logURL)
        }
        if !fm.fileExists(atPath: logURL.path) {
            fm.createFile(atPath: logURL.path, contents: nil)
        }
        guard let handle = try? FileHandle(forWritingTo: logURL) else { return nil }
        handle.seekToEndOfFile()
        let stamp = ISO8601DateFormatter().string(from: Date())
        handle.write(Data("\n[tv-stream-app] starting server \(stamp)\n".utf8))
        return handle
    }
}
