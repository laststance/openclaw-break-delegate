import AppKit

/// Builds the same selectable, scrollable review for a user-opened window and offscreen verification.
/// Construction never orders the window onscreen or changes the application's activation policy.
func makeReviewWindow(_ review: BreakReview, reusing existing: NSWindow? = nil) -> NSWindow {
    let size = NSRect(x: 0, y: 0, width: 590, height: 430)
    let window = existing ?? NSWindow(contentRect: size, styleMask: [.titled, .closable, .resizable],
                                     backing: .buffered, defer: false)
    if existing == nil { window.center() }
    window.isReleasedWhenClosed = false
    window.title = "Break Delegate — Return review"
    window.contentMinSize = NSSize(width: 320, height: 230)
    let scroll = NSScrollView(frame: window.contentView?.bounds ?? size)
    scroll.autoresizingMask = [.width, .height]
    scroll.hasVerticalScroller = true
    let text = NSTextView(frame: scroll.contentView.bounds)
    text.isEditable = false
    text.isSelectable = true
    text.isVerticallyResizable = true
    text.isHorizontallyResizable = false
    text.autoresizingMask = [.width]
    text.textContainer?.widthTracksTextView = true
    text.textContainerInset = NSSize(width: 18, height: 14)
    let content = NSMutableAttributedString()

    func line(_ value: String, size: CGFloat, weight: NSFont.Weight = .regular, after: CGFloat = 3,
              secondary: Bool = false) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.paragraphSpacing = after
        paragraph.lineSpacing = 1
        content.append(NSAttributedString(string: value + "\n", attributes: [
            .font: NSFont.systemFont(ofSize: size, weight: weight), .paragraphStyle: paragraph,
            .foregroundColor: secondary ? NSColor.secondaryLabelColor : NSColor.labelColor
        ]))
    }

    line("Answers OpenClaw sent (\(review.answeredTotal))", size: 18, weight: .bold, after: 8)
    if review.answered.isEmpty { line("No answers to show.", size: 13, after: 13, secondary: true) }
    for entry in review.answered {
        line(entry.question, size: 14, weight: .semibold)
        line("Answer: \(entry.answer)", size: 13, after: 12)
    }
    if review.answered.count < review.answeredTotal {
        line("Showing \(review.answered.count) of \(review.answeredTotal) answers.", size: 12, after: 12, secondary: true)
    }
    line("Questions held for you (\(review.heldTotal))", size: 18, weight: .bold, after: 8)
    if review.held.isEmpty { line("No questions to show.", size: 13, after: 13, secondary: true) }
    for entry in review.held {
        line(entry.question, size: 14, weight: .semibold)
        line("Held: \(entry.reason)", size: 13, after: 12)
    }
    if review.held.count < review.heldTotal {
        line("Showing \(review.held.count) of \(review.heldTotal) held questions.", size: 12, after: 12, secondary: true)
    }
    line("Complete text and history: openclaw break-delegate review", size: 12, secondary: true)
    text.textStorage?.setAttributedString(content)
    scroll.documentView = text
    window.contentView = scroll
    window.layoutIfNeeded()
    if let container = text.textContainer { text.layoutManager?.ensureLayout(for: container) }
    text.sizeToFit()
    return window
}
