import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, appendFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import {
  PreferenceStore,
  hasAnswerNotes,
} from '../../dist/preferences/index.js'

const card = {
  header: 'Bug',
  question: 'How should we handle an unrelated bug?',
  options: [{ label: 'Fix in this PR' }, { label: 'Open a separate issue' }],
}
const args = { questions: [{ ...card, id: 'scope' }] }
const answers = { scope: { answers: ['Fix in this PR'] } }
const base = Date.UTC(2025, 1, 1)
const event = (type, payload, t = 0) => ({
  type,
  payload,
  timestamp: new Date(base + t).toISOString(),
})
const ask = (id, body = {}, ms = 10) =>
  event(
    'response_item',
    {
      type: 'function_call',
      name: 'request_user_input',
      call_id: id,
      arguments: JSON.stringify({ ...args, ...body }),
    },
    ms,
  )
const reply = (id, body = {}, ms = 20) =>
  event(
    'response_item',
    {
      type: 'function_call_output',
      call_id: id,
      output: JSON.stringify({ answers, ...body }),
    },
    ms,
  )
const native = (item, t) =>
  event(
    'event_msg',
    { type: 'item_completed', thread_id: 'root', turn_id: 't', item },
    t,
  )
const append = (file, rows) =>
  appendFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'break-origin-'))
  const repo = join(root, 'repo'),
    codex = join(root, 'codex'),
    claude = join(root, 'claude')
  mkdirSync(repo)
  execFileSync('git', ['-C', repo, 'init', '--quiet'])
  mkdirSync(join(codex, 'sessions'), { recursive: true })
  mkdirSync(join(claude, 'projects', 'repo'), { recursive: true })
  const file = join(codex, 'sessions', 'rollout-synthetic.jsonl')
  const transcript = join(claude, 'projects', 'repo', 's.jsonl')
  append(file, [
    event('session_meta', {
      id: 'root',
      source: 'vscode',
      thread_source: 'user',
      originator: 'codex-tui',
      cwd: repo,
    }),
  ])
  const db = new DatabaseSync(join(root, 'db.sqlite'))
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    repo,
    codex,
    claude,
    file,
    transcript,
    db,
    store: new PreferenceStore(db),
  }
}

test('automatic, zero-delay and timed-out Codex answers earn zero evidence and workload through requests, output envelopes and native mirrors', async (t) => {
  // Arrange
  const { store, repo, codex, file } = fixture(t)
  const ids = [
    'automated',
    'timedOut',
    'timed_out',
    'args-timer',
    'native-timer',
    'result-envelope',
    'native-output',
    'answer-marker',
    'early-output',
    'content-marker',
    'custom-timer',
  ]
  append(file, [
    ask('automated'),
    reply('automated', { automated: true }),
    ask('timedOut'),
    reply('timedOut', { timedOut: true }),
    ask('timed_out'),
    reply('timed_out', { timed_out: true }),
    ask('args-timer', { auto_resolution_ms: 0 }),
    reply('args-timer'),
    ask('native-timer'),
    event(
      'event_msg',
      {
        type: 'request_user_input',
        call_id: 'native-timer',
        ...args,
        autoResolutionMs: 0,
      },
      15,
    ),
    reply('native-timer'),
    ask('result-envelope'),
    { ...reply('result-envelope'), timed_out: true },
    ask('native-output'),
    native(
      {
        type: 'FunctionCallOutput',
        name: 'request_user_input',
        id: 'native-output',
        output: JSON.stringify({ answers }),
        automated: true,
      },
      25,
    ),
    reply('native-output'),
    ask('answer-marker'),
    reply('answer-marker', {
      answers: { scope: { answers: ['Fix in this PR'], timedOut: true } },
    }),
    reply('early-output', { timed_out: true }, 5),
    ask('early-output'),
    reply('early-output'),
    ask('content-marker'),
    event(
      'response_item',
      {
        type: 'custom_tool_call_output',
        call_id: 'content-marker',
        output: [
          { type: 'text', text: JSON.stringify({ answers }), automated: true },
        ],
      },
      30,
    ),
    event(
      'response_item',
      {
        type: 'custom_tool_call',
        name: 'functions.request_user_input',
        call_id: 'custom-timer',
        input: JSON.stringify({ ...args, autoResolutionMs: 500 }),
      },
      10,
    ),
    reply('custom-timer'),
    ask('human'),
    reply('human', { timedOut: false, automated: false }),
  ])

  // Act
  const report = await store.importHistory({ codex })

  // Assert
  assert.equal(report.observations, 1)
  assert.equal(store.evaluate(card, { cwd: repo }).summary.currentTotal, 1)
  assert.deepEqual(
    store.humanResponsesSince(0).map((r) => r.responseId),
    ['tool:human'],
  )
  assert.deepEqual(
    store
      .excludedResponsesSince(0)
      .map((r) => r.responseId)
      .sort(),
    ids.map((id) => 'tool:' + id).sort(),
  )
})

