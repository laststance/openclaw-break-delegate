import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { startService } from '../dist/service.js'
import { requestGateway } from '../dist/ipc.js'
import { PreferenceStore } from '../dist/preferences/index.js'

for (const change of [
  'task instruction',
  'incomplete session prompt',
  'incomplete terminal prompt',
]) {
  test(
    `a new ${change} prevents a prepared answer from reaching the original Claude question`,
    { timeout: 10000 },
    async (t) => {
      // Arrange
      const directory = await mkdtemp(join(tmpdir(), 'bd-final-consent-'))
      t.after(() => rm(directory, { recursive: true, force: true }))
      const cwd = join(directory, 'repo')
      await mkdir(cwd)
      execFileSync('git', ['init', '-q', cwd])
      let now = Date.now()
      const card = {
        question: 'How should we handle an unrelated bug?',
        options: [
          { label: 'Fix in this PR' },
          { label: 'Open a separate issue' },
        ],
      }
      const db = new DatabaseSync(join(directory, 'state.sqlite'))
      const training = new PreferenceStore(db)
      for (let i = 0; i < 28; i++) {
        const at = now - 86400000 + i * 1000
        training.recordHumanSelection({
          source: 'claude',
          sessionId: 'past',
          toolUseId: 'q-' + i,
          cwd,
          card,
          label: 'Fix in this PR',
          askedAt: at,
          answeredAt: at + 1,
        })
      }
      training.replay()
      db.close()
      const invited = Promise.withResolvers()
      const authorized = async () => ({ status: 'authorized' })
      let act
      const stop = await startService({
        directory,
        roots: {},
        now: () => now,
        judge: async () => true,
        log() {},
        tickMs: 60000,
        workload: { threshold: 4 },
        nativeFactory(handler) {
          act = handler
          return {
            status: authorized,
            authorize: authorized,
            active: authorized,
            clear: authorized,
            summary: authorized,
            close() {},
            async invite(id) {
              invited.resolve(id)
              return authorized()
            },
          }
        },
        async poll(coordinator) {
          coordinator.observe({
            provider: 'claude',
            source: 'hook',
            sessionId: 'current',
            incarnation: 'terminal',
            status: 'running',
            canDelegate: true,
            newSession: true,
          })
          coordinator.humanReply({
            provider: 'claude',
            sessionId: 'current',
            responseId: 'earlier',
          })
        },
      })
      t.after(stop)
      const rpc = (request) => requestGateway(directory, request)
      await act({ kind: 'start', id: await invited.promise })
      now += 10
      const claimed = await rpc({
        op: 'hook',
        event: 'PreToolUse',
        sessionId: 'current',
        incarnation: 'terminal',
        questionId: 'new-card',
        cwd,
        toolName: 'AskUserQuestion',
        cards: [card],
      })
      assert.equal(claimed.answers[card.question], 'Fix in this PR')
      assert.equal(
        await rpc({ op: 'can-deliver', receipt: claimed.receipt }),
        true,
      )

      // Act
      if (change === 'task instruction') {
        // History can record a new user instruction without changing the terminal roster or open card.
        const updates = new DatabaseSync(join(directory, 'state.sqlite'))
        new PreferenceStore(updates).recordInstruction(
          'claude',
          'current',
          'Ask for my approval.',
          now,
        )
        updates.close()
      } else {
        await rpc({
          op: 'incomplete-instruction',
          incarnation: 'terminal',
          ...(change === 'incomplete session prompt'
            ? { sessionId: 'current' }
            : {}),
        })
      }
      const authorizedAfterChange = await rpc({
        op: 'can-deliver',
        receipt: claimed.receipt,
      })

      // Assert
      assert.equal(authorizedAfterChange, false)
      assert.equal(
        await rpc({ op: 'undelivered', receipt: claimed.receipt }),
        true,
      )
    },
  )
}
