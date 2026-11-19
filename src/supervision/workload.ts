import type { DatabaseSync } from 'node:sqlite'

export type Provider = 'claude' | 'codex'
export type NativeClient = 'desktop' | 'cli' | 'background'
export type Activity = 'running' | 'waiting' | 'idle' | 'unknown' | 'closed'
export interface Observation {
  provider: Provider
  client?: NativeClient
  sessionId: string
  status: Activity
  source?: string
  /** Only an authenticated, interactive Claude lifecycle hook grants this capability. */
  canDelegate?: boolean
  incarnation?: string
  newSession?: boolean
  /** True only for the original main-agent Stop hook. */
  turnEnded?: boolean
  /** Provider observation time, in Unix milliseconds. */
  at?: number
}

interface Sample {
  status: Activity
  at: number
  until: number
}
interface MeasuredState {
  samples: Map<string, Sample>
  waiting: { size: number }
  closed: boolean
  missingFromRosterAt?: number
}
interface Change {
  at: number
  source?: string
  sample?: Sample
  waiting?: number
  closed?: boolean
  absent?: boolean
}
function emptyMeasurement(): MeasuredState {
  return { samples: new Map(), waiting: { size: 0 }, closed: false }
}
function applyMeasurement(state: MeasuredState, c: Change) {
  if (c.source) {
    if (c.sample) state.samples.set(c.source, c.sample)
    else state.samples.delete(c.source)
  }
  if (c.waiting !== undefined) state.waiting = { size: c.waiting }
  if (c.closed !== undefined) state.closed = c.closed
  if (c.absent !== undefined)
    state.missingFromRosterAt = c.absent ? c.at : undefined
}
interface Session {
  provider: Provider
  client?: NativeClient
  sessionId: string
  generation: string
  incarnation?: string
  canDelegate: boolean
  closed: boolean
  missingFromRosterAt?: number
  samples: Map<string, Sample>
  waiting: Set<string>
  accountedAt: number
  lastHook: number
  runId?: number
  baseline: MeasuredState
  baselineAt: number
  changes: Change[]
  runs: Map<number, { start: number; finish: number }>
}

export interface SessionView {
  provider: Provider
  client?: NativeClient
  sessionId: string
  generation: string
  canDelegate: boolean
  status: Activity
}

interface Weights {
  active: number
  additional: number
  reply: number
}
export const minute = 60_000

/**
 * Resolve independent views of one provider session at a single instant.
 * Blocked cards and explicit user waits take precedence over concurrent views reporting work.
 */
function statusAt(
  session: MeasuredState,
  at: number,
  includeUnconfirmedWaits = true,
): Activity {
  if (session.closed) return 'closed'
  if (includeUnconfirmedWaits && session.waiting.size) return 'waiting'
  const live = [...session.samples.entries()].filter(
    ([, s]) => s.at <= at && at < s.until,
  )
  const known = live.filter(
    ([, s]) => s.status !== 'unknown' && s.status !== 'closed',
  )
  if (known.length === 0) return 'unknown'
  if (
    session.missingFromRosterAt !== undefined &&
    known.every(([, sample]) => sample.at <= session.missingFromRosterAt!)
  )
    return 'unknown'
  if (session.waiting.size > 0) return 'waiting'
  const hook = known.find(([source]) => source === 'hook')?.[1]
  if (hook?.status === 'waiting') return 'waiting'
  // A newer lifecycle hook wins over a snapshot already in flight when the hook fired.
  const latestProbe = known.filter(([source]) => source !== 'hook')
  if (hook && latestProbe.every(([, s]) => s.at <= hook.at)) return hook.status
  const current = latestProbe.filter(([, s]) => !hook || s.at > hook.at)
  // App-server and direct runtime views may cover the same Codex thread.
  if (current.some(([, s]) => s.status === 'waiting')) return 'waiting'
  if (current.some(([, s]) => s.status === 'running')) return 'running'
  return 'idle'
}

/**
 * Account only for time backed by a fresh observation of a particular provider session.
 * The gateway checkpoints periodically and on lifecycle changes. SQLite keeps the already
 * measured intervals across a restart without extrapolating across the outage.
 *
 * @example
 * workload.observe({ provider: 'codex', sessionId: 'thread', status: 'running' }, now, 'generation')
 */
export class Workload {
  readonly #db: DatabaseSync
  readonly #freshMs: number
  readonly #weights: Weights
  #sessions = new Map<string, Session>()

