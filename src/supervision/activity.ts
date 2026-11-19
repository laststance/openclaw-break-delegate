import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { createConnection } from 'node:net'
import WebSocket from 'ws'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  nativeClient,
  object,
  RolloutDetector,
  rolloutMeta,
  type DetectorResult,
  type VerifiedReply,
} from './codex-rollout.js'
import type { Supervision } from './coordinator.js'
import type { Activity, Observation } from './workload.js'

const exec = promisify(execFile)
const packetLimit = 2 * 1024 * 1024
type RecordValue = Record<string, unknown>

/**
 * Translate documented Claude agent-view fields. An exited background job may still
 * report 'working'; only the live process status can establish running time.
 *
 * @example
 * parseClaudeAgents([{kind:'interactive',sessionId:'s',pid:123,status:'waiting'}])
 */
export function parseClaudeAgents(value: unknown): DetectorResult {
  if (!Array.isArray(value)) throw Error('Unexpected agent roster')
  const observations: Observation[] = []
  let misses = 0
  for (const item of value) {
    const row = object(item)
    if (
      !row ||
      typeof row.sessionId !== 'string' ||
      !['interactive', 'background'].includes(String(row.kind))
    ) {
      misses++
      continue
    }
    let status: Activity = 'unknown'
    if (row.kind === 'background' && row.state === 'blocked') status = 'waiting'
    if (Number.isInteger(row.pid) && Number(row.pid) > 0) {
      if (row.status === 'busy') status = 'running'
      else if (row.status === 'waiting') status = 'waiting'
      else if (row.status === 'idle') status = 'idle'
    }
    if (status === 'unknown') misses++
    observations.push({
      provider: 'claude',
      client: row.kind === 'interactive' ? 'cli' : 'background',
      sessionId: row.sessionId,
      status,
    })
  }
  return {
    observations,
    partial: misses > 0,
    detail:
      'Claude agent roster. Interactive hooks establish reply capability and human authorship.',
  }
}

/** App-server active flags describe work or an explicit block; unknown flags require a future adapter. */
export function codexStatus(value: unknown): Activity {
  const status = object(value)
  if (status?.type === 'idle') return 'idle'
  if (status?.type !== 'active' || !Array.isArray(status.activeFlags))
    return 'unknown'
  const flags = status.activeFlags
  if (
    flags.includes('waitingOnApproval') ||
    flags.includes('waitingOnUserInput')
  )
    return 'waiting'
  return flags.length === 0 ? 'running' : 'unknown'
}

/**
 * Read native thread metadata over the existing app-server Unix WebSocket. A local
 * socket connection cannot start a daemon or reach a remote endpoint. The observer
 * never resumes a thread, subscribes to one, or handles an agent's server request.
 */
