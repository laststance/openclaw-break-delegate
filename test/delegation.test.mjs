import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import { startService } from '../dist/service.js'
import { readHookInput, requestReview } from '../dist/commands.js'
import { runHook } from '../dist/hooks.js'
import { requestGateway } from '../dist/ipc.js'
import { PreferenceStore } from '../dist/preferences/index.js'
import { Supervision } from '../dist/supervision/index.js'

test('an accepted break answers the original Claude card once and keeps its reply out of human history', async (t) => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), 'bd-flow-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'profile'),
    cwd = join(root, 'repo')
  await mkdir(directory)
  await mkdir(cwd)
  execFileSync('git', ['init', '-q', cwd])
  const start = Date.now()
  let now = start
  const card = {
    question: 'How should we handle an unrelated bug?',
    header: 'Bug',
    options: [
      {
        label: 'Fix in this PR',
        description: 'Fix it in the current pull request.',
      },
      { label: 'Open a separate issue', description: 'Defer the fix.' },
    ],
    multiSelect: false,
  }
  const db = new DatabaseSync(join(directory, 'state.sqlite'))
  const training = new PreferenceStore(db)
  for (let i = 0; i < 28; i++) {
    const asked = start - 86400000 + i * 1000
    training.recordHumanSelection({
      source: 'claude',
      sessionId: 'past',
      toolUseId: 'past-' + i,
      cwd,
      card,
      label: 'Fix in this PR',
      askedAt: asked,
      answeredAt: asked + 1,
    })
  }
  const replay = training.replay()
  assert.equal(
    replay.types.some((row) => row.eligible),
    true,
    JSON.stringify(replay),
  )
  db.close()
  let onAction, invite, active
  let seeded = false
  let supersede = false
  let judgeCalls = 0
  const pass = async () => ({ status: 'authorized' })
  const stop = await startService({
    directory,
    now: () => now,
    tickMs: 60000,
    maxConfirmationsPerBreak: 2,
    roots: {},
    log: () => {},
    judge: async (payload) => {
      judgeCalls++
      assert.equal(payload[0].candidate, 'Fix in this PR')
      assert.equal(payload[0].header, 'Bug')
      if (supersede) {
        await runHook(
          directory,
          { ...hook, tool_use_id: 'over-allowance' },
          async (value) => sent.push(JSON.parse(value)),
          'instance-A',
        )
        const updates = new DatabaseSync(join(directory, 'state.sqlite'))
        new PreferenceStore(updates).recordInstruction(
          'claude',
          'terminal-A',
          'Do not fix this bug in the current PR.',
          now,
        )
        updates.close()
      }
      assert.equal(JSON.stringify(payload).includes(cwd), false)
      return true
    },
    nativeFactory: (fn) => {
      onAction = fn
      return {
        status: pass,
        authorize: pass,
        invite: async (id) => {
          invite = id
          return pass()
        },
        active: async (id) => {
          active = id
          return pass()
        },
        summary: pass,
        clear: pass,
        close() {},
      }
    },
    poll: async (c) => {
      if (seeded) return
      seeded = true
      c.observe({
        provider: 'claude',
        sessionId: 'terminal-A',
        source: 'hook',
        state: 'running',
        status: 'running',
        canDelegate: true,
        newSession: true,
        incarnation: 'instance-A',
      })
      for (let i = 0; i < 12; i++)
        c.humanReply({
          provider: 'claude',
          sessionId: 'terminal-A',
          responseId: 'typed-user-' + i,
        })
    },
  })
  t.after(stop)
  for (let i = 0; i < 30 && !invite; i++)
    await new Promise((r) => setTimeout(r, 10))
  assert.ok(invite)
  now += 10
  await onAction({ kind: 'start', id: invite })
  assert.ok(active)
  now += 10
  const hook = {
    hook_event_name: 'PreToolUse',
    session_id: 'terminal-A',
    cwd,
    tool_use_id: 'live-card',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [card] },
  }
  const sent = []
  // Act
  await runHook(
    directory,
    hook,
    async (value) => sent.push(JSON.parse(value)),
    'instance-A',
  )
  await runHook(
    directory,
    hook,
    async (value) => sent.push(JSON.parse(value)),
    'instance-A',
  )
  const beforeClaudeResult = await requestReview(directory, active)
  assert.equal(
    beforeClaudeResult.find((row) => row.questionId === 'live-card')?.outcome,
    'pending',
  )
  await runHook(
    directory,
    {
      ...hook,
      hook_event_name: 'PostToolUse',
      tool_response: { answers: { [card.question]: 'Fix in this PR' } },
    },
    async (value) => sent.push(JSON.parse(value)),
    'instance-A',
  )
  const unsupported = {
    ...card,
    options: [
      { ...card.options[0], preview: 'A second, unverified change' },
      card.options[1],
    ],
  }
  await runHook(
    directory,
    {
      ...hook,
      tool_use_id: 'preview-card',
      tool_input: { questions: [unsupported] },
    },
    async (value) => sent.push(JSON.parse(value)),
    'instance-A',
  )
  await runHook(
    directory,
    {
      ...hook,
      tool_use_id: 'prefilled',
      tool_input: {
        questions: [card],
        answers: { [card.question]: 'Open a separate issue' },
      },
    },
    async (value) => sent.push(JSON.parse(value)),
    'instance-A',
  )
  supersede = true
  await runHook(
    directory,
    { ...hook, tool_use_id: 'preference-changed' },
    async (value) => sent.push(JSON.parse(value)),
    'instance-A',
  )
  const review = await requestReview(directory, active)
  await requestGateway(directory, { op: 'return' })
  const state = await requestGateway(directory, { op: 'status' })
  // Assert
  assert.equal(sent.length, 1, JSON.stringify(review))
  assert.equal(judgeCalls, 2)
  assert.equal(
    review.find((row) => row.questionId === 'over-allowance')?.outcome,
    'held',
  )
  assert.equal(
    review.find((row) => row.questionId === 'prefilled')?.outcome,
    'held',
  )
  assert.deepEqual(sent[0].hookSpecificOutput.updatedInput.questions, [card])
  assert.deepEqual(sent[0].hookSpecificOutput.updatedInput.answers, {
    'How should we handle an unrelated bug?': 'Fix in this PR',
  })
  assert.equal(
    review.find((row) => row.questionId === 'live-card')?.outcome,
    'sent',
  )
  assert.equal(
    review.find((row) => row.questionId === 'preview-card')?.outcome,
    'held',
  )
  assert.equal(
    review.find((row) => row.questionId === 'preference-changed')?.outcome,
    'held',
  )
  assert.equal(state.supervision.activeBreakId, null)
  const verify = new DatabaseSync(join(directory, 'state.sqlite'))
  const history = new PreferenceStore(verify)
  const humanReplies = history.humanResponsesSince(start - 2 * 86400000)
  assert.ok(
    humanReplies.some(
      (row) => row.sessionId === 'past' && row.responseId === 'tool:past-0',
    ),
  )
  assert.equal(
    humanReplies.some(
      (row) =>
        row.sessionId === 'terminal-A' && row.responseId === 'tool:live-card',
    ),
    false,
  )
  assert.equal(history.isDelegated('claude', 'terminal-A', 'live-card'), true)
  verify.close()
})

