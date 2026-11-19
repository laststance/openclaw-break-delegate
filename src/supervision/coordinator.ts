import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { ExecutionApprovals, type ExecutionObservation } from './execution.js'
import { readReviewPage, type ReviewPage, type ReviewQuery } from './review.js'
import {
  Workload,
  minute,
  type Observation,
  type Provider,
} from './workload.js'

export interface SupervisionOptions {
  now?: () => number
  threshold?: number
  activePointsPerMinute?: number
  additionalPointsPerMinute?: number
  humanReplyPoints?: number
  breakMs?: number
  snoozeMs?: number
  invitationMs?: number
  /** Maximum interval for which an observer can attest to its last live status. */
  observationTtlMs?: number
}

export interface QuestionInput {
  sessionId: string
  questionId: string
  question: string
  kind?: 'choice' | 'approval'
  /** When the original hook began, before any IPC or model latency. */
  openedAt?: number
  incarnation?: string
}
export interface Gate {
  eligible: boolean
  breakId?: string
  reason?: string
}
export type NativeAction = 'accept' | 'snooze' | 'dismiss' | 'return'
export interface NativeEffect {
  kind: 'invitation' | 'break' | 'digest' | 'review-updated'
  id: string
}
export type Outcome =
  'held' | 'pending' | 'sent' | 'ambiguous' | 'human' | 'resolved'
export interface ReviewReceipt {
  sessionId: string
  questionId: string
  breakId: string
  question: string
  answer: string | null
  outcome: Outcome
  reason: string | null
  at: number
}
export interface Coverage {
  source: string
  status: 'available' | 'partial' | 'unavailable'
  detail: string
  at: number
}
interface Break {
  id: string
  startedAt: number
  expiresAt: number
}
interface Invitation {
  id: string
  expiresAt: number
}
interface Control {
  resetAt: number
  armed: number
  snoozeAt: number | null
}
interface Card {
  question: string
  generation: string
  live: number
  candidate: string | null
  kind: 'choice' | 'approval'
  disposition:
    'open' | 'held' | 'human' | 'pending' | 'sent' | 'ambiguous' | 'resolved'
}

interface ReplyOrigin {
  provider: Provider
  sessionId: string
  responseId: string
  originId?: string
}
function replyKey(input: ReplyOrigin): string {
  return createHash('sha256')
    .update(
      input.originId ??
        [input.provider, input.sessionId, input.responseId].join(':'),
    )
    .digest('hex')
}

const schema = `
CREATE TABLE IF NOT EXISTS sv_control(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), resetAt INTEGER NOT NULL DEFAULT 0,
  armed INTEGER NOT NULL DEFAULT 1, snoozeAt INTEGER
);
INSERT OR IGNORE INTO sv_control(singleton) VALUES(1);
CREATE TABLE IF NOT EXISTS sv_runs(id INTEGER PRIMARY KEY, start INTEGER NOT NULL, finish INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sv_runs_finish ON sv_runs(finish);
CREATE TABLE IF NOT EXISTS sv_replies(id TEXT PRIMARY KEY, at INTEGER NOT NULL, credited INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sv_replies_at ON sv_replies(at);
CREATE TABLE IF NOT EXISTS sv_live_replies(id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS sv_resolved(sessionId TEXT NOT NULL, questionId TEXT NOT NULL, PRIMARY KEY(sessionId,questionId));
CREATE TABLE IF NOT EXISTS sv_invitations(id TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL, state TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS sv_one_invitation ON sv_invitations(state) WHERE state='open';
CREATE TABLE IF NOT EXISTS sv_breaks(id TEXT PRIMARY KEY, startedAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, endedAt INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS sv_one_break ON sv_breaks((1)) WHERE endedAt IS NULL;
CREATE TABLE IF NOT EXISTS sv_members(breakId TEXT NOT NULL, sessionId TEXT NOT NULL, generation TEXT NOT NULL, PRIMARY KEY(breakId,sessionId));
CREATE TABLE IF NOT EXISTS sv_unidentified_waits(breakId TEXT NOT NULL, sessionId TEXT NOT NULL, generation TEXT NOT NULL, PRIMARY KEY(breakId,sessionId,generation));
CREATE TABLE IF NOT EXISTS sv_questions(
  sessionId TEXT NOT NULL, questionId TEXT NOT NULL, generation TEXT NOT NULL, question TEXT NOT NULL,
  kind TEXT NOT NULL, live INTEGER NOT NULL, candidate TEXT, disposition TEXT NOT NULL,
  PRIMARY KEY(sessionId,questionId)
);
CREATE TABLE IF NOT EXISTS sv_question_origins(sessionId TEXT NOT NULL,questionId TEXT NOT NULL,incarnation TEXT NOT NULL,openedAt INTEGER NOT NULL,PRIMARY KEY(sessionId,questionId));
CREATE TABLE IF NOT EXISTS sv_reviews(
  breakId TEXT NOT NULL, sessionId TEXT NOT NULL, questionId TEXT NOT NULL, question TEXT NOT NULL,
  answer TEXT, outcome TEXT NOT NULL, reason TEXT, at INTEGER NOT NULL,
  PRIMARY KEY(breakId,sessionId,questionId)
);
CREATE TABLE IF NOT EXISTS sv_effects(
  seq INTEGER PRIMARY KEY, id TEXT NOT NULL,kind TEXT NOT NULL,claimed INTEGER NOT NULL DEFAULT 0,
  UNIQUE(id,kind)
);`

