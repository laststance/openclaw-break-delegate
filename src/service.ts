import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { decodeCards } from './hooks.js'
import {
  boundedGatewayStatus,
  isObject,
  listenGateway,
  type ObjectValue,
  type RpcContext,
} from './ipc.js'
import {
  PreferenceStore,
  isStandingReplyInstruction,
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
  maxConfirmationsPerBreak?: number
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
  /** Native helper inside the installed package. */
  helperExecutable?: string
  poll?: (coordinator: Supervision) => Promise<void>
  now?: () => number
  tickMs?: number
}
interface PendingReceipt {
  breakId: string
  deliverBefore: number
  sessionId: string
  questionId: string
  incarnation: string | null
  expires: number
  emitted: number
  applied: number
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
  const confirmationLimit = options.maxConfirmationsPerBreak ?? 60
  function getReceipt(id: unknown): PendingReceipt | undefined {
    if (typeof id !== 'string' || id.length !== 36) return
    return db
      .prepare(
        'SELECT sessionId,questionId,breakId,incarnation,deliverBefore,expires,emitted,applied FROM bd_delivery_receipts WHERE receipt=?',
      )
      .get(id) as unknown as PendingReceipt | undefined
  }
  const activeAsks = new Set<string>()
  // Only the live service that evaluated the original cards can authorize their emission.
  const deliveryChecks = new Map<string, () => string | undefined>()
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
  let retainedDigest: string | undefined
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
        const since = now() - 3_600_000
        for (const reply of preferences.excludedResponsesSince(since)) {
          coordinator.retractHumanReply({
            provider: reply.source,
            sessionId: reply.sessionId,
            responseId: reply.responseId,
          })
        }
        // Losing a transcript match can be temporary if its paired file is rotated.
        for (const reply of preferences.unmatchedTypedResponsesSince(since)) {
          coordinator.retractHumanReply({
            provider: reply.source,
            sessionId: reply.sessionId,
            responseId: reply.responseId,
            permanent: false,
          })
        }
        for (const reply of preferences.humanResponsesSince(since)) {
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
  function nativeReview(id: string) {
    const rows = coordinator.review(id)
    return {
      answered: rows
        .filter((r) => r.outcome === 'sent')
        .map((r) => ({ question: r.question, answer: r.answer ?? '' })),
      held: rows
        .filter(
          (r) =>
            r.outcome !== 'sent' &&
            r.outcome !== 'human' &&
            r.outcome !== 'resolved',
        )
        .map((r) => ({
          question: r.question,
          reason: r.reason ?? r.outcome,
        })),
    }
  }
  function refreshRetainedDigest(id: string) {
    if (retainedDigest === id && ui.refreshSummary) {
      void ui
        .refreshSummary(id, nativeReview(id))
        .catch(() => options.log('The native review could not refresh.'))
    }
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
          try {
            if (effect.kind === 'review-updated') {
              refreshRetainedDigest(effect.id)
              continue
            }
            if (effect.kind === 'invitation') {
              visibleInvitation = effect.id
              const result = await ui.invite(effect.id)
              nativeStatus = result
              if (result.status === 'unavailable')
                options.log(
                  'The break invitation could not be displayed. Check the native helper with openclaw break-delegate status.',
                )
            } else {
              visibleInvitation = undefined
            }
            if (effect.kind === 'break') {
              const active = coordinator.status().break
              if (active?.id === effect.id)
                nativeStatus = await ui.active(effect.id, active.endsAt)
            }
            if (effect.kind === 'digest') {
              retainedDigest = effect.id
              nativeStatus = await ui.summary(
                effect.id,
                nativeReview(effect.id),
              )
            }
          } catch {
            // Each claimed effect is independent, including later break reviews.
            options.log('A native break action could not be displayed.')
          }
        }
        if (
          !closing &&
          visibleInvitation &&
          coordinator.status().invitationId !== visibleInvitation
        ) {
          visibleInvitation = undefined
          retainedDigest = undefined
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
    let retainedReviewExpired = false
    for (const row of db
      .prepare(
        'SELECT receipt,sessionId,questionId,breakId FROM bd_delivery_receipts WHERE expired=0 AND expires<=?',
      )
      .all(now())) {
      deliveryChecks.delete(String(row.receipt))
      coordinator.settleAnswer(
        String(row.sessionId),
        String(row.questionId),
        'ambiguous',
      )
      db.prepare(
        'UPDATE bd_delivery_receipts SET expired=1 WHERE receipt=?',
      ).run(row.receipt)
      if (row.breakId === retainedDigest) retainedReviewExpired = true
    }
    if (retainedDigest && retainedReviewExpired)
      refreshRetainedDigest(retainedDigest)
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
    const observedAt =
      typeof r.at === 'number' && Number.isFinite(r.at)
        ? Math.min(r.at, now())
        : now()
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
      coordinator.observe({
        ...base,
        status: 'idle',
        newSession: true,
        at: observedAt,
      })
      return null
    }
    if (event === 'SessionEnd') {
      coordinator.observe({ ...base, status: 'closed' })
      return null
    }
    if (event === 'Stop') {
      coordinator.observe({
        ...base,
        status: 'idle',
        turnEnded: true,
        at: observedAt,
      })
      return null
    }
    if (
      typeof r.toolName === 'string' &&
      r.toolName !== 'AskUserQuestion' &&
      (event === 'PreToolUse' ||
        event === 'PermissionRequest' ||
        event === 'PostToolUse' ||
        event === 'PostToolUseFailure')
    ) {
      coordinator.observeExecution({
        event,
        sessionId,
        incarnation,
        toolName: r.toolName,
        toolUseId: questionId,
        fingerprint:
          typeof r.fingerprint === 'string' ? r.fingerprint : undefined,
        at: observedAt,
      })
      return null
    }
    if (event === 'Notification') {
      if (r.reason === 'permission_prompt')
        coordinator.observe({ ...base, status: 'waiting' })
      else if (r.reason === 'idle_prompt')
        coordinator.observe({ ...base, status: 'idle' })
      return null
    }
    if (event === 'UserPromptSubmit' && typeof r.prompt === 'string') {
      if (
        typeof r.replyTo !== 'string' ||
        !r.replyTo ||
        r.truncated === true ||
        isStandingReplyInstruction(r.prompt)
      )
        preferences.recordInstruction(
          'claude',
          sessionId,
          r.prompt,
          now(),
          r.truncated === true,
        )
      if (typeof r.replyTo === 'string')
        coordinator.humanReply({
          provider: 'claude',
          sessionId,
          incarnation,
          observedLive: true,
          responseId: typedResponseId(
            r.prompt,
            typeof r.at === 'number' ? r.at : now(),
            typeof r.clientId === 'string' ? r.clientId : undefined,
            r.replyTo,
          ),
        })
      coordinator.observe({ ...base, status: 'running' })
      return null
    }
    if (event === 'PostToolUseFailure' && questionId) {
      coordinator.resolveQuestion(sessionId, questionId, 'failed')
      coordinator.observe({ ...base, status: 'running' })
      return null
    }
    const cards = decodeCards(r.cards)
    if (!questionId || (!cards && r.unsupported !== true)) return null
    if (event === 'PostToolUse') {
      const answers = r.answers
      const original = db
        .prepare(
          'SELECT receipt,expected FROM bd_delivery_receipts WHERE sessionId=? AND questionId=? AND incarnation=?',
        )
        .get(sessionId, questionId, incarnation)
      if (
        original &&
        isObject(answers) &&
        typeof original.expected === 'string'
      ) {
        const expected = JSON.parse(original.expected) as Record<string, string>
        if (
          Object.keys(answers).length === Object.keys(expected).length &&
          Object.entries(expected).every(([q, label]) => answers[q] === label)
        ) {
          db.prepare(
            'UPDATE bd_delivery_receipts SET applied=1 WHERE receipt=?',
          ).run(original.receipt)
          finalizeProviderReceipt(String(original.receipt))
        }
      }
      if (
        r.human === true &&
        (isObject(answers) || (!cards && r.selected === true))
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
              conditional:
                Array.isArray(r.conditional) &&
                r.conditional.includes(card.question),
              askedAt: Number(start.openedAt),
              answeredAt: now(),
            })
        }
        if (
          selected &&
          !preferences.isDelegated('claude', sessionId, questionId)
        )
          coordinator.humanReply({
            provider: 'claude',
            sessionId,
            incarnation,
            questionId,
            observedLive: true,
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
    if (
      db
        .prepare('SELECT 1 FROM bd_incomplete_prompts WHERE incarnation=?')
        .get(incarnation)
    ) {
      coordinator.hold(
        sessionId,
        questionId,
        'An instruction exceeded the hook input limit',
      )
      return null
    }
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
      // Charge the break's allowance before inference, including concurrent attempts and model timeouts.
      const reserved = db
        .prepare(
          'INSERT OR IGNORE INTO bd_model_attempts(breakId,sessionId,questionId) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM bd_model_attempts WHERE breakId=?) < ?',
        )
        .run(
          ticket.breakId,
          sessionId,
          questionId,
          ticket.breakId,
          confirmationLimit,
        )
      if (!reserved.changes) {
        coordinator.hold(
          sessionId,
          questionId,
          'Model confirmation allowance reached or already attempted',
        )
        return null
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
      // Reuse the original policy inputs at claim time and at the final hook authorization.
      const blockingReason = (): string | undefined => {
        if (
          db
            .prepare('SELECT 1 FROM bd_incomplete_prompts WHERE incarnation=?')
            .get(incarnation)
        )
          return 'An instruction exceeded the hook input limit'
        for (const [index, card] of cards.entries()) {
          const fresh = preferences.evaluate(card, {
            cwd,
            now: now(),
            session: { source: 'claude', sessionId },
          })
          if (fresh.eligibleLabel !== payload[index]!.candidate)
            return fresh.reason ?? 'Preference changed during confirmation'
        }
      }
      const reason = blockingReason()
      if (reason) {
        coordinator.hold(sessionId, questionId, reason)
        return null
      }
      const authorizedBreak = coordinator.status().break
      if (!authorizedBreak || authorizedBreak.id !== ticket.breakId) return null
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
          () => {
            preferences.excludeDelegated('claude', sessionId, questionId)
            db.prepare(
              'INSERT INTO bd_delivery_receipts(receipt,breakId,sessionId,questionId,deliverBefore,expires,expected,incarnation) VALUES(?,?,?,?,?,?,?,?)',
            ).run(
              receipt,
              authorizedBreak.id,
              sessionId,
              questionId,
              authorizedBreak.endsAt,
              now() + 15000,
              JSON.stringify(answers),
              incarnation,
            )
          },
        )
      )
        return null
      deliveryChecks.set(receipt, blockingReason)
      return { answers, receipt, deliverBefore: authorizedBreak.endsAt }
    } finally {
      activeAsks.delete(id)
    }
  }
  /** Check the original live card again when the Gateway returns a claim and immediately before the hook emits it. */
  function mayDeliver(id: unknown): boolean {
    const receipt = getReceipt(id)
    if (
      !receipt?.incarnation ||
      receipt.emitted ||
      receipt.applied ||
      typeof id !== 'string'
    )
      return false
    const check = deliveryChecks.get(id)
    if (!check || check() !== undefined) return false
    // Policy replay can take time. Sample the clock again before accepting the original recipient.
    const at = now()
    return (
      at < receipt.expires &&
      at < receipt.deliverBefore &&
      coordinator.isPendingDelivery(
        receipt.sessionId,
        receipt.questionId,
        receipt.breakId,
        receipt.incarnation,
      )
    )
  }
  function finalizeProviderReceipt(receiptId: string) {
    const row = db
      .prepare(
        'SELECT sessionId,questionId,breakId FROM bd_delivery_receipts WHERE receipt=? AND emitted=1 AND applied=1',
      )
      .get(receiptId)
    if (!row) return
    deliveryChecks.delete(receiptId)
    coordinator.settleAnswer(
      String(row.sessionId),
      String(row.questionId),
      'sent',
    )
    db.prepare('DELETE FROM bd_delivery_receipts WHERE receipt=?').run(
      receiptId,
    )
    refreshRetainedDigest(String(row.breakId))
  }
  function retireUndelivered(id: unknown): boolean {
    const receipt = getReceipt(id)
    if (
      !receipt ||
      typeof id !== 'string' ||
      receipt.emitted ||
      receipt.applied
    )
      return false
    deliveryChecks.delete(id)
    coordinator.discardUndelivered(receipt.sessionId, receipt.questionId)
    if (
      preferences.releaseUndelivered(
        'claude',
        receipt.sessionId,
        receipt.questionId,
      )
    ) {
      for (const reply of preferences.humanResponsesSince(now() - 3600000)) {
        if (
          reply.source === 'claude' &&
          reply.sessionId === receipt.sessionId &&
          reply.responseId === 'tool:' + receipt.questionId
        ) {
          coordinator.humanReply({
            provider: 'claude',
            sessionId: reply.sessionId,
            responseId: reply.responseId,
            at: reply.at,
          })
        }
      }
    }
    refreshRetainedDigest(receipt.breakId)
    db.prepare('DELETE FROM bd_delivery_receipts WHERE receipt=?').run(id)
    return true
  }
  async function dispatch(r: ObjectValue, ctx: RpcContext): Promise<unknown> {
    if (r.op === 'ping') return { ready }
    if (!ready || closing) throw Error('Gateway is starting.')
    switch (r.op) {
      case 'status':
        return boundedGatewayStatus({
          supervision: coordinator.status(),
          native: nativeStatus,
          history: lastImport,
        })
      case 'review-page':
        return coordinator.reviewPage({
          breakId: typeof r.breakId === 'string' ? r.breakId : undefined,
          cursor: typeof r.cursor === 'string' ? r.cursor : undefined,
        })
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
      case 'incomplete-instruction':
        if (
          typeof r.incarnation !== 'string' ||
          !r.incarnation ||
          r.incarnation.length > 180
        )
          return false
        if (
          typeof r.sessionId === 'string' &&
          r.sessionId.length > 0 &&
          r.sessionId.length <= 256 &&
          !/[\x00-\x1f]/u.test(r.sessionId)
        ) {
          preferences.recordInstruction('claude', r.sessionId, '', now(), true)
          return true
        }
        db.prepare(
          'INSERT OR REPLACE INTO bd_incomplete_prompts VALUES(?,?)',
        ).run(r.incarnation, now())
        return true
      case 'hook': {
        const value = await onHook(r, ctx)
        tick()
        if (isObject(value) && typeof value.receipt === 'string') {
          if (!mayDeliver(value.receipt)) {
            retireUndelivered(value.receipt)
            return null
          }
        }
        return value
      }
      case 'can-deliver': {
        return mayDeliver(r.receipt)
      }
      case 'undelivered':
        return retireUndelivered(r.receipt)
      case 'ack': {
        if (typeof r.receipt !== 'string' || !getReceipt(r.receipt))
          return false
        // Stdout confirms emission only. A matching Claude PostToolUse confirms actual application.
        db.prepare(
          'UPDATE bd_delivery_receipts SET emitted=1 WHERE receipt=?',
        ).run(r.receipt)
        finalizeProviderReceipt(r.receipt)
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
  let openedDatabase: DatabaseSync | undefined
  let openedUi: NativeUi | undefined
  let timer: NodeJS.Timeout | undefined
  function refresh(): void {
    if (closing) return
    tick()
    if (now() - lastImportAt >= 300000) void refreshHistory()
    // Wall-clock deadlines and native reviews continue while a provider is slow.
    if (!polling)
      void refreshActivity()
        .then(() => {
          if (!closing) tick()
        })
        .catch(() =>
          options.log('The latest workload sample could not be recorded.'),
        )
  }
  async function stop() {
    closing = true
    ready = false
    stopSignal.abort()
    if (timer) clearInterval(timer)
    try {
      await closeSocket()
    } finally {
      try {
        openedUi?.close()
      } finally {
        await Promise.allSettled([polling, importing, effectsTask, ...requests])
        openedDatabase?.close()
      }
    }
  }
  try {
    const dbPath = join(options.directory, 'state.sqlite')
    closeSync(openSync(dbPath, 'a', 0o600))
    chmodSync(dbPath, 0o600)
    db = openedDatabase = new DatabaseSync(dbPath)
    db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2500; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS bd_hook_times(sessionId TEXT,questionId TEXT,openedAt INTEGER, PRIMARY KEY(sessionId,questionId));',
    )
    db.exec(`CREATE TABLE IF NOT EXISTS bd_model_attempts(breakId TEXT NOT NULL,sessionId TEXT NOT NULL,questionId TEXT NOT NULL,PRIMARY KEY(breakId,sessionId,questionId));
      CREATE TABLE IF NOT EXISTS bd_delivery_receipts(receipt TEXT PRIMARY KEY,breakId TEXT NOT NULL,sessionId TEXT NOT NULL,questionId TEXT NOT NULL,deliverBefore INTEGER NOT NULL,expires INTEGER NOT NULL,expired INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS bd_incomplete_prompts(incarnation TEXT PRIMARY KEY,at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS bd_pending_expiry ON bd_delivery_receipts(expired,expires);`)
    const receiptColumns = new Set(
      db
        .prepare('PRAGMA table_info(bd_delivery_receipts)')
        .all()
        .map((r) => String(r.name)),
    )
    for (const [name, type] of [
      ['expected', 'TEXT'],
      ['incarnation', 'TEXT'],
      ['emitted', 'INTEGER NOT NULL DEFAULT 0'],
      ['applied', 'INTEGER NOT NULL DEFAULT 0'],
    ] as const) {
      if (!receiptColumns.has(name))
        db.exec(
          'ALTER TABLE bd_delivery_receipts ADD COLUMN ' + name + ' ' + type,
        )
    }
    coordinator = new Supervision(db, { ...options.workload, now })
    preferences = new PreferenceStore(db)
    ui = openedUi = (options.nativeFactory ?? createNativeBreakUi)(
      async (action) => {
        if (closing) return
        // Freeze the known session set as soon as the native callback arrives.
        const accepted = coordinator.action(
          action.id,
          action.kind === 'start' ? 'accept' : action.kind,
        )
        await effects()
        if (
          !accepted &&
          action.kind === 'start' &&
          coordinator.status().invitationId === action.id
        )
          return 'restore-invitation' as const
      },
      {
        profileDirectory: options.directory,
        executable: options.helperExecutable,
      },
    )
    ready = true
    refresh()
    void ui
      .status()
      .then((v) => {
        nativeStatus = v
      })
      .catch(() => {
        nativeStatus = { status: 'unavailable' }
      })
    timer = setInterval(() => {
      try {
        refresh()
      } catch {
        options.log('The workload clock could not update.')
      }
    }, options.tickMs ?? 15000)
    timer.unref()
  } catch (err) {
    await stop()
    throw err
  }
  return stop
}
