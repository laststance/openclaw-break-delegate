import test from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  appendFileSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
} from 'node:fs'
import { fixtureGit } from './git-fixture.mjs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import {
  PreferenceStore,
  canonicalRepository,
  hasAnswerNotes,
  isTypedReply,
  isStandingReplyInstruction,
  typedResponseId,
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
  fixtureGit(root, repo, ['init', '--quiet'])
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

const brief =
  'D1 — How should we handle an unrelated bug?\nA) Fix in this PR\nB) Open a separate issue\n<gstack-qid:scope>'
const question = (id, t, message = brief) =>
  event('event_msg', { type: 'agent_message', id, message }, t)
const typed = (client_id, message, t, details = {}) =>
  event(
    'event_msg',
    { type: 'user_message', client_id, message, ...details },
    t,
  )
const receipt = (t, client_id) => ({
  session_id: 'root',
  ts: (base + t) / 1000,
  text: 'A',
  client_id,
})

test('a zero-byte delivery releases the verified human answer received during its claim, while actual automation remains excluded', async (t) => {
  // Arrange
  const { store, repo, file, codex } = fixture(t)
  store.excludeDelegated('codex', 'root', 'zero')
  store.excludeDelegated('codex', 'root', 'automated')
  store.excludeDelegated('claude', 'live', 'zero-live')
  store.excludeDelegated('claude', 'live', 'ambiguous')
  const live = {
    source: 'claude',
    sessionId: 'live',
    cwd: repo,
    card,
    label: 'Fix in this PR',
    askedAt: base,
    answeredAt: base + 1,
  }
  store.recordHumanSelection({ ...live, toolUseId: 'zero-live' })
  store.recordHumanSelection({ ...live, toolUseId: 'ambiguous' })
  append(file, [
    ask('zero'),
    reply('zero'),
    ask('automated'),
    reply('automated'),
    reply('automated', { timedOut: true }, 30),
  ])
  const before = await store.importHistory({ codex })

  // Act
  const hidden = store.humanResponsesSince(0)
  const withdrawals = store.excludedResponsesSince(0).map((r) => r.responseId)
  const restored = store.releaseUndelivered('codex', 'root', 'zero')
  const again = store.releaseUndelivered('codex', 'root', 'zero')
  const neverReleased = store.releaseUndelivered('codex', 'root', 'automated')
  const liveRestored = store.releaseUndelivered('claude', 'live', 'zero-live')
  const after = await store.importHistory({ codex })
  store.excludeDelegated('claude', 'live', 'later')
  store.releaseUndelivered('claude', 'live', 'later')
  store.recordHumanSelection({ ...live, toolUseId: 'later' })

  // Assert
  assert.equal(before.observations, 0)
  assert.deepEqual(hidden, [])
  assert.deepEqual(withdrawals, ['tool:automated'])
  assert.deepEqual(
    [restored, again, neverReleased, liveRestored],
    [true, false, false, true],
  )
  assert.equal(after.observations, 2)
  assert.equal(after.bytesRead, 0)
  assert.equal(store.isDelegated('claude', 'live', 'ambiguous'), true)
  assert.deepEqual(
    store
      .humanResponsesSince(0)
      .map((r) => r.responseId)
      .sort(),
    ['tool:later', 'tool:zero', 'tool:zero-live'],
  )
  assert.equal(store.evaluate(card, { cwd: repo }).summary.currentTotal, 3)
})

test('questions about tests, documentation and approval leave later decisions eligible while a request to obtain approval holds them', (t) => {
  // Arrange
  const { store, repo } = fixture(t)
  for (let i = 0; i < 25; i++)
    store.recordHumanSelection({
      source: 'claude',
      sessionId: 'training',
      toolUseId: 'decision-' + i,
      cwd: repo,
      card,
      label: 'Fix in this PR',
      askedAt: base + i * 10,
      answeredAt: base + i * 10 + 1,
    })
  store.replay()
  const decision = (sessionId) =>
    store.evaluate(card, {
      cwd: repo,
      session: { source: 'claude', sessionId },
    })

  // Act
  for (const note of [
    'Why did the tests fail?',
    'Where should the documentation live?',
    'What does approval mean?',
    'Approval was already recorded.',
    'Did you remember to ask me for approval?',
    'Can you explain why I need you to get my approval?',
    'Can you explain why assistants pause and then ask for my approval when a task is complete?',
    'Can you explain the results?',
    'The guide says to make sure you get my approval.',
  ])
    store.recordInstruction('claude', 'normal', note, base + 500)
  store.recordInstruction(
    'claude',
    'approval',
    'Ask me for approval.',
    base + 500,
  )
  store.recordInstruction(
    'claude',
    'polite',
    'Could you ask me for approval?',
    base + 500,
  )
  store.recordInstruction(
    'claude',
    'ja',
    '変更前に私に確認してください。',
    base + 500,
  )
  for (const [session, text] of [
    ['remember', 'Remember to ask me for approval.'],
    ['ensure', 'Make sure you get my approval first.'],
    ['need', 'I need you to get my approval.'],
    ['compound', 'Can you explain the results, and ask for my approval?'],
    [
      'separate-request',
      'Can you explain why the tests fail, and then ask for my approval?',
    ],
    [
      'then-approve',
      'Can you explain the results and then ask for my approval?',
    ],
    ['direct-approve', 'Please explain the results, and ask for my approval.'],
  ])
    store.recordInstruction('claude', session, text, base + 500)

  // Assert
  assert.equal(decision('normal').eligibleLabel, 'Fix in this PR')
  assert.equal(decision('approval').reason, 'current-instructions')
  assert.equal(decision('polite').reason, 'current-instructions')
  assert.equal(decision('ja').reason, 'current-instructions')
  assert.equal(decision('remember').reason, 'current-instructions')
  assert.equal(decision('ensure').reason, 'current-instructions')
  assert.equal(decision('need').reason, 'current-instructions')
  assert.equal(decision('compound').reason, 'current-instructions')
  assert.equal(decision('separate-request').reason, 'current-instructions')
  assert.equal(decision('then-approve').reason, 'current-instructions')
  assert.equal(decision('direct-approve').reason, 'current-instructions')
})

