import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Supervision } from '../../dist/supervision/index.js'

const minute = 60_000
const start = Date.UTC(2026, 0, 1)

function setup(t, options = {}) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  let now = start
  const clock = () => now
  const supervisor = new Supervision(db, { now: clock, ...options })
  const observe = (sessionId, status = 'running', extra = {}) =>
    supervisor.observe({
      provider: 'claude',
      sessionId,
      status,
      canDelegate: true,
      ...extra,
    })
  return {
    db,
    supervisor,
    observe,
    clock,
    advance: (ms) => {
      now += ms
    },
  }
}

function invite(supervisor) {
  supervisor.humanReply({
    provider: 'claude',
    sessionId: 'a',
    responseId: 'prompt:trusted',
  })
  const [effect] = supervisor.takeEffects()
  assert.equal(effect.kind, 'invitation')
  assert.equal(supervisor.action(effect.id, 'accept'), true)
  const [active] = supervisor.takeEffects()
  assert.equal(active.kind, 'break')
  return active.id
}

test('four unattended sessions run for 30 minutes and score 39 across duplicate views', (t) => {
  // Arrange
  const { supervisor, observe, advance } = setup(t)
  // Act
  for (let interval = 0; interval < 60; interval++) {
    for (const id of ['a', 'b', 'c', 'd']) observe(id)
    observe('b', 'running', { source: 'other-view' })
    advance(30_000)
  }
  // Assert
  assert.equal(supervisor.status().score, 39)
  assert.deepEqual(supervisor.takeEffects(), [])
})

test('30 running minutes and five verified human replies score 50 and create one durable invitation', (t) => {
  // Arrange
  const { supervisor, observe, advance } = setup(t)
  for (let i = 0; i < 60; i++) {
    observe('a')
    advance(30_000)
  }
  // Act
  for (let i = 0; i < 5; i++)
    supervisor.humanReply({
      provider: 'claude',
      sessionId: 'a',
      responseId: 'tool:' + i,
    })
  assert.equal(
    supervisor.humanReply({
      provider: 'codex',
      sessionId: 'copy',
      responseId: 'tool:4',
      originId: 'claude:a:tool:4',
    }),
    false,
  )
  // Assert
  assert.equal(supervisor.status().score, 50)
  assert.equal(supervisor.takeEffects().length, 1)
  assert.deepEqual(supervisor.takeEffects(), [])
})

test('a wait, an expired observation and an old rolling-window reply add no running time', (t) => {
  // Arrange
  const { supervisor, observe, advance } = setup(t)
  observe('a')
  advance(minute)
  observe('a', 'waiting')
  // Act
  advance(10_000)
  observe('a', 'running', { source: 'concurrent-view' })
  advance(50_000)
  assert.equal(supervisor.status().score, 1)
  observe('a', 'running')
  advance(5 * minute)
  // Assert
  assert.equal(supervisor.status().score, 2.5)
  assert.equal(supervisor.status().sessions[0].status, 'unknown')
  advance(60 * minute)
  assert.equal(
    supervisor.humanReply({
      provider: 'claude',
      sessionId: 'a',
      responseId: 'old',
      at: start,
    }),
    false,
  )
  assert.equal(supervisor.status().score, 0)
})

test('dismissal rearms on a fresh crossing and snooze requests a single still-supervised reminder', (t) => {
  // Arrange
  const { supervisor, observe, advance } = setup(t, {
    threshold: 4,
    activePointsPerMinute: 0,
  })
  observe('a', 'waiting')
  supervisor.humanReply({
    provider: 'claude',
    sessionId: 'a',
    responseId: 'one',
  })
  const first = supervisor.takeEffects()[0]
  // Act
  assert.equal(supervisor.action(first.id, 'dismiss'), true)
  supervisor.tick()
  assert.deepEqual(supervisor.takeEffects(), [])
  advance(61 * minute)
  supervisor.tick()
  observe('a', 'waiting')
  supervisor.humanReply({
    provider: 'claude',
    sessionId: 'a',
    responseId: 'two',
  })
  const second = supervisor.takeEffects()[0]
  assert.equal(supervisor.action(second.id, 'snooze'), true)
  advance(15 * minute - 1)
  observe('a', 'waiting')
  assert.deepEqual(supervisor.takeEffects(), [])
  advance(1)
  supervisor.tick()
  // Assert
  assert.equal(supervisor.takeEffects()[0].kind, 'invitation')
  assert.deepEqual(supervisor.takeEffects(), [])
  assert.equal(supervisor.action(first.id, 'accept'), false)
})

