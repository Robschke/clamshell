// Purpose: Reads and selects sound outputs through Control Center's Sound panel, for outputs that
//          CoreAudio does not expose to other apps (AirPlay receivers, unconnected Bluetooth).
// Depends on: the Accessibility API (the responsible app, TV Stream, needs the Accessibility
//             permission), Control Center (com.apple.controlcenter) and its element identifiers.
// Used by: macos/AudioTool/main.swift ("wireless" and "select-cc" commands)
// Notes:
// - macOS keeps AirPlay routing to Apple's own processes; Control Center is the only place it can
//   be chosen, so this drives Control Center like a user would. It briefly appears on screen.
// - Elements are found by identifier, not by label, so it works in every system language:
//   "com.apple.menuextra.controlcenter" (menu bar item), "controlcenter-volume" (Sound tile),
//   "sound-device-<name>" (one checkbox per output, value 1 = active).
// - A device whose identifier also has a disclosure triangle is a Bluetooth device with options
//   (headphones); the others are reported as AirPlay. This is a heuristic for the label only.
// - Opening presses the menu bar item (it toggles, so the window is checked first). Closing sends
//   Escape, covered by the same Accessibility permission; see closeControlCenter.

import AppKit
import ApplicationServices

struct WirelessOutput: Encodable {
    let uid: String
    let name: String
    let kind: String
    let active: Bool
}

enum ControlCenterSound {
    private static let devicePrefix = "sound-device-"

    static func list() throws -> [WirelessOutput] {
        try withSoundPanel { devices in devices.map(\.output) }
    }

    static func select(name: String) throws -> [WirelessOutput] {
        try withSoundPanel { devices in
            guard let device = devices.first(where: { $0.output.name == name }) else {
                throw ToolError("\(name) is not available any more")
            }
            if !device.output.active {
                AXUIElementPerformAction(device.element, kAXPressAction as CFString)
                // Control Center updates the checkmarks after the route change starts.
                _ = waitFor(timeout: 2) { readDevices().contains { $0.output.name == name && $0.output.active } }
            }
            return readDevices().map(\.output)
        }
    }

    // MARK: - Panel handling

    private struct Device {
        let output: WirelessOutput
        let element: AXUIElement
    }

    /// Opens Control Center's Sound panel, runs the body with its devices and closes it again.
    private static func withSoundPanel<T>(_ body: ([Device]) throws -> T) throws -> T {
        guard AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary) else {
            throw ToolError("Allow TV Stream under System Settings > Privacy & Security > Accessibility, then try again.")
        }
        guard let app = controlCenter(), let menuItem = controlCenterMenuItem(app) else {
            throw ToolError("Control Center is not available")
        }
        // Opening Control Center from its menu bar item reveals the menu bar over the fullscreen TV
        // window, and it stays visible after closing until the app in front takes the screen back.
        let previousApp = NSWorkspace.shared.frontmostApplication
        guard openControlCenter(app, menuItem) else {
            throw ToolError("Control Center did not open, please try again")
        }
        defer {
            closeControlCenter(app, menuItem)
            restoreFront(previousApp)
        }

