import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startService } from '../dist/service.js'
import { requestReview } from '../dist/commands.js'
import { runHook } from '../dist/hooks.js'
import { requestGateway } from '../dist/ipc.js'
import { PreferenceStore } from '../dist/preferences/index.js'

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
  assert.equal(
    new PreferenceStore(verify).isDelegated(
      'claude',
      'terminal-A',
      'live-card',
    ),
    true,
  )
  verify.close()
})
