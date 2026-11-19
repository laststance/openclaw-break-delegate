import AppKit
import Foundation
import UserNotifications

@main
enum SurfaceChecks {
    static func main() throws {
        // Arrange — all questions, choices and dates are synthetic.
        let start = Date(timeIntervalSince1970: 1_000)
        let review = BreakReview(answered: [
            .init(question: "Where should the parser regression test live?",
                  answer: "Add it to the existing parser test suite."),
            .init(question: "How should a missing display name appear?",
                  answer: "Use the account handle as the fallback.")
        ], held: [
            .init(question: "May I deploy the patch to production?",
                  reason: "Execution approval needs your decision."),
            .init(question: "Should the export include archived workspaces?",
                  reason: "There are too few comparable answers in this repository."),
            .init(question: "Should this migration run during business hours?",
                  reason: "Scheduling has conflicting examples in the current repository."),
            .init(question: "What should happen to the old audit entries?",
                  reason: "The available choices do not match a verified preference."),
            .init(question: "May I rotate the production signing key?",
                  reason: "Credential changes need the owner's approval."),
            .init(question: "Should the public changelog mention this migration?",
                  reason: "The current repository has too few comparable publication decisions.")
        ], answeredTotal: 2, heldTotal: 6)
        let profile = NotificationProfile(key: String(repeating: "a", count: 64))!
        let secondProfile = NotificationProfile(key: String(repeating: "b", count: 64))!
        let invitation = GatewayCommand(request: 1, kind: .invite, id: "invite-one", endsAt: nil, review: nil)
        let offer = Surface(command: invitation, profile: profile)!
        let restored = Surface(command: invitation, profile: profile)!
        let otherOffer = Surface(command: invitation, profile: secondProfile)!
        let active = Surface(command: .init(request: 2, kind: .active, id: "break-one", endsAt: 1_900_000, review: nil), profile: profile)!
        let digest = Surface(command: .init(request: 3, kind: .summary, id: "break-one", endsAt: nil, review: review), profile: profile)!

        // Act — use real Apple request/category objects without opening a notification center.
        let request = offer.notification
        let category = offer.kind.category
        func select(_ surface: Surface, _ action: String, at date: Date = start) -> Selection? {
            let request = surface.notification
            guard let choice = surface.notificationChoice(request: request.identifier, category: request.content.categoryIdentifier,
                                                          action: action, subject: request.content.userInfo["subject"] as? String) else { return nil }
            return surface.selection(choice, now: date)
        }

        // Assert — consent requires a current explicit action, including after a gateway restart.
        precondition(request.content.categoryIdentifier == category.identifier)
        precondition(category.actions.map(\.title) == ["Take a 15-minute break and delegate", "Remind me in 15 minutes", "Dismiss"])
        precondition(category.options.contains(.customDismissAction))
        precondition(select(offer, category.actions[0].identifier) == .send(.start))
        precondition(select(offer, category.actions[1].identifier) == .send(.snooze))
        precondition(select(offer, category.actions[2].identifier) == .send(.dismiss))
        precondition(select(offer, UNNotificationDismissActionIdentifier) == .send(.dismiss))
        precondition(select(offer, UNNotificationDefaultActionIdentifier) == .showMenu)
        precondition(restored.selection(offer.menuChoice(.start), now: start) == nil)
        precondition(offer.selection(NativeChoice(request: request.identifier, category: category.identifier,
                                                  action: category.actions[0].identifier, subject: "other"), now: start) == nil)
        precondition(select(active, UNNotificationDismissActionIdentifier) == nil)
        precondition(select(active, Button.back.actionID) == .send(.back))
        precondition(select(active, Button.back.actionID, at: Date(timeIntervalSince1970: 1_900)) == nil)
        precondition(select(digest, UNNotificationDefaultActionIdentifier) == .readReview)
        precondition(select(digest, Button.review.actionID) == .readReview)
        let restoredDigest = Surface(command: .init(request: 7, kind: .summary, id: "break-one", endsAt: nil, review: review), profile: profile)!
        let otherDigest = Surface(command: .init(request: 8, kind: .summary, id: "break-two", endsAt: nil, review: review), profile: profile)!
        precondition(restoredDigest.notification.identifier == digest.notification.identifier)
        precondition(restoredDigest.requestID != digest.requestID)
        precondition(otherDigest.notification.identifier != digest.notification.identifier)
        precondition(profile.owns(digest.notificationID) && !secondProfile.owns(digest.notificationID))
        precondition(profile.isSummary(digest.notificationID) && !profile.isSummary(offer.notificationID))
        precondition(!secondProfile.isSummary(digest.notificationID))
        let receiptsDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: receiptsDirectory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: receiptsDirectory) }
        let receipts = SummaryBannerReceipts(directory: receiptsDirectory)
        precondition(!receipts.contains(digest.notificationID))
        receipts.accept(digest.notificationID)
        let restarted = SummaryBannerReceipts(directory: receiptsDirectory)
        precondition(restarted.contains(restoredDigest.notificationID) && !restarted.contains(otherDigest.notificationID))
        let recoveredSnapshot = SummaryBannerReceipts(directory: nil)
        recoveredSnapshot.observe([digest.notificationID])
        precondition(recoveredSnapshot.contains(restoredDigest.notificationID))
        precondition(digest.notification.content.body == "2 answered · 6 held. Open the review to read them.")
        precondition(digest.notification.content.userInfo.count == 1)
        precondition(digest.notification.content.userInfo["subject"] as? String == "break-one")
        precondition(Surface(command: .init(request: 4, kind: .invite, id: "", endsAt: nil, review: nil), profile: profile) == nil)

        // Every profile registers all three categories, independent of its surface or subject.
        let registered = Set(BreakCategory.all.map(\.identifier))
        precondition(registered == ["break-delegate.category.invitation", "break-delegate.category.active", "break-delegate.category.summary"])
        precondition(otherOffer.notification.content.categoryIdentifier == request.content.categoryIdentifier)
        precondition(otherOffer.kind.category.actions.map(\.identifier) == category.actions.map(\.identifier))
        precondition(registered.contains(active.notification.content.categoryIdentifier))
        precondition(registered.contains(digest.notification.content.categoryIdentifier))

        // A second profile can use the same subject yet cannot consume its peer's banner or stale menu item.
        precondition(offer.selection(otherOffer.menuChoice(.start), now: start) == nil)
        precondition(otherOffer.selection(offer.menuChoice(.start), now: start) == nil)
        precondition(otherOffer.selection(otherOffer.menuChoice(.start), now: start) == .send(.start))
        let unscoped = "break-delegate.00000000-0000-0000-0000-000000000001"
        let sharedStore = [offer.requestID, otherOffer.requestID, restored.requestID, unscoped]
        precondition(profile.orphanedIDs(in: sharedStore, keeping: restored.requestID) == [offer.requestID])
        precondition(secondProfile.orphanedIDs(in: sharedStore, keeping: otherOffer.requestID).isEmpty)
        precondition(secondProfile.orphanedIDs(in: sharedStore, keeping: nil) == [otherOffer.requestID])
        precondition(NotificationProfile(key: "") == nil)
        precondition(NotificationProfile(key: String(repeating: "z", count: 64)) == nil)

        // Late delivery confirmation revises the original review without issuing another presentation ID.
        let settled = BreakReview(answered: [.init(question: "Which option?", answer: "First")], held: [],
                                  answeredTotal: 1, heldTotal: 0)
        let update = GatewayCommand(request: 5, kind: .refreshSummary, id: "break-one", endsAt: nil, review: settled)
        var returned = ReturnedReview(id: "break-one", review: review)
        precondition(returned.refresh(from: update))
        precondition(returned.review.answered.first?.answer == "First")
        var displayed = digest
        displayed.refresh(returned)
        precondition(displayed.requestID == digest.requestID)
        precondition(displayed.notification.content.body == "1 answered · 0 held. Open the review to read them.")
        var nextBreak = active
        nextBreak.refresh(returned)
        precondition(nextBreak.kind == .active && nextBreak.requestID == active.requestID)
        var newerReview = ReturnedReview(id: "break-two", review: review)
        precondition(!newerReview.refresh(from: update))
        precondition(newerReview.review.heldTotal == 6)

        // KERN_PROCARGS2 stores argv and environment separately. Only whole CLI switches control mode.
        func arguments(_ executable: String, _ argv: [String]) -> [UInt8] {
            var count = Int32(argv.count)
            var bytes = withUnsafeBytes(of: &count) { Array($0) }
            bytes += Array(executable.utf8) + [0, 0, 0]
            for arg in argv { bytes += Array(arg.utf8) + [0] }
            return bytes + Array("--print".utf8) + [0]
        }
        let binary = "/Users/demo/.local/share/claude/versions/2.1.328"
        precondition(classifyClaudeArguments(arguments(binary, ["claude", "Explain how --print works"])) == .interactive)
        precondition(classifyClaudeArguments(arguments(binary, ["claude", "--print", "any question"])) == .headless)
        precondition(classifyClaudeArguments(arguments(binary, ["claude", "--", "--print"])) == .interactive)
        let cli = "/tmp/node_modules/@anthropic-ai/claude-code/cli.js"
        precondition(classifyClaudeArguments(arguments("/usr/local/bin/node", ["node", cli, "Explain how -p works"])) == .interactive)
        precondition(classifyClaudeArguments(arguments("/usr/local/bin/node", ["node", cli, "--output-format=json"])) == .headless)
        precondition(classifyClaudeArguments(arguments("/usr/local/bin/node", ["custom-label", "--no-warnings", cli])) == .interactive)
        precondition(classifyClaudeArguments(arguments("/usr/local/bin/node", ["node", "-r", "/tmp/loader", "--", cli, "--print"])) == .headless)
        precondition(classifyClaudeArguments(arguments("/usr/local/bin/node", ["node", "--require=" + cli, "/tmp/other.js"])) == .unrelated)
        precondition(classifyClaudeArguments(arguments("/usr/local/bin/node", ["node", "--require", cli, "/tmp/other.js"])) == .unrelated)
        precondition(classifyClaudeArguments(arguments("/usr/local/bin/node", ["node", "--eval=x", cli])) == .unrelated)
        precondition(classifyClaudeArguments(arguments("/usr/local/bin/node", ["node", "/tmp/tool.js", cli, "--print"])) == .unrelated)
        precondition(classifyClaudeArguments([2, 0, 0, 0]) == .unknown)

        if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--render-review" {
            try captureReview(review, directory: URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true))
        }
        print("Native invitation, snooze, dismissal, early return, review and stale response checks passed.")
    }

    /// Renders the real review view into local bitmap frames. No window is ordered onscreen.
    static func captureReview(_ review: BreakReview, directory: URL) throws {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        app.appearance = NSAppearance(named: .aqua)
        let window = makeReviewWindow(review)
        let scroll = window.contentView as! NSScrollView
        let text = scroll.documentView as! NSTextView
        let frame = scroll.superview!
        let distance = max(0, text.bounds.height - scroll.contentView.bounds.height)
        precondition(distance > 0 && !window.isVisible, "Document \(text.bounds.size), clip \(scroll.contentView.bounds.size), visible \(window.isVisible)")
        let frames = directory.appendingPathComponent("frames", isDirectory: true)
        try FileManager.default.createDirectory(at: frames, withIntermediateDirectories: true)
        for i in 0..<72 {
            // Scroll the real AppKit clip view, pausing at both ends for the exported video.
            let fraction = max(0, min(1, Double(i - 18) / 36))
            let progress = fraction * fraction * (3 - 2 * fraction)
            scroll.contentView.scroll(to: NSPoint(x: 0, y: progress * distance))
            scroll.reflectScrolledClipView(scroll.contentView)
            frame.layoutSubtreeIfNeeded()
            let image = frame.bitmapImageRepForCachingDisplay(in: frame.bounds)!
            frame.cacheDisplay(in: frame.bounds, to: image)
            let png = image.representation(using: .png, properties: [:])!
            try png.write(to: frames.appendingPathComponent(String(format: "review-%03d.png", i)))
            if i == 0 { try png.write(to: directory.appendingPathComponent("return-review.png")) }
        }
        precondition(!window.isVisible)
    }
}
