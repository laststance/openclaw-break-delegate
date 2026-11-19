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
  #groups = new Map<string, Group>()

  /** Roll back the copy-on-write tracker if a card update or its SQLite commit fails.
   * @example tracker.transaction(() => persistCards())
   */
  transaction<T>(write: () => T): T {
    const previous = this.#groups
    this.#groups = new Map(previous)
    try {
      return write()
    } catch (error) {
      this.#groups = previous
      throw error
    }
  }

  #edit(generation: string, at: number): Group {
    const previous = this.#groups.get(generation)
    const group = {
      attempts: new Map(previous?.attempts),
      approvals: new Map(previous?.approvals),
      lastSeen: Math.max(at, previous?.lastSeen ?? at),
      endedAt: previous?.endedAt ?? -Infinity,
    }
    this.#groups.set(generation, group)
    return group
  }
  /** Keep native event ordering comparable after the wall clock moves. */
  rebaseClock(delta: number): void {
    for (const [id, previous] of this.#groups) {
      const group = this.#edit(id, previous.lastSeen)
      group.lastSeen += delta
      group.endedAt += delta
      for (const [key, attempt] of group.attempts)
        group.attempts.set(key, { ...attempt, at: attempt.at + delta })
      for (const [key, at] of group.approvals)
        group.approvals.set(key, at + delta)
    }
  }
  /** Forget the native records once the original terminal closes. */
  close(generation: string): void {
    this.#groups.delete(generation)
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
      group.approvals.delete(key)
      ended.push(key)
    }
    for (const [key, attempt] of group.attempts)
      if (!attempt.completed && attempt.at <= at)
        group.attempts.set(key, { ...attempt, completed: true })
    return ended
  }
  observe(
    generation: string,
    input: ExecutionObservation,
    at: number,
  ): Matches {
    for (const [id, group] of this.#groups)
      if (!group.approvals.size && group.lastSeen < at - 3_600_000)
        this.#groups.delete(id)
    const group = this.#edit(generation, at)
    const result: Matches = { completed: [] }
    if (at <= group.endedAt) return result
    for (const [key, attempt] of group.attempts)
      if (attempt.completed && attempt.at < at - 3_600_000)
        group.attempts.delete(key)
    const { toolUseId: id, toolName, fingerprint } = input
    const attempt = id ? group.attempts.get(id) : undefined
    if (
      attempt &&
      (attempt.toolName !== toolName || at < attempt.at || attempt.completed)
    )
      return result
    if (input.event === 'PreToolUse') {
      if (id && !attempt)
        group.attempts.set(id, { toolName, at, completed: false })
      return result
    }
    if (input.event === 'PermissionRequest') {
      if (id && !attempt)
        group.attempts.set(id, { toolName, at, completed: false })
      // Even one identical pre-hook cannot rule out a second tool whose pre-hook was lost.
      const key = id
        ? 'approval:' + id
        : 'approval:unidentified:' +
          createHash('sha256')
            .update(JSON.stringify([generation, at, toolName, fingerprint]))
            .digest('hex')
      if (!group.approvals.has(key)) {
        group.approvals.set(key, at)
        result.registered = key
      }
      return result
    }
    if (!id) return result
    const key = 'approval:' + id,
      opened = group.approvals.get(key)
    if (opened !== undefined && opened > at) return result
    group.attempts.set(id, { toolName, at, completed: true })
    if (group.approvals.delete(key)) result.completed.push(key)
    return result
  }
}
