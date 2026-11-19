import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import assert from 'node:assert/strict'
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  LocalActivityProbe,
  Supervision,
} from '../../dist/supervision/index.js'
import {
  codexStatus,
  openRolloutPaths,
  parseClaudeAgents,
} from '../../dist/supervision/activity.js'
import { RolloutDetector } from '../../dist/supervision/codex-rollout.js'
import { PreferenceStore } from '../../dist/preferences/index.js'
import { startService } from '../../dist/service.js'
import { requestGateway } from '../../dist/ipc.js'

const now = Date.UTC(2026, 5, 1, 12)
const ts = new Date(now).toISOString()
const jsonl = (...rows) =>
  rows.map((row) => JSON.stringify(row) + '\n').join('')
const event = (type, fields = {}) => ({
  timestamp: ts,
  type: 'event_msg',
  payload: { type, ...fields },
})
const item = (type, fields = {}) => ({
  timestamp: ts,
  type: 'response_item',
  payload: { type, ...fields },
})
const session = (id, source = 'cli', originator = 'codex_cli_rs') => ({
  timestamp: ts,
  type: 'session_meta',
  payload: { id, source, originator },
})
const input = (id, args = {}) =>
  item('function_call', {
    call_id: id,
    name: 'request_user_input',
    arguments: JSON.stringify({
      questions: [
        { id: 'layout', options: [{ label: 'Compact' }, { label: 'Wide' }] },
      ],
      ...args,
    }),
  })
const answer = (id, extra = {}) =>
  item('function_call_output', {
    call_id: id,
    output: JSON.stringify({
      answers: { layout: { answers: ['Compact'] } },
      ...extra,
    }),
  })
const empty = async () => ({ observations: [], detail: 'No live sessions' })

async function isolated(t) {
  const home = await mkdtemp(join(tmpdir(), 'break-supervision-'))
  const sessions = join(home, 'sessions')
  await mkdir(sessions, { recursive: true })
  t.after(() => rm(home, { recursive: true, force: true }))
  return { home, sessions, file: join(sessions, 'rollout-native.jsonl') }
}

test('Claude roster counts tested native busy/wait/idle statuses and leaves an exited background worker unknown', () => {
  // Arrange
  const roster = [
    { kind: 'interactive', sessionId: 'live', pid: 123, status: 'busy' },
    {
      kind: 'interactive',
      sessionId: 'ask',
      pid: 124,
      status: 'waiting',
      waitingFor: 'input needed',
    },
    {
      kind: 'background',
      sessionId: 'finish',
      pid: 125,
      status: 'idle',
      state: 'done',
    },
    { kind: 'background', sessionId: 'detached', state: 'working' },
  ]
  // Act
  const result = parseClaudeAgents(roster)
  // Assert
  assert.deepEqual(
    result.observations.map((o) => o.status),
    ['running', 'waiting', 'idle', 'unknown'],
  )
  assert.equal(result.partial, true)
  assert.ok(result.observations.every((o) => o.canDelegate === undefined))
})

test('Codex activeFlags suspend work for human waits and stored status never implies idle or work', () => {
  // Arrange
  const statuses = [
    { type: 'active', activeFlags: [] },
    { type: 'active', activeFlags: ['waitingOnUserInput'] },
    { type: 'active', activeFlags: ['waitingOnApproval'] },
    { type: 'idle' },
    { type: 'notLoaded' },
    { type: 'systemError' },
    { type: 'active', activeFlags: ['futureFlag'] },
    {},
  ]
  // Act
  const result = statuses.map(codexStatus)
  // Assert
  assert.deepEqual(result, [
    'running',
    'waiting',
    'waiting',
    'idle',
    'unknown',
    'unknown',
    'unknown',
    'unknown',
  ])
})

test('only the native Codex writer can attest to a private CLI rollout, and reader handles do not qualify', () => {
  // Arrange
  const list =
    'p101\nccodex\nf7\naw\nn/tmp/rollout-cli.jsonl\nf8\nar\nn/tmp/rollout-stored.jsonl\np202\ncother\nf9\nau\nn/tmp/rollout-other.jsonl\n'
  // Act
  const result = openRolloutPaths(list)
  // Assert
  assert.deepEqual(result, ['/tmp/rollout-cli.jsonl'])
})

