import { resolve } from 'node:path'
import { configureHooks } from './settings.js'
import { dataDirectory, requestGateway } from './ipc.js'
import { runHook } from './hooks.js'

export const commandDescription =
  'Manage break invitations and delegated Claude Code questions'
export const commandNames = [
  'setup',
  'uninstall-hooks',
  'authorize-notifications',
  'status',
  'review',
  'return',
  'import',
  'replay',
] as const
export const usage =
  'openclaw break-delegate <' +
  commandNames.join('|') +
  '> [--state-dir PATH] [--settings PATH]'

async function stdinJson(): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const part of process.stdin) {
    const b = Buffer.isBuffer(part) ? part : Buffer.from(part)
    size += b.length
    if (size > 256 * 1024) return null
    chunks.push(b)
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
  } catch {
    return null
  }
}

/** Execute a command from either the OpenClaw CLI or the packaged hook executable.
 * @example
 * await runCommand(["status"]);
 */
export async function runCommand(
  argv: readonly string[],
  defaultDir = dataDirectory(),
): Promise<void> {
  const args = [...argv]
  const take = (flag: string) => {
    const at = args.indexOf(flag)
    if (at < 0) return
    const value = args[at + 1]
    if (!value || value.startsWith('--'))
      throw Error('Missing value for ' + flag)
    args.splice(at, 2)
    return resolve(value)
  }
  const directory = take('--state-dir') ?? defaultDir
  const settings = take('--settings')
  const [op, extra, ...rest] = args
  if (op === 'hook') {
    await runHook(
      directory,
      await stdinJson(),
      (value) =>
        new Promise((ok, reject) =>
          process.stdout.write(value, (e) => (e ? reject(e) : ok())),
        ),
    )
    return
  }
  if (!op || op === 'help' || op === '--help' || op === '-h') {
    console.log(usage)
    return
  }
  if (rest.length || (extra && op !== 'review')) throw Error(usage)
  if (op === 'setup' || op === 'uninstall-hooks') {
    const result = await configureHooks(
      op === 'setup' ? 'install' : 'remove',
      directory,
      settings,
    )
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (!commandNames.some((n) => n === op) || settings) throw Error(usage)
  const value = await requestGateway(
    directory,
    { op, ...(extra ? { breakId: extra } : {}) },
    op === 'authorize-notifications'
      ? 125000
      : op === 'import' || op === 'replay'
        ? 180000
        : 10000,
  )
  console.log(JSON.stringify(value, null, 2))
}
