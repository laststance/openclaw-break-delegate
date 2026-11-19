import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PreferenceStore } from '../../dist/preferences/index.js'

const base = Date.UTC(2025, 0, 4)
const event = (type, payload, milliseconds) => ({
  type,
  payload,
  timestamp: new Date(base + milliseconds).toISOString(),
})
const meta = event(
  'session_meta',
  {
    id: 'thread',
    source: 'vscode',
    originator: 'Codex Desktop',
    thread_source: 'user',
    cwd: '/fixture',
    git: { repository_url: 'https://github.com/fixture/example.git' },
  },
  0,
)
const card = {
  id: 'scope',
  question: 'Which tests should we run?',
  options: [{ label: 'Focused tests' }, { label: 'Full suite' }],
}
const request = (question = card, at = 1000) =>
  event(
    'response_item',
    {
      type: 'function_call',
      name: 'request_user_input',
      call_id: 'form-1',
      arguments: JSON.stringify({ questions: [question] }),
    },
    at,
  )
const response = event(
  'response_item',
  {
    type: 'function_call_output',
    call_id: 'form-1',
    output: JSON.stringify({
      answers: { scope: { answers: ['Focused tests'] } },
    }),
  },
  2000,
)
const native = (item, at) =>
  event(
    'event_msg',
    { type: 'item_completed', thread_id: 'thread', turn_id: 'turn', item },
    at,
  )
const rows = (file, entries) =>
  writeFileSync(file, entries.map((row) => JSON.stringify(row) + '\n').join(''))

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'break-history-repair-'))
  const codex = join(root, 'codex')
  const sessions = join(codex, 'sessions')
  mkdirSync(sessions, { recursive: true })
  const db = new DatabaseSync(':memory:')
  const store = new PreferenceStore(db)
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    db,
    store,
    codex,
    one: join(sessions, 'rollout-first.jsonl'),
    two: join(sessions, 'rollout-second.jsonl'),
  }
}

test('a surviving copy of an explicit native correction continues to reject a misdirected anonymous reply and its workload credit', async (t) => {
  // Arrange
  const { codex, one, two, store } = fixture(t)
  const question = native(
    {
      type: 'AgentMessage',
      id: 'current-brief',
      phase: 'final_answer',
      content: [
        {
          type: 'Text',
          text: 'D1 - Which tests should we run?\nA. Focused tests\nB. Full suite',
        },
      ],
    },
    1000,
  )
  const candidate = event(
    'event_msg',
    { type: 'user_message', message: 'A' },
    2000,
  )
  const correction = native(
    {
      type: 'UserMessage',
      id: 'answer',
      client_id: 'native-reply',
      reply_to: 'other-brief',
      content: [{ type: 'text', text: 'A' }],
    },
    2001,
  )
  rows(one, [meta, question, candidate, correction])
  rows(two, [meta, question, candidate, correction])
  rows(join(codex, 'history.jsonl'), [
    { session_id: 'thread', ts: (base + 2000) / 1000, text: 'A' },
  ])
  const original = await store.importHistory({ codex })
  const before = store.humanResponsesSince(0)
  rows(one, [meta])

  // Act
  const after = await store.importHistory({ codex })

  // Assert
  assert.equal(original.observations, 0)
  assert.deepEqual(before, [])
  assert.equal(after.observations, 0)
  assert.deepEqual(store.humanResponsesSince(0), [])
})

