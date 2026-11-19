import AppKit
import CoreGraphics
import CoreServices
import Foundation

/// Writes one bounded JSON record to the gateway's inherited stdout pipe.
func writeFrame(_ message: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: message) else { return }
    data.append(10)
    FileHandle.standardOutput.write(data)
}

// A notification delivered after gateway shutdown may relaunch the bundle without its pipe.
// Ignore that launch before registering delegates, showing a window or handling any action.
let arguments = CommandLine.arguments
if arguments.count >= 2, arguments[1] == "--classify-claude-process" {
    let kind = arguments.count == 3 ? Int32(arguments[2]).map(classifyClaudeProcess) : nil
    print((kind ?? .unknown).rawValue)
    exit(0)
}
guard arguments.count == 3, arguments[1] == "--bridge",
      let profile = NotificationProfile(key: arguments[2]) else { exit(0) }
guard Bundle.main.bundleIdentifier == "io.laststance.openclaw-break-delegate",
      let session = CGSessionCopyCurrentDictionary() as? [String: Any],
      let uid = session[kCGSessionUserIDKey as String] as? NSNumber, uid.uint32Value == getuid(),
      session[kCGSessionLoginDoneKey as String] as? Bool == true else {
    writeFrame(["type": "offline", "detail": "Run the packaged helper from the gateway in your logged-in macOS desktop session."])
    exit(69)
}

// Directly spawning the signed bundled executable preserves the private inherited pipes.
// Register its bundle for Notification Center before constructing the notification center.
guard LSRegisterURL(Bundle.main.bundleURL as CFURL, true) == noErr else {
    writeFrame(["type": "offline", "detail": "Launch Services could not register the Break Delegate app bundle."])
    exit(69)
}
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let delegate = BreakApp(profile: profile)
application.delegate = delegate
application.run()