test('withdrawn fallback evidence keeps only an independently validated selection at its actual response time', async (t) => {
  // Arrange
  const { store, repo, codex, file } = fixture(t)
  const independent = { prompt_source: 'typed' }
  append(join(codex, 'history.jsonl'), [receipt(1500), receipt(11500)])
  append(file, [
    question('skew', 1000),
    typed('direct-skew', 'A', 800, independent),
    question('skew', 1000),
    typed('weak-skew', 'A', 1500),
    question('valid', 11000),
    typed('weak-valid', 'A', 11500),
    question('valid', 11000),
    typed('direct-valid', 'A', 11800, independent),
  ])
  const unique = await store.importHistory({ codex })
  append(file, [
    question('ambiguous-skew', 1600),
    typed('second-skew', 'A', 1700),
    question('ambiguous-valid', 11600),
    typed('second-valid', 'A', 11700),
  ])

  // Act
  const ambiguous = await store.importHistory({ codex })

  // Assert
  assert.equal(unique.observations, 2)
  assert.equal(ambiguous.observations, 1)
  assert.equal(
    store.evaluate(card, { cwd: repo, now: base + 11600 }).summary.currentTotal,
    0,
  )
  assert.equal(
    store.evaluate(card, { cwd: repo, now: base + 11900 }).summary.currentTotal,
    1,
  )
  assert.deepEqual(
    store.humanResponsesSince(0).map((r) => r.responseId),
    ['prompt:direct-skew', 'prompt:direct-valid'],
  )
})

test('an unrelated or unidentified Codex tool output cannot withdraw human workload, while an early empty timed-out answer is excluded when its question arrives', async (t) => {
  // Arrange
  const { store, codex, file, db } = fixture(t)
  const output = (id, body, extra = {}) =>
    event(
      'response_item',
      {
        type: 'function_call_output',
        call_id: id,
        output: typeof body === 'string' ? body : JSON.stringify(body),
        ...extra,
      },
      5,
    )
  append(file, [
    event('response_item', {
      type: 'function_call',
      name: 'exec_command',
      call_id: 'shell',
      arguments: '{}',
    }),
    output('shell', {
      timed_out: true,
      source: 'agent',
      output: 'n'.repeat(200_000),
    }),
    output('nested', { delegated: true, payload: { answers: {} } }),
    output(
      'named-ordinary',
      { answers, timedOut: true },
      { name: 'other_tool' },
    ),
    native(
      {
        type: 'FunctionCallOutput',
        id: 'native-ordinary',
        name: 'exec_command',
        output: { answers, timedOut: true },
      },
      6,
    ),
    output('unconfirmed', { answers, timed_out: true }),
    output('early-empty', { answers: {}, timed_out: true }),
    output(
      'explicit',
      { timed_out: true },
      { name: 'functions.request_user_input' },
    ),
  ])
  const first = await store.importHistory({ codex })
  const earlyKeys = store.excludedResponsesSince(0).map((r) => r.responseId)
  append(file, [
    ask('early-empty'),
    reply('early-empty'),
    ask('human'),
    reply('human'),
  ])

  // Act
  const restarted = new PreferenceStore(db)
  const final = await restarted.importHistory({ codex })

  // Assert
  assert.equal(first.unverified, 1)
  assert.deepEqual(earlyKeys, ['tool:explicit'])
  assert.equal(final.unverified, 1)
  assert.equal(final.observations, 1)
  assert.deepEqual(
    restarted.humanResponsesSince(0).map((r) => r.responseId),
    ['tool:human'],
  )
  assert.deepEqual(
    restarted
      .excludedResponsesSince(0)
      .map((r) => r.responseId)
      .sort(),
    ['tool:early-empty', 'tool:explicit'],
  )
})

test('a new task following a question earns no response or Other, while linked replies and choices with qualifications do', async (t) => {
  // Arrange
  const { store, repo, codex, file } = fixture(t)
  const fromHuman = { prompt_source: 'typed' }
  append(file, [
    question('q1', 100),
    typed('new-task', 'Build a calendar page', 200, fromHuman),
    question('q2', 300, 'Which detail should I explain?'),
    typed(
      'new-task-2',
      'Only inspect the code. Do not edit it.',
      400,
      fromHuman,
    ),
    question('q3', 500),
    typed('linked', 'My own wording for this choice', 600, {
      ...fromHuman,
      reply_to: 'q3',
    }),
    question('q4', 700),
    typed('wrong-link', 'A', 800, { ...fromHuman, reply_to: 'q3' }),
    question('q5', 900),
    typed('qualified', 'A, if the owner approves later', 1000, fromHuman),
    question('q6', 1100),
    typed('number', 'option 2', 1200, fromHuman),
  ])

  // Act
  const report = await store.importHistory({ codex })
  const summary = store.evaluate(card, { cwd: repo }).summary

  // Assert
  assert.equal(report.observations, 3)
  assert.deepEqual(
    store.humanResponsesSince(0).map((r) => r.responseId),
    ['prompt:linked', 'prompt:qualified', 'prompt:number'],
  )
  assert.deepEqual(summary.choices, [
    { meaning: 'current-change', current: 0, other: 0 },
    { meaning: 'separate-issue', current: 1, other: 0 },
    { meaning: 'other-response', current: 2, other: 0 },
  ])
  assert.equal(
    isTypedReply(
      'Build a calendar page',
      card.options.map((o) => o.label),
    ),
    false,
  )
  assert.equal(isTypedReply('A', ['a', 'b'], 'q2', 'q1'), false)
  assert.equal(isTypedReply('Only inspect the code.', [], 'q2', 'q2'), true)
  assert.equal(isTypedReply('A、ただし確認した後で', ['直す', '次回']), true)
})

test('a receipt arriving first loses its provisional credit when two replies qualify, until a native submission identifies one answer', async (t) => {
  // Arrange
  const { store, codex, file } = fixture(t)
  const input = join(codex, 'history.jsonl')
  append(input, [receipt(1000)])
  append(file, [question('first', 100), typed('first', 'A', 500)])
  const unique = await store.importHistory({ codex })
  const uniqueIds = store.humanResponsesSince(0).map((r) => r.responseId)
  append(file, [question('second', 800), typed('second', 'A', 1200)])

  // Act
  const ambiguous = await store.importHistory({ codex })
  const ambiguousIds = store.humanResponsesSince(0)
  const withdrawn = store
    .unmatchedTypedResponsesSince(0)
    .map((r) => r.responseId)
  append(input, [receipt(1250, 'second'), receipt(1270, 'second')])
  const identified = await store.importHistory({ codex })

  // Assert
  assert.equal(unique.observations, 1)
  assert.deepEqual(uniqueIds, ['prompt:first'])
  assert.equal(ambiguous.observations, 0)
  assert.deepEqual(ambiguousIds, [])
  assert.deepEqual(withdrawn, ['prompt:first'])
  assert.deepEqual(store.excludedResponsesSince(0), [])
  assert.equal(identified.observations, 1)
  assert.deepEqual(
    store.humanResponsesSince(0).map((r) => r.responseId),
    ['prompt:second'],
  )
})

