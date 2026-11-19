import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runHook } from '../dist/hooks.js'
import { Readable } from 'node:stream'
import { readHookInput } from '../dist/commands.js'
import { listenGateway } from '../dist/ipc.js'

const card = {
  question: 'How should we handle an unrelated bug?',
  options: [{ label: 'Fix in this PR' }, { label: 'Open a separate issue' }],
}

test('an offline status command reports failure when its state directory is named hook', async (t) => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), 'bd-cli-argument-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
  // Act
  const result = spawnSync(
    process.execPath,
    [cli, 'status', '--state-dir', 'hook'],
    { cwd: directory, encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' },
  )
  // Assert
  assert.ifError(result.error)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /offline|unavailable|no such file|ENOENT/i)
})

test('a suspended Claude hook leaves the original choice untouched after the break expires', async (t) => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), 'bd-expiry-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const operations = []
  const close = await listenGateway(directory, async (request) => {
    operations.push(request.op)
    return request.op === 'hook'
      ? {
          answers: { [card.question]: 'Fix in this PR' },
          receipt: 'own-receipt',
          deliverBefore: Date.now() - 10,
        }
      : true
  })
  t.after(close)
  const written = []

  // Act
  await runHook(
    directory,
    {
      hook_event_name: 'PreToolUse',
      session_id: 'a',
      cwd: directory,
      tool_use_id: 'original',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [card] },
    },
    async (value) => written.push(value),
    'pty-A',
  )

  // Assert
  assert.deepEqual(written, [])
  assert.deepEqual(operations, ['hook', 'can-deliver', 'undelivered'])
})

test('Claude leaves the original question open when consent expires during the delivery check', async (t) => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), 'bd-midcheck-expiry-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const opensAt = Date.now()
  let now = opensAt
  t.mock.method(Date, 'now', () => now)
  const requests = [],
    written = []
  const close = await listenGateway(directory, async (request) => {
    requests.push(request.op)
    if (request.op === 'hook')
      return {
        answers: { [card.question]: 'Fix in this PR' },
        receipt: 'private-receipt',
        deliverBefore: opensAt + 100,
      }
    if (request.op === 'can-deliver') now = opensAt + 101
    return true
  })
  t.after(close)
  // Act
  await runHook(
    directory,
    {
      hook_event_name: 'PreToolUse',
      session_id: 'a',
      cwd: directory,
      tool_use_id: 'midcheck',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [card] },
    },
    async (value) => written.push(value),
    'pty',
  )
  // Assert
  assert.deepEqual(requests, ['hook', 'can-deliver', 'undelivered'])
  assert.deepEqual(written, [])
})

test('Claude conveys an incomplete instruction and a qualified answer without copying the private note', async (t) => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), 'bd-qualification-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const observed = []
  const close = await listenGateway(directory, async (value) => {
    observed.push(value)
    return null
  })
  t.after(close)
  const hook = { session_id: 'a', cwd: directory }
  const quiet = async () => {}
  const note = 'Only if the change is fully covered.'

  // Act
  await runHook(
    directory,
    {
      ...hook,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'a'.repeat(17_000) + ' Do not fix that bug.',
    },
    quiet,
    'pty-A',
  )
  await runHook(
    directory,
    {
      ...hook,
      hook_event_name: 'PostToolUse',
      tool_use_id: 'human',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [card] },
      tool_response: {
        answers: { [card.question]: card.options[0].label },
        permissionDecision: { decision: 'accept', source: 'user_temporary' },
        annotations: { [card.question]: { notes: note } },
      },
    },
    quiet,
    'pty-A',
  )

  // Assert
  assert.equal(observed[0].truncated, true)
  assert.equal(observed[0].prompt.length, 16_384)
  assert.deepEqual(observed[1].conditional, [card.question])
  assert.equal(observed[1].human, true)
  assert.equal(JSON.stringify(observed).includes(note), false)
})

test('an interrupted stdin stream sends an incomplete-instruction hold for the submitting process', async (t) => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), 'bd-read-error-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const requests = []
  const close = await listenGateway(directory, async (request) => {
    requests.push(request)
    return true
  })
  t.after(close)
  async function* interruptedInput() {
    yield Buffer.from('{"session_id":')
    throw Error('Closed input stream')
  }

  // Act
  const body = await readHookInput(interruptedInput())
  await runHook(
    directory,
    body,
    async () => {},
    'submitting-terminal',
    'UserPromptSubmit',
  )

  // Assert
  assert.deepEqual(requests, [
    { op: 'incomplete-instruction', incarnation: 'submitting-terminal' },
  ])
})

