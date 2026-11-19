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
  fingerprint?: string
  at: number
  completed: boolean
}
interface Approval {
  toolName: string
  fingerprint?: string
  at: number
  candidates: string[]
}
interface Group {
  attempts: Map<string, Attempt>
  approvals: Map<string, Approval>
  lastSeen: number
}
interface Matches {
  registered?: string
  completed: string[]
}

/**
 * Correlate read-only hook events within an exact native terminal incarnation.
 * A missing permission ID can refer to several concurrent identical invocations.
 * In that case every candidate must finish before the wait is released.
 * @example tracker.observe(generation, observation, Date.now())
 */
export class ExecutionApprovals {
  readonly #groups = new Map<string, Group>()

  observe(
    generation: string,
    input: ExecutionObservation,
    at: number,
  ): Matches {
    for (const [key, group] of this.#groups) {
      if (!group.approvals.size && group.lastSeen < at - 3_600_000)
        this.#groups.delete(key)
    }
    let group = this.#groups.get(generation)
    if (!group) {
      group = { attempts: new Map(), approvals: new Map(), lastSeen: at }
      this.#groups.set(generation, group)
    }
    group.lastSeen = Math.max(at, group.lastSeen)
    // Completed IDs briefly absorb duplicated or reordered hooks. Outstanding waits retain their candidates.
    for (const [id, attempt] of group.attempts) {
      if (
        attempt.completed &&
        attempt.at < at - 3_600_000 &&
        ![...group.approvals.values()].some((wait) =>
          wait.candidates.includes(id),
        )
      )
        group.attempts.delete(id)
    }
    const { toolUseId: id, toolName, fingerprint } = input
    const attempt = id ? group.attempts.get(id) : undefined
    const result: Matches = { completed: [] }
    if (attempt && attempt.toolName !== toolName) return result
    if (input.event === 'PreToolUse') {
      if (id && !attempt)
        group.attempts.set(id, { toolName, fingerprint, at, completed: false })
      return result
    }
    if (input.event === 'PermissionRequest') {
      if (attempt?.completed) return result
      const candidates = id
        ? [id]
        : [...group.attempts]
            .filter(
              ([, other]) =>
                !other.completed &&
                other.at <= at &&
                other.toolName === toolName &&
                !!fingerprint &&
                other.fingerprint === fingerprint,
            )
            .map(([key]) => key)
            .sort()
      if (id && !attempt)
        group.attempts.set(id, { toolName, fingerprint, at, completed: false })
      const key =
        candidates.length === 1
          ? 'approval:' + candidates[0]
          : 'approval:unidentified:' +
            createHash('sha256')
              .update(
                JSON.stringify([
                  generation,
                  at,
                  toolName,
                  fingerprint,
                  candidates,
                ]),
              )
              .digest('hex')
      if (!group.approvals.has(key)) {
        group.approvals.set(key, { toolName, fingerprint, at, candidates })
        result.registered = key
      }
      return result
    }
    if (!id || attempt?.completed || (attempt && at < attempt.at)) return result
    group.attempts.set(id, {
      toolName,
      fingerprint: attempt?.fingerprint ?? fingerprint,
      at,
      completed: true,
    })
    const anonymous: string[] = []
    for (const [key, wait] of group.approvals) {
      if (wait.toolName !== toolName || wait.at > at) continue
      if (
        wait.candidates.includes(id) &&
        wait.candidates.every(
          (candidate) => group.attempts.get(candidate)?.completed,
        )
      ) {
        result.completed.push(key)
      } else if (
        !wait.candidates.length &&
        fingerprint &&
        wait.fingerprint === fingerprint &&
        (!attempt || attempt.at <= wait.at)
      ) {
        // A post without a recorded pre can resolve one unique, exact anonymous fingerprint.
        anonymous.push(key)
      }
    }
    if (anonymous.length === 1 && result.completed.length === 0)
      result.completed.push(anonymous[0])
    for (const key of result.completed) group.approvals.delete(key)
    return result
  }
}