test('a verified result in a separate transcript regains its preference and workload only when the original eligible request is restored', async (t) => {
  // Arrange
  const { codex, one, two, store } = fixture(t)
  rows(one, [meta, request()])
  await store.importHistory({ codex })
  rows(two, [meta, response])
  const original = await store.importHistory({ codex })
  const earned = () => store.humanResponsesSince(0).map((r) => r.responseId)
  const before = earned()
  const checkpoint = async (entries) => {
    rows(one, [meta, ...entries])
    const report = await store.importHistory({ codex })
    return [report.observations, earned()]
  }
  const incompatible = {
    ...card,
    options: [{ label: 'Full suite' }, { label: 'Focused tests' }],
  }

  // Act
  const noRequest = await checkpoint([])
  const withdrawn = store
    .unmatchedTypedResponsesSince(0)
    .map((row) => row.responseId)
  const changedQuestion = await checkpoint([request(incompatible)])
  const lateRequest = await checkpoint([request(card, 3000)])
  const restored = await checkpoint([request()])
  const released = store
    .unmatchedTypedResponsesSince(0)
    .map((row) => row.responseId)
  const secondScan = await store.importHistory({ codex })
  rows(two, [meta])
  const noResult = await store.importHistory({ codex })
  const absent = earned()
  const afterAnotherRequest = await checkpoint([request(), { type: 'padding' }])

  // Assert
  assert.equal(original.observations, 1)
  assert.deepEqual(before, ['tool:form-1'])
  assert.deepEqual(noRequest, [0, []])
  assert.deepEqual(withdrawn, ['tool:form-1'])
  assert.deepEqual(released, [])
  assert.deepEqual(changedQuestion, [0, []])
  assert.deepEqual(lateRequest, [0, []])
  assert.deepEqual(restored, [1, ['tool:form-1']])
  assert.equal(secondScan.observations, 1)
  assert.equal(noResult.observations, 0)
  assert.deepEqual(absent, [])
  assert.deepEqual(afterAnotherRequest, [0, []])
})

test('upgrading an unowned cache releases a removed Codex transcript instruction and preserves an independently possible legacy Claude instruction', async (t) => {
  // Arrange
  const { db, store, codex, one } = fixture(t)
  const oldRule = event(
    'event_msg',
    {
      type: 'user_message',
      prompt_source: 'typed',
      client_id: 'p',
      message: 'Ask me for approval.',
    },
    1000,
  )
  rows(one, [meta, oldRule])
  await store.importHistory({ codex })
  store.recordInstruction(
    'claude',
    'other',
    'Ask me for approval.',
    base + 1000,
  )
  const rules = () =>
    db
      .prepare(
        'SELECT source,kind,required FROM pref_constraints ORDER BY source',
      )
      .all()
      .map((r) => [r.source, r.kind, r.required])
  const before = rules()
  db.exec(
    "DELETE FROM pref_source_facts; DELETE FROM pref_decoder_versions WHERE version='history-source-ownership-v1'",
  )
  rows(one, [meta])

  // Act
  const upgraded = new PreferenceStore(db)
  await upgraded.importHistory({ codex })
  await upgraded.importHistory({ codex })

  // Assert
  assert.deepEqual(before, [
    ['claude', '*', '*'],
    ['codex', '*', '*'],
  ])
  assert.deepEqual(rules(), [['claude', '*', '*']])
})

test('upgrading a prior split-result cache verifies the actual answer file before restoring its previously lost choice and workload', async (t) => {
  // Arrange
  const { db, store, codex, one, two } = fixture(t)
  rows(one, [meta, request()])
  await store.importHistory({ codex })
  rows(two, [meta, response])
  await store.importHistory({ codex })
  const prior = db
    .prepare(
      'SELECT owner,source,session,tool,question,repo,selected,at FROM pref_structured_witnesses',
    )
    .all()
  for (const proof of prior) {
    const table = proof.question ? 'pref_primary_choices' : 'pref_responses'
    const value = proof.question
      ? [
          proof.source,
          proof.session,
          proof.tool,
          proof.question,
          proof.selected,
          proof.at,
        ]
      : [
          proof.source,
          proof.session,
          'tool:' + proof.tool,
          proof.tool,
          proof.at,
        ]
    db.prepare('INSERT INTO pref_source_facts VALUES(?,?,?,?,?)').run(
      proof.owner,
      proof.source,
      proof.session,
      table,
      JSON.stringify(value),
    )
  }
  db.exec(`DELETE FROM pref_structured_witnesses; DELETE FROM pref_primary_choices; DELETE FROM pref_responses;
    UPDATE pref_offers SET answered=NULL,selected=NULL; UPDATE pref_state SET dirty=1;
    DELETE FROM pref_decoder_versions WHERE version='revalidated-native-links-and-structured-witnesses-v1'`)

  // Act
  const upgraded = new PreferenceStore(db)
  const pending = upgraded.humanResponsesSince(0)
  const verified = await upgraded.importHistory({ codex })
  const stable = await upgraded.importHistory({ codex })

  // Assert
  assert.deepEqual(pending, [])
  assert.equal(verified.changedFiles, 1)
  assert.equal(verified.observations, 1)
  assert.deepEqual(
    upgraded.humanResponsesSince(0).map((r) => r.responseId),
    ['tool:form-1'],
  )
  assert.equal(stable.bytesRead, 0)
})

