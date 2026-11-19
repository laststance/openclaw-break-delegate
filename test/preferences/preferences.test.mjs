import test from 'node:test'
import assert from 'node:assert/strict'
import { fixtureGit } from './git-fixture.mjs'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  renameSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  canonicalRepository,
  classifyCard,
  normalizeQuestionCard,
  PreferenceStore,
  typedResponseId,
  typedQuestionId,
} from '../../dist/preferences/index.js'

const base = Date.UTC(2025, 0, 1)
const bug = {
  question: 'How should we handle an unrelated bug?',
  options: [
    {
      label: 'Fix in this PR',
      description: 'Fix it in the current pull request.',
    },
    { label: 'Open a separate issue', description: 'Defer the fix.' },
  ],
  multiSelect: false,
}
const japaneseBug = {
  question: '無関係なバグを見つけました。どうしますか？',
  options: [
    { label: '別のIssueとして起票する' },
    { label: '今回のPRで修正する（推奨）' },
  ],
}
const tests = {
  question: 'Which tests should we run?',
  options: [{ label: 'Focused tests' }, { label: 'Full suite' }],
}

function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'break-preferences-'))
  const db = new DatabaseSync(join(root, 'state.sqlite'))
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  const repo = join(root, 'worktree')
  const other = join(root, 'unrelated-repository')
  for (const cwd of [repo, other]) {
    mkdirSync(cwd)
    fixtureGit(root, cwd, ['init', '--quiet'])
  }
  return { root, repo, other, db, store: new PreferenceStore(db) }
}

function selected(store, cwd, number, which = 0, card = bug, timing = {}) {
  const askedAt = timing.askedAt ?? base + number * 1000
  return store.recordHumanSelection({
    source: 'claude',
    sessionId: timing.sessionId ?? 'human-session',
    toolUseId: 'call-' + number,
    cwd,
    card,
    label: card.options[which].label,
    askedAt,
    answeredAt: timing.answeredAt ?? askedAt + 100,
    instructions: timing.instructions,
  })
}

function saveLines(path, rows) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

function claudeAsk(cwd, id, no = 0, card = bug) {
  return {
    sessionId: 'terminal',
    cwd,
    timestamp: new Date(base + no * 1000).toISOString(),
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id,
          name: 'AskUserQuestion',
          input: { questions: [{ header: 'Scope', ...card }] },
        },
      ],
    },
  }
}

function claudeAnswer(cwd, id, no = 0, label = bug.options[0].label) {
  return {
    sessionId: 'terminal',
    cwd,
    timestamp: new Date(base + no * 1000 + 100).toISOString(),
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: 'User has answered your questions.',
        },
      ],
    },
    permissionDecision: {
      decision: 'accept',
      source: 'user_temporary',
      reasonType: 'other',
      grantScope: 'once',
    },
    toolUseResult: {
      questions: [bug],
      answers: { [bug.question]: label },
      annotations: {},
    },
  }
}

function codexEvent(type, payload, ms) {
  return { type, timestamp: new Date(base + ms).toISOString(), payload }
}

test('the exact English and Japanese offered labels map to reordered safe choices across six kinds of question', () => {
  // Arrange
  const examples = [
    [bug, 'unrelated-bug'],
    [japaneseBug, 'unrelated-bug'],
    [tests, 'test-scope'],
    [
      {
        question: 'How detailed should the report be?',
        options: [{ label: 'Brief summary' }, { label: 'Detailed report' }],
      },
      'report-detail',
    ],
    [
      {
        question: 'Where should the documentation live?',
        options: [{ label: 'README' }, { label: 'Dedicated guide' }],
      },
      'documentation-location',
    ],
    [
      {
        question: 'Which language should the reply use?',
        options: [{ label: 'English' }, { label: 'Japanese' }],
      },
      'response-language',
    ],
    [
      {
        question: 'How should we structure the test cases?',
        options: [
          { label: 'Individual cases' },
          { label: 'Table-driven tests' },
        ],
      },
      'test-structure',
    ],
  ]

  // Act
  const kinds = examples.map(([card]) => classifyCard(card).card?.kind)

  // Assert
  assert.deepEqual(kinds, [
    'unrelated-bug',
    'unrelated-bug',
    'test-scope',
    'report-detail',
    'documentation-location',
    'response-language',
    'test-structure',
  ])
  assert.deepEqual(
    classifyCard(japaneseBug).card.choices.map((c) => c.meaning),
    ['separate-issue', 'current-change'],
  )
})

