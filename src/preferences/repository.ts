import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** Produce a stable local lookup key without persisting a credential-bearing remote or user text.
 * @example digest('github.com/example/project')
 */
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function remoteIdentity(value: string): string | null {
  let remote: URL
  try {
    // SCP-style SSH and HTTPS clones share a repository even when their login differs.
    const scp = /^([^@/:]+@)?([^/:]+):([^/].*)$/u.exec(value)
    remote = new URL(
      !value.includes('://') && scp ? 'ssh://' + scp[2] + '/' + scp[3] : value,
    )
  } catch {
    return null
  }
  if (
    !['http:', 'https:', 'ssh:', 'git:'].includes(remote.protocol) ||
    !remote.hostname ||
    remote.search ||
    remote.hash
  )
    return null
  const host = remote.hostname.toLowerCase()
  const path = remote.pathname
    .replace(/^\/+|\/+$/gu, '')
    .replace(/\.git$/iu, '')
  if (!path || !path.includes('/')) return null
  return (
    'remote:' +
    digest(
      remote.host.toLowerCase() +
        '/' +
        (host === 'github.com' ? path.toLowerCase() : path),
    )
  )
}

/** Resolve a worktree or a nested directory to the same repository used by historical imports.
 * @param recordedRemote - A Codex session's originating remote, retained after a temporary worktree is gone.
 * @example canonicalRepository(process.cwd())
 */
export function canonicalRepository(
  cwd: string,
  recordedRemote?: string,
): string | null {
  if (recordedRemote) {
    const recorded = remoteIdentity(recordedRemote)
    if (recorded) return recorded
  }
  if (!isAbsolute(cwd) || cwd.includes('\0')) return null
  const git = (args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 1000,
      maxBuffer: 16_384,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_COMMON_DIR: undefined,
      },
    }).trim()
  try {
    const common = realpathSync(
      resolve(cwd, git(['rev-parse', '--git-common-dir'])),
    )
    try {
      const origin = remoteIdentity(
        git(['config', '--local', '--get', 'remote.origin.url']),
      )
      if (origin) return origin
    } catch {
      /* A local-only repository still has a common Git directory. */
    }
    return 'git:' + digest(common)
  } catch {
    return null
  }
}
