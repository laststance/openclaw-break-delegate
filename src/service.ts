import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { decodeCards } from './hooks.js'
import {
  isObject,
  listenGateway,
  type ObjectValue,
  type RpcContext,
} from './ipc.js'
import {
  PreferenceStore,
  typedResponseId,
  type HistoryRoots,
} from './preferences/index.js'
import {
  LocalActivityProbe,
  Supervision,
  type SupervisionOptions,
} from './supervision/index.js'
import { createNativeBreakUi } from './native/index.js'
import type { Judge, JudgeCard } from './model.js'

type NativeUi = ReturnType<typeof createNativeBreakUi>
type UiFactory = typeof createNativeBreakUi
interface ServiceOptions {
  directory: string
  judge: Judge
  log: (message: string) => void
  workload?: Pick<
    SupervisionOptions,
    | 'threshold'
    | 'activePointsPerMinute'
    | 'additionalPointsPerMinute'
    | 'humanReplyPoints'
  >
  roots?: HistoryRoots
  nativeFactory?: UiFactory
  poll?: (coordinator: Supervision) => Promise<void>
  now?: () => number
  tickMs?: number
}
interface PendingReceipt {
  sessionId: string
  questionId: string
  expires: number
}

/** Run the owner of consent, evidence and native actions for one OpenClaw profile.
 * Bind the socket before claiming durable state; cancel model work on a disconnected hook.
 * @example
 * const stop = await startService({ directory, judge, log });
 */