/**
 * Own confirmed observations, invitations and break consent for one local gateway.
 * The private service is the single writer. Every state change that authorizes a reply
 * or notification is synchronous and transactionally recorded before returning to its caller.
 *
 * @example
 * const supervisor = new Supervision(db)
 * supervisor.observe({provider:'claude',sessionId:'terminal',status:'running',canDelegate:true})
 * supervisor.tick()
 */
export class Supervision {
  readonly #db: DatabaseSync
  readonly #now: () => number
  readonly #work: Workload
  readonly #threshold: number
  readonly #breakMs: number
  readonly #snoozeMs: number
  readonly #invitationMs: number
  readonly #approvals = new ExecutionApprovals()
  #nextTrackingSweep = -Infinity
  #writing = false
  #coverage = new Map<string, Coverage>()
  #lastAt: number

  constructor(db: DatabaseSync, options: SupervisionOptions = {}) {
    this.#db = db
    this.#now = options.now ?? Date.now
    this.#threshold = options.threshold ?? 45
    this.#breakMs = options.breakMs ?? 15 * minute
    this.#snoozeMs = options.snoozeMs ?? 15 * minute
    this.#invitationMs = options.invitationMs ?? 15 * minute
    this.#work = new Workload(db, options.observationTtlMs ?? 90_000, {
      active: options.activePointsPerMinute ?? 1,
      additional: options.additionalPointsPerMinute ?? 0.1,
      reply: options.humanReplyPoints ?? 4,
    })
    this.#lastAt = this.#now()
    db.exec(schema)
    this.#transaction(() => {
      // A gateway cannot prove that the previous process still owns a waiting hook.
      db.exec("UPDATE sv_invitations SET state='restart' WHERE state='open'")
      db.prepare(
        "UPDATE sv_reviews SET outcome='ambiguous',reason='Gateway restarted before delivery was confirmed',at=? WHERE outcome='pending'",
      ).run(this.#lastAt)
      db.exec(
        "UPDATE sv_questions SET disposition='ambiguous' WHERE disposition='pending'",
      )
      const previous = this.#active()
      if (previous)
        this.#finish(
          previous,
          Math.min(this.#lastAt, previous.expiresAt),
          'Gateway restarted',
        )
      db.exec('UPDATE sv_questions SET live=0 WHERE live=1')
    })
  }

  #transaction<T>(apply: () => T): T {
    if (this.#writing) return apply()
    this.#db.exec('BEGIN IMMEDIATE')
    this.#writing = true
    const nextSweep = this.#nextTrackingSweep
    const lastAt = this.#lastAt,
      coverage = this.#coverage
    this.#coverage = new Map(coverage)
    try {
      const result = this.#work.transaction(() =>
        this.#approvals.transaction(() => {
          const result = apply()
          this.#db.exec('COMMIT')
          return result
        }),
      )
      if (this.#lastAt < lastAt)
        this.#approvals.rebaseClock(this.#lastAt - lastAt)
      return result
    } catch (error) {
      this.#nextTrackingSweep = nextSweep
      this.#lastAt = lastAt
      this.#coverage = coverage
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK')
      throw error
    } finally {
      this.#writing = false
    }
  }

  #control(): Control {
    return this.#db
      .prepare('SELECT resetAt,armed,snoozeAt FROM sv_control')
      .get() as unknown as Control
  }
  #active(): Break | undefined {
    return this.#db
      .prepare(
        'SELECT id,startedAt,expiresAt FROM sv_breaks WHERE endedAt IS NULL',
      )
      .get() as unknown as Break | undefined
  }
  #invitation(): Invitation | undefined {
    return this.#db
      .prepare("SELECT id,expiresAt FROM sv_invitations WHERE state='open'")
      .get() as unknown as Invitation | undefined
  }
  #card(sessionId: string, questionId: string): Card | undefined {
    return this.#db
      .prepare(
        'SELECT question,generation,live,candidate,kind,disposition FROM sv_questions WHERE sessionId=? AND questionId=?',
      )
      .get(sessionId, questionId) as unknown as Card | undefined
  }
  #effect(kind: NativeEffect['kind'], id: string) {
    this.#db
      .prepare('INSERT OR IGNORE INTO sv_effects(id,kind) VALUES(?,?)')
      .run(id, kind)
  }
  #member(breakId: string, sessionId: string, generation: string | undefined) {
    return Boolean(
      generation &&
      this.#db
        .prepare(
          'SELECT 1 FROM sv_members WHERE breakId=? AND sessionId=? AND generation=?',
        )
        .get(breakId, sessionId, generation),
    )
  }

  #finish(active: Break, end: number, reason: string) {
    this.#db
      .prepare('UPDATE sv_breaks SET endedAt=? WHERE id=? AND endedAt IS NULL')
      .run(end, active.id)
    this.#db
      .prepare(
        "UPDATE sv_questions SET disposition='held' WHERE candidate=? AND disposition='open'",
      )
      .run(active.id)
    this.#db
      .prepare(
        "UPDATE sv_reviews SET reason=?,at=? WHERE breakId=? AND outcome='held' AND reason='Awaiting decision'",
      )
      .run(reason, end, active.id)
    this.#db
      .prepare('UPDATE sv_control SET resetAt=?,armed=1,snoozeAt=NULL')
      .run(end)
    this.#db
      .prepare('UPDATE sv_replies SET credited=0 WHERE credited=1 AND at<=?')
      .run(end)
    this.#effect('digest', active.id)
  }

  #advance(now: number) {
    // Clock regression invalidates consent instead of extending its wall-clock lifetime.
    if (now < this.#lastAt) {
      const old = this.#active()
      if (old)
        this.#finish(
          old,
          Math.min(this.#lastAt, old.expiresAt),
          'Clock changed',
        )
      this.#db.exec(
        "UPDATE sv_invitations SET state='clock-changed' WHERE state='open'",
      )
      this.#nextTrackingSweep = -Infinity
      this.#db
        .prepare(
          'UPDATE sv_question_origins SET openedAt=openedAt+? WHERE EXISTS (SELECT 1 FROM sv_questions q WHERE q.sessionId=sv_question_origins.sessionId AND q.questionId=sv_question_origins.questionId AND q.live=1)',
        )
        .run(now - this.#lastAt)
      this.#work.resetClock(now)
      this.#coverage.clear()
      this.#db
        .prepare('UPDATE sv_control SET resetAt=?,armed=1,snoozeAt=NULL')
        .run(now)
    }
    this.#lastAt = now
    this.#work.checkpoint(now)
    const active = this.#active()
    if (active && now >= active.expiresAt)
      this.#finish(active, active.expiresAt, 'Break ended')
    if (now >= this.#nextTrackingSweep) {
      const confirmed = new Set(
        this.#work
          .views(now, false)
          .filter((s) => s.status !== 'unknown' && s.status !== 'closed')
          .map((s) => s.generation),
      )
      if (active && now < active.expiresAt)
        for (const { generation } of this.#db
          .prepare('SELECT generation FROM sv_members WHERE breakId=?')
          .all(active.id))
          confirmed.add(String(generation))
      this.#work.detach(new Set(this.#approvals.prune(now, confirmed)))
      this.#nextTrackingSweep = now + minute
    }
    this.#db
      .prepare(
        "UPDATE sv_invitations SET state='expired' WHERE state='open' AND expiresAt<=?",
      )
      .run(now)
  }

  #supervising(now: number) {
    return this.#work
      .views(now, false)
      .some((s) => s.status === 'running' || s.status === 'waiting')
  }

  #considerInvitation(now: number) {
    if (this.#active()) return
    const control = this.#control()
    const score = this.#work.score(now, control.resetAt)
    if (score < this.#threshold) {
      this.#db.exec(
        "UPDATE sv_control SET armed=1; UPDATE sv_invitations SET state='below-threshold' WHERE state='open'",
      )
      if (control.snoozeAt !== null && now >= control.snoozeAt)
        this.#db.exec('UPDATE sv_control SET snoozeAt=NULL')
      return
    }
    if (control.snoozeAt !== null) {
      if (now < control.snoozeAt) return
      // Consume the one requested reminder even if supervision has since stopped.
      this.#db.exec('UPDATE sv_control SET snoozeAt=NULL,armed=0')
    } else if (!control.armed) return
    if (this.#invitation() || !this.#supervising(now)) return
    const id = randomUUID()
    this.#db
      .prepare("INSERT INTO sv_invitations VALUES(?,?,'open')")
      .run(id, now + this.#invitationMs)
    this.#db.exec('UPDATE sv_control SET armed=0')
    this.#effect('invitation', id)
  }

  /** Periodic gateway tick evaluates rolling load, expiration, and a due snooze. */
  tick(): void {
    this.#transaction(() => {
      const now = this.#now()
      this.#advance(now)
      this.#considerInvitation(now)
    })
  }

  #restoreOriginal(
    sessionId: string,
    incarnation: string | undefined,
    replacement: boolean,
    now: number,
  ) {
    if (!incarnation || this.#work.claude(sessionId, incarnation, now)) return
    const rows = this.#db
      .prepare(
        `SELECT q.questionId,q.question,q.kind,q.generation,o.incarnation,o.openedAt
      FROM sv_questions q JOIN sv_question_origins o USING(sessionId,questionId)
      WHERE q.sessionId=? AND q.live=1 AND (o.incarnation=? OR ?=1)
      ORDER BY (o.incarnation=?) DESC,o.openedAt DESC`,
      )
      .all(sessionId, incarnation, replacement ? 1 : 0, incarnation)
    if (!rows.length) return
    const generation = String(rows[0].generation),
      owner = String(rows[0].incarnation)
    const same = rows.filter((row) => row.generation === generation)
    this.#work.restore(
      sessionId,
      owner,
      generation,
      same.map((row) => String(row.questionId)),
      now,
    )
    if (this.#work.claude(sessionId, owner, now)?.generation !== generation)
      return
    this.#approvals.restore(
      generation,
      same
        .filter((row) => row.kind === 'approval')
        .map((row) => ({
          key: String(row.questionId),
          toolName: String(row.question).slice(
            'Execution approval for '.length,
          ),
          at: Number(row.openedAt),
        })),
      now,
    )
  }

  /** Record a lifecycle hook; an ordinary prompt submission supplies no human reply points. */
  observe(observation: Observation): void {
    this.#transaction(() => {
      const now = this.#now()
      this.#advance(now)
      const lifecycle =
        observation.provider === 'claude' &&
        (observation.source ?? 'hook') === 'hook'
      if (lifecycle && this.#work.isFresh(observation.at ?? now, now))
        this.#restoreOriginal(
          observation.sessionId,
          observation.incarnation,
          !!observation.newSession,
          now,
        )
      const previous =
        lifecycle && (observation.status === 'closed' || observation.newSession)
          ? this.#work.claude(observation.sessionId, undefined, now)
          : undefined
      this.#work.observe(observation, now, randomUUID())
      if (
        previous &&
        previous.generation !==
          this.#work.claude(observation.sessionId, undefined, now)?.generation
      ) {
        // Only a confirmed end or replacement can retire this particular terminal's original cards.
        const live = this.#db
          .prepare(
            'SELECT questionId FROM sv_questions WHERE sessionId=? AND generation=? AND live=1',
          )
          .all(observation.sessionId, previous.generation)
        for (const row of live)
          this.#resolveQuestion(
            observation.sessionId,
            String(row.questionId),
            'Original terminal closed',
            now,
          )
        this.#approvals.close(previous.generation)
      }
      if (
        lifecycle &&
        observation.turnEnded &&
        observation.status === 'idle' &&
        observation.incarnation
      ) {
        const terminal = this.#work.claude(
          observation.sessionId,
          observation.incarnation,
          now,
        )
        const at = observation.at ?? now
        if (terminal && Number.isFinite(at) && at <= now)
          for (const questionId of this.#approvals.endTurn(
            terminal.generation,
            at,
          ))
            this.#resolveApproval(
              observation.sessionId,
              terminal.generation,
              questionId,
              'The native turn ended before this approval completed',
              now,
            )
      }
      if (
        lifecycle &&
        !observation.newSession &&
        (observation.status === 'running' || observation.status === 'idle')
      ) {
        const active = this.#active()
        const session = this.#work.claude(
          observation.sessionId,
          observation.incarnation,
          now,
        )
        if (
          active &&
          session?.status === observation.status &&
          (observation.at ?? now) > active.startedAt
        )
          this.#db
            .prepare(
              'DELETE FROM sv_unidentified_waits WHERE breakId=? AND sessionId=? AND generation=?',
            )
            .run(active.id, observation.sessionId, session.generation)
      }
      this.#considerInvitation(now)
    })
  }

  /** Replace one snapshot without borrowing the authority or extending the freshness of another. */
  snapshot(
    source: string,
    observations: Observation[],
    coverage: Omit<Coverage, 'source'>,
  ): void {
    this.#transaction(() => {
      const now = this.#now()
      this.#advance(now)
      if (
        coverage.at > now ||
        (this.#coverage.get(source)?.at ?? -Infinity) > coverage.at
      )
        return
      this.#work.replaceSource(
        source,
        observations,
        coverage.at,
        now,
        randomUUID,
        coverage.status === 'available',
      )
      this.#coverage.set(source, { source, ...coverage })
      this.#considerInvitation(now)
    })
  }

  /**
   * Score a positively identified human response once. A live witness also confirms a prior
   * history import when the original provider independently identifies the human reply.
   * @example supervisor.humanReply({provider:'codex',sessionId:'s',responseId:'prompt:p',observedLive:true})
   */
  humanReply(input: {
    provider: Provider
    sessionId: string
    responseId: string
    questionId?: string
    originId?: string
    incarnation?: string
    at?: number
    observedLive?: boolean
  }): boolean {
    return this.#transaction(() => {
      const now = this.#now(),
        at = input.at ?? now
      this.#advance(now)
      if (
        !input.responseId ||
        !Number.isFinite(at) ||
        at > now ||
        at <= now - 60 * minute
      )
        return false
      if (
        input.incarnation &&
        input.provider === 'claude' &&
        !this.#work.claude(input.sessionId, input.incarnation, now)
      )
        return false
      const questionId =
        input.questionId ??
        (input.provider === 'claude' && input.responseId.startsWith('tool:')
          ? input.responseId.slice(5)
          : undefined)
      const card =
        input.provider === 'claude' && questionId
          ? this.#card(input.sessionId, questionId)
          : undefined
      if (card && ['pending', 'sent', 'ambiguous'].includes(card.disposition))
        return false
      const responseId = questionId ? 'tool:' + questionId : input.responseId
      const key = replyKey({ ...input, responseId })
      if (
        this.#db
          .prepare('SELECT 1 FROM sv_replies WHERE id=? AND credited=-1')
          .get(key)
      )
        return false
      // Remember the independent witness even if history already credited the same reply.
      if (input.observedLive)
        this.#db
          .prepare('INSERT OR IGNORE INTO sv_live_replies VALUES(?)')
          .run(key)
      if (card?.disposition === 'human') return false
      const added = this.#db
        .prepare('INSERT OR IGNORE INTO sv_replies VALUES(?,?,?)')
        .run(key, at, this.#active() || at < this.#control().resetAt ? 0 : 1)
      if (input.provider === 'claude' && questionId)
        this.#db
          .prepare('INSERT OR IGNORE INTO sv_resolved VALUES(?,?)')
          .run(input.sessionId, questionId)
      if (card && questionId) {
        this.#db
          .prepare(
            "UPDATE sv_questions SET disposition='human',live=0 WHERE sessionId=? AND questionId=?",
          )
          .run(input.sessionId, questionId)
        this.#db
          .prepare(
            "UPDATE sv_reviews SET outcome='human',reason='Answered by the person',at=? WHERE sessionId=? AND questionId=? AND outcome='held' AND breakId IN (SELECT id FROM sv_breaks WHERE endedAt IS NULL)",
          )
          .run(now, input.sessionId, questionId)
        this.#work.setWaiting(input.sessionId, questionId, false, now)
      }
      this.#considerInvitation(now)
      return added.changes === 1
    })
  }

  /**
   * Withdraw a history credit when its question disappears or later provenance identifies automation.
   * A temporary withdrawal preserves independent live proof and permits a later verified import.
   * Confirmed automation permanently excludes the response, including future live or mirrored events.
   * @example supervisor.retractHumanReply({provider:'codex',sessionId:'s',responseId:'tool:q'})
   */
  retractHumanReply(input: ReplyOrigin & { permanent?: boolean }): void {
    this.#transaction(() => {
      const now = this.#now()
      this.#advance(now)
      const key = replyKey(input)
      if (input.permanent === false) {
        // Only recent workload credit can be withdrawn; reset and excluded replies keep their prior state.
        this.#db
          .prepare(
            'DELETE FROM sv_replies WHERE id=? AND credited=1 AND NOT EXISTS (SELECT 1 FROM sv_live_replies WHERE id=sv_replies.id)',
          )
          .run(key)
        this.#considerInvitation(now)
        return
      }
      this.#db
        .prepare(
          'INSERT INTO sv_replies VALUES(?,?,-1) ON CONFLICT(id) DO UPDATE SET credited=-1',
        )
        .run(key, now)
      if (input.provider === 'claude' && input.responseId.startsWith('tool:')) {
        const id = input.responseId.slice(5)
        this.#db
          .prepare(
            "UPDATE sv_questions SET disposition='resolved' WHERE sessionId=? AND questionId=? AND disposition='human'",
          )
          .run(input.sessionId, id)
        this.#db
          .prepare(
            "UPDATE sv_reviews SET outcome='resolved',reason='Completed without a verified human answer' WHERE sessionId=? AND questionId=? AND outcome='human'",
          )
          .run(input.sessionId, id)
      }
      this.#considerInvitation(now)
    })
  }

  /**
   * Track a local Claude operation without granting permission or inferring a human reply.
   * Only the original tool ID resolves an individual permission. Anonymous waits require a native turn or session boundary.
   * @example supervisor.observeExecution({event:'PostToolUse',sessionId:'s',incarnation:'p',toolUseId:'t',toolName:'Bash'})
   */
  observeExecution(input: ExecutionObservation): boolean {
    const now = this.#now(),
      at = input.at ?? now
    if (
      !input.sessionId ||
      !input.incarnation ||
      !input.toolName ||
      !Number.isFinite(at) ||
      at > now
    )
      return false
    if (now < this.#lastAt) this.tick()
    return this.#transaction(() => {
      const base = {
        provider: 'claude' as const,
        sessionId: input.sessionId,
        incarnation: input.incarnation,
        canDelegate: true,
        at,
      }
      if (this.#work.isFresh(at, now))
        this.#restoreOriginal(input.sessionId, input.incarnation, false, now)
      let currentTerminal = this.#work.claude(
        input.sessionId,
        input.incarnation,
        now,
      )
      const isOpening =
        input.event === 'PreToolUse' || input.event === 'PermissionRequest'
      if (!currentTerminal && isOpening) {
        this.observe({ ...base, status: 'running' })
        currentTerminal = this.#work.claude(
          input.sessionId,
          input.incarnation,
          now,
        )
      }
      if (!currentTerminal) return false
      if (input.event === 'PreToolUse' && input.toolUseId)
        this.observe({
          ...base,
          status: currentTerminal.status === 'waiting' ? 'waiting' : 'running',
        })
      const match = this.#approvals.observe(
        currentTerminal.generation,
        input,
        at,
      )
      if (match.registered) {
        if (this.#card(input.sessionId, match.registered)?.live === 0)
          return false
        this.observe({ ...base, status: 'waiting' })
        this.question({
          sessionId: input.sessionId,
          questionId: match.registered,
          incarnation: input.incarnation,
          kind: 'approval',
          question: 'Execution approval for ' + input.toolName,
          openedAt: at,
        })
      }
      if (match.completed.length) {
        for (const questionId of match.completed)
          this.#resolveApproval(
            input.sessionId,
            currentTerminal.generation,
            questionId,
            'Tool completed; the approval is no longer pending',
            now,
          )
        this.observe({ ...base, status: 'running' })
      }
      return !!match.registered || match.completed.length > 0
    })
  }

  #resolveApproval(
    sessionId: string,
    generation: string,
    questionId: string,
    reason: string,
    now: number,
  ) {
    const card = this.#card(sessionId, questionId)
    if (
      card?.kind === 'approval' &&
      card.live &&
      card.generation === generation
    )
      this.#resolveQuestion(sessionId, questionId, reason, now)
  }

  /** Consume a correlated native action; callbacks from expired invitations or old breaks fail closed. */
  action(id: string, action: NativeAction): boolean {
    return this.#transaction(() => {
      const now = this.#now()
      this.#advance(now)
      if (action === 'return') {
        const active = this.#active()
        if (!active || active.id !== id) return false
        this.#finish(active, now, 'Person returned')
        return true
      }
      const invite = this.#invitation()
      if (
        !invite ||
        invite.id !== id ||
        !['dismiss', 'snooze', 'accept'].includes(action)
      )
        return false
      if (
        action === 'accept' &&
        (!this.#supervising(now) ||
          this.#work.score(now, this.#control().resetAt) < this.#threshold)
      )
        return false
      this.#db
        .prepare('UPDATE sv_invitations SET state=? WHERE id=?')
        .run(action, id)
      if (action === 'snooze')
        this.#db
          .prepare('UPDATE sv_control SET snoozeAt=?')
          .run(now + this.#snoozeMs)
      if (action !== 'accept') return true
      const breakId = randomUUID()
      this.#db
        .prepare('INSERT INTO sv_breaks VALUES(?,?,?,NULL)')
        .run(breakId, now, now + this.#breakMs)
      for (const s of this.#work.views(now, false)) {
        if (
          s.provider !== 'claude' ||
          !s.canDelegate ||
          s.status === 'unknown' ||
          s.status === 'closed'
        )
          continue
        this.#db
          .prepare('INSERT INTO sv_members VALUES(?,?,?)')
          .run(breakId, s.sessionId, s.generation)
        if (
          s.status === 'waiting' &&
          !this.#db
            .prepare(
              'SELECT 1 FROM sv_questions WHERE sessionId=? AND generation=? AND live=1',
            )
            .get(s.sessionId, s.generation)
        ) {
          // A provider can report a preexisting prompt whose original hook we never witnessed.
          this.#db
            .prepare('INSERT INTO sv_unidentified_waits VALUES(?,?,?)')
            .run(breakId, s.sessionId, s.generation)
        }
        // Cards on screen at acceptance remain held across retries and subsequent observations.
        this.#db
          .prepare(
            `INSERT INTO sv_reviews(breakId,sessionId,questionId,question,outcome,reason,at)
          SELECT ?,sessionId,questionId,question,'held','Already waiting when the break began',? FROM sv_questions
          WHERE sessionId=? AND generation=? AND live=1 AND disposition IN ('open','held')`,
          )
          .run(breakId, now, s.sessionId, s.generation)
      }
      this.#effect('break', breakId)
      return true
    })
  }

  /** Register the original Claude request before a model call; duplicate hooks may never obtain a fresh ticket. */
  question(input: QuestionInput): Gate {
    return this.#transaction(() => {
      const now = this.#now()
      this.#advance(now)
      const existing = this.#card(input.sessionId, input.questionId)
      if (existing)
        return { eligible: false, reason: 'Question was already observed' }
      if (
        this.#db
          .prepare(
            'SELECT 1 FROM sv_resolved WHERE sessionId=? AND questionId=?',
          )
          .get(input.sessionId, input.questionId)
      )
        return {
          eligible: false,
          reason: 'Original request already completed',
        }
      const session = this.#work.claude(input.sessionId, input.incarnation, now)
      const active = this.#active()
      const member =
        active &&
        session?.canDelegate &&
        this.#member(active.id, input.sessionId, session.generation)
      const kind = input.kind ?? 'choice'
      let reason: string | undefined
      if (!member) reason = 'Outside participating sessions'
      else if (
        this.#db
          .prepare(
            'SELECT 1 FROM sv_unidentified_waits WHERE breakId=? AND sessionId=? AND generation=?',
          )
          .get(active.id, input.sessionId, session.generation)
      )
        reason = 'Input was already pending in this terminal at acceptance'
      else if (kind === 'approval')
        reason = 'Execution approval requires the person'
      else if (
        input.openedAt !== undefined &&
        (!Number.isFinite(input.openedAt) ||
          input.openedAt <= active.startedAt ||
          input.openedAt > now)
      )
        reason = 'Question predates confirmed consent'
      const eligible = !reason && !!active
      this.#db
        .prepare('INSERT INTO sv_questions VALUES(?,?,?,?,?,1,?,?)')
        .run(
          input.sessionId,
          input.questionId,
          session?.generation ?? '',
          input.question,
          kind,
          eligible ? active!.id : null,
          eligible ? 'open' : 'held',
        )
      if (input.incarnation && session)
        this.#db
          .prepare('INSERT INTO sv_question_origins VALUES(?,?,?,?)')
          .run(
            input.sessionId,
            input.questionId,
            input.incarnation,
            Number.isFinite(input.openedAt) && input.openedAt! <= now
              ? input.openedAt!
              : now,
          )
      if (member) {
        this.#db
          .prepare(
            `INSERT INTO sv_reviews(breakId,sessionId,questionId,question,outcome,reason,at) VALUES(?,?,?,?,'held',?,?)`,
          )
          .run(
            active.id,
            input.sessionId,
            input.questionId,
            input.question,
            reason ?? 'Awaiting decision',
            now,
          )
      }
      if (session)
        this.#work.setWaiting(input.sessionId, input.questionId, true, now)
      this.#considerInvitation(now)
      return eligible
        ? { eligible: true, breakId: active!.id }
        : { eligible: false, reason }
    })
  }

  /** Leave an unanswered card visible in its original terminal and retain the private review reason. */
  hold(sessionId: string, questionId: string, reason: string): void {
    this.#transaction(() =>
      this.#hold(sessionId, questionId, reason, this.#now()),
    )
  }
  #hold(sessionId: string, questionId: string, reason: string, now: number) {
    const card = this.#card(sessionId, questionId)
    if (card?.disposition !== 'open') return
    this.#db
      .prepare(
        "UPDATE sv_questions SET disposition='held' WHERE sessionId=? AND questionId=?",
      )
      .run(sessionId, questionId)
    this.#db
      .prepare(
        "UPDATE sv_reviews SET reason=?,at=? WHERE breakId=? AND sessionId=? AND questionId=? AND outcome='held'",
      )
      .run(reason, now, card.candidate, sessionId, questionId)
  }

  /** A matching post-tool event can prove a card closed even when its answer's author is unknown. */
  resolveQuestion(
    sessionId: string,
    questionId: string,
    outcome: 'completed' | 'failed' = 'completed',
  ): void {
    this.#transaction(() =>
      this.#resolveQuestion(
        sessionId,
        questionId,
        outcome === 'failed'
          ? 'Original request failed or was canceled'
          : 'Original request completed',
        this.#now(),
      ),
    )
  }

  #resolveQuestion(
    sessionId: string,
    questionId: string,
    reason: string,
    now: number,
  ): void {
    this.#db
      .prepare('INSERT OR IGNORE INTO sv_resolved VALUES(?,?)')
      .run(sessionId, questionId)
    // Provider completion closes the card, while delivery and human provenance have independent outcomes.
    this.#db
      .prepare(
        "UPDATE sv_questions SET live=0,disposition=CASE WHEN disposition IN ('open','held') THEN 'resolved' ELSE disposition END WHERE sessionId=? AND questionId=?",
      )
      .run(sessionId, questionId)
    const changed = this.#db
      .prepare(
        "UPDATE sv_reviews SET outcome='resolved',reason=?,at=? WHERE sessionId=? AND questionId=? AND outcome='held' RETURNING breakId",
      )
      .all(reason, now, sessionId, questionId)
    // An ended break owns its retained summary even while a later invitation is on screen.
    for (const { breakId } of changed)
      this.#db
        .prepare(
          "INSERT INTO sv_effects(id,kind,claimed) SELECT id,'review-updated',0 FROM sv_breaks WHERE id=? AND endedAt IS NOT NULL ON CONFLICT(id,kind) DO UPDATE SET claimed=0",
        )
        .run(breakId)
    this.#work.setWaiting(sessionId, questionId, false, now)
  }

  /**
   * Claim one answer immediately before replying on its original IPC request.
   * The callback must synchronously verify that the exact waiting socket/request pair still exists.
   * A durable pending claim prevents a retry after an ambiguous write or process failure.
   *
   * @example
   * supervisor.commitAnswer(ticket, () => pending.get(ticket.questionId) === originalSocket)
   */
  commitAnswer(
    input: {
      sessionId: string
      questionId: string
      breakId: string
      answer: string
      incarnation?: string
    },
    originalClientStillWaiting: () => boolean,
    recordProvenance?: () => void,
  ): boolean {
    // Commit measured time separately so an attribution failure can roll back the answer
    // without reverting SQLite's clock checkpoint behind the in-memory activity cursor.
    this.tick()
    const lostOriginal = Symbol()
    try {
      return this.#transaction(() => {
        const now = this.#now()
        const active = this.#active(),
          card = this.#card(input.sessionId, input.questionId)
        if (
          !active ||
          active.id !== input.breakId ||
          now >= active.expiresAt ||
          now < active.startedAt ||
          !card?.live ||
          card.candidate !== active.id ||
          card.disposition !== 'open' ||
          card.kind !== 'choice' ||
          !input.answer
        )
          return false
        const session = this.#work.claude(
          input.sessionId,
          input.incarnation,
          now,
        )
        if (
          !session?.canDelegate ||
          session.status === 'unknown' ||
          session.generation !== card.generation ||
          !this.#member(active.id, input.sessionId, session.generation)
        ) {
          this.#hold(
            input.sessionId,
            input.questionId,
            'Original terminal is no longer confirmed',
            now,
          )
          return false
        }
        if (!originalClientStillWaiting() || this.#now() >= active.expiresAt) {
          this.#hold(
            input.sessionId,
            input.questionId,
            'Original request or consent ended',
            now,
          )
          return false
        }
        this.#db
          .prepare(
            "UPDATE sv_questions SET disposition='pending' WHERE sessionId=? AND questionId=?",
          )
          .run(input.sessionId, input.questionId)
        this.#db
          .prepare(
            "UPDATE sv_reviews SET outcome='pending',answer=?,reason=NULL,at=? WHERE breakId=? AND sessionId=? AND questionId=?",
          )
          .run(input.answer, now, active.id, input.sessionId, input.questionId)
        recordProvenance?.()
        const commitAt = this.#now()
        if (
          commitAt < active.startedAt ||
          commitAt >= active.expiresAt ||
          !originalClientStillWaiting()
        )
          throw lostOriginal
        return true
      })
    } catch (error) {
      if (error !== lostOriginal) throw error
      this.hold(
        input.sessionId,
        input.questionId,
        'Original request or consent ended during the claim',
      )
      return false
    }
  }

  /**
   * Recheck the original waiting terminal before its hook writes an already claimed answer.
   * The gateway calls this read-only gate when the hook presents its opaque delivery receipt.
   * @example supervisor.isPendingDelivery('session', 'question', 'break', 'terminal')
   */
  isPendingDelivery(
    sessionId: string,
    questionId: string,
    breakId: string,
    incarnation: string,
  ): boolean {
    if (!incarnation) return false
    const now = this.#now(),
      active = this.#active(),
      card = this.#card(sessionId, questionId)
    if (
      !active ||
      active.id !== breakId ||
      now < this.#lastAt ||
      now < active.startedAt ||
      now >= active.expiresAt ||
      !card?.live ||
      card.disposition !== 'pending' ||
      card.candidate !== breakId ||
      card.kind !== 'choice'
    )
      return false
    const session = this.#work.claude(sessionId, incarnation, now)
    return (
      !!session?.canDelegate &&
      session.status === 'waiting' &&
      session.generation === card.generation &&
      this.#member(breakId, sessionId, session.generation)
    )
  }

  /** Settle only an earlier claim, including when completion arrives just after the break ends. */
  settleAnswer(
    sessionId: string,
    questionId: string,
    outcome: 'sent' | 'ambiguous',
  ): void {
    this.#transaction(() => {
      const now = this.#now(),
        card = this.#card(sessionId, questionId)
      if (
        !card ||
        (card.disposition !== 'pending' &&
          !(outcome === 'sent' && card.disposition === 'ambiguous'))
      )
        return
      this.#db
        .prepare(
          "UPDATE sv_questions SET disposition=?,live=CASE WHEN ?='sent' THEN 0 ELSE live END WHERE sessionId=? AND questionId=?",
        )
        .run(outcome, outcome, sessionId, questionId)
      this.#db
        .prepare(
          "UPDATE sv_reviews SET outcome=?,reason=?,at=? WHERE breakId=? AND sessionId=? AND questionId=? AND outcome IN ('pending','ambiguous')",
        )
        .run(
          outcome,
          outcome === 'sent' ? null : 'Delivery was not confirmed',
          now,
          card.candidate,
          sessionId,
          questionId,
        )
      if (outcome === 'sent')
        this.#work.setWaiting(sessionId, questionId, false, now)
    })
  }

  /**
   * Record the original hook's positive confirmation that it wrote no answer bytes.
   * A held receipt keeps the original request claim consumed and its candidate private.
   * @example supervisor.discardUndelivered('session', 'question')
   */
  discardUndelivered(sessionId: string, questionId: string): void {
    this.#transaction(() => {
      const card = this.#card(sessionId, questionId)
      if (!card || !['pending', 'ambiguous'].includes(card.disposition)) return
      const closed = this.#db
        .prepare('SELECT 1 FROM sv_resolved WHERE sessionId=? AND questionId=?')
        .get(sessionId, questionId)
      const outcome = closed ? 'resolved' : 'held'
      this.#db
        .prepare(
          "UPDATE sv_questions SET disposition=? WHERE sessionId=? AND questionId=? AND disposition IN ('pending','ambiguous')",
        )
        .run(outcome, sessionId, questionId)
      this.#db
        .prepare(
          "UPDATE sv_reviews SET outcome=?,answer=NULL,reason=?,at=? WHERE breakId=? AND sessionId=? AND questionId=? AND outcome IN ('pending','ambiguous')",
        )
        .run(
          outcome,
          closed
            ? 'Original request ended without a delegated answer'
            : 'Original hook confirmed no answer was delivered',
          this.#now(),
          card.candidate,
          sessionId,
          questionId,
        )
    })
  }

  /** Claim ready native side effects once across repeated polling, racing actions, and restarts. */
  takeEffects(): NativeEffect[] {
    return this.#transaction(() => {
      const now = this.#now()
      this.#advance(now)
      const ready = this.#db
        .prepare(
          'SELECT seq,kind,id FROM sv_effects WHERE claimed=0 ORDER BY seq',
        )
        .all()
      const active = this.#active(),
        invite = this.#invitation()
      const effects: NativeEffect[] = []
      for (const row of ready) {
        this.#db
          .prepare('UPDATE sv_effects SET claimed=1 WHERE seq=?')
          .run(row.seq)
        const id = String(row.id)
        if (
          row.kind === 'digest' ||
          row.kind === 'review-updated' ||
          (row.kind === 'break' && id === active?.id) ||
          (row.kind === 'invitation' && id === invite?.id)
        )
          effects.push({ kind: row.kind, id })
      }
      return effects
    })
  }

  /** Load a bounded local IPC page while pinning the chosen break and receipt order. */
  reviewPage(query: ReviewQuery = {}): ReviewPage {
    this.tick()
    return readReviewPage(this.#db, query)
  }

  /** Read private review details for a specific break or the most recently started one. */
  review(breakId?: string): ReviewReceipt[] {
    this.tick()
    const rows: ReviewReceipt[] = []
    let page = readReviewPage(this.#db, { breakId })
    rows.push(...page.rows)
    while (page.nextCursor) {
      page = readReviewPage(this.#db, {
        breakId: page.breakId ?? undefined,
        cursor: page.nextCursor,
      })
      rows.push(...page.rows)
    }
    return rows
  }

  /** Project current load and detector coverage for the local CLI; question text is available through review. */
  status() {
    this.tick()
    const now = this.#lastAt,
      active = this.#active(),
      invite = this.#invitation()
    return {
      score: active ? 0 : this.#work.score(now, this.#control().resetAt),
      threshold: this.#threshold,
      supervising: this.#supervising(now),
      activeBreakId: active?.id ?? null,
      invitationId: invite?.id ?? null,
      break: active
        ? {
            id: active.id,
            startedAt: active.startedAt,
            endsAt: active.expiresAt,
          }
        : null,
      activeBreak: active
        ? {
            ...active,
            sessionCount: Number(
              this.#db
                .prepare('SELECT COUNT(*) AS n FROM sv_members WHERE breakId=?')
                .get(active.id)?.n,
            ),
          }
        : null,
      invitation: invite ?? null,
      snoozeUntil: this.#control().snoozeAt,
      sessions: this.#work.views(now),
      coverage: [...this.#coverage.values()],
    }
  }
}