test('a live native rollout pauses while waiting and credits one exact structured human selection', async (t) => {
  // Arrange
  const { home, file } = await isolated(t)
  await writeFile(
    file,
    jsonl(
      session('cli', 'vscode', 'codex-tui'),
      event('task_started'),
      input('decision'),
    ),
  )
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const supervisor = new Supervision(db, { now: () => now })
  const probe = new LocalActivityProbe({
    codexHome: home,
    now: () => now,
    readClaude: empty,
    readCodex: empty,
    readWriters: async () => [file],
  })
  // Act
  await probe.poll(supervisor)
  assert.equal(supervisor.status().sessions[0].status, 'waiting')
  await appendFile(
    file,
    jsonl(
      answer('decision'),
      event('user_message', { message: 'Start a new task' }),
    ),
  )
  await probe.poll(supervisor)
  await probe.poll(supervisor)
  // Assert
  assert.equal(supervisor.status().score, 4)
  assert.equal(supervisor.status().sessions[0].status, 'unknown')
  assert.equal(
    supervisor.humanReply({
      provider: 'codex',
      sessionId: 'cli',
      responseId: 'tool:decision',
    }),
    false,
  )
})

test('auto-resolutions, unrelated prompts, malformed selections, and spawned agents get no answer credit', async (t) => {
  // Arrange
  const { home, file, sessions } = await isolated(t)
  const child = join(sessions, 'rollout-child.jsonl')
  await writeFile(
    child,
    jsonl(
      session('child', { subagent: 'worker' }, 'Codex Desktop'),
      event('task_started'),
      input('child-q'),
      answer('child-q'),
    ),
  )
  await writeFile(
    file,
    jsonl(
      session('desktop', 'vscode', 'Codex Desktop'),
      event('task_started'),
      input('timed', { autoResolutionMs: 1000 }),
      answer('timed'),
      input('invalid'),
      item('function_call_output', {
        call_id: 'invalid',
        output: JSON.stringify({
          answers: { layout: { answers: ['Unlisted'] } },
        }),
      }),
      event('agent_message', {
        phase: 'final_answer',
        message: 'Should I make it wider?',
      }),
      event('user_message', { message: 'Please open a different project' }),
      event('task_complete'),
    ),
  )
  // Act
  const result = await new RolloutDetector(home).read([file, child])
  // Assert
  assert.deepEqual(result.replies, [])
  assert.deepEqual(
    result.observations.map((o) => [o.sessionId, o.status]),
    [['desktop', 'idle']],
  )
})

