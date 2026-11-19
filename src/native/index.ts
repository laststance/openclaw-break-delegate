import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { dataDirectory, isObject } from '../ipc.js'

export interface NativeAction {
  kind: 'start' | 'snooze' | 'dismiss' | 'return'
  id: string
}

export interface NativeStatus {
  status: 'authorized' | 'not-determined' | 'denied' | 'unavailable'
  detail?: string
}

export interface NativeReview {
  answered: ReadonlyArray<{ question: string; answer: string }>
  held: ReadonlyArray<{ question: string; reason: string }>
}

export interface NativeBreakUi {
  status(): Promise<NativeStatus>
  authorize(): Promise<NativeStatus>
  invite(invitationId: string): Promise<NativeStatus>
  active(breakId: string, endsAtEpochMs: number): Promise<NativeStatus>
  summary(breakId: string, review: NativeReview): Promise<NativeStatus>
  clear(): Promise<NativeStatus>
  close(): void
}

type StatusCommand = { kind: 'status' | 'authorize' | 'clear' }
type ReviewPreview = NativeReview & { answeredTotal: number; heldTotal: number }
type Presentation =
  | { kind: 'invite'; id: string }
  | { kind: 'active'; id: string; endsAt: number }
  | { kind: 'summary'; id: string; review: ReviewPreview }
type Command = StatusCommand | Presentation
type Helper = ChildProcessByStdio<Writable, Readable, null>
type ActionHandler = (action: NativeAction) => void | Promise<void>
type LaunchOptions = {
  profileDirectory?: string
  launch?: (profileKey: string) => Helper
  timeoutMs?: number
  retryMs?: number
}
type Pending = { finish: (status: NativeStatus) => void; timer: NodeJS.Timeout }

const executable = fileURLToPath(
  new URL(
    '../../native/generated/BreakDelegate.app/Contents/MacOS/BreakDelegate',
    import.meta.url,
  ),
)
const unavailable = (detail: string): NativeStatus => ({
  status: 'unavailable',
  detail,
})
const statuses = new Set([
  'authorized',
  'not-determined',
  'denied',
  'unavailable',
])

/**
 * Launches the bundled app in the gateway's login session using private inherited pipes.
 * The helper only receives the user/locale environment required by macOS.
 *
 * @example
 * const child = launchHelper(profileKey);
 */
function launchHelper(profileKey: string): Helper {
  if (process.platform !== 'darwin')
    throw new Error('Native notifications require a macOS desktop session.')
  try {
    accessSync(executable, constants.X_OK)
  } catch {
    throw new Error(
      'The signed Break Delegate app is missing or cannot be executed. Install a package containing the native helper.',
    )
  }
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }
  for (const key of [
    'HOME',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    '__CF_USER_TEXT_ENCODING',
  ]) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return spawn(executable, ['--bridge', profileKey], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env,
  })
}

/**
 * Builds a bounded window preview. The gateway keeps the complete review for its local CLI.
 *
 * @example
 * const preview = previewReview({ answered: [], held: [] });
 */
function previewReview(review: NativeReview): ReviewPreview {
  function field(value: string): string {
    const clean = value
      .slice(0, 1026)
      .replace(/[\uD800-\uDFFF]/gu, '�')
      .replace(/[\p{Cc}]+/gu, ' ')
      .trim()
    const points = Array.from(clean)
    return points.length > 512 || value.length > 1026
      ? points.slice(0, 512).join('') + '…'
      : clean
  }
  function rows<T, R>(entries: readonly T[], select: (entry: T) => R): R[] {
    const result: R[] = []
    let bytes = 0
    // Reserve a separate budget for each section so both remain visible on large breaks.
    for (const entry of entries.slice(0, 40)) {
      const row = select(entry)
      bytes += Buffer.byteLength(JSON.stringify(row)) + 1
      if (bytes > 24_000) break
      result.push(row)
    }
    return result
  }
  return {
    answered: rows(review.answered, (x) => ({
      question: field(x.question),
      answer: field(x.answer),
    })),
    held: rows(review.held, (x) => ({
      question: field(x.question),
      reason: field(x.reason),
    })),
    answeredTotal: review.answered.length,
    heldTotal: review.held.length,
  }
}

