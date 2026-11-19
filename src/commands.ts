import { resolve } from 'node:path'
import { configureHooks } from './settings.js'
import { dataDirectory, requestGateway, isObject } from './ipc.js'
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
  if (op === 'review') {
    console.log(JSON.stringify(await requestReview(directory, extra), null, 2))
    return
  }
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

/** Retrieve a complete break from bounded Gateway pages, pinning the first page's break ID.
 * @example
 * const rows = await requestReview(profileDir, breakId)
 */
export async function requestReview(
  directory: string,
  breakId?: string,
): Promise<unknown[]> {
  const rows: unknown[] = []
  let cursor: string | undefined
  do {
    const page = await requestGateway(directory, {
      op: 'review-page',
      breakId,
      cursor,
    })
    if (
      !isObject(page) ||
      !Array.isArray(page.rows) ||
      (page.breakId !== null && typeof page.breakId !== 'string') ||
      (page.nextCursor !== null && typeof page.nextCursor !== 'string')
    )
      throw Error('Invalid break review page.')
    rows.push(...page.rows)
    breakId = page.breakId ?? undefined
    if (page.nextCursor && page.nextCursor === cursor)
      throw Error('Review cursor did not advance.')
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return rows
}
