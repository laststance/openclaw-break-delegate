import { createHash } from 'node:crypto'

export interface ExecutionObservation {
  event:
    'PreToolUse' | 'PermissionRequest' | 'PostToolUse' | 'PostToolUseFailure'
  sessionId: string
  incarnation: string
  toolName: string
  toolUseId?: string
  fingerprint?: string
  at?: number
}

/**
 * Hash the canonical JSON for an invocation on the hook side of the local socket.
 * Object property order can vary across hook events, while array order remains significant.
 * @example toolInputFingerprint({ command: 'pnpm test' })
 */
export function toolInputFingerprint(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    return
  try {
    const text = JSON.stringify(input, (_, value: unknown) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        return value
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      )
    })
    return createHash('sha256').update(text).digest('hex')
  } catch {
    return
  }
}

interface Attempt {
  toolName: string
  at: number
  completed: boolean
}
interface Group {
  attempts: Map<string, Attempt>
  approvals: Map<string, number>
  lastSeen: number
  endedAt: number
}
interface Matches {
  registered?: string
  completed: string[]
}

/** Correlate exact tool IDs in a terminal. Anonymous permissions await a confirmed turn or session end.
 * @example tracker.observe(generation, observation, Date.now())
 */
export class ExecutionApprovals {
  readonly #groups = new Map<string, Group>()
  #undo: Array<() => void> | undefined

  /** Journal only keys changed by a hook until the related SQLite transaction commits.
   * @example tracker.transaction(() => persistCards())
   */
  transaction<T>(write: () => T): T {
    if (this.#undo) return write()
    const undo: Array<() => void> = []
    this.#undo = undo
    try {
      return write()
    } catch (error) {
      for (let i = undo.length - 1; i >= 0; i--) undo[i]()
      throw error
    } finally {
      this.#undo = undefined
    }
  }

  #put<K, V>(map: Map<K, V>, key: K, value: V): void {
    if (this.#undo) {
      const previous = map.get(key)
      this.#undo.push(
        map.has(key)
          ? () => {
              map.set(key, previous!)
            }
          : () => {
              map.delete(key)
            },
      )
    }
    map.set(key, value)
  }

  #drop<K, V>(map: Map<K, V>, key: K): boolean {
    if (!map.has(key)) return false
    if (this.#undo) {
      const previous = map.get(key)!
      this.#undo.push(() => {
        map.set(key, previous)
      })
    }
    return map.delete(key)
  }

  #edit(generation: string, at: number): Group {
    const previous = this.#groups.get(generation)
    const group: Group = {
      attempts: previous?.attempts ?? new Map(),
      approvals: previous?.approvals ?? new Map(),
      lastSeen: Math.max(at, previous?.lastSeen ?? at),
      endedAt: previous?.endedAt ?? -Infinity,
    }
    this.#put(this.#groups, generation, group)
    return group
  }
  /** Keep native event ordering comparable after the wall clock moves. */
  rebaseClock(delta: number): void {
    for (const [id, previous] of this.#groups) {
      const group = this.#edit(id, previous.lastSeen)
      group.lastSeen += delta
      group.endedAt += delta
      for (const [key, attempt] of group.attempts)
        this.#put(group.attempts, key, { ...attempt, at: attempt.at + delta })
      for (const [key, at] of group.approvals)
        this.#put(group.approvals, key, at + delta)
    }
  }
  /** Remove unconfirmed tracking from the live hook path after one workload window.
   * Durable questions retain their original identity and stay held until the provider confirms their outcome.
   * @example tracker.prune(now, currentGenerations)
   */
  prune(now: number, confirmed: ReadonlySet<string>): string[] {
    const evicted: string[] = []
    for (const [id, group] of this.#groups) {
      if (group.lastSeen < now - 3_600_000 && !confirmed.has(id)) {
        this.#drop(this.#groups, id)
        evicted.push(id)
        continue
      }
      // Expiry maintenance runs on the gateway sweep instead of every new hook.
      for (const [key, attempt] of group.attempts)
        if (attempt.completed && attempt.at < now - 3_600_000)
          this.#drop(group.attempts, key)
    }
    return evicted
  }

  /** Restore only still-open permissions proven to belong to a returning original terminal. */
  restore(
    generation: string,
    approvals: { key: string; toolName: string; at: number }[],
    now: number,
  ): void {
    if (!approvals.length) return
    const group = this.#edit(generation, now)
    for (const { key, toolName, at } of approvals) {
      this.#put(group.approvals, key, at)
      if (!key.startsWith('approval:unidentified:'))
        this.#put(group.attempts, key.slice('approval:'.length), {
          toolName,
          at,
          completed: false,
        })
    }
  }

  /** Forget the native records once the original terminal closes. */
  close(generation: string): void {
    this.#drop(this.#groups, generation)
  }

  /** Retire only permissions that predate a confirmed end of the main agent response.
   * @example tracker.endTurn(generation, stopAt)
   */
  endTurn(generation: string, at: number): string[] {
    const group = this.#edit(generation, at)
    group.endedAt = Math.max(group.endedAt, at)
    const ended: string[] = []
    for (const [key, opened] of group.approvals) {
      if (opened > at) continue
      this.#drop(group.approvals, key)
      ended.push(key)
    }
    for (const [key, attempt] of group.attempts)
      if (!attempt.completed && attempt.at <= at)
        this.#put(group.attempts, key, { ...attempt, at, completed: true })
    return ended
  }
  observe(
    generation: string,
    input: ExecutionObservation,
    at: number,
  ): Matches {
    const group = this.#edit(generation, at)
    const result: Matches = { completed: [] }
    if (at <= group.endedAt) return result
    const { toolUseId: id, toolName, fingerprint } = input
    let attempt = id ? group.attempts.get(id) : undefined
    if (id && attempt?.completed && attempt.at < at - 3_600_000) {
      this.#drop(group.attempts, id)
      attempt = undefined
    }
    if (
      attempt &&
      (attempt.toolName !== toolName || at < attempt.at || attempt.completed)
    )
      return result
    if (input.event === 'PreToolUse') {
      if (id && !attempt)
        this.#put(group.attempts, id, { toolName, at, completed: false })
      return result
    }
    if (input.event === 'PermissionRequest') {
      if (id && !attempt)
        this.#put(group.attempts, id, { toolName, at, completed: false })
      // Even one identical pre-hook cannot rule out a second tool whose pre-hook was lost.
      const key = id
        ? 'approval:' + id
        : 'approval:unidentified:' +
          createHash('sha256')
            .update(JSON.stringify([generation, at, toolName, fingerprint]))
            .digest('hex')
      if (!group.approvals.has(key)) {
        this.#put(group.approvals, key, at)
        result.registered = key
      }
      return result
    }
    if (!id) return result
    const key = 'approval:' + id,
      opened = group.approvals.get(key)
    if (opened !== undefined && opened > at) return result
    this.#put(group.attempts, id, { toolName, at, completed: true })
    if (this.#drop(group.approvals, key)) result.completed.push(key)
    return result
  }
}