test('an approval, second operation, unknown wording, contradictory description or multiselect holds the entire card', () => {
  // Arrange
  const unsafe = [
    { ...bug, question: 'May I fix the unrelated bug?' },
    {
      ...bug,
      question:
        'How should we handle an unrelated bug and publish the release?',
    },
    {
      ...bug,
      options: [
        bug.options[0],
        {
          label: 'Open a separate issue',
          description: 'Make the database public first.',
        },
      ],
    },
    {
      ...bug,
      options: [
        bug.options[0],
        { label: 'Open a separate issue', description: 'Fix it in this PR.' },
      ],
    },
    { ...bug, options: [...bug.options, { label: 'Surprise me' }] },
    { ...bug, question: 'How should we proceed?' },
    { ...bug, multiSelect: true },
    { ...bug, header: 'Deploy now' },
    { ...bug, header: 'Fix everything today' },
    { ...bug, header: '本番リリース' },
    {
      ...bug,
      options: [
        bug.options[0],
        { ...bug.options[1], preview: 'Also approve a deploy' },
      ],
    },
    {
      ...bug,
      options: [
        bug.options[0],
        { ...bug.options[1], markdown: 'Confirm a purchase' },
      ],
    },
    {
      ...bug,
      options: [
        bug.options[0],
        { ...bug.options[1], confirmationText: 'A different action' },
      ],
    },
    {
      ...japaneseBug,
      question: '無関係なバグの修正と本番デプロイを許可しますか？',
    },
  ]

  // Act
  const decisions = unsafe.map((card) => classifyCard(card))

  // Assert
  assert.ok(decisions.every((decision) => 'reason' in decision))
  assert.equal(
    classifyCard({ ...bug, header: 'Bug' }).card.kind,
    'unrelated-bug',
  )
  assert.equal(
    classifyCard({ ...bug, header: '別件対応' }).card.kind,
    'unrelated-bug',
  )
  assert.equal(normalizeQuestionCard({ ...bug, isSecret: true }), null)
  assert.equal(
    normalizeQuestionCard({ ...bug, hiddenConfirmation: true }),
    null,
  )
  assert.equal(
    normalizeQuestionCard({
      ...bug,
      header: 'Bug',
      id: 'decision',
      isOther: true,
    }).header,
    'Bug',
  )
})

test('twenty chronological trials with nineteen correct enable the type, while nineteen perfect trials are insufficient', (t) => {
  // Arrange
  const { store, repo } = createFixture(t)
  for (let i = 0; i < 24; i++) selected(store, repo, i)
  const early = store.replay()
  selected(store, repo, 24, 1)

  // Act
  const final = store.replay()
  const decision = store.evaluate(japaneseBug, {
    cwd: repo,
    now: base + 26_000,
  })
  const atNineteen = store.evaluate(bug, { cwd: repo, now: base + 24_000 })

  // Assert
  assert.deepEqual(early.types, [
    {
      kind: 'unrelated-bug',
      predictions: 19,
      correct: 19,
      held: 5,
      eligible: false,
    },
  ])
  assert.deepEqual(final.types, [
    {
      kind: 'unrelated-bug',
      predictions: 20,
      correct: 19,
      held: 5,
      eligible: true,
    },
  ])
  assert.equal(decision.eligibleLabel, '今回のPRで修正する（推奨）')
  assert.equal(atNineteen.reason, 'replay-threshold')
  assert.deepEqual(decision.summary.choices, [
    { meaning: 'separate-issue', current: 1, other: 0 },
    { meaning: 'current-change', current: 24, other: 0 },
  ])
  assert.doesNotMatch(
    JSON.stringify(decision.summary),
    /terminal|human-session|Fix in this PR|worktree|推奨/,
  )
})

