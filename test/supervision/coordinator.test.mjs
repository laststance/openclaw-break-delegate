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

test('a backward wall-clock jump fences consent and immediately measures fresh hooks and lower-timestamp snapshots', (t) => {
  // Arrange
  const { supervisor, observe, advance, clock } = setup(t, {
    threshold: 4,
    observationTtlMs: 2 * minute,
  })
  observe('a')
  advance(20 * minute)
  observe('a')
  supervisor.snapshot(
    'app-server',
    [{ provider: 'codex', sessionId: 'other', status: 'running' }],
    { at: clock(), status: 'available', detail: 'old clock' },
  )
  const id = invite(supervisor)
  // Act
  advance(-20 * minute)
  supervisor.snapshot(
    'app-server',
    [{ provider: 'codex', sessionId: 'other', status: 'running' }],
    { at: clock(), status: 'available', detail: 'corrected clock' },
  )
  assert.equal(supervisor.status().score, 0)
  observe('a')
  advance(minute)
  // Assert
  const status = supervisor.status()
  assert.equal(status.activeBreakId, null)
  assert.equal(supervisor.action(id, 'return'), false)
  assert.equal(status.score, 1.1)
  assert.equal(
    status.coverage.find((row) => row.source === 'app-server').detail,
    'corrected clock',
  )
  advance(20 * minute)
  assert.equal(supervisor.status().score, 2.2)
})

