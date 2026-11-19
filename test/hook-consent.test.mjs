import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runHook } from '../dist/hooks.js'
import { Readable } from 'node:stream'
import { readHookInput } from '../dist/commands.js'
import { listenGateway } from '../dist/ipc.js'

const card = {
  question: 'How should we handle an unrelated bug?',
  options: [{ label: 'Fix in this PR' }, { label: 'Open a separate issue' }],
}

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
