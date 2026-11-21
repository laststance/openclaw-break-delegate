import { resolve } from 'node:path'
import { configureHooks } from './settings.js'
import {
  dataDirectory,
  requestGateway,
  isObject,
  type ObjectValue,
} from './ipc.js'
import { IncompleteHookInstruction, runHook } from './hooks.js'

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

const routingKeys = new Set([
  'session_id',
  'hook_event_name',
  'agent_id',
  'agent_type',
  'prompt',
  'cwd',
  'tool_name',
  'tool_use_id',
])

/** Project oversized hook JSON onto its top-level routing fields for {@link readHookInput}.
 * Preserve delimiters and validate string escapes so JSON.parse can verify the complete envelope without storing its prompt.
 * @example const envelope = new HookEnvelopeReader()
 */
class HookEnvelopeReader {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly seen = new Set<string>()
  private json = ''
  private depth = 0
  private key = ''
  private expectingKey = false
  private inString = false
  private capture = false
  private token = ''
  private escaped = false
  private hexLeft = 0

  write(input: Buffer | string): void {
    // An upstream iterator can hand over an arbitrarily large chunk. Decode bounded slices, including split UTF-8 sequences.
    for (let offset = 0; offset < input.length;) {
      let end = Math.min(offset + 16_384, input.length)
      if (
        typeof input === 'string' &&
        end < input.length &&
        /[\uD800-\uDBFF]/u.test(input[end - 1]!)
      )
        end++
      const bytes =
        typeof input === 'string'
          ? Buffer.from(input.slice(offset, end))
          : input.subarray(offset, end)
      this.consume(this.decoder.decode(bytes, { stream: true }))
      offset = end
    }
  }

  private consume(text: string): void {
    for (const c of text) {
      if (this.inString) {
        if (this.hexLeft) {
          if (!/[0-9a-f]/iu.test(c)) throw Error('Invalid JSON escape')
          this.hexLeft--
        } else if (this.escaped) {
          if (!'"\\/bfnrtu'.includes(c)) throw Error('Invalid JSON escape')
          this.escaped = false
          if (c === 'u') this.hexLeft = 4
        } else if (c === '"') {
          const value: string = this.capture
            ? JSON.parse('"' + this.token + '"')
            : '\u0000'
          this.inString = false
          if (this.depth === 1 && this.expectingKey) {
            this.key = routingKeys.has(value) ? value : ''
            if (this.key && this.seen.has(this.key))
              throw Error('Duplicate hook metadata')
            if (this.key) this.seen.add(this.key)
            this.expectingKey = false
            this.json += JSON.stringify(this.key)
          } else this.json += JSON.stringify(value)
          continue
        } else if (c === '\\') this.escaped = true
        else if (c < ' ') throw Error('Invalid JSON string')
        // 256 session characters fit even when each one uses a JSON Unicode escape.
        if (this.capture && this.token.length < 1536) this.token += c
        else this.capture = false
        continue
      }
      if (this.json.length > 65_536)
        throw Error('Hook metadata exceeds the limit')
      if (c === '"') {
        this.inString = true
        this.token = ''
        this.capture =
          this.depth === 1 &&
          (this.expectingKey || (!!this.key && this.key !== 'prompt'))
        continue
      }
      if (c === '{' || c === '[') {
        this.depth++
        if (this.depth === 1) this.expectingKey = true
      } else if (c === '}' || c === ']') this.depth--
      else if (c === ',' && this.depth === 1) {
        this.expectingKey = true
        this.key = ''
      }
      // Collapse JSON whitespace without merging the tokens on its two sides.
      if (' \n\r\t'.includes(c)) {
        if (!this.json.endsWith(' ')) this.json += ' '
      } else this.json += c
    }
  }

  finish(): unknown {
    this.consume(this.decoder.decode())
    if (this.inString) return undefined
    const value: unknown = JSON.parse(this.json)
    if (!isObject(value) || typeof value.hook_event_name !== 'string')
      return undefined
    if (value.agent_id || value.agent_type) return {}
    if (
      typeof value.session_id !== 'string' ||
      !/^[^\x00-\x1f]{1,256}$/u.test(value.session_id)
    )
      return undefined
    if (
      value.hook_event_name === 'UserPromptSubmit' &&
      typeof value.prompt === 'string'
    )
      return new IncompleteHookInstruction(value.session_id)
    // Keep the original question's lifecycle visible without retaining its choices or issuing an answer.
    if (
      ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(
        value.hook_event_name,
      ) &&
      value.tool_name === 'AskUserQuestion' &&
      typeof value.tool_use_id === 'string' &&
      /^[^\x00-\x1f]{1,256}$/u.test(value.tool_use_id) &&
      typeof value.cwd === 'string'
    )
      return {
        hook_event_name: value.hook_event_name,
        session_id: value.session_id,
        cwd: value.cwd === '\u0000' ? '' : value.cwd,
        tool_name: 'AskUserQuestion',
        tool_use_id: value.tool_use_id,
        tool_input: {},
      }
    return undefined
  }
}

/** Bound the input from the installed hook and signal oversized or unreadable tasks to the consent gate.
 * @example
 * const body = await readHookInput(process.stdin)
 */
export async function readHookInput(
  input: AsyncIterable<Buffer | string>,
): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  let envelope: HookEnvelopeReader | undefined
  try {
    for await (const part of input) {
      size += typeof part === 'string' ? Buffer.byteLength(part) : part.length
      if (!envelope && size <= 256 * 1024) {
        chunks.push(Buffer.isBuffer(part) ? part : Buffer.from(part))
        continue
      }
      if (!envelope) {
        envelope = new HookEnvelopeReader()
        for (const buffered of chunks) envelope.write(buffered)
        chunks.length = 0
      }
      envelope.write(part)
    }
    if (envelope) return envelope.finish()
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
  } catch {
    return undefined
  }
}

/** Execute a command from either the OpenClaw CLI or the packaged hook executable.
 * `hookExecutable` overrides the hook command recorded by setup; the OpenClaw CLI
 * passes the installed package's executable because it may run from a transient copy.
 * @example
 * await runCommand(["status"]);
 */
export async function runCommand(
  argv: readonly string[],
  defaultDir = dataDirectory(),
  hookExecutable?: string,
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
    // An unavailable hook leaves the original question in Claude's terminal.
    await runHook(
      directory,
      await readHookInput(process.stdin),
      (value) =>
        new Promise((ok, reject) =>
          process.stdout.write(value, (e) => (e ? reject(e) : ok())),
        ),
      undefined,
      extra,
    ).catch(() => undefined)
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
      hookExecutable,
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
): Promise<ObjectValue[]> {
  const rows: ObjectValue[] = []
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
    for (const receipt of page.rows) {
      if (!isObject(receipt) || typeof receipt.at !== 'number')
        throw Error('Invalid break review receipt.')
      rows.push(receipt)
    }
    breakId = page.breakId ?? undefined
    if (page.nextCursor && page.nextCursor === cursor)
      throw Error('Review cursor did not advance.')
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  // Pagination pins insertion order while a question can settle after a later card.
  return rows.sort((first, second) => Number(first.at) - Number(second.at))
}