test('live and history readers give zero credit to auto-resolved Codex outputs at every native envelope and four points to a human selection', async (t) => {
  // Arrange
  const { home, file } = await isolated(t)
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const supervisor = new Supervision(db, { now: () => now })
  const preferences = new PreferenceStore(db)
  const probe = new LocalActivityProbe({
    codexHome: home,
    now: () => now,
    readClaude: empty,
    readCodex: empty,
    readWriters: async () => [file],
  })
  const ask = (id) =>
    input(id, {
      questions: [
        {
          id: 'layout',
          question: 'Which layout should we use?',
          options: [{ label: 'Compact' }, { label: 'Wide' }],
        },
      ],
    })
  const nativeOutput = (id, extra) =>
    event('item_completed', {
      thread_id: 'cli',
      item: {
        type: 'FunctionCallOutput',
        id,
        name: 'request_user_input',
        output: JSON.stringify({
          answers: { layout: { answers: ['Compact'] } },
        }),
        ...extra,
      },
    })
  const nested = answer('function-output')
  nested.payload.autoResolved = true
  const content = item('custom_tool_call_output', {
    call_id: 'content',
    output: [
      {
        type: 'text',
        text: JSON.stringify({ answers: { layout: { answers: ['Compact'] } } }),
        responder: 'agent',
      },
    ],
  })
  await writeFile(file, jsonl(session('cli'), event('task_started')))
  await probe.poll(supervisor)

  // Act
  await appendFile(
    file,
    jsonl(
      ask('autoResolved'),
      answer('autoResolved', { autoResolved: true }),
      ask('snake'),
      answer('snake', { auto_resolved: true }),
      ask('row'),
      { ...answer('row'), timedOut: true },
      ask('function-output'),
      nested,
      ask('answer'),
      answer('answer', {
        answers: { layout: { answers: ['Compact'], autoResolved: true } },
      }),
      ask('content'),
      content,
      nativeOutput('early-native', { autoResolved: true }),
      ask('early-native'),
      answer('early-native'),
      { ...ask('request'), auto_resolution_ms: 0 },
      ask('request'),
      answer('request'),
    ),
  )
  await probe.poll(supervisor)
  await preferences.importHistory({ codex: home })

  // Assert
  assert.equal(supervisor.status().score, 0)
  assert.deepEqual(preferences.humanResponsesSince(0), [])
  await appendFile(
    file,
    jsonl(
      ask('human'),
      answer('human', {
        autoResolved: false,
        auto_resolved: false,
        automated: false,
      }),
    ),
  )
  await probe.poll(supervisor)
  await preferences.importHistory({ codex: home })
  assert.equal(supervisor.status().score, 4)
  assert.deepEqual(
    preferences.humanResponsesSince(0).map((reply) => reply.responseId),
    ['tool:human'],
  )
})

test('a later marked native mirror retracts the provisional live selection while independent human answers keep their four points', async (t) => {
  // Arrange
  const { home, file } = await isolated(t)
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const supervisor = new Supervision(db, { now: () => now })
  const probe = new LocalActivityProbe({
    codexHome: home,
    now: () => now,
    readClaude: empty,
    readCodex: empty,
    readWriters: async () => [file],
  })
  await writeFile(file, jsonl(session('cli'), event('task_started')))
  await probe.poll(supervisor)
  await appendFile(
    file,
    jsonl(input('late'), answer('late'), input('human'), answer('human')),
  )
  await probe.poll(supervisor)
  assert.equal(supervisor.status().score, 8)

  // Act
  await appendFile(
    file,
    jsonl(
      event('item_completed', {
        thread_id: 'cli',
        item: {
          type: 'FunctionCallOutput',
          id: 'late',
          name: 'request_user_input',
          output: [
            {
              type: 'text',
              text: JSON.stringify({
                answers: { layout: { answers: ['Compact'] } },
                autoResolved: true,
              }),
            },
          ],
        },
      }),
    ),
  )
  await probe.poll(supervisor)
  await appendFile(file, jsonl(input('late'), answer('late')))
  await probe.poll(supervisor)

  // Assert
  assert.equal(supervisor.status().score, 4)
  assert.equal(
    supervisor.humanReply({
      provider: 'codex',
      sessionId: 'cli',
      responseId: 'tool:late',
      observedLive: true,
    }),
    false,
  )
})

test('a direct human reply to the preceding native question counts while a new prompt or injected message does not', async (t) => {
  // Arrange
  const { home, file } = await isolated(t)
  await writeFile(
    file,
    jsonl(
      session('desktop', 'vscode', 'Codex Desktop'),
      event('task_started'),
      event('agent_message', {
        phase: 'final_answer',
        message: 'Should I use the existing type?',
      }),
      event('task_complete'),
      event('task_started'),
      event('user_message', { message: 'はい', client_id: 'reply-7' }),
      event('user_message', { message: 'yes', client_id: 'new-prompt' }),
      event('agent_message', {
        phase: 'final_answer',
        message: 'Use the same type?',
      }),
      event('user_message', {
        message: 'yes',
        author: 'automation',
        client_id: 'auto',
      }),
    ),
  )
  // Act
  const result = await new RolloutDetector(home).read([file])
  // Assert
  assert.deepEqual(result.replies, [
    {
      sessionId: 'desktop',
      responseId: 'prompt:reply-7',
      originId: 'codex:desktop:prompt:reply-7',
      at: now,
      observedLive: false,
    },
  ])
})