test('a late anonymous receipt cannot certify either of two existing candidates, while their separate native submission IDs certify each once', async (t) => {
  // Arrange
  const { store, codex, file } = fixture(t)
  const input = join(codex, 'history.jsonl')
  append(file, [
    question('first', 100),
    typed('first', 'A', 500),
    question('second', 800),
    typed('second', 'A', 1200),
  ])
  const noReceipts = await store.importHistory({ codex })
  append(input, [receipt(1000)])

  // Act
  const anonymous = await store.importHistory({ codex })
  const anonymousIds = store.humanResponsesSince(0)
  append(input, [receipt(1030, 'second'), receipt(1080, 'first')])
  const identified = await store.importHistory({ codex })

  // Assert
  assert.equal(noReceipts.observations, 0)
  assert.equal(anonymous.observations, 0)
  assert.deepEqual(anonymousIds, [])
  assert.equal(identified.observations, 2)
  assert.deepEqual(
    store.humanResponsesSince(0).map((r) => r.responseId),
    ['prompt:first', 'prompt:second'],
  )
})

test('a history rewritten and regrown during a yielded import replays the replacement prefix and resumes at its correct end', async (t) => {
  // Arrange
  const { store, repo, file, codex, db } = fixture(t)
  const pad = { type: 'padding', value: 'X'.repeat(145000) }
  const leading = { type: 'padding', value: 'same prefix '.repeat(36) }
  const rows = (id, questions) =>
    [
      leading,
      event('session_meta', { id, cwd: repo, source: 'cli' }),
      ...questions,
      pad,
      pad,
      pad,
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n'
  writeFileSync(
    file,
    rows('original', [
      typed('obsolete-task', 'Never change the code.', 1, {
        prompt_source: 'typed',
      }),
      ask('obsolete-choice'),
      reply('obsolete-choice'),
    ]),
  )
  const replacing = rows('replacement', [
    ask('from-prefix'),
    reply('from-prefix'),
  ])

  // Act
  const scanning = store.importHistory({ codex })
  await new Promise((resolve) =>
    setImmediate(() => {
      writeFileSync(file, replacing)
      resolve()
    }),
  )
  const first = await scanning
  const second = await store.importHistory({ codex })

  // Assert
  assert.equal(first.observations, 1)
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM pref_constraints WHERE session='original'",
      )
      .get().n,
    0,
  )
  assert.equal(first.unreadable, 0)
  assert.deepEqual(
    store.humanResponsesSince(0).map((r) => [r.sessionId, r.responseId]),
    [['replacement', 'tool:from-prefix']],
  )
  assert.equal(second.bytesRead, 0)
})

test('absolute SCP paths share an SSH repository across clones and home-relative repositories remain specific to their login', () => {
  // Arrange
  const key = (remote) => canonicalRepository('', remote)

  // Act
  const absolute = key('git@git.example:/srv/git/project.git')
  const uri = key('ssh://git@git.example/srv/git/project.git')
  const alice = key('alice@git.example:team/project.git')
  const bob = key('bob@git.example:team/project.git')

  // Assert
  assert.match(absolute, /^remote:/u)
  assert.equal(absolute, uri)
  assert.notEqual(absolute, key('git@git.example:/srv/git/project'))
  assert.notEqual(alice, key('alice@git.example:team/project'))
  assert.notEqual(alice, bob)
  const space = key('git@git.example:/srv/my repo.git')
  const percent = key('git@git.example:/srv/my%20repo.git')
  assert.match(space, /^remote:/u)
  assert.equal(space, key('ssh://git@git.example/srv/my%20repo.git'))
  assert.equal(percent, key('ssh://git@git.example/srv/my%2520repo.git'))
  assert.notEqual(space, percent)
  const ambiguousLegacy =
    'remote:' +
    createHash('sha256')
      .update(
        JSON.stringify([
          'ssh-literal-path',
          'git.example',
          'git',
          'absolute',
          'srv/my%20repo.git',
        ]),
      )
      .digest('hex')
  assert.notEqual(space, ambiguousLegacy)
  assert.notEqual(percent, ambiguousLegacy)
  assert.notEqual(alice, key('alice@git.example:/team/project.git'))
  assert.equal(key('alice@git.example:~/team/project.git'), null)
  assert.equal(key('ssh://alice@git.example/~alice/team/project.git'), null)
  assert.equal(
    key('git@github.com:Org/Repo.git'),
    key('https://github.com/org/repo.git'),
  )
})

test('a native receipt is reserved before assigning another receipt to a nearby answer without a submission ID', async (t) => {
  // Arrange
  const { store, codex, file } = fixture(t)
  append(join(codex, 'history.jsonl'), [
    receipt(100, 'native-A'),
    receipt(140, 'native-B'),
  ])
  append(file, [
    question('d1', 25),
    typed('native-A', 'A', 100),
    question('d2', 120),
    typed(undefined, 'A', 150),
  ])

  // Act
  const report = await store.importHistory({ codex })

  // Assert
  assert.equal(report.observations, 2)
  assert.deepEqual(
    store.humanResponsesSince(0).map((r) => r.responseId),
    ['prompt:native-A', typedResponseId('A', base + 150, undefined, 'd2')],
  )
})

test('identical independently typed answers within one second credit two distinct questions once across copies', async (t) => {
  // Arrange
  const { store, codex, file } = fixture(t)
  const rows = [
    question('q1', 100),
    typed(undefined, 'A', 200, { prompt_source: 'typed' }),
    question('q2', 300),
    typed(undefined, 'A', 350, { prompt_source: 'typed' }),
  ]
  append(file, [...rows, ...rows])

  // Act
  const report = await store.importHistory({ codex })

  // Assert
  assert.equal(report.observations, 2)
  assert.deepEqual(
    store.humanResponsesSince(0).map((r) => r.responseId),
    [
      typedResponseId('A', base + 200, undefined, 'q1'),
      typedResponseId('A', base + 350, undefined, 'q2'),
    ],
  )
  assert.notEqual(
    typedResponseId('A', base + 200, undefined, 'q1'),
    typedResponseId('A', base + 350, undefined, 'q2'),
  )
})

