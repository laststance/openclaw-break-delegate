import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  renameSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'darwin')
  throw Error(
    'Build the macOS release candidate on a Mac with Xcode Command Line Tools.',
  )
const run = (program, args, capture = false) => {
  const r = spawnSync(program, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  })
  if (r.error) throw r.error
  if (r.status !== 0) throw Error(program + ' failed (' + r.status + ').')
  return r.stdout
}
run('pnpm', ['run', 'build'])
run('pnpm', ['run', 'build:native'])
run('pnpm', ['run', 'validate'])
const stage = mkdtempSync(join(tmpdir(), 'break-delegate-pack-'))
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
  const release = join(root, 'release')
  mkdirSync(release, { recursive: true })
  const target = join(release, artifact.filename)
  const sha256 = createHash('sha256')
    .update(readFileSync(archive))
    .digest('hex')
  renameSync(archive, target)
  console.log(
    JSON.stringify({ archive: target, sha256, fileCount: names.size }, null, 2),
  )
} finally {
  rmSync(stage, { recursive: true, force: true })
}