test('only a newly witnessed native reply survives a direct temporary workload withdrawal', async (t) => {
  // Arrange
  const { home, file } = await isolated(t)
  const question = event('agent_message', {
    message: 'Use the compact layout?',
  })
  const response = (id) =>
    event('user_message', { message: 'yes', client_id: id })
  await writeFile(file, jsonl(session('cli'), question, response('replayed')))
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const supervisor = new Supervision(db, { now: () => now })
  const probe = new LocalActivityProbe({
    codexHome: home,
    now: () => now,
    readClaude: empty,
    readCodex: empty,
    readWriters: async () => [file],
  })
  await probe.poll(supervisor)
  await appendFile(file, jsonl(question, response('witnessed')))
  await probe.poll(supervisor)
  assert.equal(supervisor.status().score, 8)

  // Act
  const withdraw = (id) =>
    supervisor.retractHumanReply({
      provider: 'codex',
      sessionId: 'cli',
      responseId: 'prompt:' + id,
      permanent: false,
    })
  withdraw('replayed')
  withdraw('witnessed')

  // Assert
  assert.equal(supervisor.status().score, 4)
  assert.equal(
    supervisor.humanReply({
      provider: 'codex',
      sessionId: 'cli',
      responseId: 'prompt:replayed',
    }),
    true,
  )
  assert.equal(supervisor.status().score, 8)
})

test('an incomplete or corrupted rollout stays unknown until a new turn boundary arrives', async (t) => {
  // Arrange
  const { home, file } = await isolated(t)
  await writeFile(
    file,
    jsonl(session('cli'), event('task_started')) +
      'not a full event\n' +
      JSON.stringify(event('task_complete')),
  )
  const detector = new RolloutDetector(home)
  // Act
  const before = await detector.read([file])
  await appendFile(file, '\n')
  const after = await detector.read([file])
  // Assert
  assert.equal(before.observations[0].status, 'unknown')
  assert.equal(after.observations[0].status, 'idle')
})

test('an unreachable observer leaves explicit coverage while other native clients still contribute', async (t) => {
  // Arrange
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const supervisor = new Supervision(db, { now: () => now })
  const probe = new LocalActivityProbe({
    now: () => now,
    readClaude: async () =>
      parseClaudeAgents([
        { kind: 'interactive', pid: 1, sessionId: 'claude', status: 'busy' },
      ]),
    readCodex: async () => {
      throw Error('unreachable')
    },
    readWriters: async () => [],
  })
  // Act
  await probe.poll(supervisor)
  // Assert
  assert.equal(supervisor.status().sessions[0].status, 'running')
  assert.equal(
    supervisor.status().coverage.find((c) => c.source === 'codex-app-server')
      .status,
    'unavailable',
  )
})

