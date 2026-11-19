import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { isObject, type ObjectValue } from './ipc.js'

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
function ours(h: unknown): boolean {
  return (
    isObject(h) &&
    h.type === 'command' &&
    typeof h.command === 'string' &&
    h.command.endsWith(' ' + owned)
  )
}

/** Serialize setup and removal, reclaiming a lock only after its recorded owner has exited. */
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
  const tmp = join(folder, '.break-delegate-' + randomUUID() + '.tmp')
  try {
    let old = ''
    let perms = 0o600
    try {
      const st = await lstat(file)
      if (!st.isFile() || st.isSymbolicLink())
        throw new Error('Select a regular Claude settings file.')
      old = await readFile(file, 'utf8')
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
    const commandPrefix = [
      process.execPath,
      cli,
      '--state-dir',
      stateDir,
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
      // Setup hands this settings file to the selected profile. Uninstall only removes this profile's commands.
      const managed = (h: unknown): boolean =>
        ours(h) &&
        (mode === 'install' ||
          (isObject(h) &&
            typeof h.command === 'string' &&
            h.command.includes(
              quoteShell('--state-dir') + ' ' + quoteShell(stateDir) + ' ',
            )))
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
    const staged = await open(tmp, 'wx', perms)
    try {
      await staged.writeFile(JSON.stringify(settings, null, 2) + '\n')
      await staged.sync()
    } finally {
      await staged.close()
    }
    await chmod(tmp, perms)
    // Detect concurrent edits made by Claude or an editor while preparing the update.
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
    await rename(tmp, file)
    return { changed: true, file }
  } finally {
    lock.close()
    await rm(tmp, { force: true })
  }
}
