import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  assert.equal(supervisor.status().sessions[0].status, 'running')
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
    },
  ])
})

test('an incomplete or corrupted rollout stays unknown until a new turn boundary arrives', async (t) => {
  // Arrange
  const { home, file } = await isolated(t)
  await writeFile(
    file,
    jsonl(session('cli'), event('task_started')) +
      'not a full event\n' +
      JSON.stringify(event('task_started')),
  )
  const detector = new RolloutDetector(home)
  // Act
  const before = await detector.read([file])
  await appendFile(file, '\n')
  const after = await detector.read([file])
  // Assert
  assert.equal(before.observations[0].status, 'unknown')
  assert.equal(after.observations[0].status, 'running')
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
  const probe = new LocalActivityProbe({
    codexHome: home,
    codexSocket: socket,
    now: () => now,
    readClaude: empty,
    readWriters: async () => [file],
  })
  // Act
  await probe.poll(supervisor)
  // Assert
  assert.deepEqual(
    supervisor
      .status()
      .sessions.map((s) => [s.sessionId, s.status])
      .sort(),
    [
      ['desktop', 'running'],
      ['stored', 'unknown'],
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
})
