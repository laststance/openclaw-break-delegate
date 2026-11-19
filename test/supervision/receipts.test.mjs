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
