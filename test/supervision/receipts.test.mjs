import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { ExecutionApprovals } from '../../dist/supervision/execution.js'
import {
  Supervision,
  toolInputFingerprint,
} from '../../dist/supervision/index.js'

function setup(t) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  let now = Date.UTC(2026, 0, 1)
  const s = new Supervision(db, {
    threshold: 4,
    now: () => now,
    activePointsPerMinute: 0,
  })
  const context = { sessionId: 'terminal', incarnation: 'one' }
  s.observe({
    provider: 'claude',
    ...context,
    status: 'running',
    canDelegate: true,
  })
  const start = (id = 'start') => {
    s.humanReply({
      provider: 'claude',
      sessionId: 'terminal',
      responseId: 'prompt:' + id,
    })
    const invite = s.takeEffects().find((e) => e.kind === 'invitation')
    assert.equal(s.action(invite.id, 'accept'), true)
    return s.takeEffects().find((e) => e.kind === 'break').id
  }
  const event = (event, toolUseId, input, toolName = 'Bash') =>
    s.observeExecution({
      event,
      ...context,
      toolUseId,
      toolName,
      fingerprint: toolInputFingerprint(input),
      at: ++now,
    })
  const status = () =>
    s.status().sessions.find((row) => row.sessionId === 'terminal')?.status
  return { db, s, context, start, event, status, advance: () => ++now }
}

test('successful or failed native tool completion releases only its own held permission', (t) => {
  // Arrange
  const { s, start, event, status } = setup(t)
  const breakId = start()
  const input = { command: 'pnpm test' },
    read = { file: 'fixture.txt' }
  event('PreToolUse', 'cmd', input)
  event('PermissionRequest', 'cmd', input)
  event('PreToolUse', 'read', read, 'Read')
  event('PermissionRequest', 'read', read, 'Read')
  // Act
  assert.equal(
    event('PostToolUse', 'cmd', { command: 'edited by the person' }),
    true,
  )
  assert.equal(status(), 'waiting')
  assert.equal(event('PostToolUseFailure', 'read', read, 'Read'), true)
  // Assert
  assert.equal(status(), 'running')
  assert.deepEqual(
    s.review(breakId).map((row) => row.outcome),
    ['resolved', 'resolved'],
  )
  assert.equal(event('PermissionRequest', 'read', read, 'Read'), false)
  assert.equal(status(), 'running')
})

test('an ID-less permission survives a matching completion when an identical parallel call lost its pre-hook', (t) => {
  // Arrange
  const { s, start, event, status, context, advance } = setup(t)
  const id = start(),
    input = { command: 'same' }
  event('PreToolUse', 'visible', input)
  event('PermissionRequest', undefined, input)
  // Act
  assert.equal(event('PostToolUse', 'visible', input), false)
  assert.equal(event('PostToolUseFailure', 'missing-pre', input), false)
  s.observe({ provider: 'claude', ...context, status: 'idle' })
  // Assert
  assert.equal(status(), 'waiting')
  assert.equal(s.review(id)[0].outcome, 'held')
  s.observe({
    provider: 'claude',
    ...context,
    status: 'idle',
    turnEnded: true,
    at: advance(),
  })
  assert.equal(status(), 'idle')
  assert.equal(s.review(id)[0].outcome, 'resolved')
})

test('a delayed turn end clears only approvals that predate its provider timestamp', (t) => {
  // Arrange
  const { s, start, event, context, advance } = setup(t)
  const id = start(),
    input = { command: 'same' }
  event('PermissionRequest', 'denied', input)
  const ended = advance()
  event('PermissionRequest', 'later', input)
  // Act
  s.observe({
    provider: 'claude',
    ...context,
    status: 'idle',
    turnEnded: true,
    at: ended,
  })
  // Assert
  assert.deepEqual(
    s
      .review(id)
      .map((row) => [row.questionId, row.outcome])
      .sort(),
    [
      ['approval:denied', 'resolved'],
      ['approval:later', 'held'],
    ],
  )
  assert.equal(event('PostToolUse', 'later', input), true)
})

