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
    private var current: Surface?
    private var latestReview: BreakReview?
    private var statusItem: NSStatusItem?
    private var reviewWindow: NSWindow?
    private var expiry: Timer?
    private var permission = NotificationStatus("not-determined")

    init(profile: NotificationProfile) { self.profile = profile }

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
                    let ids = self.profile.orphanedIDs(in: snapshot, keeping: self.current?.requestID)
                    if !ids.isEmpty {
                        // A request can move from pending to delivered between the two snapshots.
                        self.center.removePendingNotificationRequests(withIdentifiers: ids)
                        self.center.removeDeliveredNotifications(withIdentifiers: ids)
                    }
                }
            }
        }
        readGatewayCommands()
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
            removeCurrent()
            latestReview = nil
            reviewWindow?.close()
            refreshMenu()
            readPermission { self.reply(command.request, $0) }
        case .invite, .active, .summary:
            guard let surface = Surface(command: command, profile: profile) else {
                reply(command.request, NotificationStatus("unavailable", "Invalid native presentation."))
                return
            }
            removeCurrent()
            current = surface
            if case .summary(let review) = surface.content { latestReview = review }
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
        guard current?.requestID == surface.requestID, permission.code == "authorized" else { done(permission); return }
        center.add(surface.notification) { error in
            DispatchQueue.main.async {
                // An authorization check or delivery may finish after return or replacement.
                if self.current?.requestID != surface.requestID { self.removeNotification(surface) }
                done(error == nil ? permission : NotificationStatus("unavailable", "macOS could not schedule this notification."))
            }
        }
    }

    private func reply(_ request: Int, _ status: NotificationStatus) {
        var message: [String: Any] = ["type": "result", "request": request, "status": status.code]
        if let detail = status.detail { message["detail"] = detail }
        writeFrame(message)
    }

    private func removeNotification(_ surface: Surface) {
        center.removePendingNotificationRequests(withIdentifiers: [surface.requestID])
        center.removeDeliveredNotifications(withIdentifiers: [surface.requestID])
    }

    private func removeCurrent() {
        expiry?.invalidate()
        expiry = nil
        if let current { removeNotification(current) }
        current = nil
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        DispatchQueue.main.async {
            let id = notification.request.identifier
            let stale = self.profile.owns(id) && self.current?.requestID != id
            completionHandler(stale ? [] : [.banner, .list])
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let request = response.notification.request
        DispatchQueue.main.async {
            defer { completionHandler() }
            let choice = NativeChoice(request: request.identifier, category: request.content.categoryIdentifier,
                                      action: response.actionIdentifier, subject: request.content.userInfo["subject"] as? String)
            guard let selected = self.current?.selection(choice, now: Date()) else { return }
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
        guard let review = latestReview else { return }
        let window = makeReviewWindow(review, reusing: reviewWindow)
        reviewWindow = window
        // Only an explicit review click opens a window or activates this accessory app.
        if #available(macOS 14.0, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
        window.makeKeyAndOrderFront(nil)
    }
}
