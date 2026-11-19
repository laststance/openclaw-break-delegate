import { strict as assert } from 'node:assert'
import childProcess, { spawn, spawnSync } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createNativeBreakUi,
  nativeHelperExecutable,
} from '../../dist/native/index.js'
import { claudeTerminal } from '../../dist/terminal.js'

const fixture = fileURLToPath(new URL('./pipe-fixture.mjs', import.meta.url))
const repo = fileURLToPath(new URL('../../', import.meta.url))

test(
  'the packaged process classifier reads exact argv boundaries from live Darwin Node launchers',
  {
    skip: process.platform !== 'darwin' || !existsSync(nativeHelperExecutable),
    timeout: 10_000,
  },
  async (t) => {
    // Arrange
    const directory = mkdtempSync(join(tmpdir(), 'break-delegate-argv-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const install = join(directory, 'node_modules/@anthropic-ai/claude-code')
    mkdirSync(install, { recursive: true })
    const cli = join(install, 'cli.js')
    writeFileSync(cli, 'process.on("message",()=>{});process.send("ready")')
    const launch = (arg) => {
      const child = spawn(process.execPath, [cli, arg], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      })
      t.after(() => child.kill())
      return child
    }
    const interactive = launch('Explain how --print works')
    const headless = launch('--print')
    await Promise.all([once(interactive, 'message'), once(headless, 'message')])

    // Act
    const classify = (pid) =>
      spawnSync(
        nativeHelperExecutable,
        ['--classify-claude-process', String(pid)],
        { encoding: 'utf8' },
      )
    const actual = [
      classify(interactive.pid),
      classify(headless.pid),
      classify(-1),
    ]

    // Assert
    assert.deepEqual(
      actual.map((r) => [r.status, r.stdout, r.stderr]),
      [
        [0, 'interactive\n', ''],
        [0, 'headless\n', ''],
        [0, 'unknown\n', ''],
      ],
    )
  },
)

test(
  'late receipts silently refresh only their returned review while later break actions remain available',
  { timeout: 5000 },
  async (t) => {
    // Arrange
    const { ui, commands, children, actions, events } = gateway(t)
    const waiting = {
      answered: [],
      held: [{ question: 'Which option?', reason: 'Awaiting delivery' }],
    }
    const sent = {
      answered: [{ question: 'Which option?', answer: 'First' }],
      held: [],
    }
    await ui.summary('first-break', waiting)
    await ui.active('later-break', Date.now() + 900_000)

    // Act
    await ui.refreshSummary('first-break', sent)
    await ui.refreshSummary('unknown-break', waiting)
    const accepted = once(events, 'action')
    children[0].send({
      frames: [{ type: 'action', id: 'later-break', kind: 'return' }],
    })
    await accepted
    await ui.summary('later-break', waiting)
    while (commands.length < 4) await once(events, 'command')
    await ui.refreshSummary('first-break', waiting)
    const barrier = ui.status()
    while (commands.at(-1)?.kind !== 'status') await once(events, 'command')
    await barrier

    // Assert
    assert.deepEqual(
      commands.map(({ kind, id }) => [kind, id]),
      [
        ['summary', 'first-break'],
        ['active', 'later-break'],
        ['refreshSummary', 'first-break'],
        ['summary', 'later-break'],
        ['status', undefined],
      ],
    )
    assert.equal(commands[2].review.answered[0].answer, 'First')
    assert.deepEqual(actions, [{ kind: 'return', id: 'later-break' }])
  },
)

test(
  'reconnecting after a settled receipt restores the corrected review without a second banner',
  { timeout: 5000 },
  async (t) => {
    // Arrange
    const { ui, children, events } = gateway(t, { retryMs: 10 })
    await Promise.all([
      once(events, 'command'),
      ui.summary('returned', { answered: [], held: [] }),
    ])
    await Promise.all([
      once(events, 'command'),
      ui.refreshSummary('returned', {
        answered: [],
        held: [{ question: 'Which option?', reason: 'Delivery failed' }],
      }),
    ])
    const reconnected = once(events, 'command')

    // Act
    children[0].kill('SIGKILL')
    const [restored] = await reconnected

    // Assert
    assert.equal(restored.kind, 'summary')
    assert.equal(restored.silent, true)
    assert.equal(restored.review.held[0].reason, 'Delivery failed')
  },
)

/** Runs an isolated helper process and records both ends of its pipe for assertions. */
function gateway(t, { onChoice, beforeLaunch, ...options } = {}) {
  const children = []
  const commands = []
  const profileKeys = []
  const actions = []
  const events = new EventEmitter()
  const ui = createNativeBreakUi(
    (action) => {
      actions.push(action)
      events.emit('action', action)
      return onChoice?.(action)
    },
    {
      ...options,
      launch(profileKey) {
        profileKeys.push(profileKey)
        beforeLaunch?.(profileKeys.length)
        const child = spawn(process.execPath, [fixture], {
          stdio: ['pipe', 'pipe', 'ignore', 'ipc'],
        })
        children.push(child)
        child.on('message', (message) => {
          if (message.command) {
            commands.push(message.command)
            events.emit('command', message.command)
          } else {
            events.emit('written')
          }
        })
        return child
      },
    },
  )
  t.after(() => ui.close())
  return { children, commands, actions, events, ui, profileKeys }
}

test(
  'an outstanding invitation reconnects after a failed relaunch without another Gateway request',
  { timeout: 5000 },
  async (t) => {
    // Arrange
    const attempts = []
    const { ui, children, events } = gateway(t, {
      retryMs: 10,
      beforeLaunch(attempt) {
        attempts.push(attempt)
        if (attempt === 2) throw new Error('Temporary launch failure.')
      },
    })
    await Promise.all([once(events, 'command'), ui.invite('still-wanted')])
    const restored = once(events, 'command')

    // Act
    children[0].kill('SIGKILL')
    const [command] = await restored

    // Assert
    assert.deepEqual(attempts, [1, 2, 3])
    assert.deepEqual([command.kind, command.id], ['invite', 'still-wanted'])
  },
)

test(
  'after saturation the helper receives the latest active break and corrected retained review',
  { timeout: 5000 },
  async (t) => {
    // Arrange
    const { ui, commands, events } = gateway(t)
    const before = { answered: [], held: [] }
    const after = {
      answered: [{ question: 'Which?', answer: 'Latest' }],
      held: [],
    }
    await Promise.all([once(events, 'command'), ui.summary('returned', before)])
    const full = Array.from({ length: 32 }, () => ui.status())

    // Act
    const obsolete = ui.invite('obsolete')
    const active = ui.active('current', Date.now() + 60_000)
    const first = ui.refreshSummary('returned', before)
    const last = ui.refreshSummary('returned', after)
    await Promise.all([...full, active, first, last])
    const checked = ui.status()
    while (commands.filter((command) => command.kind === 'status').length < 33)
      await once(events, 'command')
    await checked

    // Assert
    assert.equal((await obsolete).status, 'unavailable')
    assert.deepEqual(
      commands
        .filter((command) => command.kind !== 'status')
        .map(({ kind, id }) => [kind, id]),
      [
        ['summary', 'returned'],
        ['refreshSummary', 'returned'],
        ['active', 'current'],
      ],
    )
    assert.equal(
      commands.find((command) => command.kind === 'refreshSummary').review
        .answered[0].answer,
      'Latest',
    )
  },
)

test(
  'clearing or closing a missing helper cancels scheduled invitation retries',
  { timeout: 5000 },
  async (t) => {
    // Arrange
    let attempts = 0
    const ui = createNativeBreakUi(() => {}, {
      retryMs: 5,
      launch() {
        attempts++
        throw new Error('Temporary launch failure.')
      },
    })
    t.after(() => ui.close())

    // Act
    await ui.invite('cleared')
    await ui.clear()
    await new Promise((resolve) => setTimeout(resolve, 30))
    const afterClear = attempts
    await ui.invite('closed')
    ui.close()
    await new Promise((resolve) => setTimeout(resolve, 30))

    // Assert
    assert.equal(afterClear, 2)
    assert.equal(attempts, 3)
  },
)

test(
  'closing a saturated helper settles the outstanding surface without presenting it',
  { timeout: 5000 },
  async (t) => {
    // Arrange
    const { ui, children, commands, events } = gateway(t)
    await Promise.all([once(events, 'command'), ui.status()])
    const full = Array.from({ length: 32 }, () => ui.status())
    const surface = ui.invite('cancelled')
    const stopped = once(children[0], 'close')

    // Act
    ui.close()
    await Promise.all([...full, stopped])

    // Assert
    assert.equal((await surface).status, 'unavailable')
    assert.equal(
      commands.some((command) => command.id === 'cancelled'),
      false,
    )
  },
)

test(
  'a queued original summary includes its latest receipt in the first banner',
  { timeout: 5000 },
  async (t) => {
    // Arrange
    const { ui, commands, events } = gateway(t)
    const full = Array.from({ length: 32 }, () => ui.status())

    // Act
    const original = ui.summary('returned', { answered: [], held: [] })
    const update = ui.refreshSummary('returned', {
      answered: [{ question: 'Which?', answer: 'Selected' }],
      held: [],
    })
    await Promise.all([...full, original, update])
    const checked = ui.status()
    while (commands.filter((command) => command.kind === 'status').length < 33)
      await once(events, 'command')
    await checked

    // Assert
    const surfaces = commands.filter((command) => command.kind !== 'status')
    assert.equal(surfaces.length, 1)
    assert.equal(surfaces[0].kind, 'summary')
    assert.equal(surfaces[0].silent, undefined)
    assert.equal(surfaces[0].review.answered[0].answer, 'Selected')
  },
)

test(
  'rejected consent requires a second explicit action on a restored invitation',
  { timeout: 5000 },
  async (t) => {
    // Arrange
    const { ui, children, actions, events } = gateway(t, {
      onChoice: (action) =>
        action.kind === 'start' ? 'restore-invitation' : undefined,
    })
    await Promise.all([once(events, 'command'), ui.invite('still-open')])
    const restored = once(events, 'command')

    // Act
    children[0].send({
      frames: [{ type: 'action', kind: 'start', id: 'still-open' }],
    })
    const [invitation] = await restored
    const second = once(events, 'action')
    children[0].send({
      frames: [{ type: 'action', kind: 'dismiss', id: 'still-open' }],
    })
    await second

    // Assert
    assert.deepEqual([invitation.kind, invitation.id], ['invite', 'still-open'])
    assert.deepEqual(actions, [
      { kind: 'start', id: 'still-open' },
      { kind: 'dismiss', id: 'still-open' },
    ])
  },
)

test(
  'a full status queue still withdraws the native surface and coalesces duplicate clears',
  { timeout: 5000 },
  async (t) => {
    // Arrange
    const { ui, commands, events } = gateway(t)
    await ui.invite('visible-invite')
    const full = Array.from({ length: 32 }, () => ui.status())
    const hidden = ui.active('never-shown', Date.now() + 60000)

    // Act
    const busy = ui.status()
    const clears = Promise.all([ui.clear(), ui.clear()])
    const ordinary = await Promise.all(full)
    const withdrawn = await clears
    while (!commands.some((command) => command.kind === 'clear'))
      await once(events, 'command')

    // Assert
    assert.deepEqual(await busy, {
      status: 'unavailable',
      detail: 'The macOS helper is busy.',
    })
    assert.equal(
      ordinary.every((result) => result.status === 'not-determined'),
      true,
    )
    assert.deepEqual(withdrawn, [
      { status: 'authorized' },
      { status: 'authorized' },
    ])
    assert.equal((await hidden).status, 'unavailable')
    assert.equal(
      commands.some((command) => command.id === 'never-shown'),
      false,
    )
    assert.equal(
      commands.filter((command) => command.kind === 'clear').length,
      1,
    )
  },
)

test('the hook recognizes a prerelease Claude terminal after native mode and TTY checks', (t) => {
  // Arrange
  let mode = 'interactive'
  let tty = 'ttys001'
  const checks = []
  const probe = t.mock.method(
    childProcess,
    'execFileSync',
    (path, args, options) => {
      if (path === '/bin/ps') {
        assert.deepEqual(options.env, { TZ: 'UTC0', LC_ALL: 'C' })
        return (
          '1 ' +
          tty +
          ' Fri Nov 20 14:12:00 2026 /Users/example/.local/share/claude/versions/2.1.328-beta.1'
        )
      }
      assert.equal(path, nativeHelperExecutable)
      checks.push(args)
      return mode
    },
  )
  syncBuiltinESMExports()
  t.after(() => {
    probe.mock.restore()
    syncBuiltinESMExports()
  })

  // Act
  const active = claudeTerminal()
  mode = 'headless'
  const printed = claudeTerminal()
  mode = 'interactive'
  tty = '??'
  const detached = claudeTerminal()

  // Assert
  assert.equal(active, process.ppid + ':1795183920')
  assert.equal(printed, undefined)
  assert.equal(detached, undefined)
  assert.deepEqual(
    checks,
    Array.from({ length: 3 }, () => [
      '--classify-claude-process',
      String(process.ppid),
    ]),
  )
})

test('independent gateways launch their helpers with distinct stable profile scopes', async (t) => {
  // Arrange
  const alpha = gateway(t, { profileDirectory: '/tmp/break-delegate/./alpha' })
  const restored = gateway(t, { profileDirectory: '/tmp/break-delegate/alpha' })
  const beta = gateway(t, { profileDirectory: '/tmp/break-delegate/beta' })

  // Act
  await Promise.all([alpha.ui.status(), restored.ui.status(), beta.ui.status()])

  // Assert
  assert.deepEqual(alpha.profileKeys, [
    'fc0815c50847b6ee333af0a776feb589c9cb85ca89e1f08b01e59ba30ed48fcf',
  ])
  assert.deepEqual(restored.profileKeys, [
    'fc0815c50847b6ee333af0a776feb589c9cb85ca89e1f08b01e59ba30ed48fcf',
  ])
  assert.deepEqual(beta.profileKeys, [
    'e8c5cce4a400a85175ad6201c66dacdcc2ea6bb015dfd7b48ede40d8ab069cef',
  ])
})

test(
  "only the current invitation's first explicit choice reaches the gateway",
  { timeout: 5000 },
  async (t) => {
    // Arrange
    const { ui, children, actions, events } = gateway(t)
    await ui.invite('old-invite')
    await ui.invite('current-invite')
    const choice = once(events, 'action')

    // Act
    children[0].send({
      frames: [
        { type: 'action', id: 'old-invite', kind: 'start' },
        { type: 'action', id: 'current-invite', kind: 'return' },
        { type: 'action', id: 'current-invite', kind: 'snooze' },
        { type: 'action', id: 'current-invite', kind: 'start' },
      ],
    })
    await choice
    await ui.status()

    // Assert
    assert.deepEqual(actions, [{ id: 'current-invite', kind: 'snooze' }])
  },
)

test(
  'only the current break can return and clearing the native surface disables previous choices',
  { timeout: 5000 },
  async (t) => {
    // Arrange
    const { ui, children, actions, events } = gateway(t)
    await ui.invite('cancelled-invite')
    await ui.clear()
    await ui.active('current-break', Date.now() + 900_000)
    const choice = once(events, 'action')

    // Act
    children[0].send({
      frames: [
        { type: 'action', id: 'cancelled-invite', kind: 'start' },
        { type: 'action', id: 'other-break', kind: 'return' },
        { type: 'action', id: 'current-break', kind: 'start' },
        { type: 'action', id: 'current-break', kind: 'return' },
      ],
    })
    await choice

    // Assert
    assert.deepEqual(actions, [{ id: 'current-break', kind: 'return' }])
    assert.equal((await ui.active('expired-break', 1)).status, 'unavailable')
  },
)

test(
  'status distinguishes missing consent from denied consent and never prompts on inspection',
  { timeout: 5000 },
  async (t) => {
    // Arrange
    const { ui, commands, events } = gateway(t)

    // Act
    const [, before] = await Promise.all([once(events, 'command'), ui.status()])
    const [, after] = await Promise.all([
      once(events, 'command'),
      ui.authorize(),
    ])

    // Assert
    assert.deepEqual(before, { status: 'not-determined' })
    assert.deepEqual(after, { status: 'denied' })
    assert.deepEqual(
      commands.map((command) => command.kind),
      ['status', 'authorize'],
    )
  },
)

test(
  'large private reviews preserve both section totals while bounding the native payload',
  { timeout: 5000 },
  async (t) => {
    // Arrange
    const { ui, events } = gateway(t)
    const answered = Array.from({ length: 100 }, () => ({
      question: '🍎'.repeat(2500),
      answer: 'Selected option A',
    }))
    const held = Array.from({ length: 80 }, () => ({
      question: 'May I deploy?',
      reason: 'Awaiting owner approval',
    }))

    // Act
    const [[frame]] = await Promise.all([
      once(events, 'command'),
      ui.summary('break-review', { answered, held }),
    ])

    // Assert
    assert.equal(frame.review.answeredTotal, 100)
    assert.equal(frame.review.heldTotal, 80)
    assert.ok(
      frame.review.answered.length > 0 && frame.review.answered.length < 40,
    )
    assert.equal(frame.review.held.length, 40)
    assert.ok(frame.review.answered[0].question.endsWith('…'))
    assert.equal(frame.review.answered[0].answer, 'Selected option A')
    assert.equal(frame.review.held[0].reason, 'Awaiting owner approval')
    assert.ok(Buffer.byteLength(JSON.stringify(frame)) < 65_536)
  },
)

test(
  'a restarted helper restores the current break and closes its pipe when the gateway stops',
  { timeout: 5000 },
  async (t) => {
    // Arrange
    const { ui, children, events } = gateway(t, { retryMs: 10 })
    const deadline = Date.now() + 900_000
    await Promise.all([
      once(events, 'command'),
      ui.active('interrupted-break', deadline),
    ])
    const restored = once(events, 'command')

    // Act
    children[0].kill('SIGKILL')
    const [command] = await restored
    const stopped = once(children[1], 'exit')
    ui.close()
    await stopped

    // Assert
    assert.deepEqual(
      { kind: command.kind, id: command.id, endsAt: command.endsAt },
      { kind: 'active', id: 'interrupted-break', endsAt: deadline },
    )
    assert.equal(children.length, 2)
    assert.equal((await ui.status()).status, 'unavailable')
  },
)

test(
  'a missing helper or unresponsive notification service reports unavailable',
  { timeout: 5000 },
  async (t) => {
    // Arrange
    const absent = createNativeBreakUi(() => {}, {
      launch() {
        throw new Error('No graphical login.')
      },
    })
    t.after(() => absent.close())
    const { ui } = gateway(t, { timeoutMs: 150 })

    // Act
    const missing = await absent.invite('mac-offline')
    const stalled = await ui.invite('no-response')
    ui.close()

    // Assert
    assert.deepEqual(missing, {
      status: 'unavailable',
      detail: 'No graphical login.',
    })
    assert.equal(stalled.status, 'unavailable')
    assert.match(stalled.detail, /Timed out/)
  },
)

test(
  'Apple notification requests correlate consent, dismissal and return without exposing review text',
  {
    skip: process.platform !== 'darwin',
    timeout: 60_000,
  },
  (t) => {
    // Arrange
    const directory = mkdtempSync(join(tmpdir(), 'break-delegate-native-'))
    const check = join(directory, 'check')
    t.after(() => rmSync(directory, { recursive: true, force: true }))

    // Act
    const build = spawnSync(
      'xcrun',
      [
        'swiftc',
        '-swift-version',
        '5',
        'native/macos/Surface.swift',
        'native/macos/ReviewWindow.swift',
        'native/macos/ProcessClassifier.swift',
        'test/native/SurfaceChecks.swift',
        '-o',
        check,
      ],
      { cwd: repo, encoding: 'utf8' },
    )
    assert.equal(build.status, 0, build.stderr)
    const result = spawnSync(check, [], {
      encoding: 'utf8',
      env: { ...process.env, CFFIXED_USER_HOME: directory },
    })

    // Assert
    assert.equal(result.status, 0, result.stderr)
    assert.match(
      result.stdout,
      /Native invitation, snooze, dismissal, early return, review and stale response checks passed/,
    )
  },
)

test(
  'the signed helper reports an unavailable desktop without launching a window or asking for consent',
  {
    skip:
      process.platform !== 'darwin' ||
      !existsSync(join(repo, 'native/generated/BreakDelegate.app')),
  },
  () => {
    // Arrange
    const executable = join(
      repo,
      'native/generated/BreakDelegate.app/Contents/MacOS/BreakDelegate',
    )
    const noDesktop =
      '(version 1)(deny default)(allow file-read*)(allow process*)(allow sysctl-read)'

    // Act — the actual program cannot reach WindowServer, Launch Services or Notification Center.
    const result = spawnSync(
      '/usr/bin/sandbox-exec',
      ['-p', noDesktop, executable, '--bridge', 'a'.repeat(64)],
      { encoding: 'utf8', timeout: 5000 },
    )

    // Assert
    assert.equal(result.status, 69, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      type: 'offline',
      detail:
        'Run the packaged helper from the gateway in your logged-in macOS desktop session.',
    })
  },
)