test('failed approval registration, tool completion and terminal closure preserve the original permission for retry', (t) => {
  // Arrange
  const { db, s, start, event, status, context } = setup(t)
  const id = start(),
    input = { command: 'test' }
  const fail = (sql) =>
    db.exec(
      'CREATE TRIGGER interrupt ' +
        sql +
        " BEGIN SELECT RAISE(ABORT,'write interrupted'); END",
    )
  const recover = () => db.exec('DROP TRIGGER interrupt')
  // Act
  fail('BEFORE INSERT ON sv_questions')
  assert.throws(() => event('PermissionRequest', 'a', input), /interrupted/)
  recover()
  assert.equal(status(), 'running')
  assert.equal(event('PermissionRequest', 'a', input), true)
  fail('BEFORE UPDATE ON sv_reviews')
  assert.throws(() => event('PostToolUse', 'a', input), /interrupted/)
  assert.throws(
    () => s.observe({ provider: 'claude', ...context, status: 'closed' }),
    /interrupted/,
  )
  recover()
  // Assert
  assert.equal(status(), 'waiting')
  assert.equal(s.review(id)[0].outcome, 'held')
  s.action(id, 'return')
  assert.equal(event('PostToolUse', 'a', input), true)
  assert.equal(event('PostToolUse', 'a', input), false)
  assert.equal(s.review(id)[0].outcome, 'resolved')
  assert.equal(status(), 'running')
})

test('a receipt authorizes delivery only while its original claimed question and terminal are still waiting', (t) => {
  // Arrange
  const { s, start, context } = setup(t)
  const id = start()
  for (const q of ['cancel', 'close']) {
    s.question({ ...context, questionId: q, question: 'Which?' })
    assert.equal(s.isPendingDelivery('terminal', q, id, 'one'), false)
    assert.equal(
      s.commitAnswer(
        { ...context, breakId: id, questionId: q, answer: 'First' },
        () => true,
      ),
      true,
    )
  }
  // Act
  assert.equal(s.isPendingDelivery('terminal', 'cancel', id, 'one'), true)
  assert.equal(s.isPendingDelivery('terminal', 'cancel', id, 'two'), false)
  assert.equal(s.isPendingDelivery('terminal', 'cancel', 'other', 'one'), false)
  s.resolveQuestion('terminal', 'cancel', 'failed')
  // Assert
  assert.equal(s.isPendingDelivery('terminal', 'cancel', id, 'one'), false)
  assert.equal(s.isPendingDelivery('terminal', 'close', id, 'one'), true)
  s.observe({ provider: 'claude', ...context, status: 'closed' })
  assert.equal(s.isPendingDelivery('terminal', 'close', id, 'one'), false)
  assert.deepEqual(
    s.review(id).map((row) => row.outcome),
    ['pending', 'pending'],
  )
})

test('a complete roster omission and duplicate startup leave the open card on its original terminal generation', (t) => {
  // Arrange
  const { s, start, context, advance, status } = setup(t)
  const id = start(),
    generation = s.status().sessions[0].generation
  s.question({ ...context, questionId: 'card', question: 'Which?' })
  // Act
  s.snapshot('claude-agents', [], {
    at: advance(),
    status: 'available',
    detail: 'Missing',
  })
  assert.equal(status(), 'waiting')
  s.observe({
    provider: 'claude',
    ...context,
    status: 'idle',
    newSession: true,
    canDelegate: true,
    at: advance(),
  })
  // Assert
  assert.equal(s.status().sessions[0].generation, generation)
  assert.equal(s.review(id)[0].outcome, 'held')
  assert.equal(
    s.commitAnswer(
      { ...context, breakId: id, questionId: 'card', answer: 'First' },
      () => true,
    ),
    true,
  )
})

test('confirmed zero-byte delivery clears the proposed answer, holds the original question, and consumes the claim', (t) => {
  // Arrange
  const { s, start, context } = setup(t)
  const breakId = start()
  s.question({ ...context, questionId: 'q', question: 'Which option?' })
  const input = { ...context, breakId, questionId: 'q', answer: 'First' }
  assert.equal(
    s.commitAnswer(input, () => true),
    true,
  )
  // Act
  s.discardUndelivered('terminal', 'q')
  s.settleAnswer('terminal', 'q', 'sent')
  // Assert
  const [row] = s.review(breakId)
  assert.equal(row.outcome, 'held')
  assert.equal(row.answer, null)
  assert.equal(
    s.commitAnswer(input, () => true),
    false,
  )
})

