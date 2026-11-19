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
        let invitation = GatewayCommand(request: 1, kind: .invite, id: "invite-one", endsAt: nil, review: nil)
        let offer = Surface(command: invitation)!
        let restored = Surface(command: invitation)!
        let active = Surface(command: .init(request: 2, kind: .active, id: "break-one", endsAt: 1_900_000, review: nil))!
        let digest = Surface(command: .init(request: 3, kind: .summary, id: "break-one", endsAt: nil, review: review))!

        // Act — use real Apple request/category objects without opening a notification center.
        let request = offer.notification
        let category = offer.category
        func select(_ surface: Surface, _ action: String, at date: Date = start) -> Selection? {
            surface.selection(request: surface.notification.identifier, category: surface.notification.content.categoryIdentifier,
                              subject: surface.notification.content.userInfo["subject"] as? String, action: action, now: date)
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
        precondition(select(restored, category.actions[0].identifier) == nil)
        precondition(offer.selection(request: request.identifier, category: category.identifier, subject: "other",
                                     action: category.actions[0].identifier, now: start) == nil)
        precondition(select(active, UNNotificationDismissActionIdentifier) == nil)
        precondition(select(active, active.identifier(for: .back)) == .send(.back))
        precondition(select(active, active.identifier(for: .back), at: Date(timeIntervalSince1970: 1_900)) == nil)
        precondition(select(digest, UNNotificationDefaultActionIdentifier) == .readReview)
        precondition(select(digest, digest.identifier(for: .review)) == .readReview)
        precondition(digest.notification.content.body == "2 answered · 6 held. Open the review to read them.")
        precondition(digest.notification.content.userInfo.count == 1)
        precondition(digest.notification.content.userInfo["subject"] as? String == "break-one")
        precondition(Surface(command: .init(request: 4, kind: .invite, id: "", endsAt: nil, review: nil)) == nil)

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