test('a linked native Codex mirror credits a free-form answer once and removes the provisional task instruction', async (t) => {
  // Arrange
  const { store, codex, file, repo } = fixture(t)
  for (let i = 0; i < 25; i++)
    store.recordHumanSelection({
      source: 'claude',
      sessionId: 'training',
      toolUseId: 't' + i,
      cwd: repo,
      card,
      label: 'Fix in this PR',
      askedAt: base - 1500 + i * 10,
      answeredAt: base - 1499 + i * 10,
    })
  const message = 'Only for this change, I have a third option.'
  append(join(codex, 'history.jsonl'), [
    { session_id: 'root', ts: (base + 200) / 1000, text: message },
  ])
  append(file, [question('offer', 100), typed(undefined, message, 200)])
  await store.importHistory({ codex })
  const session = { source: 'codex', sessionId: 'root' }
  const before = store.evaluate(card, { cwd: repo, session })
  append(file, [
    native(
      {
        type: 'UserMessage',
        client_id: 'native',
        id: 'n',
        reply_to: 'offer',
        content: [{ type: 'text', text: message }],
      },
      201,
    ),
  ])

  // Act
  const report = await store.importHistory({ codex })
  const after = store.evaluate(card, { cwd: repo, session })

  // Assert
  assert.equal(before.reason, 'current-instructions')
  assert.equal(after.eligibleLabel, 'Fix in this PR')
  assert.equal(report.observations, 26)
  assert.deepEqual(after.summary.choices.at(-1), {
    meaning: 'other-response',
    current: 1,
    other: 0,
  })
  assert.deepEqual(
    store.humanResponsesSince(base).map((r) => r.responseId),
    ['prompt:native'],
  )
})

test('a restriction inside an explanation request overrides a learned full-suite answer, while a factual question imposes no rule', (t) => {
  // Arrange
  const { store, repo } = fixture(t)
  const tests = {
    question: 'Which tests should we run?',
    options: [{ label: 'Focused tests' }, { label: 'Full suite' }],
  }
  for (let i = 0; i < 25; i++)
    store.recordHumanSelection({
      source: 'claude',
      sessionId: 'past',
      toolUseId: 't' + i,
      cwd: repo,
      card: tests,
      label: 'Full suite',
      askedAt: base + i * 10,
      answeredAt: base + i * 10 + 1,
    })
  store.replay()
  const decision = (id) =>
    store.evaluate(tests, {
      cwd: repo,
      session: { source: 'claude', sessionId: id },
    })

  // Act
  store.recordInstruction(
    'claude',
    'limited',
    'Can you explain the changes and only run focused tests?',
    base + 1000,
  )
  store.recordInstruction(
    'claude',
    'unknown',
    'Can you explain the changes but only use my custom plan?',
    base + 1000,
  )
  store.recordInstruction(
    'claude',
    'general',
    'Why did only focused tests fail?',
    base + 1000,
  )

  // Assert
  assert.equal(decision('limited').reason, 'current-instructions')
  assert.equal(decision('unknown').reason, 'current-instructions')
  assert.equal(decision('general').eligibleLabel, 'Full suite')
  store.recordInstruction(
    'claude',
    'qualified',
    'Run the focused tests for this refactor.',
    base + 1200,
  )
  assert.equal(decision('qualified').reason, 'current-instructions')
  store.recordInstruction(
    'claude',
    'release',
    'Run the focused tests for this release.',
    base + 1200,
  )
  store.recordInstruction(
    'claude',
    'prefixed',
    'For this release, run the focused tests.',
    base + 1200,
  )
  assert.equal(decision('release').reason, 'current-instructions')
  assert.equal(decision('prefixed').reason, 'current-instructions')
})

test('answer qualifications stay local to the selected option, with a standing rule applied only to an explicitly ongoing instruction', async (t) => {
  // Arrange
  const { store, repo, codex, file } = fixture(t)
  for (let i = 0; i < 75; i++)
    store.recordHumanSelection({
      source: 'claude',
      sessionId: 'past',
      toolUseId: 't' + i,
      cwd: repo,
      card,
      label: 'Fix in this PR',
      askedAt: base - 1500 + i * 10,
      answeredAt: base - 1499 + i * 10,
    })
  const msg = 'A, only for this change',
    session = { source: 'codex', sessionId: 'root' }
  append(join(codex, 'history.jsonl'), [
    { session_id: 'root', ts: (base + 5200) / 1000, text: msg },
  ])
  append(file, [
    question('one', 100),
    typed('direct', msg, 180, { prompt_source: 'typed' }),
    question('two', 5100),
    typed('joined', msg, 5200),
  ])
  await store.importHistory({ codex })
  const local = store.evaluate(card, { cwd: repo, session })
  append(file, [
    question('three', 8000),
    typed('ongoing', 'A, but always ask me first from now on', 8100, {
      prompt_source: 'typed',
    }),
  ])

  // Act
  await store.importHistory({ codex })

  // Assert
  assert.equal(local.eligibleLabel, 'Fix in this PR')
  assert.equal(
    isStandingReplyInstruction('A, only if our tests always pass'),
    false,
  )
  assert.equal(
    isStandingReplyInstruction('A, but never skip tests from now on'),
    true,
  )
  assert.deepEqual(local.summary.choices.at(-1), {
    meaning: 'other-response',
    current: 2,
    other: 0,
  })
  assert.equal(
    store.evaluate(card, { cwd: repo, session }).reason,
    'current-instructions',
  )
})

