import { execFileSync } from 'node:child_process'
import { nativeHelperExecutable } from './native/index.js'

/** Identify the interactive Claude process above a piped hook, including its start epoch.
 * A headless Claude invocation can inherit a TTY, so check its launch arguments too.
 * @example
 * const incarnation = claudeTerminal();
 */
export function claudeTerminal(): string | undefined {
  let pid = process.ppid
  for (let depth = 0; depth < 10 && pid > 1; depth++) {
    try {
      const fields = execFileSync(
        '/bin/ps',
        [
          '-p',
          String(pid),
          '-o',
          'ppid=',
          '-o',
          'tty=',
          '-o',
          'lstart=',
          '-o',
          'comm=',
        ],
        { encoding: 'utf8', timeout: 800, maxBuffer: 64_000 },
      ).trim()
      const match = fields.match(
        /^(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d{4})\s+(.+)$/,
      )
      if (!match) return
      const [, parent, tty, started, command] = match
      if (/(?:^|\/)(?:claude(?:-code)?|node|versions\/[^/]+)$/.test(command)) {
        // Darwin validates the actual versioned executable, including prerelease suffixes, and its argv.
        const mode = execFileSync(
          nativeHelperExecutable,
          ['--classify-claude-process', String(pid)],
          {
            encoding: 'utf8',
            timeout: 1000,
            maxBuffer: 100,
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        ).trim()
        if (mode === 'headless') return
        if (mode === 'interactive')
          return tty === '??' || tty === '?'
            ? undefined
            : pid + ':' + started.replace(/\s+/g, ' ')
      }
      pid = Number(parent)
    } catch {
      return
    }
  }
}
