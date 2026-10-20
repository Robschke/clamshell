// Purpose: Keeps the Mac awake with the lid closed, also on battery, while TV Stream runs.
// Depends on: /usr/bin/pmset (disablesleep needs root, granted through the standard macOS
//             administrator prompt), /usr/bin/pgrep.
// Used by: macos/Sources/AppDelegate.swift
// Notes:
// - On battery macOS sleeps on lid close no matter which app runs; only "pmset disablesleep"
//   prevents that, and it is a persistent system setting.
// - The same authorization starts a root watcher that switches sleep back on as soon as no
//   TVStream process is left, so quitting or a crash needs no second password prompt. It waits
//   for any TVStream process (not one pid) so a quick relaunch is not undone by the old watcher.
// - The state is read back from "pmset -g" (SleepDisabled) rather than assumed.

import Foundation

final class LidSleepGuard {
    enum State: Equatable {
        case off
        case active
        case declined
        case failed(String)
    }

    var onStateChange: ((State) -> Void)?
    private(set) var state: State = .off {
        didSet { if state != oldValue { onStateChange?(state) } }
    }

    private static let prompt =
        "TV Stream wants to keep the Mac awake while the lid is closed, also on battery. " +
        "Sleep is switched back on automatically when TV Stream quits."

    private static let command =
        "/usr/bin/pmset -a disablesleep 1; " +
        "(while /usr/bin/pgrep -x TVStream >/dev/null; do /bin/sleep 2; done; " +
        "/usr/bin/pmset -a disablesleep 0) >/dev/null 2>&1 &"

    /// Shows the administrator prompt (blocks until answered) and enables lid-closed mode.
    func enable() {
        let source = "do shell script \"\(Self.command)\" with administrator privileges with prompt \"\(Self.prompt)\""
        var error: NSDictionary?
        NSAppleScript(source: source)?.executeAndReturnError(&error)
        if let error {
            let code = error[NSAppleScript.errorNumber] as? Int
            state = code == -128 ? .declined : .failed(error[NSAppleScript.errorMessage] as? String ?? "Unknown error")
            return
        }
        state = Self.isSleepDisabled() ? .active : .failed("pmset did not report sleep as disabled")
    }

    func refresh() {
        if Self.isSleepDisabled() {
            state = .active
        } else if state == .active {
            state = .off
        }
    }

    static func isSleepDisabled() -> Bool {
        let pmset = Process()
        pmset.executableURL = URL(fileURLWithPath: "/usr/bin/pmset")
        pmset.arguments = ["-g"]
        let pipe = Pipe()
        pmset.standardOutput = pipe
        guard (try? pmset.run()) != nil else { return false }
        pmset.waitUntilExit()
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return output.split(separator: "\n").contains { line in
            let parts = line.split(whereSeparator: { $0 == " " || $0 == "\t" })
            return parts.count == 2 && parts[0] == "SleepDisabled" && parts[1] == "1"
        }
    }
}
