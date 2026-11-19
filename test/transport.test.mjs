import test from 'node:test'
import childProcess, { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { createConnection } from 'node:net'
import { syncBuiltinESMExports } from 'node:module'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import fs, {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
  symlink,
  mkdir,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureHooks } from '../dist/settings.js'
import {
  boundedGatewayStatus,
  listenGateway,
  requestGateway,
} from '../dist/ipc.js'
import { nativeHelperExecutable } from '../dist/native/index.js'

const exchangeHelper = process.env.BREAK_DELEGATE_NATIVE_OUTPUT
  ? join(
      process.env.BREAK_DELEGATE_NATIVE_OUTPUT,
      'BreakDelegate.app/Contents/MacOS/BreakDelegate',
    )
  : nativeHelperExecutable

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

test(
  'a long profile has one reachable owner across processes with different temporary directories',
  { timeout: 5000 },
  async (t) => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), 'bd-owner-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const profile = join(root, 'long-profile-'.repeat(10))
    const otherTmp = join(root, 'other-tmp')
    await mkdir(otherTmp)
    const stop = await listenGateway(profile, async () => 'original owner')
    t.after(stop)
    const moduleUrl = new URL('../dist/ipc.js', import.meta.url).href
    const check = [
      'const {listenGateway,requestGateway}=await import(process.argv[1])',
      'let blocked=false',
      'try { const stop=await listenGateway(process.argv[2],async()=>"second"); await stop() } catch(e) { blocked=e.code==="EADDRINUSE" }',
      'const value=await requestGateway(process.argv[2],{op:"ping"})',
      'process.stdout.write(JSON.stringify({blocked,value}))',
    ].join('\n')

    // Act
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', check, moduleUrl, profile],
      { env: { ...process.env, TMPDIR: otherTmp } },
    )

    // Assert
    assert.deepEqual(JSON.parse(stdout), {
      blocked: true,
      value: 'original owner',
    })
    assert.equal((await lstat(join(profile, 'owner.sqlite'))).isFile(), true)
  },
)

test(
  'a socket permission failure releases the listener and profile for an immediate retry',
  { timeout: 5000 },
  async (t) => {
    // Arrange
    const profile = await mkdtemp('/tmp/bd-retry-')
    t.after(() => rm(profile, { recursive: true, force: true }))
    const address = join(await realpath(profile), 'gateway.sock')
    const originalChmod = fs.chmod
    let clientClosed
    const permission = t.mock.method(fs, 'chmod', async (path, mode) => {
      if (path === address) {
        const client = createConnection(address)
        clientClosed = new Promise((done) => client.once('close', done))
        client.on('error', () => {})
        await once(client, 'connect')
        throw Object.assign(new Error('Cannot change test socket mode.'), {
          code: 'EACCES',
        })
      }
      return originalChmod(path, mode)
    })
    syncBuiltinESMExports()

    // Act
    try {
      await assert.rejects(
        listenGateway(profile, async () => 'first'),
        { code: 'EACCES' },
      )
      await clientClosed
      await assert.rejects(lstat(address), { code: 'ENOENT' })
    } finally {
      permission.mock.restore()
      syncBuiltinESMExports()
    }
    const stop = await listenGateway(profile, async () => 'restarted')
    t.after(stop)

    // Assert
    assert.equal(await requestGateway(profile, { op: 'ping' }), 'restarted')
  },
)

test(
  'hook data is only serialized and delivered after the profile credential authenticates the Gateway',
  { timeout: 5000 },
  async (t) => {
    // Arrange
    const profile = await mkdtemp('/tmp/bd-auth-')
    t.after(() => rm(profile, { recursive: true, force: true }))
    const received = []
    const stop = await listenGateway(profile, async (request) => {
      received.push(request.payload)
      return 'received'
    })
    t.after(stop)
    const keyFile = join(profile, 'gateway.key')
    const original = await readFile(keyFile)
    let serialized = 0
    const request = {
      op: 'hook',
      get payload() {
        serialized++
        return 'synthetic test event'
      },
    }

    // Act
    await writeFile(keyFile, randomBytes(32))
    await assert.rejects(requestGateway(profile, request))
    await writeFile(keyFile, original)
    await chmod(keyFile, 0o644)
    await assert.rejects(
      requestGateway(profile, request),
      /private profile file/,
    )
    await chmod(keyFile, 0o600)
    await chmod(profile, 0o755)
    await assert.rejects(
      requestGateway(profile, request),
      /socket directory must be private/,
    )
    await chmod(profile, 0o700)
    const whileUnavailable = { serialized, received: received.length }
    const result = await requestGateway(profile, request)

    // Assert
    assert.deepEqual(whileUnavailable, { serialized: 0, received: 0 })
    assert.equal(result, 'received')
    assert.equal(serialized, 1)
    assert.deepEqual(received, ['synthetic test event'])
    assert.equal(
      (await lstat(join(profile, 'gateway.sock'))).mode & 0o777,
      0o600,
    )
  },
)