test('the Codex Unix WebSocket uses metadata-only methods, pages loaded IDs, and deduplicates a thread shared with another view', async (t) => {
  // Arrange
  const { home, file } = await isolated(t)
  await writeFile(
    file,
    jsonl(session('desktop', 'vscode', 'Codex Desktop'), event('task_started')),
  )
  const socket = join(home, 'observer.sock'),
    server = createServer(),
    websocket = new WebSocketServer({ server })
  const requests = []
  websocket.on('connection', (ws) =>
    ws.on('message', (data) => {
      const { id, method, params } = JSON.parse(data.toString())
      requests.push({ method, params })
      if (!id) return
      let result
      if (method === 'initialize') result = {}
      if (method === 'thread/loaded/list')
        result = params.cursor
          ? { data: ['stored'], nextCursor: null }
          : { data: ['desktop'], nextCursor: 'next' }
      if (method === 'thread/read')
        result = {
          thread:
            params.threadId === 'desktop'
              ? {
                  id: 'desktop',
                  source: 'vscode',
                  path: file,
                  status: { type: 'active', activeFlags: [] },
                }
              : { id: 'stored', source: 'cli', status: { type: 'notLoaded' } },
        }
      ws.send(JSON.stringify({ id, result }))
    }),
  )
  server.listen(socket)
  await once(server, 'listening')
  t.after(() => {
    for (const ws of websocket.clients) ws.terminate()
    websocket.close()
    return new Promise((resolve) => server.close(resolve))
  })
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const supervisor = new Supervision(db, { now: () => now })
  let writerVisible = false
  const probe = new LocalActivityProbe({
    codexHome: home,
    codexSocket: socket,
    now: () => now,
    readClaude: empty,
    readWriters: async () => (writerVisible ? [file] : []),
  })
  // Act
  await probe.poll(supervisor)
  // Assert
  assert.deepEqual(
    supervisor
      .status()
      .sessions.map((s) => [s.sessionId, s.client, s.status])
      .sort(),
    [
      ['desktop', 'desktop', 'running'],
      ['stored', 'cli', 'unknown'],
    ],
  )
  assert.deepEqual(
    requests.map((r) => r.method),
    [
      'initialize',
      'initialized',
      'thread/loaded/list',
      'thread/loaded/list',
      'thread/read',
      'thread/read',
    ],
  )
  assert.ok(
    requests
      .filter((r) => r.method === 'thread/read')
      .every((r) => r.params.includeTurns === false),
  )
  // A second view of the same native Desktop thread must not add another session.
  writerVisible = true
  await probe.poll(supervisor)
  assert.deepEqual(
    supervisor
      .status()
      .sessions.map((s) => [s.sessionId, s.client, s.status])
      .sort(),
    [
      ['desktop', 'desktop', 'running'],
      ['stored', 'cli', 'unknown'],
    ],
  )
})

test("the native terminal's completed user item counts once when it answers the preceding final question", async (t) => {
  // Arrange
  const { home, file } = await isolated(t)
  await writeFile(
    file,
    jsonl(
      session('cli', 'vscode', 'codex-tui'),
      event('task_started'),
      event('item_completed', {
        thread_id: 'cli',
        item: {
          type: 'AgentMessage',
          id: 'q',
          phase: 'final_answer',
          content: [{ type: 'Text', text: 'Proceed?' }],
        },
      }),
      event('task_complete'),
      event('task_started'),
      event('item_completed', {
        thread_id: 'cli',
        item: {
          type: 'UserMessage',
          id: 'u',
          client_id: 'n1',
          content: [{ type: 'text', text: 'Yes', text_elements: [] }],
        },
      }),
      event('user_message', { client_id: 'n1', message: 'Yes' }),
    ),
  )
  // Act
  const result = await new RolloutDetector(home).read([file])
  // Assert
  assert.deepEqual(
    result.replies.map((reply) => reply.originId),
    ['codex:cli:prompt:n1'],
  )
})

test('a live writer with no observed turn boundary reports partial coverage until activity becomes known', async (t) => {
  // Arrange
  const { home, file } = await isolated(t)
  await writeFile(file, jsonl(session('term')))
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const supervisor = new Supervision(db, { now: () => now })
  const probe = new LocalActivityProbe({
    codexHome: home,
    now: () => now,
    readClaude: empty,
    readCodex: empty,
    readWriters: async () => [file],
  })
  const coverage = () =>
    supervisor.status().coverage.find((c) => c.source === 'codex-rollouts')
      ?.status
  // Act
  await probe.poll(supervisor)
  // Assert
  assert.equal(coverage(), 'partial')
  await appendFile(file, jsonl(event('task_complete')))
  await probe.poll(supervisor)
  assert.equal(coverage(), 'available')
})

