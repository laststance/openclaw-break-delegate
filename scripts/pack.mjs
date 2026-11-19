import { spawnSync } from 'node:child_process'
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  renameSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const generated = join(root, 'native/generated')
const bundlePath = 'native/generated/BreakDelegate.app'
const binaryPath = 'Contents/MacOS/BreakDelegate'
const run = (program, args, capture = false) => {
  const r = spawnSync(program, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (r.error) throw r.error
  if (r.status !== 0)
    throw Error(
      program + ' failed (' + r.status + '). ' + (r.stderr?.trim() ?? ''),
    )
  return r.stdout
}
/** Verifies the signed app actually present in the archive before its atomic promotion.
 * @example
 * verifyPackedHelper(archive, stage, verifiedBinary)
 */
export function verifyPackedHelper(
  archive,
  stage,
  verifiedBinary,
  requireTicket = false,
) {
  const unpacked = mkdtempSync(join(stage, 'extracted-'))
  try {
    run('/usr/bin/tar', ['-xzf', archive, '-C', unpacked])
    const app = join(unpacked, 'package', bundlePath)
    const executable = join(app, binaryPath)
    accessSync(executable, constants.X_OK)
    run(
      '/usr/bin/codesign',
      ['--verify', '--strict', '--all-architectures', app],
      true,
    )
    if (!readFileSync(executable).equals(verifiedBinary))
      throw Error(
        'The packed native executable differs from the verified build.',
      )
    if (requireTicket) {
      run('xcrun', ['stapler', 'validate', app])
      run('/usr/sbin/spctl', ['--assess', '--type', 'execute', app])
    }
  } finally {
    rmSync(unpacked, { recursive: true, force: true })
  }
}

function packRelease() {
  const override = process.env.BREAK_DELEGATE_NATIVE_OUTPUT
  if (override && resolve(root, override) !== generated)
    throw Error(
      'Release packaging requires BREAK_DELEGATE_NATIVE_OUTPUT to resolve to native/generated.',
    )
  if (process.platform !== 'darwin')
    throw Error(
      'Build the macOS release candidate on a Mac with Xcode Command Line Tools.',
    )
  run('pnpm', ['run', 'build'])
  run('pnpm', ['run', 'build:native'])
  const sourceApp = join(root, bundlePath)
  run('/usr/bin/codesign', [
    '--verify',
    '--strict',
    '--all-architectures',
    sourceApp,
  ])
  const verifiedBinary = readFileSync(join(sourceApp, binaryPath))
  run('pnpm', ['run', 'validate'])
  const release = join(root, 'release')
  mkdirSync(release, { recursive: true })
  // Rename the verified archive atomically even when the release checkout is on a separate volume.
  const stage = mkdtempSync(join(release, '.pack-'))
  try {
    const packed = JSON.parse(
      run(
        'npm',
        ['pack', '--json', '--ignore-scripts', '--pack-destination', stage],
        true,
      ),
    )
    const [artifact] = Object.values(packed)
    const names = new Set(artifact.files.map((f) => f.path))
    for (const file of [
      'package.json',
      'openclaw.plugin.json',
      'dist/index.js',
      'dist/cli.js',
      'LICENSE',
      'native/generated/BreakDelegate.app/Contents/Info.plist',
    ]) {
      if (!names.has(file)) throw Error('Missing release file: ' + file)
    }
    if (
      ![...names].some((p) =>
        p.startsWith('native/generated/BreakDelegate.app/Contents/MacOS/'),
      )
    )
      throw Error('Missing native executable')
    if (
      [...names].some((p) =>
        /(?:^|\/)(?:\.env(?:\.|$)|\.git|\.gstack|node_modules|state\.sqlite|.*\.jsonl$)/.test(
          p,
        ),
      )
    )
      throw Error('Unexpected private or development data in archive.')
    const archive = join(stage, artifact.filename)
    verifyPackedHelper(
      archive,
      stage,
      verifiedBinary,
      process.env.BREAK_DELEGATE_REUSE_STAPLED === '1',
    )
    const target = join(release, artifact.filename)
    const sha256 = createHash('sha256')
      .update(readFileSync(archive))
      .digest('hex')
    renameSync(archive, target)
    console.log(
      JSON.stringify(
        { archive: target, sha256, fileCount: names.size },
        null,
        2,
      ),
    )
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}
if (import.meta.main) packRelease()
