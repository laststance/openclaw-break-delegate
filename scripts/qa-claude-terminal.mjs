import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { startService } from '../dist/service.js'
import { configureHooks } from '../dist/settings.js'
import { requestReview } from '../dist/commands.js'
import { requestGateway } from '../dist/ipc.js'
import { PreferenceStore } from '../dist/preferences/index.js'

if (process.platform !== 'darwin' || !process.argv[2] || !process.argv[3]) {
  throw Error(
    'Usage on macOS: node scripts/qa-claude-terminal.mjs <private output directory> <claude executable>',
  )
}
await mkdir(resolve(process.argv[2]), { recursive: true, mode: 0o700 })
const run = await mkdtemp(join(resolve(process.argv[2]), 'run-'))
console.log('Claude acceptance directory:', run)
const claude = resolve(process.argv[3])
const cwd = join(run, 'repo')
const directory = join(run, 'gateway')
const config = join(run, 'config')
await Promise.all(
  [cwd, directory, config, join(run, 'home')].map((path) =>
    mkdir(path, { mode: 0o700 }),
  ),
)
execFileSync('/usr/bin/git', ['init', '-q', cwd])
const cliVersion = execFileSync(claude, ['--version'], {
  encoding: 'utf8',
  timeout: 5000,
  killSignal: 'SIGKILL',
}).trim()
const sessionId = randomUUID()
const tool = 'toolu_fixture_break_delegate_01'
const selected = 'Fix in this PR'
const card = {
  question: 'How should we handle an unrelated bug?',
  header: 'Bug',
  multiSelect: false,
  options: [
    { label: selected, description: 'Fix it in the current pull request.' },
    { label: 'Open a separate issue', description: 'Defer the fix.' },
  ],
}
const completed = 'BREAK_DELEGATE_REAL_SESSION_COMPLETE'
const fakeKey = randomUUID()
await writeFile(
  join(config, '.claude.json'),
  JSON.stringify({
    hasCompletedOnboarding: true,
    lastOnboardingVersion: cliVersion.split(' ')[0],
    theme: 'dark',
    numStartups: 3,
    customApiKeyResponses: { approved: [fakeKey.slice(-20)], rejected: [] },
    projects: {
      [cwd]: {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    },
  }),
  { mode: 0o600 },
)
await configureHooks('install', directory, join(config, 'settings.json'))

const db = new DatabaseSync(join(directory, 'state.sqlite'))
const preferences = new PreferenceStore(db)
for (let i = 0; i < 28; i++) {
  const at = Date.now() - 86_400_000 + i * 1_000
  preferences.recordHumanSelection({
    source: 'claude',
    sessionId: 'fictional-history',
    toolUseId: 'synthetic-' + i,
    cwd,
    card,
    label: selected,
    askedAt: at,
    answeredAt: at + 1,
  })
}
assert.ok(preferences.replay().types.some((type) => type.eligible))
db.close()

const evidence = {
  cliVersion,
  sessionId,
  tool,
  capturedTerminal: false,
  judged: false,
  continuation: false,
  requests: [],
}
let onAction,
  breakId,
  scored = false
const pass = async () => ({ status: 'authorized' })
const stop = await startService({
  directory,
  roots: {},
  tickMs: 150,
  log: (message) => console.error(message),
  nativeFactory(handler) {
    onAction = handler
    return {
      status: pass,
      authorize: pass,
      clear: pass,
      summary: pass,
      close() {},
      invite: async (id) => {
        setImmediate(() => {
          void onAction({ kind: 'start', id })
        })
        return pass()
      },
      active: async (id) => {
        breakId = id
        return pass()
      },
    }
  },
  poll: async (coordinator) => {
    const session = coordinator
      .status()
      .sessions.find(
        (row) =>
          row.sessionId === sessionId &&
          row.canDelegate &&
          row.status === 'running',
      )
    if (!session || scored) return
    scored = true
    evidence.capturedTerminal = true
    evidence.gatewayGeneration = session.generation
    // Exercise a real hook-discovered terminal with a synthetic load high enough to invite a break.
    for (let i = 0; i < 12; i++)
      coordinator.humanReply({
        provider: 'claude',
        sessionId,
        responseId: 'synthetic-work-' + i,
      })
  },
  judge: async (cards) => {
    assert.equal(cards[0].candidate, selected)
    evidence.judged = true
    return true
  },
})

function reply(response, body, block) {
  const reason = block.type === 'tool_use' ? 'tool_use' : 'end_turn'
  const message = {
    id: 'msg_' + randomUUID(),
    type: 'message',
    role: 'assistant',
    model: body.model || 'claude-sonnet-4-6',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 25, output_tokens: 0 },
  }
  if (!body.stream) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({ ...message, content: [block], stop_reason: reason }),
    )
    return
  }
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  })
  function event(type, data) {
    response.write(
      'event: ' +
        type +
        '\ndata: ' +
        JSON.stringify({ type, ...data }) +
        '\n\n',
    )
  }
  event('message_start', { message })
  if (block.type === 'tool_use') {
    event('content_block_start', {
      index: 0,
      content_block: { ...block, input: {} },
    })
    event('content_block_delta', {
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify(block.input),
      },
    })
  } else {
    event('content_block_start', {
      index: 0,
      content_block: { type: 'text', text: '' },
    })
    event('content_block_delta', {
      index: 0,
      delta: { type: 'text_delta', text: block.text },
    })
  }
  event('content_block_stop', { index: 0 })
  event('message_delta', {
    delta: { stop_reason: reason, stop_sequence: null },
    usage: { output_tokens: 25 },
  })
  event('message_stop', {})
  response.end()
}

