import Darwin
import Foundation

enum ClaudeInvocation: String { case interactive, headless, unrelated, unknown }

/// Classifies Darwin's length/count-bounded argv block. The trailing environment is never decoded.
func classifyClaudeArguments(_ bytes: [UInt8]) -> ClaudeInvocation {
    guard bytes.count >= MemoryLayout<Int32>.size else { return .unknown }
    let count = bytes.withUnsafeBytes { Int($0.loadUnaligned(as: Int32.self)) }
    guard count > 0, count <= 16_384 else { return .unknown }
    var offset = MemoryLayout<Int32>.size
    func field() -> String? {
        guard offset < bytes.count, let end = bytes[offset...].firstIndex(of: 0),
              let text = String(bytes: bytes[offset..<end], encoding: .utf8) else { return nil }
        offset = end + 1
        return text
    }
    guard let path = field(), !path.isEmpty else { return .unknown }
    let name = URL(fileURLWithPath: path).lastPathComponent
    let standalone = name == "claude" || name == "claude-code" ||
        (path.contains("/share/claude/versions/") && name.range(of: #"^\d+\.\d+\.\d+([.-][A-Za-z0-9.-]+)?$"#, options: .regularExpression) != nil)
    guard standalone || name == "node" else { return .unrelated }
    // The kernel pads the executable path before argv[0]; subsequent empty arguments are significant.
    while offset < bytes.count && bytes[offset] == 0 { offset += 1 }
    guard field() != nil else { return .unknown }
    var firstOption = 1
    if !standalone {
        guard count >= 2, let script = field() else { return .unrelated }
        let entry = URL(fileURLWithPath: script).resolvingSymlinksInPath().path
        guard entry.hasSuffix("/@anthropic-ai/claude-code/cli.js") else { return .unrelated }
        firstOption = 2
    }
    var parseOptions = true
    var headless = false
    for _ in firstOption..<count {
        guard let arg = field() else { return .unknown }
        if arg == "--" { parseOptions = false }
        if parseOptions && (["-p", "--print", "--input-format", "--output-format"].contains(arg) ||
            ["--print=", "--input-format=", "--output-format="].contains(where: { arg.hasPrefix($0) })) { headless = true }
    }
    return headless ? .headless : .interactive
}

/// Lets the hook inspect one candidate ancestor's real argument boundaries without reporting arguments.
func classifyClaudeProcess(_ pid: pid_t) -> ClaudeInvocation {
    guard pid > 1 else { return .unknown }
    var maximum: Int32 = 0
    var size = MemoryLayout.size(ofValue: maximum)
    guard sysctlbyname("kern.argmax", &maximum, &size, nil, 0) == 0,
          maximum > 0, maximum <= 8 * 1024 * 1024 else { return .unknown }
    var query = [CTL_KERN, KERN_PROCARGS2, pid]
    var bytes = [UInt8](repeating: 0, count: Int(maximum))
    size = bytes.count
    guard sysctl(&query, 3, &bytes, &size, nil, 0) == 0, size <= bytes.count else { return .unknown }
    bytes.removeSubrange(size..<bytes.count)
    return classifyClaudeArguments(bytes)
}