test('document-language evidence never enables a chat-language answer in the same repository', (t) => {
  // Arrange
  const { store, repo, db } = fixture(t)
  const options = [{ label: 'English' }, { label: 'Japanese' }]
  const docs = {
    question: 'Which language should we use for documentation?',
    options,
  }
  const chat = { question: 'Which language should we use in chat?', options }
  for (let i = 0; i < 25; i++)
    store.recordHumanSelection({
      source: 'claude',
      sessionId: 'past',
      toolUseId: 'doc' + i,
      cwd: repo,
      card: docs,
      label: 'English',
      askedAt: base + i * 10,
      answeredAt: base + i * 10 + 1,
    })
  store.replay()

  // Act
  const document = store.evaluate(
    { question: '文書は何語で書くべきですか？', options },
    { cwd: repo },
  )
  const conversation = store.evaluate(chat, { cwd: repo })
  db.exec(
    "UPDATE pref_offers SET kind='response-language' WHERE kind='documentation-language'; DELETE FROM pref_decoder_versions WHERE version='language-target-and-typed-question-v1'",
  )
  const upgraded = new PreferenceStore(db)
  upgraded.replay()

  // Assert
  assert.equal(document.eligibleLabel, 'English')
  assert.equal(conversation.reason, 'no-local-evidence')
  assert.equal(conversation.summary.currentTotal, 0)
  assert.equal(upgraded.evaluate(chat, { cwd: repo }).summary.currentTotal, 0)
  assert.equal(upgraded.evaluate(docs, { cwd: repo }).eligibleLabel, 'English')
})

test('corrected middle rows with identical size and endpoint anchors retract earlier evidence between imports', async (t) => {
  // Arrange
  const { store, codex, file } = fixture(t)
  append(file, [
    ask('corrected'),
    reply('corrected', { timed_out: false }),
    { type: 'trailer', padding: 'z'.repeat(500) },
  ])
  const before = await store.importHistory({ codex })
  const original = readFileSync(file, 'utf8')
  const corrected = original.replace('false', 'true ')
  writeFileSync(file, corrected)

  // Act
  const after = await store.importHistory({ codex })
  const again = await store.importHistory({ codex })

  // Assert
  assert.equal(before.observations, 1)
  assert.equal(original.length, corrected.length)
  assert.equal(after.observations, 0)
  assert.deepEqual(
    store.excludedResponsesSince(0).map((r) => r.responseId),
    ['tool:corrected'],
  )
  assert.equal(again.bytesRead, 0)
  assert.equal(again.verificationBytesRead, 0)
})

test('a gateway task can run during validation of an append-only multi-megabyte prefix and a concurrent rewrite invalidates that validation', async (t) => {
  // Arrange
  const { store, codex, file, db } = fixture(t)
  append(file, [
    ask('watched'),
    reply('watched', { timed_out: false }),
    ...Array.from({ length: 32 }, () => ({
      type: 'padding',
      value: 'z'.repeat(96 * 1024),
    })),
  ])
  await store.importHistory({ codex })
  const committedBytes = readFileSync(file).length
  append(file, [{ type: 'append' }])
  const progress = []
  const prepare = db.prepare.bind(db)
  const probe = t.mock.method(db, 'prepare', (sql) => {
    const statement = prepare(sql)
    if (sql.includes('SELECT start,stop,hash FROM pref_file_segments')) {
      const get = statement.get.bind(statement)
      t.mock.method(statement, 'get', (...args) => {
        const segment = get(...args)
        if (segment?.start === 0) {
          progress.push('first segment')
          setImmediate(() => progress.push('gateway callback'))
        }
        if (segment?.stop === committedBytes) progress.push('last segment')
        return segment
      })
    }
    return statement
  })
  let resumed
  try {
    resumed = await store.importHistory({ codex })
  } finally {
    probe.mock.restore()
  }
  const original = readFileSync(file, 'utf8')
  append(file, [{ type: 'append-two' }])
  const scanning = store.importHistory({ codex })
  await new Promise((resolve) =>
    setImmediate(() =>
      setImmediate(() => {
        writeFileSync(file, original.replace('false', 'true '))
        resolve()
      }),
    ),
  )

  // Act
  const revised = await scanning

  // Assert
  assert.deepEqual(progress, [
    'first segment',
    'gateway callback',
    'last segment',
  ])
  assert.equal(resumed.bytesRead, Buffer.byteLength('{"type":"append"}\n'))
  assert.ok(resumed.verificationBytesRead >= committedBytes)
  assert.equal(revised.observations, 0)
  assert.deepEqual(
    store.excludedResponsesSince(0).map((r) => r.responseId),
    ['tool:watched'],
  )
})