test('after a failed SQLite checkpoint, retry credits the full original running interval and discards the failed wait', (t) => {
  // Arrange
  const { supervisor, observe, advance, db } = setup(t, {
    threshold: 1,
    observationTtlMs: 5 * minute,
  })
  observe('a')
  advance(minute)
  db.exec(
    "CREATE TEMP TRIGGER fail_invite BEFORE INSERT ON sv_invitations BEGIN SELECT RAISE(ABORT,'injected failure'); END",
  )
  // Act
  assert.throws(() => observe('a', 'waiting'), /injected failure/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sv_runs').get().n, 0)
  db.exec('DROP TRIGGER fail_invite')
  advance(30_000)
  // Assert
  const status = supervisor.status()
  assert.equal(status.score, 1.5)
  assert.equal(status.sessions[0].status, 'running')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sv_runs').get().n, 1)
})

test('an ambiguous settlement after a completed card never makes a later unidentified wait appear tracked', (t) => {
  // Arrange
  const { supervisor, observe, advance } = setup(t, { threshold: 4 })
  observe('a')
  const first = invite(supervisor)
  supervisor.question({
    sessionId: 'a',
    questionId: 'finished',
    question: 'Which?',
  })
  assert.equal(
    supervisor.commitAnswer(
      {
        sessionId: 'a',
        questionId: 'finished',
        breakId: first,
        answer: 'First',
      },
      () => true,
    ),
    true,
  )
  supervisor.resolveQuestion('a', 'finished')
  supervisor.settleAnswer('a', 'finished', 'ambiguous')
  supervisor.action(first, 'return')
  advance(1)
  observe('a', 'waiting')
  supervisor.humanReply({
    provider: 'claude',
    sessionId: 'a',
    responseId: 'prompt:second',
  })
  const next = supervisor.takeEffects().find((e) => e.kind === 'invitation')
  assert.equal(supervisor.action(next.id, 'accept'), true)
  // Act
  const gate = supervisor.question({
    sessionId: 'a',
    questionId: 'unidentified',
    question: 'Already on screen?',
  })
  // Assert
  assert.equal(gate.eligible, false)
  assert.match(gate.reason, /already pending/)
})

test('a pending card remains visibly waiting after observations expire while an unattended terminal becomes unknown', (t) => {
  // Arrange
  const { supervisor, observe, advance } = setup(t, { observationTtlMs: 100 })
  observe('card')
  observe('other')
  supervisor.question({
    sessionId: 'card',
    questionId: 'q',
    question: 'Which?',
  })
  // Act
  advance(101)
  // Assert
  assert.deepEqual(
    supervisor.status().sessions.map((s) => [s.sessionId, s.status]),
    [
      ['card', 'waiting'],
      ['other', 'unknown'],
    ],
  )
  assert.equal(supervisor.status().supervising, false)
})
test('partial and unavailable polls retain fresh observations until expiry or a complete roster withdrawal', (t) => {
  // Arrange
  const { supervisor, advance, clock } = setup(t, { observationTtlMs: 1000 })
  const poll = (rows, status) =>
    supervisor.snapshot('codex-app-server', rows, {
      at: clock(),
      status,
      detail: 'test',
    })
  const busy = { provider: 'codex', sessionId: 'one', status: 'running' }
  poll([busy], 'available')
  advance(100)
  // Act
  poll([], 'partial')
  assert.equal(supervisor.status().sessions[0].status, 'running')
  advance(100)
  poll([], 'unavailable')
  // Assert
  assert.equal(supervisor.status().sessions[0].status, 'running')
  advance(801)
  assert.equal(supervisor.status().sessions[0].status, 'unknown')
  poll([busy], 'available')
  advance(1)
  poll([], 'available')
  assert.equal(supervisor.status().sessions[0]?.status ?? 'unknown', 'unknown')
})

test('an unconfirmed permission leaves live tracking after one hour while its held review and a confirmed terminal survive', (t) => {
  // Arrange
  const { supervisor: s, observe, clock, advance } = setup(t, { threshold: 4 })
  observe('lost', 'running', { incarnation: 'lost-source' })
  observe('alive', 'running', { incarnation: 'live-source' })
  const id = invite(s)
  const permission = (sessionId, incarnation, event, toolUseId) =>
    s.observeExecution({
      sessionId,
      incarnation,
      event,
      toolUseId,
      toolName: 'Bash',
      at: clock(),
    })
  permission('lost', 'lost-source', 'PermissionRequest', 'p1')
  permission('alive', 'live-source', 'PermissionRequest', 'p2')
  s.action(id, 'return')
  advance(59 * minute + 50000)
  observe('alive', 'waiting', { incarnation: 'live-source' })
  // Act
  advance(70000)
  s.tick()
  // Assert
  assert.deepEqual(
    s.status().sessions.map((row) => [row.sessionId, row.status]),
    [['alive', 'waiting']],
  )
  assert.deepEqual(
    s.review(id).map((row) => row.outcome),
    ['held', 'held'],
  )
  assert.equal(
    permission('lost', 'unrelated-process', 'PostToolUse', 'p1'),
    false,
  )
  assert.equal(permission('lost', 'lost-source', 'PostToolUse', 'p1'), true)
  assert.deepEqual(
    s
      .review(id)
      .map((row) => [row.sessionId, row.outcome])
      .sort(),
    [
      ['alive', 'held'],
      ['lost', 'resolved'],
    ],
  )
})

test('an old complete roster cannot revive a later withdrawal and only a newer observation restores activity', (t) => {
  // Arrange
  const {
    supervisor: s,
    observe,
    clock,
    advance,
  } = setup(t, { observationTtlMs: 3 * minute })
  advance(90000)
  observe('a')
  const hookAt = clock()
  advance(10000)
  s.snapshot('claude-agents', [], {
    at: clock(),
    status: 'available',
    detail: 'Withdrawn',
  })
  // Act
  advance(10000)
  s.snapshot(
    'claude-agents',
    [{ provider: 'claude', sessionId: 'a', status: 'running' }],
    {
      at: hookAt - 10000,
      status: 'available',
      detail: 'Late older roster',
    },
  )
  // Assert
  assert.equal(s.status().sessions[0].status, 'unknown')
  assert.equal(
    s.status().coverage.find((c) => c.source === 'claude-agents').at,
    hookAt + 10000,
  )
  assert.equal(s.status().score, 0.166667)
  observe('a')
  assert.equal(s.status().sessions[0].status, 'running')
})

test('a dated idle snapshot ends running credit at observation even after a checkpoint and a newer independent hook', (t) => {
  // Arrange
  const {
    supervisor: s,
    observe,
    advance,
    clock,
  } = setup(t, { observationTtlMs: 2 * minute })
  const send = (status, at) =>
    s.snapshot(
      'claude-agents',
      [{ provider: 'claude', sessionId: 'terminal', status }],
      { at, status: 'available', detail: 'Native roster' },
    )
  send('running', clock())
  const observedIdle = clock() + 10000
  advance(30000)
  s.tick()
  advance(10000)
  observe('terminal', 'waiting', { incarnation: 'tty' })
  advance(20000)
  // Act
  send('idle', observedIdle)
  // Assert
  assert.equal(s.status().score, 0.166667)
  assert.equal(s.status().sessions[0].status, 'waiting')
  advance(10000)
  s.tick()
  assert.equal(s.status().score, 0.166667)
})

test('a tool completion received before its original terminal is known prevents a reordered permission from creating a wait', (t) => {
  // Arrange
  const { supervisor: s, observe, clock, advance } = setup(t)
  const hook = (incarnation, event, toolUseId) =>
    s.observeExecution({
      sessionId: 'original',
      incarnation,
      event,
      toolUseId,
      toolName: 'Bash',
      at: clock(),
    })
  // Act
  assert.equal(hook('one', 'PostToolUse', 'finished'), false)
  assert.equal(s.status().sessions.length, 0)
  advance(10)
  observe('original', 'running', { incarnation: 'one', newSession: true })
  // Assert
  assert.equal(hook('one', 'PreToolUse', 'finished'), false)
  assert.equal(hook('one', 'PermissionRequest', 'finished'), false)
  assert.equal(s.status().sessions[0].status, 'running')
  assert.equal(hook('one', 'PermissionRequest', 'current'), true)
  advance(10)
  observe('original', 'running', { incarnation: 'two', newSession: true })
  assert.equal(hook('two', 'PermissionRequest', 'finished'), true)
})

test('a delayed SessionStart cannot replace a resumed terminal or retire its original live card', (t) => {
  // Arrange
  const { supervisor: s, observe, clock, advance } = setup(t, { threshold: 4 })
  observe('a', 'idle', { incarnation: 'A', newSession: true, at: clock() })
  advance(100)
  const lateA = clock()
  advance(100)
  const startB = clock()
  observe('a', 'idle', { incarnation: 'B', newSession: true, at: startB })
  observe('a', 'running', { incarnation: 'B', at: startB })
  const id = invite(s),
    generation = s.status().sessions[0].generation
  s.question({
    sessionId: 'a',
    incarnation: 'B',
    questionId: 'open',
    question: 'Which?',
  })
  // Act
  advance(50)
  observe('a', 'idle', { incarnation: 'A', newSession: true, at: lateA })
  observe('a', 'idle', { incarnation: 'A', newSession: true, at: startB })
  // Assert
  assert.equal(s.status().sessions[0].generation, generation)
  assert.equal(s.review(id)[0].outcome, 'held')
  assert.equal(
    s.commitAnswer(
      {
        sessionId: 'a',
        incarnation: 'B',
        questionId: 'open',
        breakId: id,
        answer: 'First',
      },
      () => true,
    ),
    true,
  )
  advance(50)
  observe('a', 'idle', { incarnation: 'C', newSession: true, at: clock() })
  assert.notEqual(s.status().sessions[0].generation, generation)
})

test('after a wall-clock rollback the default review chooses the latest created break while explicit IDs and continuation cursors retain the original break', (t) => {
  // Arrange
  const { supervisor: s, observe, advance } = setup(t, { threshold: 4 })
  observe('a')
  const first = invite(s)
  for (let i = 0; i < 42; i++)
    s.question({
      sessionId: 'a',
      questionId: 'first-' + i,
      question: 'Previous question?',
    })
  const pinned = s.reviewPage()
  assert.ok(pinned.nextCursor)
  s.action(first, 'return')
  advance(-60 * minute)
  s.tick()
  observe('a')
  s.humanReply({
    provider: 'claude',
    sessionId: 'a',
    responseId: 'prompt:after-reset',
  })
  const inviteId = s.status().invitationId
  assert.equal(s.action(inviteId, 'accept'), true)
  const second = s.status().break.id
  s.question({
    sessionId: 'a',
    questionId: 'second',
    question: 'Current question?',
  })
  // Act
  const current = s.reviewPage()
  // Assert
  assert.equal(current.breakId, second)
  assert.ok(s.review().some((row) => row.questionId === 'second'))
  assert.equal(s.reviewPage({ breakId: first }).breakId, first)
  assert.equal(s.reviewPage({ cursor: pinned.nextCursor }).breakId, first)
})