        // The tile is in the accessibility tree before Control Center finishes opening, and a press
        // during that animation is ignored, so wait for it to settle and press again if needed.
        Thread.sleep(forTimeInterval: openSettleDelay)
        for _ in 0..<3 {
            guard let soundTile = waitForElement(timeout: 1, in: app, where: { identifier($0) == "controlcenter-volume" && role($0) == kAXButtonRole }) else {
                break
            }
            AXUIElementPerformAction(soundTile, kAXPressAction as CFString)
            if waitFor(timeout: 1.5, { !readDevices(in: app).isEmpty }) {
                return try body(readDevices(in: app))
            }
        }
        if !readDevices(in: app).isEmpty { return try body(readDevices(in: app)) }
        throw ToolError("Control Center did not show the sound outputs, please try again")
    }

    private static let openSettleDelay: TimeInterval = 0.8

    private static func isOpen(_ app: AXUIElement) -> Bool {
        !(attribute(app, kAXWindowsAttribute) as? [AnyObject] ?? []).isEmpty
    }

    /// Presses the menu bar item until Control Center shows a window; a press right after it
    /// closed can be swallowed.
    private static func openControlCenter(_ app: AXUIElement, _ menuItem: AXUIElement) -> Bool {
        if isOpen(app) { return true }
        for _ in 0..<2 {
            AXUIElementPerformAction(menuItem, kAXPressAction as CFString)
            if waitFor(timeout: 1.2, { isOpen(app) }) { return true }
        }
        return false
    }

    /// Closes with Escape, like a user would: pressing the menu bar item while the Sound panel is
    /// shown can leave Control Center half open at the screen edge. Escape is only sent while
    /// Control Center is open, so it never reaches the TV page (where it would exit fullscreen).
    /// The menu bar item is the fallback.
    private static func closeControlCenter(_ app: AXUIElement, _ menuItem: AXUIElement) {
        guard isOpen(app) else { return }
        postEscape()
        if waitFor(timeout: 1, { !isOpen(app) }) { return }
        AXUIElementPerformAction(menuItem, kAXPressAction as CFString)
        _ = waitFor(timeout: 1) { !isOpen(app) }
    }

    /// Gives the screen back to the app that was in front (normally the fullscreen TV window), which
    /// hides the menu bar again.
    private static func restoreFront(_ previous: NSRunningApplication?) {
        guard let previous, !previous.isTerminated, previous.bundleIdentifier != "com.apple.controlcenter" else { return }
        previous.activate()
        _ = waitFor(timeout: 1) { NSWorkspace.shared.frontmostApplication?.processIdentifier == previous.processIdentifier }
    }

    private static func postEscape() {
        let escape: CGKeyCode = 53
        CGEvent(keyboardEventSource: nil, virtualKey: escape, keyDown: true)?.post(tap: .cghidEventTap)
        CGEvent(keyboardEventSource: nil, virtualKey: escape, keyDown: false)?.post(tap: .cghidEventTap)
    }

    private static func readDevices() -> [Device] {
        guard let app = controlCenter() else { return [] }
        return readDevices(in: app)
    }

    private static func readDevices(in app: AXUIElement) -> [Device] {
        let elements = descendants(of: app, depth: 10).filter { (identifier($0) ?? "").hasPrefix(devicePrefix) }
        let withOptions = Set(elements.filter { role($0) == kAXDisclosureTriangleRole }.compactMap(identifier))
        return elements.filter { role($0) == kAXCheckBoxRole }.compactMap { element in
            guard let id = identifier(element) else { return nil }
            let name = String(id.dropFirst(devicePrefix.count))
            let value = (attribute(element, kAXValueAttribute) as? NSNumber)?.intValue ?? 0
            let kind = withOptions.contains(id) ? "bluetooth" : "airplay"
            return Device(output: WirelessOutput(uid: "cc:" + name, name: name, kind: kind, active: value == 1), element: element)
        }
    }

    // MARK: - Accessibility helpers

    private static func controlCenter() -> AXUIElement? {
        guard let pid = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.controlcenter").first?.processIdentifier else {
            return nil
        }
        return AXUIElementCreateApplication(pid)
    }

    private static func controlCenterMenuItem(_ app: AXUIElement) -> AXUIElement? {
        for barAttribute in ["AXExtrasMenuBar", kAXMenuBarAttribute] {
            guard let bar = element(attribute(app, barAttribute)) else { continue }
            if let item = children(of: bar).first(where: { identifier($0) == "com.apple.menuextra.controlcenter" }) {
                return item
            }
        }
        return nil
    }

    private static func waitForElement(timeout: TimeInterval, in root: AXUIElement, where match: (AXUIElement) -> Bool) -> AXUIElement? {
        var found: AXUIElement?
        _ = waitFor(timeout: timeout) {
            found = descendants(of: root, depth: 10).first(where: match)
            return found != nil
        }
        return found
    }

    private static func waitFor(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.1)
        }
        return condition()
    }

    private static func descendants(of root: AXUIElement, depth: Int) -> [AXUIElement] {
        guard depth > 0 else { return [] }
        return children(of: root).flatMap { [$0] + descendants(of: $0, depth: depth - 1) }
    }

    private static func children(of element: AXUIElement) -> [AXUIElement] {
        (attribute(element, kAXChildrenAttribute) as? [AnyObject] ?? []).compactMap(Self.element)
    }

    private static func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }

    private static func element(_ value: AnyObject?) -> AXUIElement? {
        guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    private static func identifier(_ element: AXUIElement) -> String? {
        attribute(element, "AXIdentifier") as? String
    }

    private static func role(_ element: AXUIElement) -> String? {
        attribute(element, kAXRoleAttribute) as? String
    }
}
