// Purpose: TV Stream Mac app: starts the server on launch, shows a Dock icon and a menu bar
//          menu (status, remote QR code, restart, quit), keeps the Mac awake with the lid
//          closed while it runs, and stops the server on quit.
// Depends on: macos/Sources/ServerProcess.swift, macos/Sources/RemoteQRWindow.swift,
//             macos/Sources/LidSleepGuard.swift, Info.plist keys TVStreamAppRoot and
//             TVStreamNodePath (macos/build-app.sh).
// Used by: macos/Sources/main.swift
// Notes:
// - Quitting waits for the server to shut down (it closes the TV window and caffeinate), so
//   nothing keeps running after the app is gone.
// - A server already answering on the port (for example "npm start" in a terminal) is not
//   started twice; the app explains that and quits.
// - Clicking the Dock icon brings the TV Chrome window to the front. It is found by its
//   dedicated profile directory, so the user's own Chrome is never touched.

import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var server: ServerProcess!
    private let lidGuard = LidSleepGuard()
    private let lidLine = NSMenuItem(title: "Lid closed: checking…", action: nil, keyEquivalent: "")
    private var lidEnableItem: NSMenuItem!
    private var statusItem: NSStatusItem!
    private let statusLine = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
    private var qrWindow: RemoteQRWindowController?
    private var quitting = false

    private static let profileDir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/TV Stream/chrome-profile").path

    func applicationDidFinishLaunching(_ notification: Notification) {
        let info = Bundle.main.infoDictionary ?? [:]
        let appRoot = info["TVStreamAppRoot"] as? String ?? ""
        let nodePath = info["TVStreamNodePath"] as? String ?? "/opt/homebrew/bin/node"
        let logURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/TV Stream/server.log")
        server = ServerProcess(nodePath: nodePath, appRoot: appRoot, logURL: logURL)
        server.onStateChange = { [weak self] state in self?.render(state) }

        NSApp.mainMenu = buildMainMenu()
        buildStatusItem()

        ServerProcess.isAnswering { [weak self] answering in
            guard let self else { return }
            if answering {
                self.alreadyRunning()
            } else {
                self.server.start()
                self.enableLidMode()
            }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        bringTvToFront()
        return false
    }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        menu.addItem(withTitle: "Show Remote QR Code…", action: #selector(showQRCode), keyEquivalent: "")
        menu.addItem(withTitle: "Restart TV", action: #selector(restartTv), keyEquivalent: "")
        return menu
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let server, server.isRunning else { return .terminateNow }
        quitting = true
        statusLine.title = "Stopping…"
        server.stop { NSApp.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }

    // MARK: - Menus

    private func buildMainMenu() -> NSMenu {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About TV Stream", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Show Remote QR Code…", action: #selector(showQRCode), keyEquivalent: "r")
        appMenu.addItem(withTitle: "Restart TV", action: #selector(restartTv), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide TV Stream", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit TV Stream", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        // Standard window menu so Cmd+W closes the QR window.
        let windowItem = NSMenuItem()
        main.addItem(windowItem)
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        return main
    }

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            let image = NSImage(systemSymbolName: "tv", accessibilityDescription: "TV Stream")
            image?.isTemplate = true
            button.image = image
        }
        let menu = NSMenu()
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        lidLine.isEnabled = false
        menu.addItem(lidLine)
        lidEnableItem = NSMenuItem(title: "Keep Awake With Lid Closed…", action: #selector(enableLidMode), keyEquivalent: "")
        lidEnableItem.isHidden = true
        menu.addItem(lidEnableItem)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Show Remote QR Code…", action: #selector(showQRCode), keyEquivalent: "")
        menu.addItem(withTitle: "Restart TV", action: #selector(restartTv), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit TV Stream", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        statusItem.menu = menu
    }

    private func render(_ state: ServerProcess.State) {
        guard !quitting else { return }
        switch state {
        case .starting: statusLine.title = "Starting…"
        case .running: statusLine.title = "Running"
        case .stopped: statusLine.title = "Stopped"
        case .failed(let message):
            statusLine.title = "Not running"
            showAlert(title: "TV Stream could not start", message: message)
        }
    }

    private func renderLid(_ state: LidSleepGuard.State) {
        switch state {
        case .active: lidLine.title = "Lid closed: stays awake"
        case .off, .declined: lidLine.title = "Lid closed: sleeps on battery"
        case .failed: lidLine.title = "Lid closed: could not keep awake"
        }
        lidEnableItem.isHidden = state == .active
    }

    // MARK: - Actions

    @objc private func enableLidMode() {
        lidGuard.onStateChange = { [weak self] state in self?.renderLid(state) }
        NSApp.activate(ignoringOtherApps: true)
        lidGuard.enable()
        renderLid(lidGuard.state)
    }

    @objc private func showQRCode() {
        if qrWindow == nil { qrWindow = RemoteQRWindowController() }
        qrWindow?.present()
    }

    @objc private func restartTv() {
        server.restart()
    }

    private func bringTvToFront() {
        let pgrep = Process()
        pgrep.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        pgrep.arguments = ["-f", "--", "--user-data-dir=\(Self.profileDir)"]
        let pipe = Pipe()
        pgrep.standardOutput = pipe
        guard (try? pgrep.run()) != nil else { return }
        pgrep.waitUntilExit()
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let chrome = output.split(separator: "\n")
            .compactMap { pid_t($0.trimmingCharacters(in: .whitespaces)) }
            .compactMap { NSRunningApplication(processIdentifier: $0) }
            .first { $0.bundleIdentifier == "com.google.Chrome" }
        chrome?.activate()
    }

    private func alreadyRunning() {
        statusLine.title = "Already running elsewhere"
        showAlert(
            title: "TV Stream is already running",
            message: "A TV Stream server is already active, probably started with npm start in a terminal. Stop it there (Ctrl+C), then open the app again."
        )
        NSApp.terminate(nil)
    }

    private func showAlert(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
}
