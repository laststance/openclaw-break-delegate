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
  /** Provider observation time, in Unix milliseconds. */
  at?: number
}

interface Sample {
  status: Activity
  at: number
  until: number
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
function statusAt(session: Session, at: number): Activity {
  if (session.closed) return 'closed'
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
  readonly #sessions = new Map<string, Session>()

  constructor(db: DatabaseSync, freshMs: number, weights: Weights) {
    this.#db = db
    this.#freshMs = freshMs
    this.#weights = weights
  }

  #key(provider: Provider, sessionId: string) {
    return JSON.stringify([provider, sessionId])
  }

  /** Integrate at transitions and freshness deadlines, including when the Mac wakes late. */
  checkpoint(now: number): void {
    for (const [key, session] of this.#sessions) {
      this.#account(session, now)
      // Forget inactive process identities once their entire scoring window has elapsed.
      if (
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

  #account(session: Session, now: number) {
    if (now <= session.accountedAt) return
    const cuts = new Set([session.accountedAt, now])
    for (const sample of session.samples.values()) {
      if (sample.until > session.accountedAt && sample.until < now)
        cuts.add(sample.until)
    }
    const points = [...cuts].sort((a, b) => a - b)
    for (let i = 1; i < points.length; i++) {
      const start = points[i - 1],
        end = points[i]
      if (statusAt(session, start) !== 'running') {
        session.runId = undefined
        continue
      }
      if (session.runId === undefined) {
        const row = this.#db
          .prepare('INSERT INTO sv_runs(start,finish) VALUES(?,?)')
          .run(start, end)
        session.runId = Number(row.lastInsertRowid)
      } else {
        this.#db
          .prepare('UPDATE sv_runs SET finish=? WHERE id=?')
          .run(end, session.runId)
      }
    }
    session.accountedAt = now
  }

  /** Accept a trusted lifecycle transition or a dated provider snapshot. */
  observe(event: Observation, now: number, newGeneration: string): void {
    const at = event.at ?? now
    if (
      !event.sessionId ||
      !Number.isFinite(at) ||
      at > now ||
      at + this.#freshMs <= now
    )
      return
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
    if (!session || (source === 'hook' && event.newSession)) {
      session = {
        provider: event.provider,
        sessionId: event.sessionId,
        generation: newGeneration,
        incarnation: event.incarnation,
        canDelegate: false,
        closed: false,
        samples: new Map(),
        waiting: new Set(),
        accountedAt: now,
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
    session.samples.set(source, {
      status: event.status,
      at,
      until: at + this.#freshMs,
    })
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
        this.#account(session, now)
        session.missingFromRosterAt = at
      }
      const previous = session.samples.get(source)
      if (previous && previous.at <= at && !found.has(key)) {
        this.#account(session, now)
        session.samples.delete(source)
      }
    }
    for (const observation of observations) {
      this.observe({ ...observation, source, at }, now, nextId())
      const current = this.#sessions.get(
        this.#key(observation.provider, observation.sessionId),
      )
      if (
        source === 'claude-agents' &&
        current &&
        (current.missingFromRosterAt ?? -Infinity) <= at
      )
        current.missingFromRosterAt = undefined
    }
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
      status: statusAt(session, now),
    }
  }

  /** The actual pending card stays blocked across unrelated tool hooks and provider polls. */
  setWaiting(id: string, question: string, waiting: boolean, now: number) {
    const session = this.#sessions.get(this.#key('claude', id))
    if (!session) return
    this.#account(session, now)
    if (waiting) session.waiting.add(question)
    else session.waiting.delete(question)
  }

  views(now: number): SessionView[] {
    return [...this.#sessions.values()].map((s) => ({
      provider: s.provider,
      client: s.client,
      sessionId: s.sessionId,
      generation: s.generation,
      canDelegate: s.canDelegate,
      status: statusAt(s, now),
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