test(
  'the return review appears at the break deadline while the provider poll is still waiting',
  { timeout: 5000 },
  async (t) => {
    // Arrange
    const directory = await mkdtemp(join(tmpdir(), 'bd-stalled-poll-'))
    let now = Date.now(),
      calls = 0,
      act
    const invitation = Promise.withResolvers(),
      pollStarted = Promise.withResolvers(),
      resume = Promise.withResolvers(),
      digest = Promise.withResolvers()
    const pass = async () => ({ status: 'authorized' })
    const stop = await startService({
      directory,
      now: () => now,
      tickMs: 15,
      workload: { threshold: 4 },
      roots: {},
      log() {},
      judge: async () => false,
      nativeFactory(callback) {
        act = callback
        return {
          status: pass,
          authorize: pass,
          active: pass,
          clear: pass,
          close() {},
          async invite(id) {
            invitation.resolve(id)
            return pass()
          },
          async summary(id) {
            digest.resolve(id)
            return pass()
          },
        }
      },
      async poll(c) {
        calls++
        if (calls > 1) {
          pollStarted.resolve()
          return resume.promise
        }
        c.observe({
          provider: 'claude',
          sessionId: 'a',
          incarnation: 'terminal',
          status: 'running',
          canDelegate: true,
          newSession: true,
        })
        c.humanReply({
          provider: 'claude',
          sessionId: 'a',
          responseId: 'human-answer',
        })
      },
    })
    t.after(async () => {
      resume.resolve()
      await stop()
      await rm(directory, { recursive: true, force: true })
    })
    await act({ kind: 'start', id: await invitation.promise })
    const breakId = (await requestGateway(directory, { op: 'status' }))
      .supervision.activeBreakId
    await pollStarted.promise
    // Act
    now += 15 * 60000
    const shown = await digest.promise
    // Assert
    assert.equal(shown, breakId)
    assert.equal(calls, 2)
  },
)

