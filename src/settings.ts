import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants, realpathSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { isObject, type ObjectValue } from './ipc.js'
import { privateDirectory } from './ipc-auth.js'
import { nativeHelperExecutable } from './native/index.js'

const events = {
  SessionStart: '',
  SessionEnd: '',
  UserPromptSubmit: '',
  Stop: '',
  PreToolUse: '',
  PostToolUse: '',
  PostToolUseFailure: '',
  PermissionRequest: '',
  Notification: 'idle_prompt|permission_prompt',
}
const owned = 'openclaw-break-delegate-hook-v1'

function quoteShell(s: string): string {
  return "'" + s.replaceAll("'", "'\\''") + "'"
}
/** Resolve parent aliases even when setup runs before the profile's first Gateway start.
 * @example
 * const owner = profileIdentity(stateDir);
 */
function profileIdentity(path: string): string {
  const absolute = resolve(path)
  let current = absolute
  const missing: string[] = []
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse())
    } catch (error) {
      const parent = dirname(current)
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
        current === parent
      )
        return absolute
      missing.push(basename(current))
      current = parent
    }
  }
}

/** Serialize editors of one Claude settings file using an OS-released file lock.
 * @example
 * const owner = lockSettings(settings + '.break-delegate-owner.sqlite')
 */
function lockSettings(path: string): DatabaseSync {
  const owner = new DatabaseSync(path)
  try {
    owner.exec('PRAGMA busy_timeout=2000; BEGIN EXCLUSIVE')
    return owner
  } catch (error) {
    owner.close()
    throw error
  }
}

/** Atomically exchange two existing files when the packaged macOS helper and filesystem support it.
 * {@link replaceSettings} uses the displaced inode to detect edits made after its final read.
 * @example
 * const exchanged = exchangeSettings(settingsPath, recoveryPath);
 */