test('four local answers cannot qualify but four of five do regardless of other repository totals', (t) => {
  // Arrange
  const { store, repo, other } = createFixture(t)
  for (let i = 0; i < 25; i++) selected(store, other, i, 1)
  for (let i = 25; i < 29; i++) selected(store, repo, i)
  store.replay()
  const four = store.evaluate(bug, { cwd: repo, now: base + 31_000 })
  selected(store, repo, 29, 1)
  store.replay()

  // Act
  const five = store.evaluate(bug, { cwd: repo, now: base + 31_000 })
  const lowConsensus = selected(store, repo, 30, 1)
  store.replay()
  const six = store.evaluate(bug, { cwd: repo, now: base + 32_000 })

  // Assert
  assert.equal(four.reason, 'insufficient-local-consensus')
  assert.equal(five.eligibleLabel, 'Fix in this PR')
  assert.deepEqual(five.summary.choices, [
    { meaning: 'current-change', current: 4, other: 0 },
    { meaning: 'separate-issue', current: 1, other: 25 },
  ])
  assert.equal(lowConsensus, true)
  assert.equal(six.reason, 'insufficient-local-consensus')
})

test('overlapping questions, unanswered earlier calls, and equal timestamps never train one another', (t) => {
  // Arrange
  const { store, repo } = createFixture(t)
  for (let i = 0; i < 25; i++)
    selected(store, repo, i, 0, bug, {
      askedAt: base + i,
      answeredAt: base + 1000,
    })
  selected(store, repo, 25, 0, bug, {
    askedAt: base + 1000,
    answeredAt: base + 1001,
  })

  // Act
  const report = store.replay()

  // Assert
  assert.deepEqual(report.types, [
    {
      kind: 'unrelated-bug',
      predictions: 0,
      correct: 0,
      held: 26,
      eligible: false,
    },
  ])
})

test('a task instruction can veto the historical winner both during replay and in the current session', (t) => {
  // Arrange
  const { store, repo } = createFixture(t)
  for (let i = 0; i < 25; i++) selected(store, repo, i)
  selected(store, repo, 25, 0, bug, {
    sessionId: 'restricted',
    instructions: ['Open a separate issue'],
  })
  store.recordInstruction(
    'claude',
    'active',
    'Only inspect the code. Do not change it.',
    base + 26_000,
  )
  store.replay()

  // Act
  const specific = store.evaluate(bug, {
    cwd: repo,
    instructions: ['Open a separate issue'],
  })
  const global = store.evaluate(bug, {
    cwd: repo,
    session: { source: 'claude', sessionId: 'active' },
  })
  const aligned = store.evaluate(bug, {
    cwd: repo,
    instructions: ['Fix in this PR'],
  })
  const unknown = store.evaluate(bug, {
    cwd: repo,
    instructions: ['Follow the agreement from the review'],
  })

  // Assert
  assert.deepEqual(store.replay().types, [
    {
      kind: 'unrelated-bug',
      predictions: 20,
      correct: 20,
      held: 6,
      eligible: true,
    },
  ])
  assert.equal(specific.reason, 'current-instructions')
  assert.equal(global.reason, 'current-instructions')
  assert.equal(aligned.eligibleLabel, 'Fix in this PR')
  assert.equal(unknown.reason, 'current-instructions')
})

test('a delegated call is excluded before or after import and a rolled-back delivery restores its evidence', (t) => {
  // Arrange
  const { store, repo, db } = createFixture(t)
  selected(store, repo, 1)
  store.replay()
  db.exec('BEGIN IMMEDIATE')
  store.excludeDelegated('claude', 'human-session', 'call-1')
  assert.equal(store.humanResponsesSince(0).length, 0)
  db.exec('ROLLBACK')
  const restored = store.replay()

  // Act
  store.excludeDelegated('claude', 'human-session', 'call-1')
  store.excludeDelegated('claude', 'human-session', 'call-2')
  const echoed = selected(store, repo, 2)
  const independent = store.recordHumanSelection({
    source: 'codex',
    sessionId: 'human-session',
    toolUseId: 'call-1',
    cwd: repo,
    card: bug,
    label: 'Fix in this PR',
    askedAt: base,
    answeredAt: base + 50,
  })
  const report = store.replay()

  // Assert
  assert.equal(restored.observations, 1)
  assert.equal(echoed, false)
  assert.equal(independent, true)
  assert.equal(report.observations, 1)
  assert.deepEqual(store.humanResponsesSince(0), [
    {
      source: 'codex',
      sessionId: 'human-session',
      responseId: 'tool:call-1',
      at: base + 50,
    },
  ])
})