test(
  'a later break review is displayed when a previous native review fails in the same delivery batch',
  { timeout: 5000 },
  async (t) => {
    // Arrange
    const directory = await mkdtemp(join(tmpdir(), 'bd-native-batch-'))
    let now = Date.now()
    const database = new DatabaseSync(join(directory, 'state.sqlite'))
    const c = new Supervision(database, { now: () => now, threshold: 4 })
    const expected = []
    for (const responseId of ['first answer', 'second answer']) {
      now += 100
      c.observe({
        provider: 'claude',
        sessionId: 'a',
        incarnation: 'terminal',
        status: 'running',
        canDelegate: true,
      })
      c.humanReply({ provider: 'claude', sessionId: 'a', responseId })
      assert.ok(c.action(c.status().invitationId, 'accept'))
      const id = c.status().activeBreakId
      expected.push(id)
      assert.ok(c.action(id, 'return'))
    }
    database.close()
    const shown = [],
      completed = Promise.withResolvers()
    const pass = async () => ({ status: 'authorized' })
    // Act
    const stop = await startService({
      directory,
      now: () => now,
      roots: {},
      log() {},
      poll: async () => {},
      judge: async () => false,
      nativeFactory: () => ({
        status: pass,
        authorize: pass,
        active: pass,
        clear: pass,
        invite: pass,
        close() {},
        async summary(id) {
          shown.push(id)
          if (shown.length === 1) throw Error('First review failed')
          completed.resolve()
          return pass()
        },
      }),
    })
    t.after(async () => {
      await stop()
      await rm(directory, { recursive: true, force: true })
    })
    await completed.promise
    // Assert
    assert.deepEqual(shown, expected)
  },
)

test('a large task veto follows the resumed Claude session and permits a different session in the former process', async (t) => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), 'bd-session-overflow-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'profile'),
    cwd = join(root, 'repo')
  await mkdir(directory)
  await mkdir(cwd)
  execFileSync('git', ['init', '-q', cwd])
  const card = {
    question: 'How should we handle an unrelated bug?',
    options: [{ label: 'Fix in this PR' }, { label: 'Open a separate issue' }],
  }
  const now = Date.now()
  const db = new DatabaseSync(join(directory, 'state.sqlite'))
  const preferences = new PreferenceStore(db)
  for (let i = 0; i < 25; i++)
    preferences.recordHumanSelection({
      source: 'claude',
      sessionId: 'training',
      toolUseId: 't' + i,
      cwd,
      card,
      label: 'Fix in this PR',
      askedAt: now - 1000 + i * 10,
      answeredAt: now - 999 + i * 10,
    })
  preferences.replay()
  db.close()
  const pass = async () => ({ status: 'authorized' })
  let invite,
    onAction,
    seeded = false
  const base = {
    directory,
    roots: {},
    log: () => {},
    judge: async () => true,
    tickMs: 60_000,
    nativeFactory(callback) {
      onAction = callback
      return {
        status: pass,
        authorize: pass,
        invite: async (id) => {
          invite = id
          return pass()
        },
        active: pass,
        summary: pass,
        clear: pass,
        close() {},
      }
    },
  }
  const stopOriginal = await startService({ ...base, poll: async () => {} })
  const raw = JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    prompt: 'private instruction '.repeat(20_000),
    metadata: { session_id: 'distractor' },
    session_id: 'session-A',
  })
  try {
    const body = await readHookInput(Readable.from([Buffer.from(raw)]))
    await runHook(
      directory,
      body,
      async () => {},
      'original-process',
      'UserPromptSubmit',
    )
  } finally {
    await stopOriginal()
  }
  const stopResumed = await startService({
    ...base,
    poll: async (coordinator) => {
      if (seeded) return
      seeded = true
      for (const [sessionId, incarnation] of [
        ['session-A', 'resumed-process'],
        ['session-B', 'original-process'],
      ])
        coordinator.observe({
          provider: 'claude',
          sessionId,
          incarnation,
          newSession: true,
          canDelegate: true,
          source: 'hook',
          status: 'running',
        })
      for (let i = 0; i < 12; i++)
        coordinator.humanReply({
          provider: 'claude',
          sessionId: 'session-A',
          responseId: 'prior-' + i,
        })
    },
  })
  t.after(stopResumed)
  for (let i = 0; i < 50 && !invite; i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(invite)
  await onAction({ kind: 'start', id: invite })
  const answers = []

  // Act
  for (const [session, process] of [
    ['session-A', 'resumed-process'],
    ['session-B', 'original-process'],
  ]) {
    await runHook(
      directory,
      {
        session_id: session,
        cwd,
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'question-' + session,
        tool_input: { questions: [card] },
      },
      async (value) =>
        answers.push([
          session,
          JSON.parse(value).hookSpecificOutput.updatedInput.answers[
            card.question
          ],
        ]),
      process,
    )
  }
  const review = await requestReview(directory)

  // Assert
  assert.deepEqual(answers, [['session-B', 'Fix in this PR']])
  assert.equal(
    review.find((row) => row.sessionId === 'session-A')?.outcome,
    'held',
  )
})