async function codexMetadata(
  socket: string,
  timeout: number,
): Promise<{ rows: RecordValue[]; partial: boolean }> {
  const ws = new WebSocket('ws://localhost/', {
    createConnection: () => createConnection({ path: socket }),
    handshakeTimeout: timeout,
    maxPayload: packetLimit,
    perMessageDeflate: false,
    followRedirects: false,
  })
  const requests = new Map<
    number,
    { resolve: (value: RecordValue) => void; reject: (error: Error) => void }
  >()
  let id = 0,
    failure: Error | undefined
  const fail = (cause: Error) => {
    failure = cause
    for (const request of requests.values()) request.reject(cause)
    requests.clear()
  }
  ws.on('error', fail)
  ws.on('close', () => fail(Error('Codex metadata connection closed')))
  ws.on('message', (data, binary) => {
    if (binary) return
    let message: RecordValue | undefined
    try {
      message = object(JSON.parse(data.toString()))
    } catch {
      fail(Error('Invalid app-server packet'))
      ws.terminate()
      return
    }
    // An unsolicited server request must never be mistaken for a response to a read.
    if (!message || typeof message.id !== 'number' || message.method) return
    const waiter = requests.get(message.id)
    if (!waiter) return
    requests.delete(message.id)
    const result = object(message.result)
    if (message.error || !result)
      waiter.reject(Error('Codex metadata request unavailable'))
    else waiter.resolve(result)
  })
  const timer = setTimeout(() => {
    fail(Error('Codex metadata timeout'))
    ws.terminate()
  }, timeout)
  const request = (method: string, params: RecordValue) =>
    new Promise<RecordValue>((resolve, reject) => {
      if (failure) {
        reject(failure)
        return
      }
      const requestId = ++id
      requests.set(requestId, { resolve, reject })
      ws.send(JSON.stringify({ id: requestId, method, params }))
    })
  try {
    await once(ws, 'open')
    await request('initialize', {
      clientInfo: { name: 'openclaw-break-delegate', version: '0.1.0' },
    })
    ws.send('{"method":"initialized"}')
    const ids = new Set<string>(),
      cursors = new Set<string>()
    let cursor: string | null = null,
      partial = false
    do {
      const page = await request('thread/loaded/list', { cursor, limit: 64 })
      if (!Array.isArray(page.data)) throw Error('Unknown thread list format')
      for (const id of page.data) {
        if (typeof id !== 'string' || id.length > 256) {
          partial = true
          continue
        }
        if (ids.size >= 64) {
          partial = true
          break
        }
        ids.add(id)
      }
      cursor = typeof page.nextCursor === 'string' ? page.nextCursor : null
      if (
        cursor &&
        (cursors.has(cursor) || ids.size >= 64 || cursors.size >= 8)
      ) {
        partial = true
        break
      }
      if (cursor) cursors.add(cursor)
    } while (cursor)
    const rows: RecordValue[] = []
    await Promise.all(
      [...ids].map(async (threadId) => {
        try {
          const value = await request('thread/read', {
            threadId,
            includeTurns: false,
          })
          const row = object(value.thread)
          if (row && row.id === threadId) rows.push(row)
          else partial = true
        } catch {
          partial = true
        }
      }),
    )
    return { rows, partial }
  } finally {
    clearTimeout(timer)
    ws.terminate()
  }
}

/** Only writable descriptors on a named native Codex process witness a live rollout writer. */
export function openRolloutPaths(lsof: string): string[] {
  const paths = new Set<string>()
  let native = false,
    writable = false
  for (const field of lsof.split('\n')) {
    if (field.startsWith('p')) {
      native = false
      writable = false
    } else if (field.startsWith('c')) native = /^codex$/i.test(field.slice(1))
    else if (field.startsWith('f')) writable = false
    else if (field.startsWith('a'))
      writable = ['w', 'u'].includes(field.slice(1))
    else if (
      native &&
      writable &&
      field.startsWith('n') &&
      /\/rollout-[^/]+\.jsonl$/.test(field)
    )
      paths.add(field.slice(1))
  }
  return [...paths]
}

export interface LocalActivityOptions {
  now?: () => number
  env?: NodeJS.ProcessEnv
  codexHome?: string
  claudeBinary?: string
  codexSocket?: string
  commandTimeoutMs?: number
  /** Injectable local snapshots let acceptance tests exercise the production merge path. */
  readClaude?: () => Promise<DetectorResult>
  readCodex?: () => Promise<DetectorResult>
  readWriters?: () => Promise<string[]>
}

/**
 * Poll first-party local read surfaces for separate status and author-attribution evidence.
 * One surface failing never lets stale or stored activity stand in for a current known state.
 *
 * @example
 * const probe = new LocalActivityProbe()
 * await probe.poll(supervisor)
 */
export class LocalActivityProbe {
  readonly #options: LocalActivityOptions
  readonly #env: NodeJS.ProcessEnv
  readonly #home: string
  readonly #pendingReplies = new Map<string, VerifiedReply>()
  readonly #pendingExclusions = new Map<string, VerifiedReply>()
  readonly #detector: RolloutDetector
  readonly #now: () => number
  readonly #timeout: number

  constructor(options: LocalActivityOptions = {}) {
    this.#options = options
    this.#env = options.env ?? process.env
    this.#home =
      options.codexHome ?? this.#env.CODEX_HOME ?? join(homedir(), '.codex')
    this.#detector = new RolloutDetector(this.#home)
    this.#now = options.now ?? Date.now
    this.#timeout = options.commandTimeoutMs ?? 4500
  }