test('a due reminder while supervision is absent and an expired invitation cannot start a break', (t) => {
  // Arrange
  const { supervisor, observe, advance } = setup(t, {
    threshold: 4,
    invitationMs: minute,
  })
  observe('a')
  supervisor.humanReply({
    provider: 'claude',
    sessionId: 'a',
    responseId: 'one',
  })
  const first = supervisor.takeEffects()[0]
  // Act
  supervisor.action(first.id, 'snooze')
  advance(15 * minute)
  supervisor.tick()
  observe('a')
  // Assert
  assert.deepEqual(supervisor.takeEffects(), [])
  assert.equal(supervisor.action(first.id, 'accept'), false)
  advance(61 * minute)
  supervisor.tick()
  observe('a')
  supervisor.humanReply({
    provider: 'claude',
    sessionId: 'a',
    responseId: 'two',
  })
  const second = supervisor.takeEffects()[0]
  advance(minute)
  assert.equal(supervisor.action(second.id, 'accept'), false)
})

test('acceptance freezes open hook-capable terminal incarnations and permanently excludes a displayed card', (t) => {
  // Arrange
  const { supervisor, observe, advance, clock } = setup(t, { threshold: 4 })
  observe('a', 'idle', { incarnation: 'process-a' })
  observe('b', 'running', { incarnation: 'process-b' })
  observe('headless', 'running', { canDelegate: false })
  supervisor.question({
    sessionId: 'a',
    questionId: 'old',
    question: 'Existing choice?',
    incarnation: 'process-a',
  })
  const breakId = invite(supervisor)
  // Act
  advance(5)
  observe('late', 'running')
  assert.equal(
    supervisor.question({
      sessionId: 'late',
      questionId: 'q',
      question: 'Late terminal?',
    }).eligible,
    false,
  )
  assert.equal(
    supervisor.question({
      sessionId: 'headless',
      questionId: 'q',
      question: 'Unverified terminal?',
    }).eligible,
    false,
  )
  assert.equal(
    supervisor.question({
      sessionId: 'a',
      questionId: 'old',
      question: 'Existing choice?',
    }).eligible,
    false,
  )
  assert.equal(
    supervisor.question({
      sessionId: 'a',
      questionId: 'delayed',
      question: 'Before consent?',
      openedAt: clock() - 10,
    }).eligible,
    false,
  )
  assert.equal(
    supervisor.question({
      sessionId: 'a',
      questionId: 'approve',
      kind: 'approval',
      question: 'Deploy?',
    }).eligible,
    false,
  )
  assert.equal(
    supervisor.question({
      sessionId: 'b',
      questionId: 'new',
      question: 'New choice?',
      openedAt: clock(),
    }).eligible,
    true,
  )
  observe('b', 'running', { incarnation: 'another-process', newSession: true })
  // Assert
  assert.equal(
    supervisor.commitAnswer(
      { sessionId: 'b', questionId: 'new', breakId, answer: 'Yes' },
      () => true,
    ),
    false,
  )
  assert.equal(
    supervisor.question({
      sessionId: 'b',
      questionId: 'later',
      question: 'Reused session ID?',
    }).eligible,
    false,
  )
  assert.deepEqual(
    supervisor
      .review(breakId)
      .map((r) => r.questionId)
      .sort(),
    ['approve', 'delayed', 'new', 'old'],
  )
})

