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
  let relativeSsh = false
  try {
    const scp =
      !value.includes('://') &&
      /^(?:([^@/:\s]+)@)?([^/:\s]+):(.+)$/u.exec(value)
    if (scp) {
      const path = scp[3]!
      if (path.startsWith('~')) return null
      relativeSsh = !path.startsWith('/')
      remote = new URL(
        'ssh://' +
          (scp[1] ? scp[1] + '@' : '') +
          scp[2] +
          (relativeSsh ? '/' : '') +
          path,
      )
    } else remote = new URL(value)
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
  if (remote.protocol === 'ssh:' && remote.pathname.startsWith('/~'))
    return null
  const literalPath = remote.pathname.replace(/^\/+|\/+$/gu, '')
  const path =
    host === 'github.com' ? literalPath.replace(/\.git$/iu, '') : literalPath
  if (!path || !path.includes('/')) return null
  // Generic SSH servers interpret a relative SCP path inside the named account's home. GitHub owner/repository paths have host-wide meaning.
  if (host !== 'github.com' && remote.protocol === 'ssh:') {
    if (relativeSsh && !remote.username) return null
    return (
      'remote:' +
      digest(
        JSON.stringify([
          'ssh-literal-path',
          remote.host.toLowerCase(),
          remote.username,
          relativeSsh ? 'home' : 'absolute',
          path,
        ]),
      )
    )
  }
  return (
    'remote:' +
    digest(
      (host === 'github.com' ? '' : 'literal-path:') +
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
