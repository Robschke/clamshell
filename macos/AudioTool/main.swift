// Purpose: Command-line helper that lists the Mac's sound outputs and switches the system output,
//          for the sound settings on the phone remote.
// Depends on: CoreAudio (system audio devices), macos/AudioTool/ControlCenterSound.swift
//             (outputs only Control Center can choose, such as AirPlay receivers).
// Used by: src/server/audio-outputs.js (built to build/tv-audio by macos/build-app.sh)
// Notes:
// - Usage: "tv-audio list", "tv-audio select <device uid> [<data source id>]" (CoreAudio),
//   "tv-audio wireless" and "tv-audio select-cc <name>" (Control Center). Output is JSON on
//   stdout: { "outputs": [...] } or { "error": "..." } with exit code 1.
// - Devices are addressed by UID, which stays the same across reboots and replugging; numeric
//   device ids do not.
// - An AirPlay device that exposes its receivers as data sources is listed once per receiver.
// - Selecting sets both the default output and the system output (alerts), so all sound follows.

import CoreAudio
import Foundation

struct Output: Encodable {
    let uid: String
    let source: UInt32?
    let name: String
    let kind: String
    let active: Bool
}

let systemObject = AudioObjectID(kAudioObjectSystemObject)

func address(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func readValue<T: BitwiseCopyable>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, default fallback: T) -> T {
    var addr = address(selector, scope)
    var value = fallback
    var size = UInt32(MemoryLayout<T>.size)
    let status = AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value)
    return status == noErr ? value : fallback
}

func readArray<T: BitwiseCopyable>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope, of _: T.Type, zero: T) -> [T] {
    var addr = address(selector, scope)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(object, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
    var items = [T](repeating: zero, count: Int(size) / MemoryLayout<T>.size)
    guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &items) == noErr else { return [] }
    return items
}

func readString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String {
    var addr = address(selector)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr, let value else { return "" }
    return value.takeRetainedValue() as String
}

func sourceName(_ device: AudioObjectID, _ source: UInt32) -> String {
    var addr = address(kAudioDevicePropertyDataSourceNameForIDCFString, kAudioObjectPropertyScopeOutput)
    var input = source
    var name: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<AudioValueTranslation>.size)
    let status = withUnsafeMutablePointer(to: &input) { inputPtr in
        withUnsafeMutablePointer(to: &name) { namePtr in
            var translation = AudioValueTranslation(
                mInputData: inputPtr,
                mInputDataSize: UInt32(MemoryLayout<UInt32>.size),
                mOutputData: namePtr,
                mOutputDataSize: UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
            )
            return AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &translation)
        }
    }
    guard status == noErr, let name else { return "" }
    return name.takeRetainedValue() as String
}

func kind(of transport: UInt32) -> String {
    switch transport {
    case kAudioDeviceTransportTypeBuiltIn: return "builtin"
    case kAudioDeviceTransportTypeHDMI: return "hdmi"
    case kAudioDeviceTransportTypeDisplayPort: return "displayport"
    case kAudioDeviceTransportTypeAirPlay: return "airplay"
    case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: return "bluetooth"
    case kAudioDeviceTransportTypeUSB: return "usb"
    case kAudioDeviceTransportTypeVirtual, kAudioDeviceTransportTypeAggregate: return "virtual"
    default: return "other"
    }
}

func outputDevices() -> [AudioObjectID] {
    readArray(systemObject, kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal, of: AudioObjectID.self, zero: 0)
        .filter { !readArray($0, kAudioDevicePropertyStreams, kAudioObjectPropertyScopeOutput, of: AudioStreamID.self, zero: 0).isEmpty }
        .filter { readValue($0, kAudioDevicePropertyIsHidden, default: UInt32(0)) == 0 }
}

func listOutputs() -> [Output] {
    let current = readValue(systemObject, kAudioHardwarePropertyDefaultOutputDevice, default: AudioObjectID(0))
    var outputs: [Output] = []
    for device in outputDevices() {
        let uid = readString(device, kAudioDevicePropertyDeviceUID)
        let name = readString(device, kAudioObjectPropertyName)
        let transport = readValue(device, kAudioDevicePropertyTransportType, default: UInt32(0))
        let sources = readArray(device, kAudioDevicePropertyDataSources, kAudioObjectPropertyScopeOutput, of: UInt32.self, zero: 0)
        if transport == kAudioDeviceTransportTypeAirPlay && !sources.isEmpty {
            let currentSource = readValue(device, kAudioDevicePropertyDataSource, kAudioObjectPropertyScopeOutput, default: UInt32(0))
            for source in sources {
                let label = sourceName(device, source)
                outputs.append(Output(uid: uid, source: source, name: label.isEmpty ? name : label, kind: "airplay",
                                      active: device == current && source == currentSource))
            }
        } else {
            outputs.append(Output(uid: uid, source: nil, name: name, kind: kind(of: transport), active: device == current))
        }
    }
    return outputs
}

func select(uid: String, source: UInt32?) throws {
    guard let device = outputDevices().first(where: { readString($0, kAudioDevicePropertyDeviceUID) == uid }) else {
        throw ToolError("That sound output is not available any more")
    }
    if var source {
        var addr = address(kAudioDevicePropertyDataSource, kAudioObjectPropertyScopeOutput)
        let status = AudioObjectSetPropertyData(device, &addr, 0, nil, UInt32(MemoryLayout<UInt32>.size), &source)
        guard status == noErr else { throw ToolError("Could not select that AirPlay receiver (\(status))") }
    }
    for selector in [kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyDefaultSystemOutputDevice] {
        var addr = address(selector)
        var value = device
        let status = AudioObjectSetPropertyData(systemObject, &addr, 0, nil, UInt32(MemoryLayout<AudioObjectID>.size), &value)
        guard status == noErr else { throw ToolError("Could not switch the sound output (\(status))") }
    }
}

struct ToolError: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

func printJSON<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    if let data = try? encoder.encode(value), let text = String(data: data, encoding: .utf8) {
        print(text)
    }
}

struct OutputsReply: Encodable { let outputs: [Output] }
struct WirelessReply: Encodable { let outputs: [WirelessOutput] }
struct ErrorReply: Encodable { let error: String }

let args = Array(CommandLine.arguments.dropFirst())
do {
    switch args.first {
    case "list":
        printJSON(OutputsReply(outputs: listOutputs()))
    case "select" where args.count >= 2:
        let source = args.count >= 3 ? UInt32(args[2]) : nil
        try select(uid: args[1], source: source)
        // CoreAudio applies the change asynchronously; give it a moment before reading back.
        Thread.sleep(forTimeInterval: 0.2)
        printJSON(OutputsReply(outputs: listOutputs()))
    case "wireless":
        printJSON(WirelessReply(outputs: try ControlCenterSound.list()))
    case "select-cc" where args.count >= 2:
        printJSON(WirelessReply(outputs: try ControlCenterSound.select(name: args[1])))
    default:
        throw ToolError("Usage: tv-audio list | select <uid> [<source>] | wireless | select-cc <name>")
    }
} catch let error as ToolError {
    printJSON(ErrorReply(error: error.message))
    exit(1)
}