export async function startService(
  options: ServiceOptions,
): Promise<() => Promise<void>> {
  const now = options.now ?? Date.now
  let ready = false,
    closing = false
  let db: DatabaseSync,
    coordinator: Supervision,
    preferences: PreferenceStore,
    ui: NativeUi
  let nativeStatus: unknown = { status: 'not-determined' }
  const pending = new Map<string, PendingReceipt>()
  const activeAsks = new Set<string>()
  const stopSignal = new AbortController()
  const probe = new LocalActivityProbe({ codexHome: options.roots?.codex, now })
  const poll = options.poll ?? ((c) => probe.poll(c))
  let polling: Promise<void> | undefined
  let importing: Promise<unknown> | undefined
  let lastImport: unknown = null
  let lastImportAt = -Infinity
  let effectsTask: Promise<void> | undefined
  let drainAgain = false
  let visibleInvitation: string | undefined
  const key = (s: string, q: string) => JSON.stringify([s, q])
  function refreshActivity(): Promise<void> {
    polling ??= poll(coordinator)
      .catch(() => options.log('Activity sampling is temporarily unavailable.'))
      .finally(() => {
        polling = undefined
      })
    return polling
  }
  function refreshHistory(): Promise<unknown> {
    importing ??= preferences
      .importHistory(options.roots)
      .then((v) => {
        for (const reply of preferences.humanResponsesSince(now() - 3600000)) {
          coordinator.humanReply({
            provider: reply.source,
            sessionId: reply.sessionId,
            responseId: reply.responseId,
            at: reply.at,
          })
        }
        lastImport = v
        return v
      })
      .catch(() => {
        lastImport = { error: 'Local history import failed.' }
        return lastImport
      })
      .finally(() => {
        lastImportAt = now()
        importing = undefined
      })
    return importing
  }
  function effects(): Promise<void> {
    drainAgain = true
    if (effectsTask) return Promise.resolve()
    effectsTask = deliverEffects().finally(() => {
      effectsTask = undefined
    })
    return effectsTask
  }
  async function deliverEffects(): Promise<void> {
    try {
      do {
        drainAgain = false
        for (const effect of coordinator.takeEffects()) {
          if (closing) return
          if (effect.kind === 'invitation') {
            visibleInvitation = effect.id
            nativeStatus = await ui.invite(effect.id)
          } else {
            visibleInvitation = undefined
          }
          if (effect.kind === 'break')
            nativeStatus = await ui.active(
              effect.id,
              coordinator.status().break?.endsAt ?? now() + 900000,
            )
          if (effect.kind === 'digest') {
            const rows = coordinator.review(effect.id)
            nativeStatus = await ui.summary(effect.id, {
              answered: rows
                .filter((r) => r.outcome === 'sent')
                .map((r) => ({ question: r.question, answer: r.answer ?? '' })),
              held: rows
                .filter((r) => r.outcome !== 'sent' && r.outcome !== 'human')
                .map((r) => ({
                  question: r.question,
                  reason: r.reason ?? r.outcome,
                })),
            })
          }
        }
        if (
          !closing &&
          visibleInvitation &&
          coordinator.status().invitationId !== visibleInvitation
        ) {
          visibleInvitation = undefined
          nativeStatus = await ui.clear()
        }
      } while (drainAgain && !closing)
    } catch {
      options.log('Native break actions are currently unavailable.')
    }
  }
  function tick(): void {
    if (closing) return
    coordinator.tick()
    db.prepare('DELETE FROM bd_hook_times WHERE openedAt<?').run(
      now() - 86400000,
    )
    for (const [id, r] of pending) {
      if (r.expires <= now()) {
        coordinator.settleAnswer(r.sessionId, r.questionId, 'ambiguous')
        pending.delete(id)
      }
    }
    void effects()
  }
  async function onHook(r: ObjectValue, ctx: RpcContext): Promise<unknown> {
    const { sessionId, incarnation, cwd, event } = r
    if (
      typeof sessionId !== 'string' ||
      !sessionId ||
      sessionId.length > 256 ||
      typeof incarnation !== 'string' ||
      incarnation.length > 180 ||
      typeof cwd !== 'string' ||
      cwd.length > 8192 ||
      typeof event !== 'string'
    )
      return null
    const base = {
      provider: 'claude' as const,
      sessionId,
      incarnation,
      canDelegate: true,
      source: 'hook',
    }
    const questionId =
      typeof r.questionId === 'string' && r.questionId.length <= 256
        ? r.questionId
        : undefined
    if (event === 'SessionStart') {
      coordinator.observe({ ...base, status: 'idle', newSession: true })
      return null
    }
    if (event === 'SessionEnd') {
      coordinator.observe({ ...base, status: 'closed' })
      return null
    }
    if (event === 'Stop') {
      coordinator.observe({ ...base, status: 'idle' })
      return null
    }
    if (event === 'Notification' || event === 'PermissionRequest') {
      if (event === 'PermissionRequest' || r.reason === 'permission_prompt') {
        coordinator.observe({ ...base, status: 'waiting' })
        if (questionId)
          coordinator.question({
            sessionId,
            questionId,
            incarnation,
            question: 'Execution approval',
            kind: 'approval',
            openedAt: now(),
          })
      } else if (r.reason === 'idle_prompt')
        coordinator.observe({ ...base, status: 'idle' })
      return null
    }
    if (event === 'UserPromptSubmit' && typeof r.prompt === 'string') {
      preferences.recordInstruction('claude', sessionId, r.prompt, now())
      if (typeof r.replyTo === 'string')
        coordinator.humanReply({
          provider: 'claude',
          sessionId,
          incarnation,
          responseId: typedResponseId(
            r.prompt,
            typeof r.at === 'number' ? r.at : now(),
            typeof r.clientId === 'string' ? r.clientId : undefined,
          ),
        })
      coordinator.observe({ ...base, status: 'running' })
      return null
    }
    if (event === 'PostToolUseFailure' && questionId) {
      coordinator.resolveQuestion(sessionId, questionId)
      coordinator.observe({ ...base, status: 'running' })
      return null
    }
    const cards = decodeCards(r.cards)
    if (!questionId || (!cards && r.unsupported !== true)) return null
    if (event === 'PostToolUse') {
      const answers = r.answers
      if (
        r.human === true &&
        (isObject(answers) || (!cards && r.selected === true)) &&
        !preferences.isDelegated('claude', sessionId, questionId)
      ) {
        // A delivered/pending delegate can never become a new human example or workload response.
        const start = db
          .prepare(
            'SELECT openedAt FROM bd_hook_times WHERE sessionId=? AND questionId=?',
          )
          .get(sessionId, questionId)
        let selected = !cards && r.selected === true
        for (const card of cards ?? []) {
          const label = isObject(answers) ? answers[card.question] : undefined
          if (typeof label !== 'string' || !label.trim()) continue
          selected = true
          if (start)
            preferences.recordHumanSelection({
              source: 'claude',
              sessionId,
              toolUseId: questionId,
              cwd,
              card,
              label,
              askedAt: Number(start.openedAt),
              answeredAt: now(),
            })
        }
        if (selected)
          coordinator.humanReply({
            provider: 'claude',
            sessionId,
            incarnation,
            questionId,
            responseId: 'tool:' + questionId,
          })
      }
      coordinator.resolveQuestion(sessionId, questionId)
      coordinator.observe({ ...base, status: 'running' })
      return null
    }
    if (event !== 'PreToolUse') return null
    const id = key(sessionId, questionId)
    if (activeAsks.has(id)) return null
    db.prepare('INSERT OR IGNORE INTO bd_hook_times VALUES (?,?,?)').run(
      sessionId,
      questionId,
      now(),
    )
    coordinator.observe({ ...base, status: 'waiting' })
    const ticket = coordinator.question({
      sessionId,
      questionId,
      incarnation,
      question:
        cards?.map((c) => c.question).join('\n') ??
        (typeof r.question === 'string'
          ? r.question.slice(0, 8000)
          : 'Claude Code question'),
      openedAt: typeof r.at === 'number' ? Math.min(r.at, now()) : now(),
      kind: 'choice',
    })
    if (!ticket.eligible || !ticket.breakId) return null
    if (!cards) {
      coordinator.hold(sessionId, questionId, 'Unsupported question content')
      return null
    }
    activeAsks.add(id)
    try {
      const payload: JudgeCard[] = []
      for (const card of cards) {
        const decision = preferences.evaluate(card, {
          cwd,
          now: now(),
          session: { source: 'claude', sessionId },
        })
        if (!decision.eligibleLabel || !decision.summary) {
          coordinator.hold(
            sessionId,
            questionId,
            decision.reason ?? 'Insufficient evidence',
          )
          return null
        }
        payload.push({
          question: card.question,
          ...(card.header ? { header: card.header } : {}),
          options: card.options,
          candidate: decision.eligibleLabel,
          summary: decision.summary,
        })
      }
      const signal = AbortSignal.any([
        ctx.signal,
        stopSignal.signal,
        AbortSignal.timeout(9500),
      ])
      const allowed = await options.judge(payload, signal).catch(() => false)
      if (!allowed || signal.aborted || !ctx.connected()) {
        coordinator.hold(sessionId, questionId, 'Confirmation unavailable')
        return null
      }
      const answers = Object.fromEntries(
        payload.map((c) => [c.question, c.candidate]),
      )
      const receipt = randomUUID()
      // A crash after the claim must never teach this answer as a human choice.
      if (
        !coordinator.commitAnswer(
          {
            sessionId,
            questionId,
            breakId: ticket.breakId,
            incarnation,
            answer: payload.map((c) => c.candidate).join('\n'),
          },
          ctx.connected,
          () => preferences.excludeDelegated('claude', sessionId, questionId),
        )
      )
        return null
      pending.set(receipt, { sessionId, questionId, expires: now() + 15000 })
      return { answers, receipt }
    } finally {
      activeAsks.delete(id)
    }
  }
  async function dispatch(r: ObjectValue, ctx: RpcContext): Promise<unknown> {
    if (r.op === 'ping') return { ready }
    if (!ready || closing) throw Error('Gateway is starting.')
    switch (r.op) {
      case 'status':
        return {
          supervision: coordinator.status(),
          native: nativeStatus,
          history: lastImport,
        }
      case 'review':
        return coordinator.review(
          typeof r.breakId === 'string' ? r.breakId : undefined,
        )
      case 'return': {
        const current = coordinator.status().break
        if (!current) return { returned: false }
        const returned = coordinator.action(current.id, 'return')
        void effects()
        return { returned }
      }
      case 'authorize-notifications':
        nativeStatus = await ui.authorize()
        return nativeStatus
      case 'import':
        return await refreshHistory()
      case 'replay':
        return preferences.replay()
      case 'hook': {
        const value = await onHook(r, ctx)
        tick()
        return value
      }
      case 'ack': {
        const receipt =
          typeof r.receipt === 'string' ? pending.get(r.receipt) : undefined
        if (!receipt || typeof r.receipt !== 'string') return false
        pending.delete(r.receipt)
        coordinator.settleAnswer(receipt.sessionId, receipt.questionId, 'sent')
        return true
      }
      default:
        throw Error('Unknown command.')
    }
  }
  const requests = new Set<Promise<unknown>>()
  const closeSocket = await listenGateway(options.directory, (r, c) => {
    const task = dispatch(r, c)
    requests.add(task)
    void task.then(
      () => requests.delete(task),
      () => requests.delete(task),
    )
    return task
  })
  try {
    const dbPath = join(options.directory, 'state.sqlite')
    closeSync(openSync(dbPath, 'a', 0o600))
    chmodSync(dbPath, 0o600)
    db = new DatabaseSync(dbPath)
    db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2500; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS bd_hook_times(sessionId TEXT,questionId TEXT,openedAt INTEGER, PRIMARY KEY(sessionId,questionId));',
    )
    coordinator = new Supervision(db, { ...options.workload, now })
    preferences = new PreferenceStore(db)
    ui = (options.nativeFactory ?? createNativeBreakUi)(async (action) => {
      if (closing) return
      // Freeze the known session set as soon as the native callback arrives.
      coordinator.action(
        action.id,
        action.kind === 'start' ? 'accept' : action.kind,
      )
      await effects()
    })
    ready = true
  } catch (err) {
    await closeSocket()
    throw err
  }
  const refresh = async () => {
    await refreshActivity()
    if (closing) return
    tick()
    if (now() - lastImportAt >= 300000) void refreshHistory()
  }
  void ui
    .status()
    .then((v) => {
      nativeStatus = v
    })
    .catch(() => {
      nativeStatus = { status: 'unavailable' }
    })
  void refresh()
  const timer = setInterval(() => {
    void refresh()
  }, options.tickMs ?? 15000)
  timer.unref()
  return async () => {
    closing = true
    ready = false
    stopSignal.abort()
    clearInterval(timer)
    await closeSocket()
    ui.close()
    await Promise.allSettled([polling, importing, effectsTask, ...requests])
    db.close()
  }
}