test('Git variables and a rejecting developer hook cannot redirect a fixture commit or write to the inherited repository', (t) => {
  // Arrange
  const root = mkdtempSync(join(tmpdir(), 'break-isolated-git-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const inherited = join(root, 'inherited'),
    repo = join(root, 'fixture'),
    hooks = join(root, 'hooks')
  for (const dir of [inherited, repo, hooks]) mkdirSync(dir)
  fixtureGit(root, inherited, ['init', '--quiet'])
  const marker = join(root, 'hook-ran')
  writeFileSync(
    join(hooks, 'pre-commit'),
    '#!/bin/sh\ntouch "' + marker + '"\nexit 1\n',
  )
  chmodSync(join(hooks, 'pre-commit'), 0o700)
  const hostile = {
    GIT_DIR: join(inherited, '.git'),
    GIT_WORK_TREE: inherited,
    GIT_COMMON_DIR: join(inherited, '.git'),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hooks,
  }
  const saved = Object.fromEntries(
    Object.keys(hostile).map((key) => [key, process.env[key]]),
  )

  // Act
  try {
    Object.assign(process.env, hostile)
    fixtureGit(root, repo, ['init', '--quiet'])
    fixtureGit(root, repo, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--no-gpg-sign',
      '--allow-empty',
      '-m',
      'fixture',
    ])
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  // Assert
  const ref = readFileSync(join(repo, '.git', 'HEAD'), 'utf8')
    .trim()
    .replace('ref: ', '')
  assert.equal(existsSync(join(repo, '.git', ref)), true)
  assert.equal(existsSync(join(inherited, '.git', ref)), false)
  assert.equal(existsSync(marker), false)
  assert.throws(
    () => fixtureGit(root, repo, ['not-a-git-fixture-command']),
    (err) => err.stderr.toString().includes('not-a-git-fixture-command'),
  )
})

test('upgrading an absent legacy transcript removes fallback-only selections and preserves the independently validated choice', async (t) => {
  // Arrange
  const { store, codex, file, db, repo } = fixture(t)
  append(join(codex, 'history.jsonl'), [receipt(400), receipt(5400)])
  append(file, [
    question('weak', 100),
    typed(undefined, 'A', 400),
    question('strong', 5100),
    typed(undefined, 'A', 5400),
    question('strong', 5100),
    typed('independent', 'A', 5600, { prompt_source: 'typed' }),
  ])
  const before = await store.importHistory({ codex })
  // Recreate the unscoped response IDs present immediately before the earlier migration.
  db.exec(`UPDATE pref_typed_candidates SET response_id='typed:abcd:'||at;
    UPDATE pref_responses SET response_id='typed:abcd:'||at WHERE response_id LIKE 'typed:q:%';
    DELETE FROM pref_decoder_versions WHERE version='language-target-and-typed-question-v1';`)
  rmSync(file)

  // Act
  const restarted = new PreferenceStore(db)
  const migrated = await restarted.importHistory({ codex })
  // Recreate the orphan left by an installation that had already run the older migration.
  db.prepare(
    "UPDATE pref_offers SET selected='current-change',answered=? WHERE asked=?",
  ).run(base + 400, base + 100)
  db.exec(
    "DELETE FROM pref_decoder_versions WHERE version='orphaned-typed-selection-v1'",
  )
  const repaired = new PreferenceStore(db).replay()

  // Assert
  assert.equal(before.observations, 2)
  assert.equal(migrated.observations, 1)
  assert.equal(repaired.observations, 1)
  assert.equal(
    restarted.evaluate(card, { cwd: repo, now: base + 5500 }).summary
      .currentTotal,
    0,
  )
  assert.equal(
    restarted.evaluate(card, { cwd: repo, now: base + 5700 }).summary
      .currentTotal,
    1,
  )
  assert.deepEqual(
    restarted.humanResponsesSince(0).map((r) => r.responseId),
    ['prompt:independent'],
  )
})

test('a second nearby same-text receipt with a different or missing submission identity withdraws a formerly unique anonymous answer', async (t) => {
  // Arrange
  const { store, codex, file } = fixture(t)
  append(file, [question('one', 100), typed(undefined, 'A', 250)])
  append(join(codex, 'history.jsonl'), [receipt(200)])
  const unique = await store.importHistory({ codex })
  append(join(codex, 'history.jsonl'), [receipt(300, 'explicit-but-distinct')])

  // Act
  const ambiguous = await store.importHistory({ codex })

  // Assert
  assert.equal(unique.observations, 1)
  assert.equal(ambiguous.observations, 0)
  assert.deepEqual(store.humanResponsesSince(0), [])
})

test('one language instruction can constrain both documents and chat, and chat-only instructions leave documents eligible', (t) => {
  // Arrange
  const { store, repo } = fixture(t)
  const options = [{ label: 'English' }, { label: 'Japanese' }]
  const docs = {
    question: 'Which language should we use for documentation?',
    options,
  }
  const chat = { question: 'Which language should we use in chat?', options }
  for (const [name, kind] of [
    ['docs', docs],
    ['chat', chat],
  ]) {
    for (let i = 0; i < 25; i++)
      store.recordHumanSelection({
        source: 'claude',
        sessionId: 'training',
        toolUseId: name + i,
        cwd: repo,
        card: kind,
        label: 'English',
        askedAt: base + i * 20,
        answeredAt: base + i * 20 + 1,
      })
  }
  store.replay()
  const evaluate = (kind, sessionId) =>
    store.evaluate(kind, {
      cwd: repo,
      session: { source: 'claude', sessionId },
    })

  // Act
  store.recordInstruction(
    'claude',
    'both',
    'Please use Japanese in documentation and chat',
    base + 2000,
  )
  store.recordInstruction(
    'claude',
    'chat',
    'Please use Japanese in chat',
    base + 2000,
  )
  store.recordInstruction(
    'claude',
    'unknown',
    'Please use Japanese on the boards',
    base + 2000,
  )

  // Assert
  assert.equal(evaluate(docs, 'both').reason, 'current-instructions')
  assert.equal(evaluate(chat, 'both').reason, 'current-instructions')
  assert.equal(evaluate(docs, 'chat').eligibleLabel, 'English')
  store.recordInstruction(
    'claude',
    'doc-context',
    'Provide the documentation in Japanese for this refactor.',
    base + 2000,
  )
  assert.equal(evaluate(docs, 'doc-context').reason, 'current-instructions')
  assert.equal(evaluate(chat, 'doc-context').eligibleLabel, 'English')
  assert.equal(evaluate(chat, 'chat').reason, 'current-instructions')
  assert.equal(evaluate(docs, 'unknown').reason, 'current-instructions')
  assert.equal(evaluate(chat, 'unknown').reason, 'current-instructions')
})

test('a verified legacy submission stays unattributed between two offers until the native link identifies one, while an unresolved link stays held', async (t) => {
  // Arrange
  const { store, codex, file, repo } = fixture(t)
  const mirror = (client, target, t) =>
    native(
      {
        type: 'UserMessage',
        id: client,
        client_id: client,
        reply_to: target,
        content: [{ type: 'text', text: 'A' }],
      },
      t,
    )
  const reversed = brief.replace(
    'A) Fix in this PR\nB) Open a separate issue',
    'A) Open a separate issue\nB) Fix in this PR',
  )
  append(join(codex, 'history.jsonl'), [
    receipt(400),
    receipt(5400),
    receipt(10400),
  ])
  append(file, [
    question('actual', 100, reversed),
    question('inferred', 300),
    typed('linked', 'A', 400),
  ])
  const early = await store.importHistory({ codex })
  append(file, [
    mirror('linked', 'actual', 410),
    question('unknown', 5300),
    typed('unresolved', 'A', 5400),
    mirror('unresolved', 'missing-target', 5410),
    question('right', 10300),
    typed('same', 'A', 10400),
    mirror('same', 'right', 10410),
  ])

  // Act
  const final = await store.importHistory({ codex })

  // Assert
  assert.equal(early.observations, 0)
  assert.equal(final.observations, 2)
  assert.deepEqual(store.evaluate(card, { cwd: repo }).summary.choices, [
    { meaning: 'current-change', current: 1, other: 0 },
    { meaning: 'separate-issue', current: 1, other: 0 },
  ])
  assert.deepEqual(
    store.humanResponsesSince(0).map((r) => r.responseId),
    ['prompt:linked', 'prompt:same'],
  )
})

test('Git URL aliases match their expanded history, generic services stay separate and GitHub keeps its historical repository key', (t) => {
  // Arrange
  const { repo } = fixture(t)
  const root = dirname(repo)
  fixtureGit(root, repo, [
    'config',
    'url.https://github.com/fixture-org/.insteadOf',
    'work:',
  ])
  fixtureGit(root, repo, ['remote', 'add', 'origin', 'work:example.git'])

  // Act
  const alias = canonicalRepository(repo)
  const reported = canonicalRepository(
    '',
    'https://github.com/fixture-org/example.git',
  )
  const generic = ['http', 'https', 'git'].map((s) =>
    canonicalRepository('', s + '://git.example/team/app'),
  )

  // Assert
  assert.equal(alias, reported)
  assert.equal(
    alias,
    'remote:8a505d0ce3631dad53fc8b996c703bf58644be2c050095b09efe3cef6b3a7126',
  )
  assert.equal(
    alias,
    canonicalRepository('', 'git@github.com:Fixture-Org/Example.git'),
  )
  assert.equal(new Set(generic).size, 3)
  assert.ok(generic.every((value) => value?.startsWith('remote:')))
})

test('a history rewrite during synchronous decoding rolls back the obsolete instruction and its cursor together', async (t) => {
  // Arrange
  const { store, codex, file, db, repo } = fixture(t)
  append(file, [
    typed('old', 'Never change the code.', 1, { prompt_source: 'typed' }),
    ask('obsolete'),
    reply('obsolete'),
  ])
  const metadata = event('session_meta', {
    id: 'root',
    source: 'cli',
    cwd: repo,
  })
  const replacement =
    [metadata, ask('replacement'), reply('replacement')]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n'
  let changed = false
  const prepare = db.prepare.bind(db)
  const probe = t.mock.method(db, 'prepare', (sql) => {
    if (!changed && sql.includes('INSERT OR IGNORE INTO pref_constraints')) {
      changed = true
      writeFileSync(file, replacement)
    }
    return prepare(sql)
  })

  // Act
  const scanned = await store.importHistory({ codex })
  probe.mock.restore()
  const again = await store.importHistory({ codex })

  // Assert
  assert.equal(changed, true)
  assert.equal(scanned.observations, 1)
  assert.deepEqual(
    store.humanResponsesSince(0).map((r) => r.responseId),
    ['tool:replacement'],
  )
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM pref_constraints WHERE session='root'",
      )
      .get().n,
    0,
  )
  assert.equal(again.bytesRead, 0)
})