test('hook removal recognizes parent aliases and previously installed quoted paths to the same profile', async (t) => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), 'bd-hook-alias-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const physical = join(await realpath(root), 'physical')
  const alias = join(root, "parent's alias")
  await mkdir(physical)
  await symlink(physical, alias)
  const realProfile = join(physical, 'state')
  const aliasProfile = join(alias, 'state')
  const settings = join(root, 'settings.json')
  await mkdir(realProfile)
  await configureHooks('install', realProfile, settings)

  // Act
  const byAlias = await configureHooks('remove', aliasProfile, settings)
  await configureHooks('install', realProfile, settings)
  // Previous versions stored the caller's literal, shell-quoted state directory.
  const legacy = JSON.parse(await readFile(settings, 'utf8'))
  for (const groups of Object.values(legacy.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks)
        hook.command = hook.command.replace(
          realProfile,
          aliasProfile.replaceAll("'", "'\\''"),
        )
    }
  }
  await writeFile(settings, JSON.stringify(legacy))
  const byPhysical = await configureHooks('remove', realProfile, settings)
  await configureHooks('install', realProfile, settings)
  await rm(realProfile, { recursive: true })
  const afterRemoval = await configureHooks('remove', realProfile, settings)

  // Assert
  assert.deepEqual(
    [byAlias.changed, byPhysical.changed, afterRemoval.changed],
    [true, true, true],
  )
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), {})
})

test('a competing settings save remains active and its displaced revision is recoverable on retry', async (t) => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), 'bd-settings-edit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(await realpath(root), 'settings.json')
  const backupDir = file + '.break-delegate-backups'
  const before = '{"theme":"dark"}'
  const competing = '{"theme":"light","language":"ja"}'
  await writeFile(file, before)
  // This path exercises the portable exchange fallback even when a signed macOS helper is installed.
  const native = t.mock.method(childProcess, 'spawnSync', () => ({
    status: 0,
    stdout: 'unsupported\n',
  }))
  const originalRename = fs.rename
  let injected = false
  const writer = t.mock.method(fs, 'rename', async (from, to) => {
    if (from === file && !injected) {
      injected = true
      await writeFile(file, competing)
    }
    return originalRename(from, to)
  })
  syncBuiltinESMExports()

  // Act
  try {
    await assert.rejects(
      configureHooks('install', root, file),
      /preserved revision/,
    )
  } finally {
    native.mock.restore()
    writer.mock.restore()
    syncBuiltinESMExports()
  }
  const active = await readFile(file, 'utf8')
  const snapshots = await Promise.all(
    (await readdir(backupDir)).map((name) =>
      readFile(join(backupDir, name), 'utf8'),
    ),
  )
  const retried = await configureHooks('install', root, file)

  // Assert
  assert.equal(active, competing)
  assert.ok(snapshots.includes(competing))
  assert.ok(snapshots.some((text) => JSON.parse(text).hooks?.UserPromptSubmit))
  assert.equal(retried.changed, true)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).language, 'ja')
  assert.equal(
    await readFile(join(backupDir, 'previous.json'), 'utf8'),
    competing,
  )
  assert.equal((await lstat(backupDir)).mode & 0o777, 0o700)
})