test('the decoder upgrade rereads an unchanged Codex transcript to correct an explicitly linked typed reply and release a stale session veto', async (t) => {
  // Arrange
  const { db, store, codex, one } = fixture(t)
  const briefA =
    'D1 — How should we handle an unrelated bug?\nA) Open a separate issue\nB) Fix in this PR'
  const briefB =
    'D1 — How should we handle an unrelated bug?\nA) Fix in this PR\nB) Open a separate issue'
  const agent = (id, message, at) =>
    event('event_msg', { type: 'agent_message', id, message }, at)
  const human = (client_id, reply_to, message, at) =>
    event(
      'event_msg',
      {
        type: 'user_message',
        client_id,
        reply_to,
        prompt_source: 'typed',
        message,
      },
      at,
    )
  rows(one, [
    meta,
    agent('q1', briefA, 1000),
    agent('q2', briefB, 2000),
    human('choice', 'q1', 'A', 3000),
    human('unknown', 'missing', 'Always ask for my approval', 4000),
  ])
  await store.importHistory({ codex })
  const fileOwner = db
    .prepare(
      "SELECT path||'/'||identity AS owner FROM pref_files WHERE json_type(state,'$.interactive') IS NOT NULL",
    )
    .get().owner
  const rule = ['codex', 'thread', base + 4000, '*', '*']
  db.prepare('INSERT OR IGNORE INTO pref_constraints VALUES(?,?,?,?,?)').run(
    ...rule,
  )
  for (const owner of [fileOwner, 'legacy-instruction'])
    db.prepare('INSERT OR IGNORE INTO pref_source_facts VALUES(?,?,?,?,?)').run(
      owner,
      'codex',
      'thread',
      'pref_constraints',
      JSON.stringify(rule),
    )
  db.exec(`DELETE FROM pref_responses;DELETE FROM pref_primary_choices;DELETE FROM pref_direct_answers;UPDATE pref_offers SET selected=NULL,answered=NULL;
    DELETE FROM pref_decoder_versions WHERE version='revalidated-native-links-and-structured-witnesses-v1'`)

  // Act
  const upgraded = new PreferenceStore(db)
  const quarantined = upgraded.humanResponsesSince(0)
  const corrected = await upgraded.importHistory({ codex })
  const stable = await upgraded.importHistory({ codex })

  // Assert
  assert.deepEqual(quarantined, [])
  assert.equal(corrected.changedFiles, 1)
  assert.equal(corrected.observations, 1)
  assert.deepEqual(
    db
      .prepare('SELECT selected FROM pref_observations')
      .all()
      .map((row) => row.selected),
    ['separate-issue'],
  )
  assert.deepEqual(
    upgraded.humanResponsesSince(0).map((row) => row.responseId),
    ['prompt:choice'],
  )
  assert.deepEqual(
    db
      .prepare(
        "SELECT kind FROM pref_constraints WHERE source='codex' AND session='thread'",
      )
      .all(),
    [],
  )
  assert.equal(stable.bytesRead, 0)
})