/**
 * Connects the gateway's consent state to the macOS invitation, menu and return review.
 * The gateway supplies a callback that rechecks the durable invitation or break before acting.
 * After a gateway restart the caller restores its current surface from persistent state.
 *
 * @example
 * const ui = createNativeBreakUi((action) => recordOwnerChoice(action), { profileDirectory });
 * await ui.invite(invitationId);
 * ui.close();
 */
export function createNativeBreakUi(
  onAction: ActionHandler,
  options: LaunchOptions = {},
): NativeBreakUi {
  let child: Helper | undefined
  let desired: Presentation | undefined
  let closed = false
  let sequence = 0
  let failures = 0
  let retry: NodeJS.Timeout | undefined
  const pending = new Map<number, Pending>()
  const timeoutMs = options.timeoutMs ?? 8_000
  // Match the gateway's normalized profile path without exposing a folder name on a banner or in argv.
  const profileKey = createHash('sha256')
    .update(resolve(options.profileDirectory ?? dataDirectory()))
    .digest('hex')

  function retire(instance: Helper): void {
    instance.stdin.end()
    // EOF allows AppKit to withdraw its banner and menu. Bound cleanup of a stuck process.
    const force = setTimeout(() => {
      if (instance.exitCode === null && instance.signalCode === null)
        instance.kill('SIGKILL')
    }, 1_000)
    force.unref()
    instance.once('close', () => clearTimeout(force))
  }

  function disconnect(
    instance: Helper,
    result: NativeStatus,
    retryable: boolean,
  ): void {
    if (child !== instance) return
    child = undefined
    for (const receipt of pending.values()) {
      clearTimeout(receipt.timer)
      receipt.finish(result)
    }
    pending.clear()
    if (closed || !desired || !retryable) return
    const delay = Math.min(
      60_000,
      (options.retryMs ?? 1_000) * 2 ** Math.min(failures++, 6),
    )
    retry = setTimeout(() => {
      retry = undefined
      if (desired) void dispatch(desired)
    }, delay)
    retry.unref()
  }

  function receive(instance: Helper, frame: unknown): void {
    if (child !== instance || !isObject(frame)) return
    if (frame.type === 'offline') {
      const detail =
        typeof frame.detail === 'string'
          ? frame.detail.slice(0, 300)
          : 'macOS notifications are unavailable.'
      disconnect(instance, unavailable(detail), false)
      retire(instance)
      return
    }
    if (
      frame.type === 'result' &&
      typeof frame.request === 'number' &&
      typeof frame.status === 'string' &&
      statuses.has(frame.status)
    ) {
      const receipt = pending.get(frame.request)
      if (!receipt) return
      pending.delete(frame.request)
      clearTimeout(receipt.timer)
      failures = 0
      const result: NativeStatus = {
        status: frame.status as NativeStatus['status'],
      }
      if (typeof frame.detail === 'string')
        result.detail = frame.detail.slice(0, 300)
      receipt.finish(result)
      return
    }
    if (frame.type !== 'action' || !desired || frame.id !== desired.id) return
    const { kind } = frame
    const inviteChoice =
      desired.kind === 'invite' &&
      (kind === 'start' || kind === 'snooze' || kind === 'dismiss')
    const earlyReturn =
      desired.kind === 'active' &&
      kind === 'return' &&
      desired.endsAt > Date.now()
    if (!inviteChoice && !earlyReturn) return
    const id = desired.id
    desired = undefined
    // Consume synchronously before handing off so duplicate frames cannot start a second break.
    void Promise.resolve()
      .then(() => onAction({ kind, id }))
      .catch(() => {
        // A failed owner callback has an unknown outcome and must never be replayed automatically.
      })
  }

  function connect(): Helper {
    if (child) return child
    if (retry) clearTimeout(retry)
    retry = undefined
    const instance = (options.launch ?? launchHelper)(profileKey)
    child = instance
    let buffer = ''
    const fail = () =>
      disconnect(
        instance,
        unavailable(
          'The macOS helper disconnected. Check the local gateway session.',
        ),
        true,
      )
    instance.once('error', fail)
    instance.once('close', fail)
    const streamFailed = () => {
      fail()
      retire(instance)
    }
    instance.stdin.on('error', streamFailed)
    instance.stdout.on('error', streamFailed)
    instance.stdout.setEncoding('utf8')
    instance.stdout.on('data', (chunk: string) => {
      if (child !== instance) return
      buffer += chunk
      try {
        let end = buffer.indexOf('\n')
        while (end !== -1) {
          if (end > 4096) throw new Error('Oversized helper frame')
          receive(instance, JSON.parse(buffer.slice(0, end)))
          buffer = buffer.slice(end + 1)
          end = buffer.indexOf('\n')
        }
        if (buffer.length > 4096) throw new Error('Incomplete helper frame')
      } catch {
        fail()
        retire(instance)
      }
    })
    return instance
  }

  function write(instance: Helper, command: Command): Promise<NativeStatus> {
    if (pending.size >= 32)
      return Promise.resolve(unavailable('The macOS helper is busy.'))
    const request = ++sequence
    return new Promise((finish) => {
      const delay =
        command.kind === 'authorize' ? Math.max(timeoutMs, 120_000) : timeoutMs
      const timer = setTimeout(() => {
        disconnect(
          instance,
          unavailable('Timed out waiting for the macOS notification helper.'),
          true,
        )
        retire(instance)
      }, delay)
      timer.unref()
      pending.set(request, { finish, timer })
      instance.stdin.write(JSON.stringify({ request, ...command }) + '\n')
    })
  }

  function dispatch(command: Command): Promise<NativeStatus> {
    if (closed)
      return Promise.resolve(
        unavailable('The macOS notification connection is closed.'),
      )
    try {
      const fresh = !child
      const instance = connect()
      // A status query can reconnect before the scheduled retry. Restore its outstanding surface first.
      if (fresh && desired && command !== desired) void write(instance, desired)
      return write(instance, command)
    } catch (error) {
      return Promise.resolve(
        unavailable(
          error instanceof Error
            ? error.message
            : 'The macOS helper could not start.',
        ),
      )
    }
  }

  function present(surface: Presentation): Promise<NativeStatus> {
    if (closed)
      return Promise.resolve(
        unavailable('The macOS notification connection is closed.'),
      )
    if (
      !surface.id ||
      Buffer.byteLength(surface.id) > 128 ||
      /\p{Cc}/u.test(surface.id)
    ) {
      return Promise.resolve(
        unavailable('Invalid native presentation identifier.'),
      )
    }
    if (
      surface.kind === 'active' &&
      (!Number.isSafeInteger(surface.endsAt) ||
        surface.endsAt <= Date.now() ||
        surface.endsAt > 8.64e15)
    ) {
      return Promise.resolve(
        unavailable('This break has already ended or has an invalid deadline.'),
      )
    }
    desired = surface
    return dispatch(surface)
  }

  return {
    status: () => dispatch({ kind: 'status' }),
    authorize: () => dispatch({ kind: 'authorize' }),
    invite: (id) => present({ kind: 'invite', id }),
    active: (id, endsAt) => present({ kind: 'active', id, endsAt }),
    summary: (id, review) =>
      present({ kind: 'summary', id, review: previewReview(review) }),
    clear() {
      desired = undefined
      if (retry) clearTimeout(retry)
      return dispatch({ kind: 'clear' })
    },
    close() {
      closed = true
      desired = undefined
      if (retry) clearTimeout(retry)
      if (child) {
        const instance = child
        disconnect(
          instance,
          unavailable('The macOS notification connection is closed.'),
          false,
        )
        retire(instance)
      }
    },
  }
}
