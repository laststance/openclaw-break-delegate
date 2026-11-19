import { execFileSync } from 'node:child_process'

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
      if (
        /(?:^|\/)(?:claude(?:-code)?|node|versions\/\d+\.\d+\.\d+)$/.test(
          command,
        )
      ) {
        // Arguments stay inside this process. Only the instance identifier is sent.
        const args = execFileSync(
          '/bin/ps',
          ['-ww', '-p', String(pid), '-o', 'command='],
          { encoding: 'utf8', timeout: 800, maxBuffer: 256_000 },
        ).trim()
        if (
          /(?:^|[\s/])claude(?:\s|$)|@anthropic-ai\/claude-code|\/share\/claude\/versions\//.test(
            args,
          )
        ) {
          if (
            tty === '??' ||
            tty === '?' ||
            /(?:^|\s)(?:-p|--print|--input-format|--output-format)(?:\s|=|$)/.test(
              args,
            )
          )
            return
          return pid + ':' + started.replace(/\s+/g, ' ')
        }
      }
      pid = Number(parent)
    } catch {
      return
    }
  }
}