test('linked worktrees and HTTPS/SSH clones of the same origin share evidence while similarly named repositories stay separate', (t) => {
  // Arrange
  const { root, repo, other } = createFixture(t)
  const git = (cwd, args) => fixtureGit(root, cwd, args)
  git(repo, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--no-gpg-sign',
    '--allow-empty',
    '-m',
    'fixture',
  ])
  const linked = join(root, 'linked')
  git(repo, ['worktree', 'add', '--detach', linked])
  mkdirSync(join(linked, 'src'))
  const local = canonicalRepository(repo)
  const linkedLocal = canonicalRepository(join(linked, 'src'))
  git(repo, ['remote', 'add', 'origin', 'git@github.com:Example/Project.git'])
  git(other, [
    'remote',
    'add',
    'origin',
    'https://github.com/example/project.git',
  ])

  // Act
  const clone = canonicalRepository(other)
  const worktree = canonicalRepository(linked)
  git(other, [
    'remote',
    'set-url',
    'origin',
    'https://github.com/another/project.git',
  ])
  const independent = canonicalRepository(other)

  // Assert
  assert.ok(local)
  assert.equal(local, linkedLocal)
  assert.equal(clone, worktree)
  assert.notEqual(clone, independent)
  assert.equal(canonicalRepository(root), null)
})

test('Claude and gstack copies count once, an opaque human result can be completed by gstack, and automated or unknown results stay excluded', async (t) => {
  // Arrange
  const { root, repo, store } = createFixture(t)
  const claude = join(root, 'test-claude')
  const gstack = join(root, 'test-gstack')
  const opaque = { ...claudeAnswer(repo, 'gstack-only', 2), toolUseResult: {} }
  const ambiguous = claudeAnswer(repo, 'ambiguous', 3)
  delete ambiguous.permissionDecision
  const mirror = (id, no, source = 'hook') => ({
    source,
    session_id: 'terminal',
    tool_use_id: id,
    skill: 'review',
    question_id: 'review-bug',
    question_summary: bug.question,
    options_count: 2,
    user_choice: 'Fix in this PR',
    ts: new Date(base + no * 1000 + 120).toISOString(),
  })
  saveLines(join(claude, 'projects', 'proj', 'terminal.jsonl'), [
    claudeAsk(repo, 'one', 1),
    claudeAnswer(repo, 'one', 1),
    claudeAsk(repo, 'gstack-only', 2),
    opaque,
    claudeAsk(repo, 'ambiguous', 3),
    ambiguous,
    claudeAsk(repo, 'machine', 4),
    claudeAnswer(repo, 'machine', 4),
    claudeAsk(repo, 'unknown', 5),
    claudeAnswer(repo, 'unknown', 5, '__unknown__'),
  ])
  saveLines(join(gstack, 'projects', 'bucket', 'question-log.jsonl'), [
    mirror('one', 1),
    mirror('gstack-only', 2),
    mirror('ambiguous', 3),
    mirror('machine', 4, 'auto-decided'),
    mirror('machine', 4),
    mirror('unknown', 5, 'agent'),
  ])

  // Act
  const report = await store.importHistory({ claude, gstack })
  const second = await store.importHistory({ claude, gstack })

  // Assert
  assert.equal(report.observations, 2)
  assert.equal(second.bytesRead, 0)
  assert.equal(second.observations, 2)
  assert.equal(store.isDelegated('claude', 'terminal', 'machine'), true)
  assert.deepEqual(
    store.humanResponsesSince(base).map((r) => r.responseId),
    ['tool:one', 'tool:gstack-only'],
  )
  assert.deepEqual(store.evaluate(bug, { cwd: repo }).summary.choices, [
    { meaning: 'current-change', current: 2, other: 0 },
    { meaning: 'separate-issue', current: 0, other: 0 },
  ])
})