test(
  'macOS settings conflicts retain the exact displaced edit and leave subsequent saves in place',
  {
    skip: process.platform !== 'darwin',
    timeout: 90_000,
  },
  async (t) => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), 'bd-settings-exchange-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const file = join(root, 'settings.json')
    const backupDir = file + '.break-delegate-backups'
    const second = join(root, 'second.json')
    const competing = '{"theme":"light","language":"ja"}'
    const newest = '{"theme":"system","language":"en"}'
    await writeFile(file, '{"theme":"dark"}')
    await writeFile(second, '{"theme":"dark"}')
    let exchanges = 0
    const run = childProcess.spawnSync
    let candidate = exchangeHelper
    // An older checkout helper ignores unfamiliar commands. Build current source in isolation for this test.
    if (run(candidate, ['--exchange-settings']).status !== 64) {
      const output = join(root, 'helper')
      const build = run(
        '/bin/bash',
        [fileURLToPath(new URL('../native/build-helper.sh', import.meta.url))],
        {
          encoding: 'utf8',
          timeout: 70_000,
          env: {
            ...process.env,
            BREAK_DELEGATE_NATIVE_OUTPUT: output,
            BREAK_DELEGATE_SIGN_IDENTITY: '-',
            BREAK_DELEGATE_REUSE_STAPLED: '0',
          },
        },
      )
      assert.equal(build.status, 0, build.stderr)
      candidate = join(output, 'BreakDelegate.app/Contents/MacOS/BreakDelegate')
    }
    const writer = t.mock.method(
      childProcess,
      'spawnSync',
      (path, args, options) => {
        assert.equal(path, nativeHelperExecutable)
        assert.equal(args[0], '--exchange-settings')
        exchanges++
        // Both editors save before publication. The second editor also saves again immediately afterwards.
        writeFileSync(args[1], competing)
        const result = run(candidate, args, options)
        if (args[1].endsWith('/second.json')) writeFileSync(args[1], newest)
        return result
      },
    )
    syncBuiltinESMExports()

    // Act
    try {
      await assert.rejects(
        configureHooks('install', root, file),
        /preserved revision/,
      )
      await assert.rejects(
        configureHooks('install', root, second),
        /preserved revision/,
      )
    } finally {
      writer.mock.restore()
      syncBuiltinESMExports()
    }
    const snapshots = await Promise.all(
      (await readdir(backupDir)).map(async (name) =>
        JSON.parse(await readFile(join(backupDir, name), 'utf8')),
      ),
    )

    // Assert
    assert.equal(exchanges, 2)
    assert.equal(
      JSON.parse(await readFile(file, 'utf8')).hooks.UserPromptSubmit.length,
      1,
    )
    assert.equal(await readFile(second, 'utf8'), newest)
    assert.deepEqual(snapshots, [{ theme: 'light', language: 'ja' }])
    const secondBackups = second + '.break-delegate-backups'
    const [displaced] = await readdir(secondBackups)
    assert.equal(
      await readFile(join(secondBackups, displaced), 'utf8'),
      competing,
    )
  },
)

test('large Gateway status reports whole session rows and the omitted count within one UTF-8 frame', async (t) => {
  // Arrange
  const profile = await mkdtemp(join(tmpdir(), 'bd-bounded-status-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const sessions = ['first', 'second', 'third', 'fourth'].map((id) => ({
    id,
    detail: '界'.repeat(40_000),
  }))
  const close = await listenGateway(profile, async ({ op }) =>
    op === 'status'
      ? boundedGatewayStatus({
          supervision: { score: 42, sessions },
          native: { status: 'authorized' },
          history: null,
        })
      : 'x'.repeat(256 * 1024),
  )
  t.after(close)

  // Act
  const result = await requestGateway(profile, { op: 'status' })
  await assert.rejects(
    requestGateway(profile, { op: 'oversize' }),
    /could not fit in an IPC frame/,
  )

  // Assert
  assert.deepEqual(
    result.supervision.sessions.map(({ id }) => id),
    ['first', 'second'],
  )
  assert.equal(result.supervision.sessionsOmitted, 2)
  assert.equal(result.supervision.score, 42)
  assert.equal(result.native.status, 'authorized')
  assert.equal(result.supervision.sessions[1].detail.length, 40_000)
  assert.ok(
    Buffer.byteLength(JSON.stringify({ ok: true, value: result }) + '\n') <=
      256 * 1024,
  )
  assert.equal(sessions.length, 4)
})
