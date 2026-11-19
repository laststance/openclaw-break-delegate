# macOS notifications and return review

Break Delegate runs as a small menu-bar app in the gateway user's graphical login session. The npm package contains the signed universal executable for macOS 13 and later. Notification Center identifies it as **Break Delegate** using the bundle ID `io.laststance.openclaw-break-delegate`.

Run `openclaw break-delegate authorize-notifications` from that login session to request notification permission. If macOS has yet to ask for permission, the invitation also offers **Enable Notifications…** in the cup menu. After a denial, open **System Settings → Notifications → Break Delegate** to change the setting. Turning off notifications there keeps the cup menu available during an invitation, break or review. Focus and alert style affect when macOS displays a banner.

Open **Options** on an invitation to delegate for 15 minutes, snooze once, or dismiss it. During a break, **I'm back** remains available in the cup menu after the banner closes. At the end, open **Read break review** in the banner or menu. The review banner shows how many questions were answered and held. The window contains private question, answer and hold text. Long reviews include a bounded preview. Run `openclaw break-delegate review` for the full local record. A gateway with no graphical session reports the native surface as unavailable. The CLI also supports `openclaw break-delegate return`.

## Gateway lifecycle

The gateway starts the signed executable inside its application bundle. A private inherited pipe carries commands and replies. Each presentation has a profile-scoped request identifier. All profiles register the same invitation, break and review actions. The app validates those identifiers, the subject and the active deadline before writing a response. The gateway checks the persisted consent again. Closing the gateway pipe retires the menu and its notification. When the helper alone restarts, the adapter restores the current surface. A gateway restart invalidates the old helper's callbacks.

## Build and release

Run `pnpm run build:native` in the repository root on a Mac with Xcode Command Line Tools. This builds an ad-hoc signed, hardened-runtime app at `native/generated/BreakDelegate.app`. Local builds verify the code signature, bundle ID, version and both CPU architectures.

For public distribution, set `BREAK_DELEGATE_SIGN_IDENTITY` to the publisher's existing Developer ID Application identity and run the same build. This requests Apple's secure signing timestamp. Use the publisher's notarization workflow for that exact app, staple the accepted ticket to the app bundle, then run `BREAK_DELEGATE_REUSE_STAPLED=1 pnpm run pack:release` in the repository root. This mode verifies the existing signature, architectures, ticket and Gatekeeper assessment before packaging the same bytes. Verify the extracted archive using `codesign --verify --strict --all-architectures`, `xcrun stapler validate` and `spctl --assess --type execute` on its `BreakDelegate.app` before publishing. [Apple's notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)

The native tests construct actual Apple categories and requests, exercise the inherited-pipe protocol with an isolated child, and run the built app with desktop services denied. On a graphical test Mac, separately grant notifications, respond to an invitation, dismiss the active banner, return through the cup menu and open the review. [Apple's notification action delivery](https://developer.apple.com/documentation/usernotifications/handling-notifications-and-notification-related-actions)