test('Codex selections and typed decision briefs require their own call or a matching human input and gstack mirrors never double-count', async (t) => {
  // Arrange
  const { root, repo, store } = createFixture(t)
  const codex = join(root, 'test-codex')
  const gstack = join(root, 'test-gstack')
  const file = join(
    codex,
    'sessions',
    '2025',
    '01',
    '01',
    'rollout-session.jsonl',
  )
  const brief =
    'D1 — ' +
    bug.question +
    '\nA) Fix in this PR\nB) Open a separate issue\n<gstack-qid:bug-scope>'
  const input = { questions: [{ ...bug, id: 'scope', header: 'Scope' }] }
  const output = { answers: { scope: { answers: ['Fix in this PR'] } } }
  const fn = (id, ms) =>
    codexEvent(
      'response_item',
      {
        type: 'function_call',
        name: 'request_user_input',
        arguments: JSON.stringify(input),
        call_id: id,
      },
      ms,
    )
  const reply = (id, value, ms) =>
    codexEvent(
      'response_item',
      {
        type: 'function_call_output',
        output: JSON.stringify(value),
        call_id: id,
      },
      ms,
    )
  const briefAt = (ms) =>
    codexEvent('event_msg', { type: 'agent_message', message: brief }, ms)
  const typedAt = (ms, msg) =>
    codexEvent('event_msg', { type: 'user_message', message: msg }, ms)
  saveLines(file, [
    codexEvent(
      'session_meta',
      { id: 'codex-session', cwd: repo, source: 'cli' },
      0,
    ),
    fn('native', 1000),
    reply('native', output, 1100),
    fn('unknown', 2000),
    reply(
      'unknown',
      { answers: { scope: { answers: ['I chose something else'] } } },
      2100,
    ),
    fn('wrong-call', 3000),
    reply('no-such-call', output, 3100),
    briefAt(4000),
    typedAt(5000, 'B'),
    briefAt(10_000),
    typedAt(11_000, 'B'),
    briefAt(20_000),
    typedAt(21_000, 'A, if the owner approves later'),
    briefAt(30_000),
    codexEvent(
      'event_msg',
      { type: 'agent_message', message: 'A different question' },
      30_300,
    ),
    typedAt(31_000, 'A'),
  ])
  saveLines(join(codex, 'history.jsonl'), [
    { session_id: 'codex-session', ts: (base + 5000) / 1000, text: 'B' },
    { session_id: 'another-session', ts: (base + 11_000) / 1000, text: 'B' },
    {
      session_id: 'codex-session',
      ts: (base + 21_000) / 1000,
      text: 'A, if the owner approves later',
    },
    { session_id: 'codex-session', ts: (base + 31_000) / 1000, text: 'A' },
  ])
  saveLines(join(gstack, 'projects', 'bucket', 'question-log.jsonl'), [
    {
      source: 'codex-import-marker',
      skill: 'codex',
      session_id: 'codex-session',
      question_id: 'bug-scope',
      question_summary: bug.question,
      user_choice: 'Open a separate issue',
      ts: new Date(base + 4000).toISOString(),
    },
  ])

  // Act
  const result = await store.importHistory({ codex, gstack })

  // Assert
  assert.equal(result.observations, 4)
  assert.equal(result.mirrors, 1)
  assert.deepEqual(store.evaluate(bug, { cwd: repo }).summary.choices, [
    { meaning: 'current-change', current: 1, other: 0 },
    { meaning: 'separate-issue', current: 1, other: 0 },
    { meaning: 'other-response', current: 2, other: 0 },
  ])
  assert.deepEqual(
    store.humanResponsesSince(base).map((r) => r.responseId),
    [
      'tool:native',
      'tool:unknown',
      typedResponseId(
        'B',
        base + 5000,
        undefined,
        typedQuestionId(brief, base + 4000),
      ),
      typedResponseId(
        'A, if the owner approves later',
        base + 21_000,
        undefined,
        typedQuestionId(brief, base + 20_000),
      ),
    ],
  )
})