test('the bounded writer tail preserves a complete turn boundary and drops only a partial first record', async (t) => {
  // Arrange
  const { home, file, sessions } = await isolated(t)
  const second = join(sessions, 'rollout-inside.jsonl')
  const header = jsonl(session('cli'))
  const boundary = jsonl(event('task_complete'))
  const padding = { type: 'ignored', payload: { padding: '' } }
  const occupied = Buffer.byteLength(boundary + jsonl(padding))
  padding.payload.padding = 'x'.repeat(2 * 1024 * 1024 - occupied)
  await writeFile(file, header + boundary + jsonl(padding))
  padding.payload.padding += 'x'
  await writeFile(second, header + boundary + jsonl(padding))
  // Act
  const detector = new RolloutDetector(home)
  const aligned = await detector.read([file])
  const interior = await detector.read([second])
  // Assert
  assert.equal(aligned.observations[0].status, 'idle')
  assert.equal(interior.observations[0].status, 'unknown')
})

test('verified rollout replies retry after an interrupted snapshot or credit and a duplicate consumes the retry', async (t) => {
  // Arrange
  const { home, file } = await isolated(t)
  await writeFile(
    file,
    jsonl(
      session('term'),
      event('task_started'),
      input('one'),
      answer('one'),
      input('two'),
      answer('two'),
    ),
  )
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const supervisor = new Supervision(db, { now: () => now })
  const probe = new LocalActivityProbe({
    codexHome: home,
    now: () => now,
    readClaude: empty,
    readCodex: empty,
    readWriters: async () => [file],
  })
  let failSnapshot = true,
    failCredit = true
  const attempts = []
  const interrupted = {
    snapshot(...args) {
      if (failSnapshot) {
        failSnapshot = false
        throw Error('snapshot interrupted')
      }
      supervisor.snapshot(...args)
    },
    humanReply(reply) {
      attempts.push(reply.responseId)
      const credited = supervisor.humanReply(reply)
      if (reply.responseId === 'tool:two' && failCredit) {
        failCredit = false
        throw Error('after credit')
      }
      return credited
    },
  }
  // Act
  await assert.rejects(probe.poll(interrupted), /snapshot interrupted/)
  await assert.rejects(probe.poll(interrupted), /after credit/)
  await probe.poll(interrupted)
  await probe.poll(interrupted)
  // Assert
  assert.deepEqual(attempts, ['tool:one', 'tool:two', 'tool:two'])
  assert.equal(supervisor.status().score, 8)
})

test('rotating an open rollout cannot assign the old file’s reply to the replacement session', async (t) => {
  // Arrange
  const { home, file, sessions } = await isolated(t)
  const next = join(sessions, 'rollout-replacement.jsonl')
  await writeFile(
    file,
    jsonl(session('original'), input('first'), answer('first')),
  )
  await writeFile(
    next,
    jsonl(session('replacement'), input('second'), answer('second')),
  )
  const handle = await open(file)
  const prototype = Object.getPrototypeOf(handle),
    initial = await handle.stat(),
    original = prototype.stat
  await handle.close()
  let rotated = false
  t.mock.method(prototype, 'stat', async function (...args) {
    const stat = await original.apply(this, args)
    if (!rotated && stat.ino === initial.ino) {
      rotated = true
      await rename(next, file)
    }
    return stat
  })
  // Act
  const detector = new RolloutDetector(home)
  const before = await detector.read([file])
  const after = await detector.read([file])
  // Assert
  assert.equal(rotated, true)
  assert.deepEqual(
    before.replies.map((r) => r.originId),
    ['codex:original:tool:first'],
  )
  assert.deepEqual(
    after.replies.map((r) => r.originId),
    ['codex:replacement:tool:second'],
  )
})

test('the first successful rollout sample after a read failure treats preexisting replies as history and only later appends as live', async (t) => {
  // Arrange
  const { home, file } = await isolated(t)
  await writeFile(file, jsonl(session('cli'), input('old'), answer('old')))
  const handle = await open(file),
    proto = Object.getPrototypeOf(handle),
    read = proto.read
  await handle.close()
  let reads = 0
  t.mock.method(proto, 'read', async function (...args) {
    if (++reads === 2) throw Error('initial read failed')
    return read.apply(this, args)
  })
  const detector = new RolloutDetector(home)
  // Act
  const failed = await detector.read([file])
  const initial = await detector.read([file])
  await appendFile(file, jsonl(input('new'), answer('new')))
  const appended = await detector.read([file])
  // Assert
  assert.equal(failed.partial, true)
  assert.deepEqual(
    initial.replies.map((r) => [r.responseId, r.observedLive]),
    [['tool:old', false]],
  )
  assert.deepEqual(
    appended.replies.map((r) => [r.responseId, r.observedLive]),
    [['tool:new', true]],
  )
})

