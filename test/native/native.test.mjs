import { strict as assert } from 'node:assert'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createNativeBreakUi } from '../../dist/native/index.js'

const fixture = fileURLToPath(new URL('./pipe-fixture.mjs', import.meta.url))
const repo = fileURLToPath(new URL('../../', import.meta.url))

/** Runs an isolated helper process and records both ends of its pipe for assertions. */
function gateway(t, options = {}) {
  const children = []
  const commands = []
  const actions = []
  const events = new EventEmitter()
  const ui = createNativeBreakUi(
    (action) => {
      actions.push(action)
      events.emit('action', action)
    },
    {
      ...options,
      launch() {
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
  return { children, commands, actions, events, ui }
}

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
    const { ui, commands } = gateway(t)

    // Act
    const before = await ui.status()
    const after = await ui.authorize()

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
    const { ui, commands } = gateway(t)
    const answered = Array.from({ length: 100 }, () => ({
      question: '🍎'.repeat(2500),
      answer: 'Selected option A',
    }))
    const held = Array.from({ length: 80 }, () => ({
      question: 'May I deploy?',
      reason: 'Awaiting owner approval',
    }))

    // Act
    await ui.summary('break-review', { answered, held })
    const frame = commands[0]

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
    await ui.active('interrupted-break', deadline)
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
      ['-p', noDesktop, executable, '--bridge'],
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