test('incomplete lines resume across restarts, oversized records are bounded, and rotated histories do not multiply observations', async (t) => {
  // Arrange
  const { root, repo, store, db } = createFixture(t)
  const claude = join(root, 'test-claude')
  const path = join(claude, 'projects', 'test', 'session.jsonl')
  saveLines(path, [claudeAsk(repo, 'q')])
  const answer = JSON.stringify(claudeAnswer(repo, 'q'))
  appendFileSync(path, answer.slice(0, 30))
  const first = await store.importHistory({ claude })
  const restarted = new PreferenceStore(db)
  appendFileSync(
    path,
    answer.slice(30) + '\n{malformed}\n' + 'z'.repeat(600_000),
  )
  const oversized = await restarted.importHistory({ claude })
  appendFileSync(
    path,
    'z\n' +
      JSON.stringify(claudeAsk(repo, 'q2', 1)) +
      '\n' +
      JSON.stringify(claudeAnswer(repo, 'q2', 1)) +
      '\n',
  )

  // Act
  const final = await restarted.importHistory({ claude })
  saveLines(path + '.replacement', [
    claudeAsk(repo, 'q'),
    claudeAnswer(repo, 'q'),
    claudeAsk(repo, 'q3', 2),
    claudeAnswer(repo, 'q3', 2),
  ])
  renameSync(path + '.replacement', path)
  const rotated = await restarted.importHistory({ claude })

  // Assert
  assert.equal(first.observations, 0)
  assert.equal(oversized.observations, 1)
  assert.equal(oversized.oversized, 1)
  assert.equal(oversized.malformed, 1)
  assert.equal(final.oversized, 0)
  assert.equal(final.observations, 2)
  assert.equal(rotated.observations, 3)
  assert.deepEqual(
    store.humanResponsesSince(0).map((r) => r.responseId),
    ['tool:q', 'tool:q2', 'tool:q3'],
  )
})

test('unknown and multi-question cards count one verified native response without poisoning preferences', async (t) => {
  // Arrange
  const { root, repo, store } = createFixture(t)
  const unknownCard = {
    question: 'Which unfamiliar framework?',
    options: [{ label: 'Alpha' }, { label: 'Beta' }],
  }
  const claude = join(root, 'test-claude')
  const ask = claudeAsk(repo, 'compound')
  ask.message.content[0].input.questions = [bug, unknownCard]
  const response = claudeAnswer(repo, 'compound')
  response.toolUseResult = {
    questions: [bug, unknownCard],
    answers: {
      [bug.question]: 'Fix in this PR',
      [unknownCard.question]: 'Beta',
    },
  }
  saveLines(join(claude, 'projects', 'proj', 'session.jsonl'), [ask, response])

  // Act
  const report = await store.importHistory({ claude })
  const unknown = store.evaluate(unknownCard, { cwd: repo })
  const recognized = store.evaluate(bug, { cwd: repo })

  // Assert
  assert.equal(report.observations, 1)
  assert.equal(store.humanResponsesSince(0).length, 1)
  assert.equal(unknown.reason, 'unrecognized-question')
  assert.equal(recognized.summary.currentTotal, 1)
  assert.deepEqual(recognized.summary.choices[0], {
    meaning: 'current-change',
    current: 1,
    other: 0,
  })
})

test('explicit Other responses remain in accuracy and local consensus denominators without exposing their text or becoming a predicted label', (t) => {
  // Arrange
  const { store, repo, other } = createFixture(t)
  for (let i = 0; i < 24; i++) selected(store, other, i)
  const qualified = (cwd, i) =>
    store.recordHumanSelection({
      source: 'claude',
      sessionId: 'review',
      toolUseId: 'other-' + i,
      cwd,
      card: bug,
      label: 'Only after the private customer meeting',
      askedAt: base + i * 1000,
      answeredAt: base + i * 1000 + 100,
    })
  qualified(other, 24)
  for (let i = 26; i < 30; i++) selected(store, repo, i)
  qualified(repo, 30)
  qualified(repo, 31)

  // Act
  const report = store.replay()
  const decision = store.evaluate(bug, { cwd: repo })

  // Assert
  assert.deepEqual(report.types, [
    {
      kind: 'unrelated-bug',
      predictions: 21,
      correct: 19,
      held: 10,
      eligible: false,
    },
  ])
  assert.equal(decision.reason, 'insufficient-local-consensus')
  assert.equal(decision.summary.currentTotal, 6)
  assert.deepEqual(
    decision.summary.choices.find((item) => item.meaning === 'other-response'),
    { meaning: 'other-response', current: 2, other: 1 },
  )
  assert.doesNotMatch(JSON.stringify(decision.summary), /customer|meeting/)
})

