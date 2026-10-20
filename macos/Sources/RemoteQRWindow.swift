// Purpose: Small window with the remote's QR code and links, to pair a phone from the Mac.
// Depends on: GET /api/info on the local server (remoteUrl, remoteUrlIp), CoreImage QR filter.
// Used by: macos/Sources/AppDelegate.swift ("Show Remote QR Code…")
// Notes:
// - The QR is generated natively from remoteUrl instead of rendering the server's SVG, so it is
//   crisp at any scale (nearest-neighbor upscaling of the module grid).

import AppKit
import CoreImage.CIFilterBuiltins

final class RemoteQRWindowController: NSWindowController {
    private let imageView = NSImageView()
    private let primaryLabel = NSTextField(labelWithString: "")
    private let secondaryLabel = NSTextField(labelWithString: "")
    private let captionLabel = NSTextField(labelWithString: "Scan to use your phone as remote")

    init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 440),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "TV Stream Remote"
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        super.init(window: window)
        buildContent()
    }

    required init?(coder: NSCoder) { nil }

    func present() {
        refresh()
        window?.center()
        NSApp.activate(ignoringOtherApps: true)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
    }

    private func buildContent() {
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.wantsLayer = true
        imageView.layer?.cornerRadius = 12
        imageView.layer?.masksToBounds = true
        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageView.widthAnchor.constraint(equalToConstant: 260).isActive = true
        imageView.heightAnchor.constraint(equalToConstant: 260).isActive = true

        captionLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        primaryLabel.font = .systemFont(ofSize: 13)
        primaryLabel.isSelectable = true
        secondaryLabel.font = .systemFont(ofSize: 12)
        secondaryLabel.textColor = .secondaryLabelColor
        secondaryLabel.isSelectable = true

        let stack = NSStackView(views: [imageView, captionLabel, primaryLabel, secondaryLabel])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 28, left: 24, bottom: 28, right: 24)
        stack.setCustomSpacing(18, after: imageView)
        window?.contentView = stack
    }

    private func refresh() {
        primaryLabel.stringValue = "Loading…"
        secondaryLabel.stringValue = ""
        imageView.image = nil
        guard let url = URL(string: "http://127.0.0.1:\(ServerProcess.port)/api/info") else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            let info = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async { self?.show(info: info) }
        }.resume()
    }

    private func show(info: [String: Any]?) {
        guard let remoteUrl = info?["remoteUrl"] as? String else {
            primaryLabel.stringValue = "TV Stream is not running."
            return
        }
        primaryLabel.stringValue = remoteUrl
        secondaryLabel.stringValue = (info?["remoteUrlIp"] as? String) ?? ""
        imageView.image = Self.qrImage(for: remoteUrl)
    }

    private static func qrImage(for text: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        // Quiet zone of 2 modules, then scale the module grid up without smoothing.
        let padded = output
            .transformed(by: CGAffineTransform(translationX: 2, y: 2))
            .composited(over: CIImage(color: .white).cropped(to: output.extent.insetBy(dx: -2, dy: -2).offsetBy(dx: 2, dy: 2)))
        let scaled = padded.samplingNearest().transformed(by: CGAffineTransform(scaleX: 12, y: 12))
        let rep = NSCIImageRep(ciImage: scaled)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }
}