test('a person, disconnected original client, or expired consent wins before an answer can be delivered', (t) => {
  // Arrange
  const { supervisor, observe, advance } = setup(t, { threshold: 4 })
  observe('a')
  const breakId = invite(supervisor)
  for (const id of ['human', 'disconnect', 'expires'])
    supervisor.question({ sessionId: 'a', questionId: id, question: 'Which?' })
  const claim = (questionId, connected) =>
    supervisor.commitAnswer(
      { sessionId: 'a', questionId, breakId, answer: 'First' },
      connected,
    )
  // Act
  supervisor.humanReply({
    provider: 'claude',
    sessionId: 'a',
    responseId: 'human',
    questionId: 'human',
  })
  assert.equal(
    claim('human', () => true),
    false,
  )
  assert.equal(
    claim('disconnect', () => false),
    false,
  )
  assert.equal(
    claim('disconnect', () => true),
    false,
  )
  advance(15 * minute)
  // Assert
  assert.equal(
    claim('expires', () => true),
    false,
  )
  assert.equal(supervisor.status().activeBreakId, null)
  assert.deepEqual(supervisor.takeEffects(), [{ kind: 'digest', id: breakId }])
  assert.equal(supervisor.status().score, 0)
})

test('a completed hook observed out of order cannot reopen a question or charge a mirrored answer twice', (t) => {
  // Arrange
  const { supervisor, observe } = setup(t, { threshold: 4 })
  observe('a')
  invite(supervisor)
  // Act
  supervisor.humanReply({
    provider: 'claude',
    sessionId: 'a',
    responseId: 'native-id',
    questionId: 'native-id',
  })
  const arrivedLate = supervisor.question({
    sessionId: 'a',
    questionId: 'native-id',
    question: 'Late pre-tool event?',
  })
  const duplicate = supervisor.humanReply({
    provider: 'claude',
    sessionId: 'a',
    responseId: 'tool:native-id',
  })
  // Assert
  assert.equal(arrivedLate.eligible, false)
  assert.equal(duplicate, false)
})

test('only a committed original request can be settled and model-generated answers earn no human points', (t) => {
  // Arrange
  const { supervisor, db, observe } = setup(t, { threshold: 4 })
  observe('a')
  const breakId = invite(supervisor)
  supervisor.question({
    sessionId: 'a',
    questionId: 'q',
    question: 'Which option?',
  })
  const answer = { sessionId: 'a', questionId: 'q', breakId, answer: 'Second' }
  db.exec('CREATE TABLE attributed(id TEXT PRIMARY KEY)')
  // Act
  assert.throws(
    () =>
      supervisor.commitAnswer(
        answer,
        () => true,
        () => {
          db.exec("INSERT INTO attributed VALUES('q')")
          throw Error('fault')
        },
      ),
    /fault/,
  )
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM attributed').get().count,
    0,
  )
  assert.equal(
    supervisor.commitAnswer(
      answer,
      () => true,
      () => db.exec("INSERT INTO attributed VALUES('q')"),
    ),
    true,
  )
  assert.equal(
    supervisor.commitAnswer(answer, () => true),
    false,
  )
  supervisor.settleAnswer('a', 'q', 'sent')
  supervisor.settleAnswer('a', 'q', 'ambiguous')
  // Assert
  const [row] = supervisor.review(breakId)
  assert.equal(row.outcome, 'sent')
  assert.equal(row.answer, 'Second')
  assert.equal(
    supervisor.humanReply({
      provider: 'claude',
      sessionId: 'a',
      responseId: 'q',
      questionId: 'q',
    }),
    false,
  )
})

