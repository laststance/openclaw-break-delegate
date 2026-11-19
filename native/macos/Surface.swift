import Foundation
import UserNotifications

enum CommandKind: String, Decodable {
    case status, authorize, invite, active, summary, clear
}

struct GatewayCommand: Decodable {
    let request: Int
    let kind: CommandKind
    let id: String?
    let endsAt: Double?
    let review: BreakReview?
}

struct BreakReview: Decodable {
    struct Answered: Decodable { let question, answer: String }
    struct Held: Decodable { let question, reason: String }
    let answered: [Answered]
    let held: [Held]
    let answeredTotal, heldTotal: Int

}

enum Button: String, CaseIterable {
    case start, snooze, dismiss, back = "return", review

    var title: String {
        switch self {
        case .start: return "Take a 15-minute break and delegate"
        case .snooze: return "Remind me in 15 minutes"
        case .dismiss: return "Dismiss"
        case .back: return "I'm back"
        case .review: return "Read break review"
        }
    }
}

enum Selection: Equatable {
    case send(Button), showMenu, readReview
}

/// Correlates a single gateway presentation with Apple's request, menu and response identifiers.
/// Each fresh presentation has its own token, including when a gateway restores the same subject.
struct Surface {
    enum Content {
        case invitation
        case active(until: Date)
        case summary(BreakReview)
    }

    let subject: String
    let content: Content
    let token: String

    init?(command: GatewayCommand) {
        guard let id = command.id, !id.isEmpty, id.utf8.count <= 128,
              id.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
        subject = id
        token = UUID().uuidString
        switch command.kind {
        case .invite: content = .invitation
        case .active:
            guard let ms = command.endsAt, ms.isFinite, ms > 0, ms <= 8.64e15 else { return nil }
            content = .active(until: Date(timeIntervalSince1970: ms / 1000))
        case .summary:
            guard let review = command.review,
                  review.answered.count <= 40, review.held.count <= 40,
                  review.answeredTotal >= review.answered.count,
                  review.heldTotal >= review.held.count else { return nil }
            content = .summary(review)
        default: return nil
        }
    }

    var requestID: String { "break-delegate.\(token)" }
    var categoryID: String { "\(requestID).category" }
    func identifier(for button: Button) -> String { "\(requestID).\(button.rawValue)" }

    var buttons: [Button] {
        switch content {
        case .invitation: return [.start, .snooze, .dismiss]
        case .active: return [.back]
        case .summary: return [.review]
        }
    }

    /// Builds Apple's category each time the gateway replaces the current presentation.
    var category: UNNotificationCategory {
        let actions = buttons.map { button in
            let options: UNNotificationActionOptions = button == .review
                ? [.foreground, .authenticationRequired] : [.authenticationRequired]
            return UNNotificationAction(identifier: identifier(for: button), title: button.title, options: options)
        }
        let options: UNNotificationCategoryOptions
        if case .invitation = content { options = [.customDismissAction] } else { options = [] }
        return UNNotificationCategory(identifier: categoryID, actions: actions, intentIdentifiers: [], options: options)
    }

    /// Supplies the actual operating-system request. Only counts appear in a return banner.
    var notification: UNNotificationRequest {
        let message = UNMutableNotificationContent()
        message.categoryIdentifier = categoryID
        message.userInfo = ["subject": subject]
        switch content {
        case .invitation:
            message.title = "Time for a break?"
            message.body = "Take 15 minutes off while OpenClaw handles eligible questions in your current Claude Code sessions."
        case .active(let end):
            let time = DateFormatter.localizedString(from: end, dateStyle: .none, timeStyle: .short)
            message.title = "Your break is underway"
            message.body = "Delegation ends at \(time). Choose “I'm back” here or in the Break Delegate menu to return early."
        case .summary(let review):
            message.title = "Your break review is ready"
            message.body = "\(review.answeredTotal) answered · \(review.heldTotal) held. Open the review to read them."
        }
        return UNNotificationRequest(identifier: requestID, content: message, trigger: nil)
    }

    /// Checks the envelope and action before forwarding a banner or status-menu response.
    func selection(request: String, category: String, subject: String?, action: String, now: Date) -> Selection? {
        guard request == requestID, category == categoryID, subject == self.subject else { return nil }
        if case .active(let end) = content, end <= now { return nil }
        if action == UNNotificationDefaultActionIdentifier {
            if case .summary = content { return .readReview }
            return .showMenu
        }
        if action == UNNotificationDismissActionIdentifier {
            if case .invitation = content { return .send(.dismiss) }
            return nil
        }
        guard let button = buttons.first(where: { identifier(for: $0) == action }) else { return nil }
        return button == .review ? .readReview : .send(button)
    }
}