  constructor(db: DatabaseSync, freshMs: number, weights: Weights) {
    this.#db = db
    this.#freshMs = freshMs
    this.#weights = weights
  }

  /**
   * Stage the live cursors, run IDs and session observations with the SQLite write.
   * Samples are immutable values. Each staged session owns its mutable maps and sets.
   * A statement or commit failure restores the whole previous view for a safe retry.
   * @example workload.transaction(() => commitMeasuredIntervals())
   */
  transaction<T>(write: () => T): T {
    const committed = this.#sessions
    this.#sessions = new Map(
      Array.from(committed, ([key, session]) => [
        key,
        {
          ...session,
          changes: [...session.changes],
          runs: new Map(session.runs),
          samples: new Map(session.samples),
          waiting: new Set(session.waiting),
        },
      ]),
    )
    try {
      return write()
    } catch (error) {
      this.#sessions = committed
      throw error
    }
  }

  /** A clock rollback starts a fresh measured window; old absolute times cannot be recredited later. */
  resetClock(now: number): void {
    this.#db.exec(
      'DELETE FROM sv_runs; UPDATE sv_replies SET credited=0 WHERE credited=1',
    )
    for (const session of this.#sessions.values()) {
      session.accountedAt = now
      session.runId = undefined
      session.baseline = {
        ...emptyMeasurement(),
        closed: session.closed,
        waiting: { size: session.waiting.size },
      }
      session.baselineAt = now
      session.changes = []
      session.runs.clear()
      session.lastHook = -Infinity
      session.missingFromRosterAt = undefined
      session.samples.clear()
    }
  }

  #key(provider: Provider, sessionId: string) {
    return JSON.stringify([provider, sessionId])
  }

  /** Integrate at transitions and freshness deadlines, including when the Mac wakes late. */
  checkpoint(now: number): void {
    for (const [key, session] of this.#sessions) {
      this.#account(session, now)
      this.#trim(session, now - Math.min(this.#freshMs, 60 * minute))
      // Keep the incarnation for a live card until its terminal confirms closure.
      if (
        !session.waiting.size &&
        [...session.samples.values()].every(
          (sample) => sample.until < now - 60 * minute,
        )
      )
        this.#sessions.delete(key)
    }
    this.#db
      .prepare('DELETE FROM sv_runs WHERE finish < ?')
      .run(now - 60 * minute)
  }

  /** Retain transitions only while an accepted provider observation can still correct this interval. */
  #trim(session: Session, floor: number) {
    if (floor <= session.baselineAt) return
    const n = session.changes.findIndex((c) => c.at >= floor)
    const before = n < 0 ? session.changes.length : n
    if (before) {
      const base = {
        ...session.baseline,
        samples: new Map(session.baseline.samples),
      }
      for (const c of session.changes.splice(0, before))
        applyMeasurement(base, c)
      session.baseline = base
    }
    session.baselineAt = floor
    for (const [id, run] of session.runs)
      if (run.finish < floor) session.runs.delete(id)
  }

  /** A delayed state change can correct intervals already measured by an intervening gateway tick.
   * Rewind only this generation's own rows and replay other sources and card transitions in time order.
   */
  #measure(session: Session, change: Change, now: number) {
    const at = Math.max(change.at, session.baselineAt)
    session.changes.push({ ...change, at })
    if (at < session.accountedAt) {
      session.changes.sort((a, b) => a.at - b.at)
      for (const [id, run] of session.runs) {
        if (run.finish <= at) continue
        if (run.start < at) {
          this.#db.prepare('UPDATE sv_runs SET finish=? WHERE id=?').run(at, id)
          session.runs.set(id, { start: run.start, finish: at })
        } else {
          this.#db.prepare('DELETE FROM sv_runs WHERE id=?').run(id)
          session.runs.delete(id)
        }
      }
      session.accountedAt = at
      session.runId = undefined
    }
    this.#account(session, now)
  }

  #account(session: Session, now: number) {
    if (now <= session.accountedAt) return
    const cuts = new Set([session.accountedAt, now])
    const within = (point: number) => {
      if (point > session.accountedAt && point < now) cuts.add(point)
    }
    const state = {
      ...session.baseline,
      samples: new Map(session.baseline.samples),
    }
    for (const sample of state.samples.values()) within(sample.until)
    for (const c of session.changes) {
      within(c.at)
      if (c.sample) within(c.sample.until)
    }
    const points = [...cuts].sort((a, b) => a - b)
    let index = 0
    for (let i = 1; i < points.length; i++) {
      const start = points[i - 1],
        end = points[i]
      while (
        index < session.changes.length &&
        session.changes[index].at <= start
      )
        applyMeasurement(state, session.changes[index++])
      if (statusAt(state, start) !== 'running') {
        session.runId = undefined
        continue
      }
      if (session.runId === undefined) {
        const row = this.#db
          .prepare('INSERT INTO sv_runs(start,finish) VALUES(?,?)')
          .run(start, end)
        session.runId = Number(row.lastInsertRowid)
        session.runs.set(session.runId, { start, finish: end })
      } else {
        this.#db
          .prepare('UPDATE sv_runs SET finish=? WHERE id=?')
          .run(end, session.runId)
        session.runs.set(session.runId, {
          start: session.runs.get(session.runId)!.start,
          finish: end,
        })
      }
    }
    session.accountedAt = now
  }

  /** A current native observation may reattach an original terminal; a superseded timestamp cannot. */
  isFresh(at: number, now: number): boolean {
    return Number.isFinite(at) && at <= now && at + this.#freshMs > now
  }

  /** Accept a trusted lifecycle transition or a dated provider snapshot. */
  observe(event: Observation, now: number, newGeneration: string): void {
    const at = event.at ?? now
    if (!event.sessionId || !this.isFresh(at, now)) return
    const source = event.source ?? 'hook'
    const key = this.#key(event.provider, event.sessionId)
    let session = this.#sessions.get(key)
    if (session) {
      this.#account(session, now)
      if (at < (session.samples.get(source)?.at ?? -Infinity)) return
      if (source === 'hook' && at < session.lastHook) return
      // A late event from a former terminal cannot supersede the current incarnation.
      if (
        event.incarnation &&
        session.incarnation &&
        event.incarnation !== session.incarnation &&
        !event.newSession
      )
        return
      if (session.closed && !event.newSession) return
    }
    const starting = source === 'hook' && event.newSession === true
    const sameTerminal =
      session &&
      !session.closed &&
      !!event.incarnation &&
      session.incarnation === event.incarnation
    // A duplicate or delayed SessionStart cannot erase a newer workload state or a live card.
    if (
      starting &&
      session &&
      sameTerminal &&
      statusAt(session, now, false) !== 'unknown'
    )
      return
    if (!session || (starting && !sameTerminal)) {
      if (session) this.#measure(session, { at, closed: true }, now)
      session = {
        provider: event.provider,
        sessionId: event.sessionId,
        generation: newGeneration,
        incarnation: event.incarnation,
        canDelegate: false,
        closed: false,
        samples: new Map(),
        waiting: new Set(),
        accountedAt: at,
        baseline: emptyMeasurement(),
        baselineAt: session ? at : now - Math.min(this.#freshMs, 60 * minute),
        changes: [],
        runs: new Map(),
        lastHook: -Infinity,
      }
      this.#sessions.set(key, session)
    }
    if (source === 'hook') {
      session.lastHook = at
      if (event.incarnation) session.incarnation = event.incarnation
      if (event.canDelegate !== undefined)
        session.canDelegate = event.provider === 'claude' && event.canDelegate
      if (event.status === 'closed') {
        session.closed = true
        session.canDelegate = false
        session.waiting.clear()
      }
    }
    if (event.client) session.client = event.client
    else if (
      source === 'hook' &&
      event.provider === 'claude' &&
      event.canDelegate
    )
      session.client = 'cli'
    const sample = { status: event.status, at, until: at + this.#freshMs }
    session.samples.set(source, sample)
    this.#measure(
      session,
      {
        at,
        source,
        sample,
        ...(session.closed ? { closed: true, waiting: 0 } : {}),
      },
      now,
    )
  }

  /** A successful complete poll can explicitly withdraw a previously reported view. */
  replaceSource(
    source: string,
    observations: Observation[],
    at: number,
    now: number,
    nextId: () => string,
    completeRoster: boolean,
  ): void {
    const found = new Set(
      observations.map((o) => this.#key(o.provider, o.sessionId)),
    )
    for (const [key, session] of this.#sessions) {
      if (
        completeRoster &&
        source === 'claude-agents' &&
        session.provider === 'claude' &&
        !found.has(key)
      ) {
        session.missingFromRosterAt = at
        this.#measure(session, { at, absent: true }, now)
      }
      const previous = session.samples.get(source)
      if (completeRoster && previous && previous.at <= at && !found.has(key)) {
        session.samples.delete(source)
        this.#measure(session, { at, source }, now)
      }
    }
    for (const observation of observations) {
      this.observe({ ...observation, source, at }, now, nextId())
      const current = this.#sessions.get(
        this.#key(observation.provider, observation.sessionId),
      )
      if (
        source === 'claude-agents' &&
        current?.missingFromRosterAt !== undefined &&
        current.missingFromRosterAt <= at
      ) {
        current.missingFromRosterAt = undefined
        this.#measure(current, { at, absent: false }, now)
      }
    }
  }

  /** Detach a long-unconfirmed incarnation without changing any durable card or break membership. */
  detach(generations: ReadonlySet<string>): void {
    if (!generations.size) return
    for (const [key, session] of this.#sessions)
      if (generations.has(session.generation)) this.#sessions.delete(key)
  }

  /** Reattach the original generation only after an authenticated native hook identifies it. */
  restore(
    id: string,
    incarnation: string,
    generation: string,
    questions: string[],
    now: number,
  ): void {
    const key = this.#key('claude', id)
    const existing = this.#sessions.get(key)
    if (existing?.incarnation) return
    if (!existing)
      this.observe(
        {
          provider: 'claude',
          sessionId: id,
          status: 'unknown',
          source: 'restored',
        },
        now,
        generation,
      )
    const session = this.#sessions.get(key)!
    session.incarnation = incarnation
    session.generation = generation
    for (const question of questions) session.waiting.add(question)
    this.#measure(session, { at: now, waiting: session.waiting.size }, now)
  }

  /** Return the matching open incarnation at the gate for a Claude question or commit. */
  claude(
    id: string,
    incarnation: string | undefined,
    now: number,
  ): SessionView | undefined {
    const session = this.#sessions.get(this.#key('claude', id))
    if (
      !session ||
      session.closed ||
      (incarnation && session.incarnation !== incarnation)
    )
      return
    return {
      provider: 'claude',
      client: session.client,
      sessionId: id,
      generation: session.generation,
      canDelegate: session.canDelegate,
      status: statusAt(session, now, false),
    }
  }

  /** The actual pending card stays blocked across unrelated tool hooks and provider polls. */
  setWaiting(id: string, question: string, waiting: boolean, now: number) {
    const session = this.#sessions.get(this.#key('claude', id))
    if (!session) return
    this.#account(session, now)
    if (session.waiting.has(question) === waiting) return
    if (waiting) session.waiting.add(question)
    else session.waiting.delete(question)
    this.#measure(session, { at: now, waiting: session.waiting.size }, now)
  }

  views(now: number, includeUnconfirmedWaits = true): SessionView[] {
    return [...this.#sessions.values()].map((s) => ({
      provider: s.provider,
      client: s.client,
      sessionId: s.sessionId,
      generation: s.generation,
      canDelegate: s.canDelegate,
      status: statusAt(s, now, includeUnconfirmedWaits),
    }))
  }

  /**
   * Integrate the union and overlap of measured running intervals, clipped to this window.
   * The sweep credits the first running session once, including across a change of tabs.
   */
  score(now: number, resetAt: number) {
    const floor = Math.max(now - 60 * minute, resetAt)
    const rows = this.#db
      .prepare('SELECT start,finish FROM sv_runs WHERE finish>? AND start<?')
      .all(floor, now)
    const edges = new Map<number, number>()
    for (const row of rows) {
      const start = Math.max(floor, Number(row.start)),
        end = Math.min(now, Number(row.finish))
      edges.set(start, (edges.get(start) ?? 0) + 1)
      edges.set(end, (edges.get(end) ?? 0) - 1)
    }
    let count = 0,
      last = floor,
      duration = 0
    for (const [at, delta] of [...edges].sort(([a], [b]) => a - b)) {
      if (count > 0)
        duration +=
          ((at - last) / minute) *
          (this.#weights.active + (count - 1) * this.#weights.additional)
      count += delta
      last = at
    }
    const replies = this.#db
      .prepare(
        'SELECT COUNT(*) AS n FROM sv_replies WHERE credited=1 AND at>? AND at>=? AND at<=?',
      )
      .get(now - 60 * minute, resetAt, now)
    return (
      Math.round(
        (duration + Number(replies?.n ?? 0) * this.#weights.reply) * 1e6,
      ) / 1e6
    )
  }
}
