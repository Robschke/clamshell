// Purpose: Entry point of the TV Stream Mac app.
// Depends on: macos/Sources/AppDelegate.swift
// Used by: macos/build-app.sh (compiled into TV Stream.app/Contents/MacOS/TVStream)

import AppKit

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