function exchangeSettings(file: string, recovery: string): boolean {
  if (process.platform !== 'darwin') return false
  const reply = spawnSync(
    nativeHelperExecutable,
    ['--exchange-settings', file, recovery],
    {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 256,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  )
  if ((reply.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT')
    return false
  if (reply.status === 0 && reply.stdout === 'exchanged\n') return true
  // A source checkout can have an older helper with no exchange command.
  if (
    reply.status === 0 &&
    (reply.stdout === '' || reply.stdout === 'unsupported\n')
  )
    return false
  throw new Error(
    'Could not confirm the settings exchange. Compare the files at ' +
      file +
      ' and ' +
      recovery +
      '.',
  )
}

/** Publish a revision only if the editor has left the destination free, including on volumes without links.
 * @example
 * await installIfAbsent(staged, file);
 */
async function installIfAbsent(
  source: string,
  destination: string,
): Promise<void> {
  try {
    await link(source, destination)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (
      code !== 'EPERM' &&
      code !== 'ENOTSUP' &&
      code !== 'EOPNOTSUPP' &&
      code !== 'EXDEV'
    )
      throw error
    await copyFile(source, destination, constants.COPYFILE_EXCL)
  }
}

/** Preserve the exact file displaced by setup for recovery after a concurrent save.
 * {@link configureHooks} prepares the replacement inside a private recovery directory.
 * @example
 * await replaceSettings(file, staged, old);
 */
async function replaceSettings(
  file: string,
  staged: string,
  old: string,
): Promise<void> {
  const previous = join(dirname(staged), 'previous.json')
  const conflict = (path: string) =>
    new Error(
      'Claude settings changed. Compare the preserved revision at ' +
        path +
        ' and retry.',
    )
  if (exchangeSettings(file, staged)) {
    // The editor can save again at any instant. Retain the displaced revision without a second swap.
    if ((await readFile(staged, 'utf8')) !== old) throw conflict(staged)
    await rename(staged, previous)
    return
  }

  // Portable fallback captures the current inode and only installs the prepared file if the path is still free.
  const displaced = staged + '.previous'
  await rename(file, displaced)
  try {
    if ((await readFile(displaced, 'utf8')) !== old) throw conflict(displaced)
    await installIfAbsent(staged, file)
  } catch {
    // If a third writer populated the path, its version stays active and the displaced copy stays recoverable.
    try {
      await installIfAbsent(displaced, file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw conflict(displaced)
    }
    throw conflict(displaced)
  }
  await rm(staged, { force: true })
  await rename(displaced, previous)
}

/** Install or remove this package's hook commands while preserving unrelated Claude settings.
 * Called only by an explicit local setup or uninstall command.
 * @example
 * await configureHooks("install", profileDir);
 */
export async function configureHooks(
  mode: 'install' | 'remove',
  stateDir: string,
  file = join(
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    'settings.json',
  ),
): Promise<{ changed: boolean; file: string }> {
  // Update a managed settings target without replacing its symbolic link.
  try {
    file = await realpath(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const folder = dirname(file)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const lock = lockSettings(file + '.break-delegate-owner.sqlite')
  const recovery = file + '.break-delegate-backups'
  const tmp = join(recovery, 'recovery-' + randomUUID() + '.json')
  let preserveStaged = false
  try {
    let old = ''
    let exists = false
    let perms = 0o600
    try {
      const st = await lstat(file)
      if (!st.isFile() || st.isSymbolicLink())
        throw new Error('Select a regular Claude settings file.')
      old = await readFile(file, 'utf8')
      exists = true
      perms = st.mode & 0o777
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    const settings: unknown = old.trim() ? JSON.parse(old) : {}
    if (
      !isObject(settings) ||
      (settings.hooks !== undefined && !isObject(settings.hooks))
    )
      throw new Error('Existing Claude settings must contain a JSON object.')
    const original = JSON.stringify(settings)
    const hooks: ObjectValue = isObject(settings.hooks) ? settings.hooks : {}
    const cli = fileURLToPath(new URL('./cli.js', import.meta.url))
    const profile = profileIdentity(stateDir)
    const owners = new Map<string, string>()
    function managed(h: unknown): boolean {
      if (
        !isObject(h) ||
        h.type !== 'command' ||
        typeof h.command !== 'string' ||
        !h.command.endsWith(' ' + owned)
      )
        return false
      // Explicit setup transfers the settings file; removal is scoped to the installing profile.
      if (mode === 'install') return true
      const token = / '--state-dir' '((?:[^']|'\\'')*)' 'hook' /.exec(
        h.command,
      )?.[1]
      if (token === undefined) return false
      const installed = token.replaceAll("'\\''", "'")
      // Older releases recorded the user's original spelling, including parent aliases.
      if (installed === stateDir || installed === profile) return true
      if (!owners.has(installed))
        owners.set(installed, profileIdentity(installed))
      return owners.get(installed) === profile
    }
    const commandPrefix = [
      process.execPath,
      cli,
      '--state-dir',
      profile,
      'hook',
    ]
      .map(quoteShell)
      .join(' ')
    for (const [event, matcher] of Object.entries(events)) {
      const current = hooks[event] ?? []
      if (!Array.isArray(current))
        throw new Error(
          'Existing hook list for ' + event + ' must be an array.',
        )
      const entries: unknown[] = []
      const command = commandPrefix + ' ' + quoteShell(event) + ' ' + owned
      for (const entry of current) {
        if (
          !isObject(entry) ||
          !Array.isArray(entry.hooks) ||
          !entry.hooks.some(managed)
        ) {
          entries.push(entry)
          continue
        }
        const kept = entry.hooks.filter((h) => !managed(h))
        if (kept.length) entries.push({ ...entry, hooks: kept })
      }
      if (mode === 'install')
        entries.push({
          ...(matcher ? { matcher } : {}),
          hooks: [{ type: 'command', command, timeout: 18 }],
        })
      if (entries.length) hooks[event] = entries
      else delete hooks[event]
    }
    if (Object.keys(hooks).length) settings.hooks = hooks
    else delete settings.hooks
    if (JSON.stringify(settings) === original) return { changed: false, file }
    await privateDirectory(recovery)
    const updated = JSON.stringify(settings, null, 2) + '\n'
    const staged = await open(tmp, 'wx', perms)
    try {
      await staged.writeFile(updated)
      await staged.sync()
    } finally {
      await staged.close()
    }
    await chmod(tmp, perms)
    // Catch an early concurrent save before touching the path.
    const current = await readFile(file, 'utf8').catch(
      (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return ''
        throw err
      },
    )
    if (current !== old)
      throw new Error(
        'Claude settings changed. Retry the command against the newer file.',
      )
    if (exists) {
      // After a swap, the staged path can be the only copy of an editor's latest save.
      preserveStaged = true
      await replaceSettings(file, tmp, old)
    } else {
      // First-time setup must not overwrite a file created by another writer since the snapshot.
      await installIfAbsent(tmp, file)
    }
    return { changed: true, file }
  } finally {
    lock.close()
    if (!preserveStaged) await rm(tmp, { force: true })
  }
}
