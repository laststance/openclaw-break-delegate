import Darwin
import Foundation

enum ClaudeInvocation: String { case interactive, headless, unrelated, unknown }

// Documented Node 24/26 script-mode options. Unrecognized separate operands are deliberately ambiguous.
private let nodeValues = Set("""
--allow-fs-read --allow-fs-write --conditions --config-file --cpu-prof-dir --cpu-prof-interval --cpu-prof-name
--debug-port --diagnostic-dir --disable-proto --disable-warning --dns-result-order --env-file
--env-file-if-exists --experimental-config-file --experimental-default-config-file --experimental-loader
--experimental-package-map --heap-prof-dir --heap-prof-interval --heap-prof-name --heapsnapshot-near-heap-limit
--heapsnapshot-signal --icu-data-dir --import --input-type --inspect-port --inspect-publish-uid --loader
--localstorage-file --max-http-header-size --max-old-space-size --max-old-space-size-percentage
--max-semi-space-size --network-family-autoselection-attempt-timeout --openssl-config --process-timeout
--redirect-warnings --report-dir --report-directory --report-filename --report-signal --require --secure-heap
--secure-heap-min --snapshot-blob --stack-trace-limit --title --tls-cipher-list --tls-keylog
--trace-event-categories --trace-event-file-pattern --trace-require-module --unhandled-rejections
--use-largepages --v8-pool-size -C -r
""".split(whereSeparator: { $0.isWhitespace }).map(String.init))

private let nodeSwitches = Set("""
--abort-on-uncaught-exception --allow-addons --allow-child-process --allow-ffi --allow-fs-vfs --allow-inspector
--allow-net --allow-openssl-store --allow-wasi --allow-worker --cpu-prof --disable-sigusr1
--disable-wasm-trap-handler --disallow-code-generation-from-strings --enable-etw-stack-walking --enable-fips
--enable-fips-indicator-events --enable-network-family-autoselection --enable-source-maps
--experimental-addon-modules --experimental-bench --experimental-eventsource --experimental-import-meta-resolve
--experimental-import-text --experimental-inspector-network-resource --experimental-network-inspection
--experimental-print-required-tla --experimental-storage-inspection --experimental-stream-iter
--experimental-strip-types --experimental-transform-types --experimental-vfs --experimental-vm-modules
--experimental-web-worker --experimental-webstorage --experimental-worker-inspection --expose-gc
--force-context-aware --force-fips --force-node-api-uncaught-exceptions-policy --frozen-intrinsics --heap-prof
--insecure-http-parser --inspect --inspect-brk --inspect-wait --interpreted-frames-native-stack --jitless
--no-addons --no-async-context-frame --no-deprecation --no-enable-source-maps --no-experimental-detect-module
--no-experimental-ffi --no-experimental-global-navigator --no-experimental-repl-await
--no-experimental-require-module --no-experimental-sqlite --no-experimental-websocket
--no-experimental-webstorage --no-extra-info-on-fatal-exception --no-force-async-hooks-checks
--no-global-search-paths --no-network-family-autoselection --no-require-module --no-strip-types --no-warnings
--no-worker-snapshot --node-memory-debug --openssl-legacy-provider --openssl-shared-config --pending-deprecation
--permission --permission-audit --preserve-symlinks --preserve-symlinks-main --prof --report-compact
--report-exclude-env --report-exclude-network --report-on-fatalerror --report-on-process-timeout
--report-on-signal --report-uncaught-exception --throw-deprecation --tls-max-v1.2 --tls-max-v1.3 --tls-min-v1.0
--tls-min-v1.1 --tls-min-v1.2 --tls-min-v1.3 --trace-gc --trace_gc --trace-deprecation --trace-env --trace-env-js-stack
--trace-env-native-stack --trace-exit --trace-promises --trace-sigint --trace-sync-io --trace-tls
--trace-uncaught --trace-warnings --track-heap-objects --use-bundled-ca --use-env-proxy --use-openssl-ca
--use-system-ca --warnings --require-module --webstorage --zero-fill-buffers
""".split(whereSeparator: { $0.isWhitespace }).map(String.init))

private let nodeOtherModes = Set("""
--bench --build-sea --build-snapshot --build-snapshot-config --check --completion-bash --entry-url --eval
--experimental-sea-config --help --interactive --print --prof-process --run --test --v8-options --version
--vfs-load --watch -c -e -h -i -p -v
""".split(whereSeparator: { $0.isWhitespace }).map(String.init))

/// Locate the actual Node script without treating an option operand or a script argument as an entrypoint.
private func nodeEntrypoint(_ argv: [String]) -> Int? {
    var index = 0
    while index < argv.count {
        let argument = argv[index]
        if argument == "--" { return index + 1 < argv.count ? index + 1 : nil }
        if !argument.hasPrefix("-") { return index }
        let name = String(argument.prefix { $0 != "=" })
        if nodeOtherModes.contains(name) { return nil }
        if name != argument && argument.hasPrefix("--") { index += 1; continue }
        if nodeValues.contains(name) { index += 2; continue }
        if nodeSwitches.contains(name) { index += 1; continue }
        // An unknown switch can consume the following path. Never guess that path is executable.
        return nil
    }
    return nil
}

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
    var argv: [String] = []
    for _ in 1..<count {
        guard let argument = field() else { return .unknown }
        argv.append(argument)
    }
    var firstOption = 0
    if !standalone {
        guard let script = nodeEntrypoint(argv) else { return .unrelated }
        let entry = URL(fileURLWithPath: argv[script]).resolvingSymlinksInPath().path
        guard entry.hasSuffix("/@anthropic-ai/claude-code/cli.js") else { return .unrelated }
        firstOption = script + 1
    }
    var parseOptions = true
    var headless = false
    for arg in argv.dropFirst(firstOption) {
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