test('a later timed-out mirror withdraws a previously credited native reply and its held-out prediction', async (t) => {
  // Arrange
  const { store, repo, codex, file } = fixture(t)
  for (let i = 0; i < 23; i++)
    store.recordHumanSelection({
      source: 'claude',
      sessionId: 'practice',
      toolUseId: 'practice-' + i,
      cwd: repo,
      card,
      label: 'Fix in this PR',
      askedAt: base - 1000 + i * 10,
      answeredAt: base - 999 + i * 10,
    })
  append(file, [
    ask('human', {}, 100),
    reply('human', {}, 110),
    ask('late', {}, 200),
    reply('late', {}, 210),
  ])
  const before = await store.importHistory({ codex })
  append(file, [
    native(
      {
        type: 'FunctionCallOutput',
        id: 'late',
        name: 'request_user_input',
        output: [
          { type: 'text', text: JSON.stringify({ answers, timed_out: true }) },
        ],
      },
      400,
    ),
  ])

  // Act
  const after = await store.importHistory({ codex })

  // Assert
  assert.deepEqual(before.replay.types, [
    {
      kind: 'unrelated-bug',
      predictions: 20,
      correct: 20,
      held: 5,
      eligible: true,
    },
  ])
  assert.deepEqual(after.replay.types, [
    {
      kind: 'unrelated-bug',
      predictions: 19,
      correct: 19,
      held: 5,
      eligible: false,
    },
  ])
  assert.deepEqual(
    store.humanResponsesSince(base).map((r) => r.responseId),
    ['tool:human'],
  )
  assert.deepEqual(
    store.excludedResponsesSince(0).map((r) => r.responseId),
    ['tool:late'],
  )
  assert.equal(store.evaluate(card, { cwd: repo }).reason, 'replay-threshold')
})

test('a pre-upgrade Codex checkpoint quarantines old structured evidence until its original provenance has been reread', async (t) => {
  // Arrange
  const { db, store, codex, file } = fixture(t)
  append(file, [ask('real'), reply('real'), ask('old-copy'), reply('old-copy')])
  await store.importHistory({ codex })
  db.exec('DELETE FROM pref_decoder_versions')
  append(file, [
    event(
      'event_msg',
      {
        type: 'request_user_input',
        call_id: 'old-copy',
        ...args,
        auto_resolution_ms: 500,
      },
      40,
    ),
  ])

  // Act
  const upgraded = new PreferenceStore(db)
  const quarantined = upgraded.humanResponsesSince(0)
  const report = await upgraded.importHistory({ codex })
  const unchanged = await new PreferenceStore(db).importHistory({ codex })

  // Assert
  assert.deepEqual(quarantined, [])
  assert.equal(report.observations, 1)
  assert.deepEqual(
    upgraded.humanResponsesSince(0).map((r) => r.responseId),
    ['tool:real'],
  )
  assert.deepEqual(
    upgraded.excludedResponsesSince(0).map((r) => r.responseId),
    ['tool:old-copy'],
  )
  assert.equal(unchanged.bytesRead, 0)
})

test('a qualified live Claude selection and its annotated transcript count once as Other and the note never appears in a summary', async (t) => {
  // Arrange
  const { store, repo, claude, transcript } = fixture(t)
  const annotations = {
    [card.question]: { notes: 'Only if my private dependency is ready' },
  }
  const live = {
    source: 'claude',
    sessionId: 's',
    toolUseId: 'tool',
    cwd: repo,
    card,
    label: 'Fix in this PR',
    askedAt: base,
    answeredAt: base + 5,
  }
  const common = { sessionId: 's', cwd: repo }
  append(transcript, [
    {
      ...common,
      type: 'assistant',
      timestamp: new Date(base).toISOString(),
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'AskUserQuestion',
            id: 'tool',
            input: { questions: [card] },
          },
        ],
      },
    },
    {
      ...common,
      type: 'user',
      timestamp: new Date(base + 5).toISOString(),
      permissionDecision: { decision: 'accept', source: 'user_temporary' },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool',
            content: 'User has answered your questions.',
          },
        ],
      },
      toolUseResult: {
        answers: { [card.question]: 'Fix in this PR' },
        annotations,
      },
    },
  ])

  // Act
  store.recordHumanSelection({
    ...live,
    conditional: hasAnswerNotes(annotations, card.question),
  })
  const early = store.evaluate(card, { cwd: repo }).summary
  await store.importHistory({ claude })
  const final = store.evaluate(card, { cwd: repo }).summary

  // Assert
  assert.equal(hasAnswerNotes(annotations, 'Unrelated question'), false)
  assert.equal(
    hasAnswerNotes({ [card.question]: { notes: '   ' } }, card.question),
    false,
  )
  assert.deepEqual(early.choices, [
    { meaning: 'current-change', current: 0, other: 0 },
    { meaning: 'separate-issue', current: 0, other: 0 },
    { meaning: 'other-response', current: 1, other: 0 },
  ])
  assert.deepEqual(final.choices, early.choices)
  assert.equal(store.replay().observations, 1)
  assert.doesNotMatch(JSON.stringify(final), /private|dependency/)
})

test('a truncated instruction holds a qualified proposal even when its retained prefix contains no restriction', (t) => {
  // Arrange
  const { store, repo } = fixture(t)
  for (let i = 0; i < 25; i++)
    store.recordHumanSelection({
      source: 'claude',
      sessionId: 's',
      toolUseId: 'q' + i,
      cwd: repo,
      card,
      label: 'Fix in this PR',
      askedAt: base + i * 10,
      answeredAt: base + i * 10 + 1,
    })
  store.replay()
  const context = {
    cwd: repo,
    session: { source: 'claude', sessionId: 'live' },
  }
  const before = store.evaluate(card, context)

  // Act
  store.recordInstruction('claude', 'live', 'Continue', base + 300, true)

  // Assert
  assert.equal(before.eligibleLabel, 'Fix in this PR')
  assert.equal(store.evaluate(card, context).reason, 'current-instructions')
})