test('an open rollout with no live provider status cannot charge time while a transient approval may be hidden', async (t) => {
  // Arrange
  const { home, file } = await isolated(t)
  await writeFile(file, jsonl(session('cli'), event('task_started')))
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  let clock = now,
    provider = false
  const supervisor = new Supervision(db, { now: () => clock })
  const probe = new LocalActivityProbe({
    codexHome: home,
    now: () => clock,
    readClaude: empty,
    readWriters: async () => [file],
    readCodex: async () => ({
      observations: provider
        ? [{ provider: 'codex', sessionId: 'cli', status: 'running' }]
        : [],
      detail: 'Local provider',
    }),
  })
  // Act
  await probe.poll(supervisor)
  clock += 60000
  await probe.poll(supervisor)
  // Assert
  assert.equal(supervisor.status().sessions[0].status, 'unknown')
  assert.equal(supervisor.status().score, 0)
  provider = true
  await probe.poll(supervisor)
  clock += 60000
  await probe.poll(supervisor)
  assert.equal(supervisor.status().sessions[0].status, 'running')
  assert.equal(supervisor.status().score, 1)
})

test('ordinary native tool results cannot create permanent exclusions and marked unknown answers wait for their original question', async (t) => {
  // Arrange
  const { home, file } = await isolated(t)
  await writeFile(
    file,
    jsonl(
      session('cli'),
      item('function_call', {
        name: 'exec_command',
        call_id: 'command',
        arguments: '{}',
      }),
      answer('command', { timed_out: true }),
      item('function_call_output', {
        call_id: 'unknown',
        output: '{"timed_out":true}',
      }),
      answer('early', { answers: {}, autoResolved: true }),
    ),
  )
  const detector = new RolloutDetector(home)
  // Act
  const first = await detector.read([file])
  await appendFile(
    file,
    jsonl(input('early'), answer('early'), input('valid'), answer('valid')),
  )
  const next = await detector.read([file])
  // Assert
  assert.deepEqual(first.excludedReplies, [])
  assert.deepEqual(
    [...new Set(next.excludedReplies.map((r) => r.responseId))],
    ['tool:early'],
  )
  assert.deepEqual(
    next.replies.map((r) => r.responseId),
    ['tool:valid'],
  )
})

test('replacing the Codex rollout reconciles an ambiguous typed reply through the gateway history import and restores only the confirmed answer', async (t) => {
  // Arrange
  const { home, file, sessions } = await isolated(t),
    directory = join(home, 'gateway'),
    history = join(home, 'history.jsonl')
  const stamped = (offset, payload) => ({
    timestamp: new Date(now + offset).toISOString(),
    type: 'event_msg',
    payload,
  })
  const question = (id, offset) =>
    stamped(offset, {
      type: 'agent_message',
      id,
      message:
        'D1 — How should we handle an unrelated bug?\nA) Fix in this PR\nB) Open a separate issue\n<gstack-qid:scope>',
    })
  const response = (id, offset) =>
    stamped(offset, { type: 'user_message', client_id: id, message: 'A' })
  const receipt = (offset, id) => ({
    session_id: 'cli',
    ts: (now + offset) / 1000,
    text: 'A',
    client_id: id,
  })
  await writeFile(
    file,
    jsonl(session('cli'), question('q1', 100), response('r1', 500)),
  )
  await writeFile(history, jsonl(receipt(1000)))
  const pass = async () => ({ status: 'not-determined' })
  const stop = await startService({
    directory,
    now: () => now + 2000,
    tickMs: 600000,
    roots: { codex: home },
    judge: async () => false,
    log() {},
    poll: async () => {},
    nativeFactory: () => ({
      status: pass,
      authorize: pass,
      invite: pass,
      active: pass,
      summary: pass,
      clear: pass,
      close() {},
    }),
  })
  try {
    const update = async () => {
      await requestGateway(directory, { op: 'import' })
      const status = await requestGateway(directory, { op: 'status' })
      return status.supervision.score
    }
    assert.equal(await update(), 4)
    // Act
    const replacement = join(sessions, 'pending-replacement')
    await writeFile(
      replacement,
      jsonl(session('cli'), question('q2', 800), response('r2', 1200)),
    )
    await rename(replacement, file)
    // Assert
    assert.equal(await update(), 0)
    await appendFile(history, jsonl(receipt(1250, 'r2')))
    assert.equal(await update(), 4)
  } finally {
    await stop()
  }
})