test('withdrawal of a conflicting inferred selection restores the independent direct choice while conflicting direct selections still hold', async (t) => {
  // Arrange
  const { store, repo, codex, file } = fixture(t)
  const proof = { prompt_source: 'typed' }
  append(join(codex, 'history.jsonl'), [{ ...receipt(500), text: 'B' }])
  append(file, [
    question('actual', 100),
    typed('direct-A', 'A', 300, proof),
    question('actual', 100),
    typed(undefined, 'B', 500),
    question('direct-disagreement', 5000),
    typed('direct-B1', 'A', 5100, proof),
    question('direct-disagreement', 5000),
    typed('direct-B2', 'B', 5200, proof),
  ])
  const conflicting = await store.importHistory({ codex })
  append(file, [question('ambiguous', 520), typed(undefined, 'B', 530)])

  // Act
  const withdrawn = await store.importHistory({ codex })

  // Assert
  assert.equal(conflicting.observations, 0)
  assert.equal(withdrawn.observations, 1)
  assert.deepEqual(store.evaluate(card, { cwd: repo }).summary.choices, [
    { meaning: 'current-change', current: 1, other: 0 },
    { meaning: 'separate-issue', current: 0, other: 0 },
  ])
  assert.deepEqual(
    store.humanResponsesSince(0).map((r) => r.responseId),
    ['prompt:direct-A', 'prompt:direct-B1', 'prompt:direct-B2'],
  )
})

test('a six-second-late exact native submission takes its receipt back from an earlier time-only answer', async (t) => {
  // Arrange
  const { store, codex, file } = fixture(t)
  append(join(codex, 'history.jsonl'), [receipt(200, 'actual-client')])
  append(file, [question('weak', 100), typed(undefined, 'A', 200)])
  const before = await store.importHistory({ codex })
  const oldId = typedResponseId('A', base + 200, undefined, 'weak')
  assert.deepEqual(
    store.humanResponsesSince(0).map((r) => r.responseId),
    [oldId],
  )
  append(file, [question('real', 6100), typed('actual-client', 'A', 6200)])

  // Act
  const corrected = await store.importHistory({ codex })

  // Assert
  assert.equal(before.observations, 1)
  assert.equal(corrected.observations, 1)
  assert.deepEqual(
    store.humanResponsesSince(0).map((r) => r.responseId),
    ['prompt:actual-client'],
  )
  assert.deepEqual(
    store.unmatchedTypedResponsesSince(0).map((r) => r.responseId),
    [oldId],
  )
})

test('a standalone native Codex reply credits its referenced earlier question and ignores an unresolved explicit target', async (t) => {
  // Arrange
  const { store, codex, file, repo, db } = fixture(t)
  const older = brief.replace(
    'A) Fix in this PR\nB) Open a separate issue',
    'A) Open a separate issue\nB) Fix in this PR',
  )
  const answer = (id, ref, text, at) =>
    native(
      {
        type: 'UserMessage',
        id,
        client_id: id,
        reply_to: ref,
        content: [{ type: 'text', text }],
      },
      at,
    )
  append(file, [
    question('older', 100, older),
    question('latest', 200),
    answer('only', 'older', 'A', 300),
    question('open', 400),
    answer('unresolved', 'unknown', 'Always ask for my approval', 500),
  ])

  // Act
  const report = await store.importHistory({ codex })

  // Assert
  assert.equal(report.observations, 1)
  assert.deepEqual(
    db
      .prepare(
        "SELECT kind FROM pref_constraints WHERE source='codex' AND session='root'",
      )
      .all(),
    [],
  )
  assert.deepEqual(
    store.humanResponsesSince(0).map((r) => r.responseId),
    ['prompt:only'],
  )
  assert.deepEqual(store.evaluate(card, { cwd: repo }).summary.choices, [
    { meaning: 'current-change', current: 0, other: 0 },
    { meaning: 'separate-issue', current: 1, other: 0 },
  ])
})