test('late typed history verifies earlier original task restrictions and ordinary human replies without learning a choice from prose', async (t) => {
  // Arrange
  const { store, root, repo } = createFixture(t)
  for (let i = 0; i < 25; i++) selected(store, repo, i)
  const codex = join(root, 'test-codex')
  saveLines(join(codex, 'sessions', '2025', '01', '01', 'rollout-late.jsonl'), [
    codexEvent(
      'session_meta',
      { id: 'text-session', source: 'vscode', cwd: repo },
      0,
    ),
    codexEvent(
      'event_msg',
      {
        type: 'user_message',
        message: 'Only inspect the code. Do not change it.',
      },
      40_000,
    ),
    codexEvent(
      'event_msg',
      { type: 'agent_message', message: 'Which detail should I explain?' },
      41_000,
    ),
    codexEvent(
      'event_msg',
      {
        type: 'user_message',
        client_id: 'submitted',
        message: 'The last one, please.',
      },
      42_000,
    ),
  ])
  const before = await store.importHistory({ codex })
  const context = {
    cwd: repo,
    session: { source: 'codex', sessionId: 'text-session' },
  }
  const uncorroborated = store.evaluate(bug, context)
  saveLines(join(codex, 'history.jsonl'), [
    {
      session_id: 'text-session',
      ts: (base + 40_000) / 1000,
      text: 'Only inspect the code. Do not change it.',
    },
    {
      session_id: 'text-session',
      ts: (base + 42_000) / 1000,
      text: 'The last one, please.',
    },
  ])

  // Act
  const after = await store.importHistory({ codex })

  // Assert
  assert.equal(before.observations, 25)
  assert.equal(uncorroborated.eligibleLabel, 'Fix in this PR')
  assert.equal(after.observations, 25)
  assert.equal(store.evaluate(bug, context).reason, 'current-instructions')
  assert.deepEqual(store.humanResponsesSince(base + 41_000), [
    {
      source: 'codex',
      sessionId: 'text-session',
      responseId: 'prompt:submitted',
      at: base + 42_000,
    },
  ])
})

test('the Japanese unrelated-bug question can choose the current PR or defer to TODO using the actual offered wording', (t) => {
  // Arrange
  const { store, repo } = createFixture(t)
  const original = {
    header: 'バグ対応',
    question:
      '本題の作業とは関係ないけど、バグが見つかりました。このPRで今直しますか？それともTODOに回しますか？',
    options: [{ label: 'このPRで今直す' }, { label: 'TODOに回す' }],
  }
  const alternate = {
    header: '別件対応',
    question: '別件のバグをこのPRで今直しますか？それともTODOに回しますか？',
    options: [{ label: 'TODOに回す' }, { label: '今すぐ修正する' }],
  }
  const english = {
    question: 'How should we handle an unrelated bug?',
    options: [{ label: 'Fix it now' }, { label: 'Add to the TODO list' }],
  }
  for (let i = 0; i < 25; i++)
    selected(store, repo, i, 1, i % 2 ? english : original)

  // Act
  const report = store.replay()
  const humanQuestion = store.evaluate(original, { cwd: repo })
  const paraphrase = store.evaluate(alternate, { cwd: repo })

  // Assert
  assert.deepEqual(report.types, [
    {
      kind: 'unrelated-bug',
      predictions: 20,
      correct: 20,
      held: 5,
      eligible: true,
    },
  ])
  assert.equal(humanQuestion.eligibleLabel, 'TODOに回す')
  assert.equal(paraphrase.eligibleLabel, 'TODOに回す')
  assert.deepEqual(paraphrase.summary.choices, [
    { meaning: 'defer', current: 25, other: 0 },
    { meaning: 'current-change', current: 0, other: 0 },
  ])
  assert.equal(store.evaluate(bug, { cwd: repo }).reason, 'no-local-evidence')
})