test('later automation provenance retracts the exact four points and suppresses repeated mirror imports across restarts', (t) => {
  // Arrange
  const { db, s } = setup(t)
  const event = { provider: 'codex', sessionId: 't', responseId: 'tool:q' }
  s.humanReply(event)
  assert.equal(s.status().score, 4)
  assert.ok(s.status().invitationId)
  // Act
  s.retractHumanReply(event)
  s.retractHumanReply(event)
  // Assert
  assert.equal(s.status().score, 0)
  assert.equal(s.status().invitationId, null)
  const reopened = new Supervision(db, { now: () => Date.UTC(2026, 0, 1) })
  assert.equal(reopened.humanReply(event), false)
  assert.equal(reopened.status().score, 0)
  assert.equal(
    reopened.humanReply({ ...event, responseId: 'tool:other' }),
    true,
  )
  assert.equal(reopened.status().score, 4)
})

test('a missing typed question withdraws the history credit until a later verified import restores it once', (t) => {
  // Arrange
  const { db, s } = setup(t)
  const reply = {
    provider: 'claude',
    sessionId: 'terminal',
    responseId: 'prompt:first',
  }
  s.humanReply(reply)
  assert.equal(s.status().score, 4)

  // Act
  s.retractHumanReply({ ...reply, permanent: false })
  s.retractHumanReply({ ...reply, permanent: false })

  // Assert
  assert.equal(s.status().score, 0)
  assert.equal(s.status().invitationId, null)
  const restarted = new Supervision(db, { now: () => Date.UTC(2026, 0, 1) })
  assert.equal(restarted.humanReply(reply), true)
  assert.equal(restarted.humanReply(reply), false)
  assert.equal(restarted.status().score, 4)
})

test('a live typed reply confirmed after history survives temporary loss and restart while definitive automation still wins', (t) => {
  // Arrange
  const { db, s } = setup(t)
  const reply = {
    provider: 'claude',
    sessionId: 'terminal',
    responseId: 'prompt:live',
  }
  s.humanReply(reply)
  assert.equal(s.humanReply({ ...reply, observedLive: true }), false)
  const restarted = new Supervision(db, { now: () => Date.UTC(2026, 0, 1) })

  // Act
  restarted.retractHumanReply({ ...reply, permanent: false })

  // Assert
  assert.equal(restarted.status().score, 4)
  restarted.retractHumanReply(reply)
  restarted.retractHumanReply({ ...reply, permanent: false })
  assert.equal(restarted.humanReply({ ...reply, observedLive: true }), false)
  assert.equal(restarted.status().score, 0)
})

test('multi-frame local review returns every original receipt exactly once after the latest break changes', (t) => {
  // Arrange
  const { s, start, context, advance } = setup(t)
  const id = start()
  const ids = []
  for (let i = 0; i < 64; i++) {
    const questionId = 'q' + i
    ids.push(questionId)
    s.question({
      ...context,
      questionId,
      question: '日本語'.repeat(2300) + ' ' + i,
    })
    s.hold(context.sessionId, questionId, 'Private reason')
  }
  const initial = s.reviewPage()
  assert.equal(initial.breakId, id)
  assert.ok(initial.nextCursor)
  // Act
  s.question({
    ...context,
    questionId: 'after-snapshot',
    question: 'Newer card',
  })
  s.action(id, 'return')
  advance()
  const other = start('second')
  assert.throws(
    () => s.reviewPage({ breakId: other, cursor: initial.nextCursor }),
    /another break/,
  )
  const pages = [initial]
  while (pages.at(-1).nextCursor && pages.length < ids.length)
    pages.push(s.reviewPage({ cursor: pages.at(-1).nextCursor }))
  // Assert
  assert.equal(pages.at(-1).nextCursor, null)
  const rows = pages.flatMap((p) => p.rows)
  assert.ok(Buffer.byteLength(JSON.stringify(rows)) > 256 * 1024)
  assert.deepEqual(
    rows.map((row) => row.questionId),
    ids,
  )
  assert.equal(rows.at(-1).question, '日本語'.repeat(2300) + ' 63')
  assert.ok(
    pages.every(
      (p) =>
        p.breakId === id &&
        p.rows.length <= 40 &&
        Buffer.byteLength(JSON.stringify({ ok: true, value: p })) < 256 * 1024,
    ),
  )
})