test('manual return fences stale actions and counts only supervision after the return', (t) => {
  // Arrange
  const { supervisor, observe, advance } = setup(t, { threshold: 4 })
  observe('a')
  const breakId = invite(supervisor)
  advance(minute)
  // Act
  assert.equal(supervisor.action('another-break', 'return'), false)
  assert.equal(supervisor.action(breakId, 'return'), true)
  assert.equal(supervisor.action(breakId, 'return'), false)
  assert.equal(supervisor.status().score, 0)
  observe('a')
  advance(minute)
  // Assert
  assert.equal(supervisor.status().score, 1)
  assert.deepEqual(supervisor.takeEffects(), [{ kind: 'digest', id: breakId }])
})

test('restart terminates consent, retains a private uncertain-delivery receipt, and never resends', (t) => {
  // Arrange
  const { supervisor, observe, db, clock } = setup(t, { threshold: 4 })
  observe('a')
  const breakId = invite(supervisor)
  supervisor.question({
    sessionId: 'a',
    questionId: 'crash',
    question: 'Which option?',
  })
  const answer = {
    sessionId: 'a',
    questionId: 'crash',
    breakId,
    answer: 'First',
  }
  assert.equal(
    supervisor.commitAnswer(answer, () => true),
    true,
  )
  // Act
  const restarted = new Supervision(db, { now: clock, threshold: 4 })
  // Assert
  assert.equal(restarted.status().activeBreakId, null)
  assert.equal(
    restarted.commitAnswer(answer, () => true),
    false,
  )
  assert.equal(restarted.review(breakId)[0].outcome, 'ambiguous')
  assert.deepEqual(restarted.takeEffects(), [{ kind: 'digest', id: breakId }])
  assert.deepEqual(restarted.takeEffects(), [])
})

test('an unidentified request already visible at acceptance stays held until the terminal positively resumes', (t) => {
  // Arrange
  const { supervisor, observe, advance } = setup(t, { threshold: 4 })
  observe('a', 'waiting')
  invite(supervisor)
  advance(1)
  // Act
  const preexisting = supervisor.question({
    sessionId: 'a',
    questionId: 'unknown-at-acceptance',
    question: 'Already on screen?',
  })
  supervisor.resolveQuestion('a', 'unknown-at-acceptance')
  observe('a', 'running')
  const fresh = supervisor.question({
    sessionId: 'a',
    questionId: 'fresh',
    question: 'Newly asked?',
  })
  // Assert
  assert.equal(preexisting.eligible, false)
  assert.equal(fresh.eligible, true)
})

test('a terminal absent from a complete Claude roster cannot enter a break through an old hook', (t) => {
  // Arrange
  const { supervisor, observe, advance, clock } = setup(t, { threshold: 4 })
  observe('a', 'running')
  observe('other', 'running')
  advance(10)
  // Act
  supervisor.snapshot(
    'claude-agents',
    [{ provider: 'claude', sessionId: 'a', status: 'running' }],
    { at: clock(), status: 'available', detail: 'Complete test roster' },
  )
  invite(supervisor)
  // Assert
  assert.equal(
    supervisor.question({
      sessionId: 'other',
      questionId: 'q',
      question: 'Closed terminal?',
    }).eligible,
    false,
  )
  assert.equal(supervisor.status().activeBreak.sessionCount, 1)
})

test('consent expiring while answer provenance is being written rolls back both the claim and its provenance', (t) => {
  // Arrange
  const { supervisor, observe, advance, db } = setup(t, { threshold: 4 })
  observe('a')
  const breakId = invite(supervisor)
  supervisor.question({ sessionId: 'a', questionId: 'q', question: 'Which?' })
  db.exec('CREATE TABLE an_answer(id TEXT PRIMARY KEY)')
  // Act
  const sent = supervisor.commitAnswer(
    { sessionId: 'a', questionId: 'q', breakId, answer: 'First' },
    () => true,
    () => {
      db.exec("INSERT INTO an_answer VALUES('claimed')")
      advance(15 * minute)
    },
  )
  // Assert
  assert.equal(sent, false)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM an_answer').get().n, 0)
  assert.equal(supervisor.review(breakId)[0].outcome, 'held')
})