test('desktop and terminal Codex root sessions can supply selections while automation, subagents and unfamiliar clients cannot', async (t) => {
  // Arrange
  const { root, repo, store } = createFixture(t)
  const codex = join(root, 'test-codex')
  const clients = [
    ['terminal', 'codex-tui', 'user'],
    ['desktop', 'Codex Desktop', 'user'],
    ['automated', 'Codex Desktop', 'automation'],
    ['child', 'codex-tui', 'subagent'],
    ['custom', 'unverified bridge', 'user'],
  ]
  for (const [id, originator, thread_source] of clients) {
    saveLines(
      join(codex, 'sessions', '2025', '01', '01', 'rollout-' + id + '.jsonl'),
      [
        codexEvent(
          'session_meta',
          { id, cwd: repo, source: 'vscode', thread_source, originator },
          0,
        ),
        codexEvent(
          'response_item',
          {
            type: 'function_call',
            name: 'request_user_input',
            call_id: 'same',
            arguments: JSON.stringify({ questions: [{ ...bug, id: 'scope' }] }),
          },
          100,
        ),
        codexEvent(
          'response_item',
          {
            type: 'function_call_output',
            call_id: 'same',
            output: JSON.stringify({
              answers: { scope: { answers: ['Fix in this PR'] } },
            }),
          },
          200,
        ),
      ],
    )
  }

  // Act
  const result = await store.importHistory({ codex })

  // Assert
  assert.equal(result.observations, 2)
  assert.deepEqual(
    store
      .humanResponsesSince(0)
      .map((row) => row.sessionId)
      .sort(),
    ['desktop', 'terminal'],
  )
})

test('native Codex completed user items verify a typed selection once across legacy fanout and hook prompts never replace the person', async (t) => {
  // Arrange
  const { root, repo, store } = createFixture(t)
  const codex = join(root, 'test-codex')
  const brief =
    'D1 — ' +
    bug.question +
    '\nA) Fix in this PR\nB) Open a separate issue\n<gstack-qid:bug-scope>'
  const item = (value, at) =>
    codexEvent(
      'event_msg',
      {
        type: 'item_completed',
        thread_id: 'native',
        turn_id: 'turn',
        item: value,
      },
      at,
    )
  const agent = (at) =>
    item(
      {
        type: 'AgentMessage',
        id: 'a' + at,
        phase: 'final_answer',
        content: [{ type: 'Text', text: brief }],
      },
      at,
    )
  const user = (text, at) =>
    item(
      {
        type: 'UserMessage',
        id: 'u' + at,
        client_id: 'typed-' + at,
        content: [{ type: 'text', text, text_elements: [] }],
      },
      at,
    )
  saveLines(
    join(codex, 'sessions', '2025', '01', '01', 'rollout-current.jsonl'),
    [
      codexEvent(
        'session_meta',
        {
          id: 'native',
          cwd: repo,
          source: 'vscode',
          originator: 'codex-tui',
          thread_source: 'user',
        },
        0,
      ),
      agent(1000),
      codexEvent('event_msg', { type: 'agent_message', message: brief }, 1001),
      user('A', 2000),
      codexEvent(
        'event_msg',
        { type: 'user_message', client_id: 'typed-2000', message: 'A' },
        2002,
      ),
      agent(4000),
      item(
        { type: 'HookPrompt', id: 'hook', fragments: [{ text: 'B' }] },
        4500,
      ),
      user('B', 5000),
    ],
  )

  // Act
  const report = await store.importHistory({ codex })

  // Assert
  assert.equal(report.observations, 1)
  assert.deepEqual(store.humanResponsesSince(0), [
    {
      source: 'codex',
      sessionId: 'native',
      responseId: 'prompt:typed-2000',
      at: base + 2000,
    },
  ])
  assert.equal(store.evaluate(bug, { cwd: repo }).summary.choices[0].current, 1)
})
