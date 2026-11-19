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
async function lockSettings(
  path: string,
): Promise<import('node:fs/promises').FileHandle> {
  try {
    const handle = await open(path, 'wx', 0o600)
    try {
      await handle.writeFile(String(process.pid))
      return handle
    } catch (err) {
      await handle.close()
      await rm(path, { force: true })
      throw err
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    const previous = await lstat(path)
    if (
      !previous.isFile() ||
      (process.getuid && previous.uid !== process.getuid())
    )
      throw err
    const pid = Number(await readFile(path, 'utf8'))
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0)
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === 'ESRCH') {
          const current = await lstat(path)
          if (current.ino === previous.ino && current.dev === previous.dev) {
            await rm(path)
            return lockSettings(path)
          }
        }
      }
    }
    throw new Error(
      'Claude settings are being edited by another Break Delegate setup. Retry when it finishes.',
    )
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
  const lock = await lockSettings(file + '.break-delegate.lock')
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
    const command =
      [process.execPath, cli, '--state-dir', stateDir, 'hook']
        .map(quoteShell)
        .join(' ') +
      ' ' +
      owned
    for (const [event, matcher] of Object.entries(events)) {
      const current = hooks[event] ?? []
      if (!Array.isArray(current))
        throw new Error(
          'Existing hook list for ' + event + ' must be an array.',
        )
      const entries: unknown[] = []
      for (const entry of current) {
        if (
          !isObject(entry) ||
          !Array.isArray(entry.hooks) ||
          !entry.hooks.some(ours)
        ) {
          entries.push(entry)
          continue
        }
        const kept = entry.hooks.filter((h) => !ours(h))
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
    const staged = await open(tmp, 'wx', perms)
    try {
      await staged.writeFile(JSON.stringify(settings, null, 2) + '\n')
      await staged.sync()
    } finally {
      await staged.close()
    }
    await chmod(tmp, perms)
    await rename(tmp, file)
    return { changed: true, file }
  } finally {
    await lock.close()
    await rm(file + '.break-delegate.lock', { force: true })
    await rm(tmp, { force: true })
  }
}