  async #claude() {
    if (this.#options.readClaude) return this.#options.readClaude()
    const { stdout } = await exec(
      this.#options.claudeBinary ?? 'claude',
      ['agents', '--json'],
      { env: this.#env, timeout: this.#timeout, maxBuffer: packetLimit },
    )
    return parseClaudeAgents(JSON.parse(stdout))
  }

  async #codex(): Promise<DetectorResult> {
    if (this.#options.readCodex) return this.#options.readCodex()
    const socket =
      this.#options.codexSocket ??
      join(this.#home, 'app-server-control', 'app-server-control.sock')
    const { rows, partial } = await codexMetadata(socket, this.#timeout)
    const observations: Observation[] = []
    let missed = partial
    for (const row of rows) {
      let client = nativeClient(row)
      // VS Code and Codex Desktop share a protocol source name; use the native originator.
      if (!client && row.source === 'vscode' && typeof row.path === 'string') {
        const meta = await rolloutMeta(row.path, this.#home).catch(
          () => undefined,
        )
        if (meta?.id === row.id && meta) client = nativeClient(meta)
      }
      if (!client) {
        if (row.source === 'vscode' || !row.source) missed = true
        continue
      }
      const status = codexStatus(row.status)
      if (status === 'unknown') missed = true
      observations.push({
        provider: 'codex',
        client,
        sessionId: String(row.id),
        status,
      })
    }
    return {
      observations,
      partial: missed,
      detail:
        'Existing app-server only. Stored/notLoaded threads and unrelated daemons have unknown activity.',
    }
  }

  async #writers(): Promise<DetectorResult> {
    if (this.#options.readWriters)
      return this.#detector.read(await this.#options.readWriters())
    const uid = process.getuid?.()
    if (uid === undefined) throw Error('Local process ownership unavailable')
    let output: string
    try {
      const { stdout } = await exec(
        process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof',
        ['-nP', '-a', '-u', String(uid), '-c', 'codex', '-Fpcfan'],
        { env: this.#env, timeout: this.#timeout, maxBuffer: 8 * 1024 * 1024 },
      )
      output = stdout
    } catch (cause) {
      // lsof uses exit 1 for an empty selection and also for incomplete enumeration.
      if (object(cause)?.code === 1 && !object(cause)?.stderr)
        output = String(object(cause)?.stdout ?? '')
      else throw cause
    }
    const result = await this.#detector.read(openRolloutPaths(output))
    if (result.observations.length === 0)
      return {
        ...result,
        partial: true,
        detail:
          'No identifiable native rollout writer. Private CLI/Desktop processes without a visible live status have unknown activity.',
      }
    return result
  }

  async poll(supervision: Supervision): Promise<void> {
    const at = this.#now()
    const sources: [string, Promise<DetectorResult>][] = [
      ['claude-agents', this.#claude()],
      ['codex-app-server', this.#codex()],
      ['codex-rollouts', this.#writers()],
    ]
    const results = await Promise.allSettled(sources.map(([, read]) => read))
    // Readers have advanced their offsets. Retain every witnessed reply before a snapshot can fail.
    for (const result of results) {
      if (result.status !== 'fulfilled') continue
      for (const reply of result.value.excludedReplies ?? []) {
        this.#pendingReplies.delete(reply.originId)
        this.#pendingExclusions.set(reply.originId, reply)
      }
      for (const reply of result.value.replies ?? [])
        if (
          !this.#pendingExclusions.has(reply.originId) &&
          !this.#pendingReplies.get(reply.originId)?.observedLive
        )
          this.#pendingReplies.set(reply.originId, reply)
    }
    for (const [i, result] of results.entries()) {
      const source = sources[i][0]
      if (result.status === 'rejected') {
        supervision.snapshot(source, [], {
          at,
          status: 'unavailable',
          detail:
            'Local read unavailable. This observer cannot confirm activity.',
        })
        continue
      }
      const { observations, partial, detail } = result.value
      supervision.snapshot(source, observations, {
        at,
        status: partial ? 'partial' : 'available',
        detail,
      })
    }
    for (const [id, reply] of this.#pendingExclusions) {
      supervision.retractHumanReply({ provider: 'codex', ...reply })
      this.#pendingExclusions.delete(id)
    }
    for (const [id, reply] of this.#pendingReplies) {
      supervision.humanReply({ provider: 'codex', ...reply })
      // An idempotent duplicate or an expired response is also fully processed.
      this.#pendingReplies.delete(id)
    }
  }
}