test(
  'cancelling a card prevents delivery and a later provider result refreshes the old review without covering the next invitation',
  { timeout: 8000 },
  async (t) => {
    // Arrange
    const directory = await mkdtemp(join(tmpdir(), 'bd-late-review-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const cwd = join(directory, 'repo')
    await mkdir(cwd)
    execFileSync('git', ['init', '-q', cwd])
    let now = Date.now()
    const card = {
      question: 'How should we handle an unrelated bug?',
      options: [
        { label: 'Fix in this PR' },
        { label: 'Open a separate issue' },
      ],
    }
    const answers = { [card.question]: 'Fix in this PR' }
    const database = new DatabaseSync(join(directory, 'state.sqlite'))
    const preferences = new PreferenceStore(database)
    for (let i = 0; i < 28; i++) {
      const at = now - 86400000 + i * 1000
      preferences.recordHumanSelection({
        source: 'claude',
        sessionId: 'previous',
        toolUseId: 'past-' + i,
        cwd,
        card,
        label: 'Fix in this PR',
        askedAt: at,
        answeredAt: at + 1,
      })
    }
    preferences.replay()
    database.close()
    const firstInvitation = Promise.withResolvers()
    const secondInvitation = Promise.withResolvers()
    const summary = Promise.withResolvers()
    const settled = Promise.withResolvers()
    const invitations = []
    const authorized = async () => ({ status: 'authorized' })
    let act,
      observed,
      seeded = false
    const live = {
      provider: 'claude',
      sessionId: 'original',
      incarnation: 'pty',
      source: 'hook',
      status: 'running',
      canDelegate: true,
    }
    const stop = await startService({
      directory,
      now: () => now,
      roots: {},
      log() {},
      judge: async () => true,
      workload: { threshold: 4 },
      tickMs: 60_000,
      nativeFactory(handler) {
        act = handler
        return {
          status: authorized,
          authorize: authorized,
          active: authorized,
          clear: authorized,
          close() {},
          async invite(id) {
            invitations.push(id)
            ;(invitations.length === 1
              ? firstInvitation
              : secondInvitation
            ).resolve(id)
            return authorized()
          },
          async summary(id, review) {
            summary.resolve({ id, review })
            return authorized()
          },
          async refreshSummary(id, review) {
            settled.resolve({ id, review })
          },
        }
      },
      async poll(coordinator) {
        observed = coordinator
        if (seeded) return
        seeded = true
        coordinator.observe({ ...live, newSession: true })
        coordinator.humanReply({
          provider: 'claude',
          sessionId: 'original',
          responseId: 'prior-supervision',
        })
      },
    })
    t.after(stop)
    const rpc = (request) => requestGateway(directory, request)
    const hook = (event, questionId, extra = {}) =>
      rpc({
        op: 'hook',
        sessionId: 'original',
        incarnation: 'pty',
        cwd,
        event,
        questionId,
        toolName: 'AskUserQuestion',
        cards: [card],
        ...extra,
      })
    await act({ kind: 'start', id: await firstInvitation.promise })
    now += 10

    // Act
    const cancelled = await hook('PreToolUse', 'cancelled')
    const permittedBeforeCancellation = await rpc({
      op: 'can-deliver',
      receipt: cancelled.receipt,
    })
    await hook('PostToolUseFailure', 'cancelled')
    const permittedAfterCancellation = await rpc({
      op: 'can-deliver',
      receipt: cancelled.receipt,
    })
    await rpc({ op: 'undelivered', receipt: cancelled.receipt })
    const accepted = await hook('PreToolUse', 'delivered')
    await rpc({ op: 'ack', receipt: accepted.receipt })
    await rpc({ op: 'return' })
    const firstReview = await summary.promise
    now += 10
    observed.observe(live)
    observed.humanReply({
      provider: 'claude',
      sessionId: 'original',
      responseId: 'new-supervision',
    })
    await hook('UserPromptSubmit', undefined, { prompt: 'Continue the work.' })
    const next = await secondInvitation.promise
    await hook('PostToolUse', 'delivered', { answers })
    const refreshed = await settled.promise
    const status = await rpc({ op: 'status' })

    // Assert
    assert.equal(permittedBeforeCancellation, true)
    assert.equal(permittedAfterCancellation, false)
    assert.equal(firstReview.review.answered.length, 0)
    assert.equal(refreshed.id, firstReview.id)
    assert.deepEqual(refreshed.review.answered, [
      { question: card.question, answer: 'Fix in this PR' },
    ])
    assert.equal(status.supervision.invitationId, next)
    assert.equal(invitations.length, 2)
  },
)
