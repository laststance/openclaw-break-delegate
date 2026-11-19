import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
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

test('a permission without a tool ID is held for the original matched operation and cannot be released by a separate tool', (t) => {
  // Arrange
  const { s, start, event, status } = setup(t)
  const original = { command: 'pnpm test', timeout: 10 }
  event('PreToolUse', 't1', original)
  event('PermissionRequest', undefined, { timeout: 10, command: 'pnpm test' })
  const breakId = start()
  // Act
  event('PreToolUse', 't2', { command: 'pnpm lint' })
  assert.equal(event('PostToolUse', 't2', { command: 'pnpm lint' }), false)
  // Assert
  assert.equal(status(), 'waiting')
  assert.equal(s.review(breakId)[0].outcome, 'held')
  assert.equal(event('PostToolUse', 't1', original), true)
  assert.equal(status(), 'running')
  assert.equal(s.review(breakId)[0].outcome, 'resolved')
})

test('indistinguishable in-flight tools keep the anonymous approval held until every candidate ends', (t) => {
  // Arrange
  const { s, start, event, status } = setup(t)
  const id = start(),
    input = { command: 'same' }
  event('PreToolUse', 'x', input)
  event('PreToolUse', 'y', input)
  event('PermissionRequest', undefined, input)
  // Act
  assert.equal(event('PostToolUse', 'x', input), false)
  assert.equal(status(), 'waiting')
  assert.equal(s.review(id)[0].outcome, 'held')
  assert.equal(event('PostToolUseFailure', 'y', input), true)
  // Assert
  assert.equal(status(), 'running')
  assert.equal(s.review(id)[0].outcome, 'resolved')
})

test('a missing pre-hook can be recovered by one unique matching completion in the same incarnation', (t) => {
  // Arrange
  const { s, start, event, status } = setup(t)
  const id = start(),
    input = { command: 'ls' }
  event('PermissionRequest', undefined, input)
  // Act
  assert.equal(
    s.observeExecution({
      event: 'PostToolUse',
      sessionId: 'terminal',
      incarnation: 'wrong',
      toolName: 'Bash',
      toolUseId: 'other',
      fingerprint: toolInputFingerprint(input),
    }),
    false,
  )
  assert.equal(event('PostToolUse', 'foreign', { command: 'different' }), false)
  assert.equal(status(), 'waiting')
  assert.equal(event('PostToolUse', 'correct', input), true)
  // Assert
  assert.equal(s.review(id)[0].outcome, 'resolved')
  assert.equal(status(), 'running')
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
  while (pages.at(-1).nextCursor)
    pages.push(s.reviewPage({ cursor: pages.at(-1).nextCursor }))
  // Assert
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