test('duplicate SessionStart preserves the original live membership and pending card but reopening after SessionEnd never rejoins', (t) => {
  // Arrange
  const { s, context, start, status } = setup(t)
  const begin = () =>
    s.observe({
      provider: 'claude',
      ...context,
      status: 'idle',
      canDelegate: true,
      newSession: true,
    })
  begin()
  s.observe({
    provider: 'claude',
    ...context,
    status: 'running',
    canDelegate: true,
  })
  const breakId = start()
  const generation = s.status().sessions[0].generation
  s.question({ ...context, questionId: 'waiting', question: 'Which?' })
  // Act
  begin()
  // Assert
  assert.equal(status(), 'waiting')
  assert.equal(s.status().sessions[0].generation, generation)
  assert.equal(
    s.commitAnswer(
      { ...context, questionId: 'waiting', breakId, answer: 'First' },
      () => true,
    ),
    true,
  )
  s.observe({ provider: 'claude', ...context, status: 'closed' })
  begin()
  assert.notEqual(s.status().sessions[0].generation, generation)
  assert.equal(
    s.question({ ...context, questionId: 'reopened', question: 'Which?' })
      .eligible,
    false,
  )
})

test('positive original-hook evidence reconciles timed-out receipts after restart and never retransmits', (t) => {
  // Arrange
  const { s, db, context, start } = setup(t)
  const breakId = start()
  for (const id of ['unwritten', 'written', 'ended']) {
    s.question({ ...context, questionId: id, question: 'Which?' })
    assert.equal(
      s.commitAnswer(
        { ...context, questionId: id, breakId, answer: 'First' },
        () => true,
      ),
      true,
    )
    s.settleAnswer(context.sessionId, id, 'ambiguous')
  }
  s.resolveQuestion(context.sessionId, 'ended', 'failed')
  const restarted = new Supervision(db)
  // Act
  restarted.discardUndelivered(context.sessionId, 'unwritten')
  restarted.settleAnswer(context.sessionId, 'written', 'sent')
  restarted.discardUndelivered(context.sessionId, 'ended')
  restarted.settleAnswer(context.sessionId, 'unwritten', 'sent')
  restarted.discardUndelivered(context.sessionId, 'written')
  // Assert
  assert.deepEqual(
    restarted
      .review(breakId)
      .map((row) => [row.questionId, row.outcome, row.answer]),
    [
      ['unwritten', 'held', null],
      ['written', 'sent', 'First'],
      ['ended', 'resolved', null],
    ],
  )
  assert.equal(
    restarted.commitAnswer(
      { ...context, questionId: 'unwritten', breakId, answer: 'First' },
      () => true,
    ),
    false,
  )
})

test('failed, canceled or completed Claude cards disappear from outstanding held review without attributing a human answer', (t) => {
  // Arrange
  const { s, context, start } = setup(t)
  s.question({
    ...context,
    questionId: 'before',
    question: 'Already displayed?',
  })
  const breakId = start()
  for (const id of ['failed', 'done', 'human']) {
    s.question({ ...context, questionId: id, question: 'Which?' })
    s.hold(context.sessionId, id, 'Waiting for the person')
  }
  s.humanReply({
    provider: 'claude',
    ...context,
    questionId: 'human',
    responseId: 'tool:human',
  })
  // Act
  s.resolveQuestion(context.sessionId, 'failed', 'failed')
  s.resolveQuestion(context.sessionId, 'before', 'failed')
  s.resolveQuestion(context.sessionId, 'done')
  s.resolveQuestion(context.sessionId, 'human')
  // Assert
  const rows = s.review(breakId)
  assert.deepEqual(
    rows.map((row) => [row.questionId, row.outcome]),
    [
      ['before', 'resolved'],
      ['failed', 'resolved'],
      ['done', 'resolved'],
      ['human', 'human'],
    ],
  )
  assert.match(rows[0].reason, /failed or was canceled/)
  assert.equal(rows[2].reason, 'Original request completed')
})

