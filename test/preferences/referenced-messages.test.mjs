import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { PreferenceStore } from '../../dist/preferences/index.js'
import { RolloutDetector } from '../../dist/supervision/codex-rollout.js'

const start = Date.UTC(2026, 3, 1)
const row = (type, payload, ms) => ({
  type,
  payload,
  timestamp: new Date(start + ms).toISOString(),
})
const first =
  'D1 — How should we handle an unrelated bug?\nA) Open a separate issue\nB) Fix in this PR'
const second =
  'D2 — How should we handle an unrelated bug?\nA) Fix in this PR\nB) Open a separate issue'
const agent = (id, message, ms) =>
  row('event_msg', { type: 'agent_message', id, message }, ms)
const completed = (item, ms, extra = {}) =>
  row(
    'event_msg',
    { type: 'item_completed', thread_id: 'root', item, ...extra },
    ms,
  )
const append = (file, ...events) =>
  appendFile(file, events.map((event) => JSON.stringify(event) + '\n').join(''))

for (const envelope of [
  'typed event',
  'completed item',
  'completed item with envelope link',
]) {
  test(
    envelope +
      ' credits the referenced earlier Codex offer once and gives unknown or ambiguous links no workload or standing rule',
    async (t) => {
      // Arrange
      const codex = await mkdtemp(join(tmpdir(), 'codex-linked-reply-'))
      const db = new DatabaseSync(':memory:')
      t.after(async () => {
        db.close()
        await rm(codex, { recursive: true, force: true })
      })
      await mkdir(join(codex, 'sessions'))
      const file = join(codex, 'sessions', 'rollout-links.jsonl')
      const reply = (id, target, text, ms) => {
        if (envelope === 'typed event')
          return row(
            'event_msg',
            {
              type: 'user_message',
              message: text,
              client_id: id,
              prompt_source: 'typed',
              reply_to: target,
            },
            ms,
          )
        const item = {
          type: 'UserMessage',
          id,
          client_id: id,
          content: [{ type: 'text', text }],
        }
        return envelope === 'completed item'
          ? completed({ ...item, reply_to: target }, ms)
          : completed(item, ms, { in_reply_to: target })
      }
      await append(
        file,
        row(
          'session_meta',
          {
            id: 'root',
            source: 'vscode',
            originator: 'codex-tui',
            thread_source: 'user',
            cwd: codex,
            git: {
              repository_url:
                'https://github.com/fixture-org/linked-replies.git',
            },
          },
          0,
        ),
        agent(undefined, first, 10),
        completed(
          {
            type: 'AgentMessage',
            id: 'older',
            content: [{ type: 'Text', text: first }],
          },
          20,
        ),
        agent('newest', second, 100),
      )
      const live = new RolloutDetector(codex)
      await live.read([file])
      await new PreferenceStore(db).importHistory({ codex })

      // Act
      await append(
        file,
        reply('earlier', 'older', 'A', 200),
        envelope === 'typed event'
          ? completed(
              {
                type: 'UserMessage',
                client_id: 'next',
                reply_to: 'newest',
                content: [{ type: 'text', text: 'A' }],
              },
              205,
            )
          : row(
              'event_msg',
              {
                type: 'user_message',
                client_id: 'next',
                reply_to: 'newest',
                prompt_source: 'typed',
                message: 'A',
              },
              205,
            ),
        reply('already-answered', 'older', 'A', 210),
        agent('nearest', 'Should I continue?', 300),
        reply('missing', 'absent', 'Always ask for my approval', 310),
        agent('another', 'Should I try again?', 320),
        reply('missing-yes', 'absent', 'yes', 330),
        agent('same-id', first, 400),
        agent('same-id', second, 440),
        reply('ambiguous', 'same-id', 'Always ask for my approval', 490),
        agent('first-link', 'Proceed with the first task?', 500),
        agent('second-link', 'Proceed with the second task?', 520),
        completed(
          {
            type: 'UserMessage',
            client_id: 'conflict',
            reply_to: 'first-link',
            content: [{ type: 'text', text: 'Always ask for my approval' }],
          },
          540,
          { reply_to: 'second-link' },
        ),
      )
      const store = new PreferenceStore(db)
      const report = await store.importHistory({ codex })
      const witnessed = await live.read([file])
      const reconstructed = await new RolloutDetector(codex).read([file])

      // Assert
      assert.equal(report.observations, 2)
      assert.deepEqual(
        store.humanResponsesSince(0).map((r) => r.responseId),
        ['prompt:earlier', 'prompt:next'],
      )
      assert.deepEqual(
        db
          .prepare(
            'SELECT selected FROM pref_offers WHERE answered IS NOT NULL ORDER BY asked',
          )
          .all()
          .map((r) => r.selected),
        ['separate-issue', 'current-change'],
      )
      assert.equal(
        db.prepare('SELECT COUNT(*) AS n FROM pref_constraints').get().n,
        0,
      )
      assert.deepEqual(
        witnessed.replies.map((r) => [r.responseId, r.observedLive]),
        [
          ['prompt:earlier', true],
          ['prompt:next', true],
        ],
      )
      assert.deepEqual(
        reconstructed.replies.map((r) => [r.responseId, r.observedLive]),
        [
          ['prompt:earlier', false],
          ['prompt:next', false],
        ],
      )
    },
  )
}