test('two same-second native typed replies to different questions are each credited once across the live and historical readers', async (t) => {
  // Arrange
  const { home, file } = await isolated(t)
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const supervisor = new Supervision(db, { now: () => now }),
    preferences = new PreferenceStore(db)
  const probe = new LocalActivityProbe({
    codexHome: home,
    now: () => now,
    readCodex: empty,
    readClaude: empty,
    readWriters: async () => [file],
  })
  await writeFile(file, jsonl(session('cli'), event('task_started')))
  await probe.poll(supervisor)
  // Act
  await appendFile(
    file,
    jsonl(
      event('agent_message', {
        id: 'q1',
        message: 'Proceed with the first option?',
      }),
      event('user_message', {
        message: 'yes',
        reply_to: 'q1',
        origin: { kind: 'human' },
      }),
      event('agent_message', {
        id: 'q2',
        message: 'Proceed with the second option?',
      }),
      event('user_message', {
        message: 'yes',
        reply_to: 'q2',
        origin: { kind: 'human' },
      }),
    ),
  )
  await probe.poll(supervisor)
  await preferences.importHistory({ codex: home })
  // Assert
  const replies = preferences.humanResponsesSince(0)
  assert.equal(replies.length, 2)
  assert.equal(new Set(replies.map((reply) => reply.responseId)).size, 2)
  assert.equal(supervisor.status().score, 8)
  for (const reply of replies)
    assert.equal(
      supervisor.humanReply({
        provider: reply.source,
        sessionId: reply.sessionId,
        responseId: reply.responseId,
        at: reply.at,
      }),
      false,
    )
  assert.equal(supervisor.status().score, 8)
})

test('a late unmarked Codex offer cannot reopen a known completed call while a second actual wait remains observable', async (t) => {
  // Arrange
  const { file, home } = await isolated(t)
  const native = (id) =>
    event('item_completed', {
      thread_id: 'cli',
      item: {
        id,
        type: 'FunctionCallOutput',
        name: 'request_user_input',
        output: answer(id).payload.output,
      },
    })
  await writeFile(
    file,
    jsonl(session('cli'), event('task_started'), native('finished')),
  )
  const detector = new RolloutDetector(home)
  await detector.read([file])
  // Act
  await appendFile(
    file,
    jsonl(
      input('finished'),
      event('request_user_input', { call_id: 'finished' }),
    ),
  )
  const late = await detector.read([file])
  await appendFile(file, jsonl(input('second')))
  const waiting = await detector.read([file])
  await appendFile(
    file,
    jsonl(answer('second'), input('finished', { autoResolutionMs: 0 })),
  )
  const done = await detector.read([file])
  // Assert
  assert.equal(late.observations[0].status, 'unknown')
  assert.deepEqual(late.replies, [])
  assert.equal(waiting.observations[0].status, 'waiting')
  assert.equal(done.observations[0].status, 'unknown')
  assert.deepEqual(
    done.replies.map((r) => r.responseId),
    ['tool:second'],
  )
  assert.deepEqual(
    done.excludedReplies.map((r) => r.responseId),
    ['tool:finished'],
  )
})