test('SessionEnd retires only live held cards and approvals in the exiting incarnation and preserves delivery receipts', (t) => {
  // Arrange
  const { s, context, start, event } = setup(t)
  const other = { sessionId: 'other', incarnation: 'two' }
  s.observe({
    provider: 'claude',
    ...other,
    status: 'running',
    canDelegate: true,
  })
  const breakId = start()
  for (const id of ['manual', 'sent', 'pending']) {
    s.question({ ...context, questionId: id, question: 'Which?' })
    if (id === 'manual') s.hold(context.sessionId, id, 'Needs the person')
    else {
      assert.equal(
        s.commitAnswer(
          { ...context, questionId: id, breakId, answer: 'First' },
          () => true,
        ),
        true,
      )
      if (id === 'sent') s.settleAnswer(context.sessionId, id, 'sent')
    }
  }
  event('PermissionRequest', 'op', { command: 'fixture' })
  s.question({ ...other, questionId: 'keep', question: 'Other terminal?' })
  s.hold(other.sessionId, 'keep', 'Not enough evidence')
  // Act
  s.observe({ provider: 'claude', ...context, status: 'closed' })
  // Assert
  assert.deepEqual(
    s.review(breakId).map((row) => [row.questionId, row.outcome]),
    [
      ['manual', 'resolved'],
      ['sent', 'sent'],
      ['pending', 'pending'],
      ['approval:op', 'resolved'],
      ['keep', 'held'],
    ],
  )
  s.settleAnswer(context.sessionId, 'pending', 'ambiguous')
  s.discardUndelivered(context.sessionId, 'pending')
  assert.equal(
    s.review(breakId).find((row) => row.questionId === 'pending').outcome,
    'resolved',
  )
})

test('resolving an old held question refreshes only its retained break review and leaves the current invitation intact', (t) => {
  // Arrange
  const { s, context, start, advance } = setup(t),
    old = start()
  s.question({ ...context, questionId: 'held', question: 'Which?' })
  s.hold(context.sessionId, 'held', 'Person needed')
  s.action(old, 'return')
  assert.deepEqual(s.takeEffects(), [{ kind: 'digest', id: old }])
  advance()
  s.humanReply({
    provider: 'claude',
    sessionId: 'terminal',
    responseId: 'prompt:new',
  })
  const [invitation] = s.takeEffects()
  assert.equal(invitation.kind, 'invitation')
  // Act
  s.resolveQuestion(context.sessionId, 'held', 'failed')
  // Assert
  assert.deepEqual(s.takeEffects(), [{ kind: 'review-updated', id: old }])
  assert.equal(s.status().invitationId, invitation.id)
  assert.equal(s.review(old)[0].outcome, 'resolved')
  s.resolveQuestion(context.sessionId, 'held')
  assert.deepEqual(s.takeEffects(), [])
})

test('a busy terminal preserves recent completed IDs and retries exactly the permission whose transaction failed', () => {
  // Arrange
  const tracker = new ExecutionApprovals()
  const observe = (event, id, at) =>
    tracker.observe(
      'generation',
      {
        sessionId: 's',
        incarnation: 'p',
        toolName: 'Bash',
        toolUseId: id,
        event,
      },
      at,
    )
  for (let i = 0; i < 4000; i++) {
    tracker.transaction(() => observe('PreToolUse', 'completed-' + i, i * 2))
    tracker.transaction(() =>
      observe('PostToolUse', 'completed-' + i, i * 2 + 1),
    )
  }
  tracker.transaction(() => observe('PermissionRequest', 'pending', 8001))
  // Act
  assert.throws(
    () =>
      tracker.transaction(() => {
        observe('PostToolUse', 'pending', 8002)
        observe('PermissionRequest', 'undone', 8003)
        throw Error('persist failed')
      }),
    /persist failed/,
  )
  tracker.prune(30 * 60000, new Set(['generation']))
  // Assert
  assert.deepEqual(observe('PermissionRequest', 'completed-0', 30 * 60000), {
    completed: [],
  })
  assert.deepEqual(observe('PostToolUse', 'pending', 30 * 60000 + 1), {
    completed: ['approval:pending'],
  })
  assert.deepEqual(observe('PostToolUse', 'pending', 30 * 60000 + 2), {
    completed: [],
  })
  assert.deepEqual(observe('PermissionRequest', 'undone', 30 * 60000 + 3), {
    registered: 'approval:undone',
    completed: [],
  })
})
