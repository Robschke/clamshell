// Purpose: Entry point of the Clamshell Mac app.
// Depends on: macos/Sources/AppDelegate.swift
// Used by: macos/build-app.sh (compiled into Clamshell.app/Contents/MacOS/Clamshell)

import AppKit

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
