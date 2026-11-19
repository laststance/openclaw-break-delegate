import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { verifyPackedHelper } from '../../scripts/pack.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const bundle = join(repo, 'native/generated/BreakDelegate.app')

test('packing refuses to verify a helper built outside the npm bundle directory', () => {
  // Arrange
  const env = {
    ...process.env,
    BREAK_DELEGATE_NATIVE_OUTPUT: join(
      tmpdir(),
      'break-delegate-unrelated-output',
    ),
  }

  // Act
  const result = spawnSync(process.execPath, ['scripts/pack.mjs'], {
    cwd: repo,
    env,
    encoding: 'utf8',
  })

  // Assert
  assert.equal(result.status, 1)
  assert.match(
    result.stderr,
    /requires BREAK_DELEGATE_NATIVE_OUTPUT to resolve to native\/generated/,
  )
})

test(
  'the extracted tarball must contain the same executable and a valid signed app',
  {
    skip: process.platform !== 'darwin' || !existsSync(bundle),
  },
  (t) => {
    // Arrange
    const stage = mkdtempSync(join(tmpdir(), 'break-delegate-pack-test-'))
    t.after(() => rmSync(stage, { recursive: true, force: true }))
    const generated = join(stage, 'package/native/generated')
    const copy = join(generated, 'BreakDelegate.app')
    const archive = join(stage, 'fixture.tgz')
    mkdirSync(generated, { recursive: true })
    cpSync(bundle, copy, { recursive: true })
    const bytes = readFileSync(join(bundle, 'Contents/MacOS/BreakDelegate'))
    const pack = () =>
      execFileSync('/usr/bin/tar', ['-czf', archive, '-C', stage, 'package'])

    // Act
    pack()
    verifyPackedHelper(archive, stage, bytes)

    // Assert
    assert.throws(
      () =>
        verifyPackedHelper(
          archive,
          stage,
          Buffer.from('different verified build'),
        ),
      /differs from the verified build/,
    )
    appendFileSync(join(copy, 'Contents/Info.plist'), '\n')
    pack()
    assert.throws(
      () => verifyPackedHelper(archive, stage, bytes),
      /codesign failed/,
    )
  },
)
