import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  assert.equal(active.hooks.PreToolUse[1].matcher, 'AskUserQuestion')
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
