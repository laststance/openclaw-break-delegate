import Foundation
import CryptoKit
import UserNotifications

enum CommandKind: String, Decodable {
    case status, authorize, invite, active, summary, refreshSummary, clear
}

struct GatewayCommand: Decodable {
    let request: Int
    let kind: CommandKind
    let id: String?
    let endsAt: Double?
    let review: BreakReview?
    var silent: Bool? = nil
}

struct BreakReview: Decodable {
    struct Answered: Decodable { let question, answer: String }
    struct Held: Decodable { let question, reason: String }
    let answered: [Answered]
    let held: [Held]
    let answeredTotal, heldTotal: Int

    var isValid: Bool {
        answered.count <= 40 && held.count <= 40 && answeredTotal >= answered.count && heldTotal >= held.count
    }
}

/// Associates private review contents with the break whose receipts may still settle.
struct ReturnedReview {
    let id: String
    private(set) var review: BreakReview

    mutating func refresh(from command: GatewayCommand) -> Bool {
        guard command.kind == .refreshSummary, command.id == id,
              let updated = command.review, updated.isValid else { return false }
        review = updated
        return true
    }
}

/// Scopes the application-wide Notification Center request store to one gateway data directory.
struct NotificationProfile {
    private let prefix: String

    init?(key: String) {
        guard key.utf8.count == 64, key.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { return nil }
        prefix = "break-delegate.\(key)."
    }

    func identifier(for token: UUID) -> String { prefix + token.uuidString }

    func summaryIdentifier(_ subject: String) -> String {
        prefix + "summary." + SHA256.hash(data: Data(subject.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    func owns(_ id: String) -> Bool {
        guard id.hasPrefix(prefix) else { return false }
        let suffix = id.dropFirst(prefix.count)
        if suffix.hasPrefix("summary.") {
            let hash = suffix.dropFirst("summary.".count)
            return hash.utf8.count == 64 && hash.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
        }
        return UUID(uuidString: String(suffix)) != nil
    }

    func isSummary(_ id: String) -> Bool { id.hasPrefix(prefix + "summary.") && owns(id) }

    /// Select only this profile's obsolete requests, even if a new surface appeared during enumeration.
    func orphanedIDs(in ids: [String], keeping current: String?) -> [String] {
        ids.filter { $0 != current && owns($0) }
    }
}

/// Remember the latest accepted banner across helper restarts, even when its pipe receipt was lost.
final class SummaryBannerReceipts {
    private let file: URL?
    private var observed = Set<String>()

    init(directory: URL?) {
        file = directory?.appendingPathComponent("last-summary-banner")
        if let file, let handle = try? FileHandle(forReadingFrom: file) {
            defer { try? handle.close() }
            if let data = try? handle.read(upToCount: 256), data.count < 256, let previous = String(data: data, encoding: .utf8) {
                observed.insert(previous)
            }
        }
    }

    func observe(_ snapshot: [String]) { observed.formUnion(snapshot) }
    func contains(_ id: String) -> Bool { observed.contains(id) }

    func accept(_ id: String) {
        observed = [id]
        if let file { try? Data(id.utf8).write(to: file, options: .atomic) }
    }
}

enum Button: String, CaseIterable {
    case start, snooze, dismiss, back = "return", review

    var actionID: String { "break-delegate.action.\(rawValue)" }

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

/// Every helper registers this identical, permanent category set for the shared app bundle.
enum BreakCategory: String, CaseIterable {
    case invitation, active, summary

    var id: String { "break-delegate.category.\(rawValue)" }

    var buttons: [Button] {
        switch self {
        case .invitation: return [.start, .snooze, .dismiss]
        case .active: return [.back]
        case .summary: return [.review]
        }
    }

    var category: UNNotificationCategory {
        let actions = buttons.map { button in
            let options: UNNotificationActionOptions = button == .review
                ? [.foreground, .authenticationRequired] : [.authenticationRequired]
            return UNNotificationAction(identifier: button.actionID, title: button.title, options: options)
        }
        return UNNotificationCategory(identifier: id, actions: actions, intentIdentifiers: [],
                                      options: self == .invitation ? [.customDismissAction] : [])
    }

    static var all: Set<UNNotificationCategory> { Set(allCases.map(\.category)) }
}

enum Selection: Equatable {
    case send(Button), showMenu, readReview
}

/// Retains the request and subject that were present when a banner or native menu item was created.
struct NativeChoice {
    let request, category, action: String
    let subject: String?
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
    private(set) var content: Content
    let requestID: String
    let notificationID: String

    init?(command: GatewayCommand, profile: NotificationProfile) {
        guard let id = command.id, !id.isEmpty, id.utf8.count <= 128,
              id.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
        subject = id
        requestID = profile.identifier(for: UUID())
        notificationID = command.kind == .summary ? profile.summaryIdentifier(id) : requestID
        switch command.kind {
        case .invite: content = .invitation
        case .active:
            guard let ms = command.endsAt, ms.isFinite, ms > 0, ms <= 8.64e15 else { return nil }
            content = .active(until: Date(timeIntervalSince1970: ms / 1000))
        case .summary:
            guard let review = command.review, review.isValid else { return nil }
            content = .summary(review)
        default: return nil
        }
    }

    var kind: BreakCategory {
        switch content {
        case .invitation: return .invitation
        case .active: return .active
        case .summary: return .summary
        }
    }

    func menuChoice(_ button: Button) -> NativeChoice {
        NativeChoice(request: requestID, category: kind.id, action: button.actionID, subject: subject)
    }

    /// Match the operating-system request before checking the current subject and its allowed actions.
    func notificationChoice(request: String, category: String, action: String, subject: String?) -> NativeChoice? {
        guard request == notificationID else { return nil }
        return NativeChoice(request: requestID, category: category, action: action, subject: subject)
    }

    mutating func refresh(_ returned: ReturnedReview) {
        if kind == .summary, subject == returned.id { content = .summary(returned.review) }
    }

    /// Supplies the actual operating-system request. Only counts appear in a return banner.
    var notification: UNNotificationRequest {
        let message = UNMutableNotificationContent()
        message.categoryIdentifier = kind.id
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
        return UNNotificationRequest(identifier: notificationID, content: message, trigger: nil)
    }

    /// Checks the envelope and action before forwarding a banner or status-menu response.
    func selection(_ choice: NativeChoice, now: Date) -> Selection? {
        guard choice.request == requestID, choice.category == kind.id, choice.subject == subject else { return nil }
        if case .active(let end) = content, end <= now { return nil }
        if choice.action == UNNotificationDefaultActionIdentifier {
            if case .summary = content { return .readReview }
            return .showMenu
        }
        if choice.action == UNNotificationDismissActionIdentifier {
            if case .invitation = content { return .send(.dismiss) }
            return nil
        }
        guard let button = kind.buttons.first(where: { $0.actionID == choice.action }) else { return nil }
        return button == .review ? .readReview : .send(button)
    }
}
