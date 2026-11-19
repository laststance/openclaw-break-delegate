import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  symlink,
  mkdir,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureHooks } from '../dist/settings.js'
import { listenGateway, requestGateway } from '../dist/ipc.js'

test('reinstalling and removing Claude hooks preserves unrelated settings and commands', async (t) => {
  // Arrange
  const tmp = await mkdtemp(join(tmpdir(), 'bd-settings-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const file = join(tmp, 'settings.json')
  const original = {
    theme: 'dark',
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: './house-rule' }],
        },
      ],
    },
  }
  await writeFile(file, JSON.stringify(original))
  // Act
  const first = await configureHooks('install', tmp, file)
  const second = await configureHooks('install', tmp, file)
  const active = JSON.parse(await readFile(file, 'utf8'))
  await configureHooks('remove', tmp, file)
  // Assert
  assert.equal(first.changed, true)
  assert.equal(second.changed, false)
  assert.equal(active.hooks.PreToolUse.length, 2)
  assert.equal(active.hooks.PreToolUse[1].matcher, undefined)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original)
})
test('a second Gateway cannot claim a live profile or intercept its requests', async (t) => {
  // Arrange
  const tmp = await mkdtemp(join(tmpdir(), 'bd-ipc-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const close = await listenGateway(tmp, async () => ({ owner: 'original' }))
  t.after(close)
  // Act
  await assert.rejects(
    listenGateway(tmp, async () => ({ owner: 'replacement' })),
  )
  const state = await requestGateway(tmp, { op: 'ping' })
  // Assert
  assert.deepEqual(state, { owner: 'original' })
})
test('a malformed Claude settings file survives setup untouched', async (t) => {
  // Arrange
  const tmp = await mkdtemp(join(tmpdir(), 'bd-invalid-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const file = join(tmp, 'settings.json')
  await writeFile(file, '{ broken')
  // Act
  await assert.rejects(configureHooks('install', tmp, file))
  // Assert
  assert.equal(await readFile(file, 'utf8'), '{ broken')
})

test('the review command prints all locally held questions across multiple bounded responses', async (t) => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), 'bd-pages-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const body = 'q'.repeat(120_000)
  const cursors = []
  const close = await listenGateway(directory, async (request) => {
    assert.equal(request.op, 'review-page')
    const offset = Number(request.cursor ?? 0)
    if (offset) assert.equal(request.breakId, 'break-1')
    cursors.push(offset)
    return {
      breakId: 'break-1',
      rows: [{ id: offset, at: [30, 10, 20][offset], question: body }],
      nextCursor: offset < 2 ? String(offset + 1) : null,
    }
  })
  t.after(close)
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

  // Act
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [cli, 'review', '--state-dir', directory],
    { maxBuffer: 1_000_000 },
  )

  // Assert
  assert.deepEqual(cursors, [0, 1, 2])
  assert.deepEqual(
    JSON.parse(stdout).map((row) => row.id),
    [1, 2, 0],
  )
  assert.equal(JSON.parse(stdout)[2].question.length, 120000)
})

test("removing hooks from a second profile preserves the profile that owns Claude's settings", async (t) => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), 'bd-ownership-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const settings = join(root, 'claude.json')
  await configureHooks('install', join(root, 'alpha'), settings)
  const original = await readFile(settings, 'utf8')

  // Act
  const removed = await configureHooks('remove', join(root, 'beta'), settings)
  const afterRemove = await readFile(settings, 'utf8')
  await configureHooks('install', join(root, 'beta'), settings)
  const switched = JSON.parse(await readFile(settings, 'utf8'))

  // Assert
  assert.equal(removed.changed, false)
  assert.equal(afterRemove, original)
  assert.equal(switched.hooks.UserPromptSubmit.length, 1)
  assert.equal(
    switched.hooks.UserPromptSubmit[0].hooks[0].command.includes(
      join(root, 'beta'),
    ),
    true,
  )
})

test('aliases to the same parent share one Gateway and one socket', async (t) => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), 'bd-alias-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const real = join(root, 'physical')
  await mkdir(real)
  await symlink(real, join(root, 'alias'))
  const close = await listenGateway(join(real, 'profile'), async () => ({
    owner: 'first',
  }))
  t.after(close)

  // Act
  const aliased = join(root, 'alias', 'profile')
  await assert.rejects(
    listenGateway(aliased, async () => ({ owner: 'second' })),
    { code: 'EADDRINUSE' },
  )
  const owner = await requestGateway(aliased, { op: 'ping' })

  // Assert
  assert.deepEqual(owner, { owner: 'first' })
})

test('the CLI chooses the same named OpenClaw profile as the Gateway', async () => {
  // Arrange
  const env = { ...process.env, OPENCLAW_PROFILE: 'work' }
  delete env.BREAK_DELEGATE_STATE_DIR
  delete env.OPENCLAW_STATE_DIR
  const moduleUrl = new URL('../dist/ipc.js', import.meta.url).href

  // Act
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'const {dataDirectory}=await import(process.argv[1]);console.log(dataDirectory());',
      moduleUrl,
    ],
    { env },
  )

  // Assert
  assert.equal(stdout.trim().endsWith('/.openclaw-work/break-delegate'), true)
})