test('a rewritten transcript withdraws its unsupported observations and workload while independent transcript and live copies retain their own evidence', async (t) => {
  // Arrange
  const { store, db, codex, file, repo } = fixture(t)
  const meta = readFileSync(file, 'utf8')
  const copy = join(dirname(file), 'rollout-independent.jsonl')
  writeFileSync(copy, meta)
  append(file, [
    ask('removed'),
    reply('removed'),
    ask('copied'),
    reply('copied'),
    ask('also-live'),
    reply('also-live'),
    ask('automated'),
    reply('automated', { timed_out: true }),
  ])
  append(copy, [ask('copied'), reply('copied')])
  const before = await store.importHistory({ codex })
  store.recordHumanSelection({
    source: 'codex',
    sessionId: 'root',
    toolUseId: 'also-live',
    cwd: repo,
    card,
    label: 'Fix in this PR',
    askedAt: base + 10,
    answeredAt: base + 20,
  })
  writeFileSync(file, '')
  const reopened = new PreferenceStore(db)

  // Act
  const revised = await reopened.importHistory({ codex })
  const unchanged = await reopened.importHistory({ codex })
  writeFileSync(copy, meta)
  const lastCopyGone = await reopened.importHistory({ codex })

  // Assert
  assert.equal(before.observations, 3)
  assert.equal(revised.observations, 2)
  assert.equal(unchanged.bytesRead, 0)
  assert.equal(lastCopyGone.observations, 1)
  assert.deepEqual(
    reopened.humanResponsesSince(0).map((r) => r.responseId),
    ['tool:also-live'],
  )
  assert.deepEqual(
    reopened
      .unmatchedTypedResponsesSince(0)
      .map((r) => r.responseId)
      .sort(),
    ['tool:copied', 'tool:removed'],
  )
  assert.deepEqual(
    reopened.excludedResponsesSince(0).map((r) => r.responseId),
    ['tool:automated'],
  )
})

test('rewriting a typed receipt file retracts the dependent inferred answer while a direct human submission in the same session survives', async (t) => {
  // Arrange
  const { store, codex, file } = fixture(t)
  const input = join(codex, 'history.jsonl')
  append(input, [receipt(200)])
  append(file, [
    question('weak', 100),
    typed(undefined, 'A', 200),
    question('real', 4000),
    typed('human', 'B', 4200, { prompt_source: 'typed' }),
  ])
  const matched = await store.importHistory({ codex })
  writeFileSync(input, '')

  // Act
  const revised = await store.importHistory({ codex })

  // Assert
  assert.equal(matched.observations, 2)
  assert.equal(revised.observations, 1)
  assert.deepEqual(
    store.humanResponsesSince(0).map((r) => r.responseId),
    ['prompt:human'],
  )
  assert.deepEqual(
    store.unmatchedTypedResponsesSince(0).map((r) => r.responseId),
    [typedResponseId('A', base + 200, undefined, 'weak')],
  )
})

test('a verified native free-form Codex question credits one human submission and never stores its text as a preference', async (t) => {
  // Arrange
  const { store, db, codex, file } = fixture(t)
  const free = (id, options) =>
    ask(id, {
      questions: [
        { id: 'field', question: 'What is the desired title?', options },
      ],
    })
  const result = (id, values, extra = {}) =>
    reply(id, { answers: { field: { answers: values } }, ...extra })
  append(file, [
    free('omitted'),
    result('omitted', ['private fixture title']),
    free('null', null),
    result('null', ['another private title']),
    free('ambiguous', null),
    result('ambiguous', ['two', 'answers']),
    free('empty'),
    result('empty', [' ']),
    free('skipped'),
    result('skipped', ['__skipped__']),
    ask('partial-form', {
      questions: [
        { id: 'field', question: 'Title?' },
        { id: 'scope', ...card },
      ],
    }),
    result('partial-form', ['form contents']),
    ask('unoffered-form', {
      questions: [
        { id: 'field', question: 'Title?' },
        { id: 'scope', ...card },
      ],
    }),
    reply('unoffered-form', {
      answers: {
        field: { answers: ['form contents'] },
        scope: { answers: ['unexpected selection'] },
      },
    }),
    free('machine'),
    result('machine', ['text'], { automated: true }),
  ])

  // Act
  const report = await store.importHistory({ codex })

  // Assert
  assert.equal(report.observations, 0)
  assert.deepEqual(
    store
      .humanResponsesSince(0)
      .map((r) => r.responseId)
      .sort(),
    ['tool:null', 'tool:omitted'],
  )
  assert.deepEqual(
    store.excludedResponsesSince(0).map((r) => r.responseId),
    ['tool:machine'],
  )
  assert.equal(
    db
      .prepare(
        "SELECT 1 FROM pref_source_facts WHERE row_data LIKE '%private%title%'",
      )
      .get(),
    undefined,
  )
})

test('upgrading unowned history rereads its checkpoint and preserves an independently witnessed live answer when the old file dropped its call', async (t) => {
  // Arrange
  const { store, db, repo, codex, file } = fixture(t)
  const meta = readFileSync(file, 'utf8')
  append(file, [
    ask('removed'),
    reply('removed'),
    ask('surviving'),
    reply('surviving'),
  ])
  await store.importHistory({ codex })
  store.recordHumanSelection({
    source: 'codex',
    sessionId: 'root',
    toolUseId: 'direct-hook',
    cwd: repo,
    card,
    label: 'Fix in this PR',
    askedAt: base + 10,
    answeredAt: base + 20,
  })
  db.exec(
    "DELETE FROM pref_source_facts; DELETE FROM pref_primary_choices; DELETE FROM pref_decoder_versions WHERE version='history-source-ownership-v1'",
  )
  writeFileSync(file, meta)
  append(file, [ask('surviving'), reply('surviving')])

  // Act
  const upgraded = new PreferenceStore(db)
  const before = upgraded.humanResponsesSince(0)
  const fresh = await upgraded.importHistory({ codex })
  const immediatelyAgain = await upgraded.importHistory({ codex })

  // Assert
  assert.deepEqual(
    before.map((r) => r.responseId),
    ['tool:direct-hook'],
  )
  assert.equal(fresh.observations, 2)
  assert.equal(immediatelyAgain.bytesRead, 0)
  assert.deepEqual(
    upgraded
      .humanResponsesSince(0)
      .map((r) => r.responseId)
      .sort(),
    ['tool:direct-hook', 'tool:surviving'],
  )
  assert.deepEqual(
    upgraded.unmatchedTypedResponsesSince(0).map((r) => r.responseId),
    ['tool:removed'],
  )
})
