import AppKit
import UserNotifications

struct NotificationStatus {
    let code: String
    let detail: String?

    init(_ code: String, _ detail: String? = nil) { self.code = code; self.detail = detail }
}

/// Holds the interactive surface for one gateway pipe. AppKit owns its main-thread lifecycle.
final class BreakApp: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()
    private let profile: NotificationProfile
    private let summaryReceipts: SummaryBannerReceipts
    private var summaryCallbacks: [String: [(NotificationStatus) -> Void]] = [:]
    private var recoveredSummaries = Set<String>()
    private var current: Surface?
    private var latestReview: ReturnedReview?
    private var statusItem: NSStatusItem?
    private var reviewWindow: NSWindow?
    private var windowReviewID: String?
    private var expiry: Timer?
    private var permission = NotificationStatus("not-determined")

    init(profile: NotificationProfile, directory: URL?) {
        self.profile = profile
        self.summaryReceipts = SummaryBannerReceipts(directory: directory)
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        center.delegate = self
        center.setNotificationCategories(BreakCategory.all)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Notification Center enumerates the entire bundle. Only this gateway may retire its prior requests.
        center.getPendingNotificationRequests { requests in
            self.center.getDeliveredNotifications { notifications in
                let snapshot = requests.map(\.identifier) + notifications.map(\.request.identifier)
                DispatchQueue.main.async {
                    // A prior helper may have submitted its banner just before it lost the acknowledgment pipe.
                    self.recoveredSummaries = Set(snapshot.filter(self.profile.isSummary))
                    self.summaryReceipts.observe(Array(self.recoveredSummaries))
                    // An already scheduled return banner must be allowed to deliver during reconnection.
                    let ids = self.profile.orphanedIDs(in: snapshot, keeping: self.current?.notificationID)
                        .filter { !self.recoveredSummaries.contains($0) }
                    if !ids.isEmpty {
                        // A request can move from pending to delivered between the two snapshots.
                        self.center.removePendingNotificationRequests(withIdentifiers: ids)
                        self.center.removeDeliveredNotifications(withIdentifiers: ids)
                    }
                    self.readGatewayCommands()
                }
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        removeCurrent()
    }

    private func readGatewayCommands() {
        DispatchQueue.global(qos: .userInitiated).async {
            var frame = Data()
            while true {
                let chunk = FileHandle.standardInput.availableData
                if chunk.isEmpty { break }
                for byte in chunk {
                    if byte == 10 {
                        guard let command = try? JSONDecoder().decode(GatewayCommand.self, from: frame),
                              command.request > 0 else { self.stopOnMain(); return }
                        DispatchQueue.main.sync { self.handle(command) }
                        frame.removeAll(keepingCapacity: true)
                    } else {
                        guard frame.count < 65_536 else { self.stopOnMain(); return }
                        frame.append(byte)
                    }
                }
            }
            // A closed pipe also covers a killed or restarted gateway.
            self.stopOnMain()
        }
    }

    private func stopOnMain() {
        DispatchQueue.main.async { NSApp.terminate(nil) }
    }

    private func handle(_ command: GatewayCommand) {
        switch command.kind {
        case .status:
            readPermission { self.reply(command.request, $0) }
        case .authorize:
            authorize { self.reply(command.request, $0) }
        case .clear:
            reconcileRecoveredSummaries(keeping: nil)
            removeCurrent()
            latestReview = nil
            windowReviewID = nil
            reviewWindow?.close()
            refreshMenu()
            readPermission { self.reply(command.request, $0) }
        case .refreshSummary:
            if latestReview?.refresh(from: command) == true, let latestReview {
                current?.refresh(latestReview)
                if windowReviewID == latestReview.id, let window = reviewWindow, window.isVisible {
                    _ = makeReviewWindow(latestReview.review, reusing: window, preservingScroll: true)
                }
            }
            // A receipt changes local review text. Leave banners, focus and later breaks alone.
            reply(command.request, permission)
        case .invite, .active, .summary:
            guard let surface = Surface(command: command, profile: profile) else {
                reply(command.request, NotificationStatus("unavailable", "Invalid native presentation."))
                return
            }
            reconcileRecoveredSummaries(keeping: surface.notificationID)
            removeCurrent(keeping: surface.notificationID)
            current = surface
            if case .summary(let review) = surface.content { latestReview = ReturnedReview(id: surface.subject, review: review) }
            if case .active(let end) = surface.content {
                guard end > Date() else {
                    removeCurrent()
                    refreshMenu()
                    reply(command.request, NotificationStatus("unavailable", "This break has already ended."))
                    return
                }
                let timer = Timer(fire: end, interval: 0, repeats: false) { [weak self] _ in
                    guard let self, self.current?.requestID == surface.requestID else { return }
                    self.removeCurrent()
                    self.refreshMenu()
                }
                RunLoop.main.add(timer, forMode: .common)
                expiry = timer
            }
            refreshMenu()
            if command.kind == .summary, command.silent == true {
                reply(command.request, permission)
                return
            }
            readPermission { permission in
                self.post(surface, permission: permission) { self.reply(command.request, $0) }
            }
        }
    }

    private func readPermission(_ done: @escaping (NotificationStatus) -> Void) {
        center.getNotificationSettings { settings in
            let result: NotificationStatus
            switch settings.authorizationStatus {
            case .notDetermined:
                result = NotificationStatus("not-determined", "Choose Enable Notifications in the Break Delegate menu.")
            case .denied:
                result = NotificationStatus("denied", "Allow Break Delegate in System Settings > Notifications.")
            case .authorized, .provisional:
                let quiet = settings.alertSetting != .enabled || settings.alertStyle == .none
                result = NotificationStatus("authorized", quiet ? "Banners are off. Check Notification Center or the Break Delegate menu." : nil)
            @unknown default:
                result = NotificationStatus("unavailable", "macOS reported an unknown authorization status.")
            }
            DispatchQueue.main.async {
                if self.permission.code != result.code { self.permission = result; self.refreshMenu() }
                done(result)
            }
        }
    }

    private func authorize(_ done: @escaping (NotificationStatus) -> Void) {
        readPermission { original in
            guard original.code == "not-determined" else { done(original); return }
            self.center.requestAuthorization(options: [.alert]) { _, error in
                DispatchQueue.main.async {
                    guard error == nil else {
                        done(NotificationStatus("unavailable", "macOS could not request notification authorization."))
                        return
                    }
                    self.readPermission { result in
                        if let current = self.current { self.post(current, permission: result, done: done) }
                        else { done(result) }
                    }
                }
            }
        }
    }

    private func post(_ surface: Surface, permission: NotificationStatus, done: @escaping (NotificationStatus) -> Void) {
        guard let current, current.requestID == surface.requestID, permission.code == "authorized" else { done(permission); return }
        let id = surface.notificationID
        if surface.kind == .summary {
            if summaryReceipts.contains(id) {
                // Notification Center can recover a submission from a helper that exited before saving its receipt.
                summaryReceipts.accept(id)
                done(permission)
                return
            }
            if summaryCallbacks[id] != nil { summaryCallbacks[id]?.append(done); return }
            summaryCallbacks[id] = [done]
        }
        center.add(current.notification) { error in
            DispatchQueue.main.async {
                // An authorization check or delivery may finish after return or replacement.
                if self.current?.notificationID != id { self.removeNotification(surface) }
                let status = error == nil ? permission : NotificationStatus("unavailable", "macOS could not schedule this notification.")
                if surface.kind == .summary {
                    if error == nil, self.latestReview?.id == surface.subject { self.summaryReceipts.accept(id) }
                    self.summaryCallbacks.removeValue(forKey: id)?.forEach { $0(status) }
                } else { done(status) }
            }
        }
    }

    private func reply(_ request: Int, _ status: NotificationStatus) {
        var message: [String: Any] = ["type": "result", "request": request, "status": status.code]
        if let detail = status.detail { message["detail"] = detail }
        writeFrame(message)
    }

    private func removeNotification(_ surface: Surface) {
        center.removePendingNotificationRequests(withIdentifiers: [surface.notificationID])
        center.removeDeliveredNotifications(withIdentifiers: [surface.notificationID])
    }

    private func reconcileRecoveredSummaries(keeping id: String?) {
        let obsolete = recoveredSummaries.filter { $0 != id }
        recoveredSummaries.removeAll()
        if !obsolete.isEmpty {
            center.removePendingNotificationRequests(withIdentifiers: Array(obsolete))
            center.removeDeliveredNotifications(withIdentifiers: Array(obsolete))
        }
    }

    private func removeCurrent(keeping notificationID: String? = nil) {
        expiry?.invalidate()
        expiry = nil
        if let current, current.notificationID != notificationID { removeNotification(current) }
        current = nil
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        DispatchQueue.main.async {
            let id = notification.request.identifier
            let stale = self.profile.owns(id) && self.current?.notificationID != id && !self.recoveredSummaries.contains(id)
            completionHandler(stale ? [] : [.banner, .list])
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let request = response.notification.request
        DispatchQueue.main.async {
            defer { completionHandler() }
            guard let current = self.current,
                  let choice = current.notificationChoice(request: request.identifier, category: request.content.categoryIdentifier,
                                                          action: response.actionIdentifier, subject: request.content.userInfo["subject"] as? String),
                  let selected = current.selection(choice, now: Date()) else { return }
            self.perform(selected)
        }
    }

    private func perform(_ selected: Selection) {
        switch selected {
        case .showMenu:
            statusItem?.button?.performClick(nil)
        case .readReview:
            openReview()
        case .send(let button):
            guard let surface = current else { return }
            // Consume before sending so double-clicks and a second OS callback cannot escape.
            removeCurrent()
            refreshMenu()
            writeFrame(["type": "action", "kind": button.rawValue, "id": surface.subject])
        }
    }

    private func refreshMenu() {
        guard current != nil || latestReview != nil else {
            if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
            statusItem = nil
            return
        }
        let item = statusItem ?? NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem = item
        item.button?.image = NSImage(systemSymbolName: "cup.and.saucer", accessibilityDescription: "Break Delegate")
        item.button?.toolTip = "Break Delegate"
        let menu = NSMenu()
        if let surface = current {
            let heading = menu.addItem(withTitle: surface.notification.content.title, action: nil, keyEquivalent: "")
            heading.isEnabled = false
            for button in surface.kind.buttons {
                let choice = menu.addItem(withTitle: button.title, action: #selector(menuAction(_:)), keyEquivalent: "")
                choice.target = self
                choice.representedObject = surface.menuChoice(button)
            }
        }
        if latestReview != nil, current?.kind != .summary {
            let choice = menu.addItem(withTitle: "Read last break review", action: #selector(openReview), keyEquivalent: "")
            choice.target = self
        }
        if permission.code == "not-determined" || permission.code == "denied" {
            menu.addItem(.separator())
            let first = permission.code == "not-determined"
            let choice = menu.addItem(withTitle: first ? "Enable Notifications…" : "Open Notification Settings…",
                                      action: first ? #selector(allowNotifications) : #selector(openSettings), keyEquivalent: "")
            choice.target = self
        }
        item.menu = menu
    }

    @objc private func menuAction(_ item: NSMenuItem) {
        guard let choice = item.representedObject as? NativeChoice, let selected = current?.selection(choice, now: Date()) else { return }
        perform(selected)
    }

    @objc private func allowNotifications() { authorize { _ in } }

    @objc private func openSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func openReview() {
        guard let latestReview else { return }
        let window = makeReviewWindow(latestReview.review, reusing: reviewWindow)
        reviewWindow = window
        windowReviewID = latestReview.id
        // Only an explicit review click opens a window or activates this accessory app.
        if #available(macOS 14.0, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
        window.makeKeyAndOrderFront(nil)
    }
}