test('an oversized question pauses and resumes the original card without submitting its private preview', async (t) => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), 'bd-question-overflow-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const requests = [],
    written = []
  const close = await listenGateway(directory, async (request) => {
    requests.push(request)
    return null
  })
  t.after(close)
  const payload = {
    cwd: directory,
    session_id: 'terminal-a',
    tool_name: 'AskUserQuestion',
    tool_use_id: 'original-card',
    tool_input: {
      questions: [
        {
          ...card,
          options: [
            {
              label: 'Fix in this PR',
              preview: 'private-preview'.repeat(24_000),
            },
            card.options[1],
          ],
        },
      ],
    },
  }
  // Act
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const body = await readHookInput(
      Readable.from([
        Buffer.from(JSON.stringify({ ...payload, hook_event_name: event })),
      ]),
    )
    await runHook(
      directory,
      body,
      async (value) => written.push(value),
      'interactive-pty',
      event,
    )
  }
  // Assert
  assert.deepEqual(
    requests.map((r) => [r.event, r.sessionId, r.questionId, r.unsupported]),
    [
      ['PreToolUse', 'terminal-a', 'original-card', true],
      ['PostToolUse', 'terminal-a', 'original-card', true],
    ],
  )
  assert.equal(JSON.stringify(requests).includes('private-preview'), false)
  assert.deepEqual(written, [])
})

test('a rejected delivery check retires an unwritten answer while a failed stdout write retains its receipt', async (t) => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), 'bd-recheck-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const operations = []
  let recheckAvailable = false
  const close = await listenGateway(directory, async ({ op }) => {
    operations.push(op)
    if (op === 'hook')
      return {
        receipt: 'fixture',
        answers: { [card.question]: card.options[0].label },
        deliverBefore: Date.now() + 60_000,
      }
    if (op === 'can-deliver' && !recheckAvailable)
      throw Error('Transient check failure')
    return true
  })
  t.after(close)
  const body = {
    session_id: 'session',
    cwd: directory,
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_use_id: 'q',
    tool_input: { questions: [card] },
  }
  let writes = 0
  const brokenOutput = async () => {
    writes++
    throw Error('Write result unknown')
  }

  // Act
  await runHook(directory, body, brokenOutput, 'terminal')
  recheckAvailable = true
  await runHook(directory, body, brokenOutput, 'terminal')

  // Assert
  assert.equal(writes, 1)
  assert.deepEqual(operations, [
    'hook',
    'can-deliver',
    'undelivered',
    'hook',
    'can-deliver',
  ])
})

test('a 300 KB task routes its instruction hold to the authenticated top-level session after the private prompt', async (t) => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), 'bd-overflow-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const requests = []
  const close = await listenGateway(directory, async (request) => {
    requests.push(request)
    return true
  })
  t.after(close)
  const wire = Buffer.from(
    JSON.stringify({
      prompt:
        'private \\"session_id\\": "quoted-decoy" }{ '.repeat(10_000) +
        ' Do not change the code.',
      nested: [
        {
          session_id: 'nested-decoy',
          hook_event_name: 'Stop',
          agent_id: 'unused',
        },
      ],
      hook_event_name: 'UserPromptSubmit',
      session_id: 'terminal-A',
    }).replace('"terminal-A"', '"terminal-\\u0041"'),
  )
  const parts = []
  for (let i = 0; i < wire.length; i += 47) parts.push(wire.subarray(i, i + 47))

  // Act
  const body = await readHookInput(Readable.from(parts))
  await runHook(
    directory,
    body,
    async () => {},
    'process-A',
    'UserPromptSubmit',
  )

  // Assert
  assert.deepEqual(requests, [
    {
      op: 'incomplete-instruction',
      incarnation: 'process-A',
      sessionId: 'terminal-A',
    },
  ])
  assert.ok(wire.length > 300_000)
  assert.equal(JSON.stringify(body).includes('private'), false)
})

test('malformed or ambiguous oversized JSON protects the process while identified subagent tasks leave the root session alone', async (t) => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), 'bd-unknown-routing-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const requests = []
  const close = await listenGateway(directory, async (request) => {
    requests.push(request)
    return true
  })
  t.after(close)
  const long = 'x'.repeat(310_000)
  const submitted = {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'root',
    prompt: long,
  }
  const inputs = [
    JSON.stringify(submitted).slice(0, -1),
    JSON.stringify(submitted).replace('x"', 'x\\z"'),
    JSON.stringify(submitted).replace(
      '"session_id":',
      '"session_id":"decoy","session_id":',
    ),
    JSON.stringify({ ...submitted, agent_id: 'subagent' }),
  ]

  // Act
  for (const wire of inputs) {
    const body = await readHookInput(Readable.from([wire]))
    await runHook(
      directory,
      body,
      async () => {},
      'same-process',
      'UserPromptSubmit',
    )
  }

  // Assert
  assert.deepEqual(requests, [
    { op: 'incomplete-instruction', incarnation: 'same-process' },
    { op: 'incomplete-instruction', incarnation: 'same-process' },
    { op: 'incomplete-instruction', incarnation: 'same-process' },
  ])
})