const server = createServer(async (req, res) => {
  try {
    if (!req.url.startsWith('/')) {
      res.writeHead(403)
      return res.end()
    }
    const chunks = []
    for await (const piece of req) chunks.push(piece)
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    const path = req.url.split('?')[0]
    if (path.endsWith('/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{"input_tokens":25}')
    }
    if (!path.endsWith('/messages')) {
      res.writeHead(404)
      return res.end()
    }
    const toolResult = body.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((b) => b.type === 'tool_result' && b.tool_use_id === tool)
    const hasTool = body.tools?.some((t) => t.name === 'AskUserQuestion')
    evidence.requests.push({
      path,
      interactiveToolOffered: Boolean(hasTool),
      containsResult: Boolean(toolResult),
    })
    if (toolResult) {
      assert.equal(toolResult.is_error === true, false)
      assert.ok(
        JSON.stringify(toolResult.content).includes(selected),
        'The actual CLI did not send the delegated result.',
      )
      const content =
        typeof toolResult.content === 'string'
          ? toolResult.content
          : JSON.stringify(toolResult.content)
      evidence.receivedResult = content.split('\n')[0]
      evidence.continuation = true
      return reply(res, body, { type: 'text', text: completed })
    }
    if (hasTool) {
      for (let i = 0; i < 125 && !breakId; i++) await delay(100)
      assert.ok(breakId, 'No active delegated break for this real terminal.')
      return reply(res, body, {
        type: 'tool_use',
        id: tool,
        name: 'AskUserQuestion',
        input: { questions: [card] },
      })
    }
    return reply(res, body, { type: 'text', text: 'Local fixture' })
  } catch (err) {
    evidence.error = String(err)
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(
      '{"type":"error","error":{"type":"api_error","message":"Local acceptance fixture failed."}}',
    )
  }
})
server.on('connect', (_req, socket) =>
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'),
)
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = 'http://127.0.0.1:' + server.address().port
const driver = fileURLToPath(new URL('./qa-claude-pty.py', import.meta.url))
const terminal = spawn(
  '/usr/bin/python3',
  [driver, run, claude, sessionId, address, fakeKey],
  { stdio: ['ignore', 'ignore', 'inherit'] },
)
// Observe startup errors immediately. ChildProcess emits close even when its executable cannot launch.
let launchError
terminal.once('error', (error) => {
  launchError = error
})
const terminalEnded = new Promise((done) =>
  terminal.once('close', (...result) => done(result)),
)
try {
  await once(terminal, 'spawn')
  const transcriptFolder = join(config, 'projects')
  const until = Date.now() + 55_000
  while (
    Date.now() < until &&
    !evidence.transcriptCompleted &&
    !evidence.error &&
    terminal.exitCode === null &&
    terminal.signalCode === null &&
    !launchError
  ) {
    if (evidence.continuation) {
      const paths = await readdir(transcriptFolder, { recursive: true }).catch(
        () => [],
      )
      const transcript = paths.find((path) =>
        path.endsWith(sessionId + '.jsonl'),
      )
      if (transcript) {
        const raw = await readFile(join(transcriptFolder, transcript), 'utf8')
        const rows = raw
          .trim()
          .split('\n')
          .flatMap((line) => {
            try {
              return [JSON.parse(line)]
            } catch {
              return []
            }
          })
        evidence.transcriptCompleted = rows.some(
          (row) =>
            row.sessionId === sessionId &&
            row.type === 'assistant' &&
            row.message?.content?.some(
              (block) => block.type === 'text' && block.text === completed,
            ),
        )
      }
    }
    if (!evidence.transcriptCompleted) await delay(200)
  }
  const state = await requestGateway(directory, { op: 'status' })
  evidence.observed = state.supervision.sessions
  evidence.breakId = breakId
  for (const file of await readdir(join(config, 'sessions')).catch(() => [])) {
    if (!file.endsWith('.json')) continue
    const registered = JSON.parse(
      await readFile(join(config, 'sessions', file), 'utf8'),
    )
    if (registered.sessionId !== sessionId) continue
    evidence.terminal = {
      pid: registered.pid,
      kind: registered.kind,
      entrypoint: registered.entrypoint,
      tty: execFileSync(
        '/bin/ps',
        ['-p', String(registered.pid), '-o', 'tty='],
        { encoding: 'utf8' },
      ).trim(),
    }
  }
  evidence.review = await requestReview(directory, breakId)
  assert.ok(
    evidence.capturedTerminal &&
      evidence.judged &&
      evidence.continuation &&
      evidence.transcriptCompleted,
    JSON.stringify(evidence),
  )
  assert.ok(
    evidence.review.some(
      (row) =>
        row.sessionId === sessionId &&
        row.questionId === tool &&
        row.outcome === 'sent',
    ),
  )
  console.log('Real Claude session completed with the delegated answer.')
} finally {
  try {
    await writeFile(
      join(run, 'evidence.json'),
      JSON.stringify(evidence, null, 2) + '\n',
      { mode: 0o600 },
    )
  } finally {
    try {
      await writeFile(join(run, 'stop'), '').catch(() =>
        terminal.kill('SIGTERM'),
      )
      const waitForExit = (ms) =>
        Promise.race([terminalEnded, delay(ms, null, { ref: false })])
      let exited = await waitForExit(8000)
      if (!exited) {
        terminal.kill('SIGTERM')
        exited = await waitForExit(5000)
      }
      if (!exited) {
        terminal.kill('SIGKILL')
        exited = await waitForExit(2000)
      }
      if (!launchError)
        assert.equal(exited?.[0], 0, 'The isolated PTY did not exit cleanly.')
    } finally {
      try {
        const closed = new Promise((done) => server.close(done))
        server.closeAllConnections()
        await closed
      } finally {
        await stop()
      }
    }
  }
}
