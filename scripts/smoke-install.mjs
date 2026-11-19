import { execFileSync, spawn } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { requestGateway } from '../dist/ipc.js'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const archive = process.argv[2]
  ? resolve(process.argv[2])
  : join(
      root,
      'release',
      readdirSync(join(root, 'release'))
        .filter((x) => x.endsWith('.tgz'))
        .sort()
        .at(-1) ?? 'missing',
    )
const tmp = mkdtempSync(join(tmpdir(), 'bd-openclaw-'))
const state = join(tmp, 'state'),
  config = join(state, 'openclaw.json')
mkdirSync(state, { mode: 0o700 })
writeFileSync(
  config,
  JSON.stringify({
    gateway: { mode: 'local' },
    plugins: { allow: ['break-delegate'] },
  }),
  { mode: 0o600 },
)
const env = {
  ...process.env,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: config,
  OPENCLAW_HOME: tmp,
  OPENCLAW_GATEWAY_TOKEN: randomBytes(24).toString('hex'),
  OPENCLAW_DISABLE_BONJOUR: '1',
  OPENCLAW_SKIP_CHANNELS: '1',
  BREAK_DELEGATE_STATE_DIR: join(tmp, 'plugin-state'),
  CLAUDE_CONFIG_DIR: join(tmp, 'claude'),
}
const host = (args) =>
  execFileSync('openclaw', args, {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 12 * 1024 * 1024,
    timeout: 120000,
  })
try {
  host([
    'plugins',
    'install',
    '--force',
    '--accept-capabilities',
    '--acknowledge-install-policy-warning',
    archive,
  ])
  // Confine source discovery to the disposable profile before the real service starts.
  const installed = JSON.parse(readFileSync(config, 'utf8'))
  installed.plugins.entries['break-delegate'].config = {
    historyRoots: {
      claude: join(tmp, 'claude'),
      codex: join(tmp, 'codex'),
      gstack: join(tmp, 'gstack'),
    },
  }
  writeFileSync(config, JSON.stringify(installed), { mode: 0o600 })
  const details = host([
    'plugins',
    'inspect',
    '--runtime',
    '--json',
    'break-delegate',
  ])
  if (!details.includes('break-delegate'))
    throw Error('The installed plugin was not discovered.')
  const help = host(['break-delegate', '--help'])
  if (
    !help.includes('authorize-notifications') ||
    !help.includes('uninstall-hooks')
  )
    throw Error('Packaged plugin CLI registration is missing.')
  const settings = join(tmp, 'claude', 'settings.json')
  host(['break-delegate', 'setup', '--settings', settings])
  const registered = JSON.parse(readFileSync(settings, 'utf8'))
  if (
    !registered.hooks?.PreToolUse?.some(
      (h) =>
        !h.matcher &&
        h.hooks?.some((item) =>
          item.command?.includes('openclaw-break-delegate-hook-v1'),
        ),
    )
  )
    throw Error(
      'The installed command did not configure Claude question hooks.',
    )
  host(['break-delegate', 'uninstall-hooks', '--settings', settings])
  if (JSON.parse(readFileSync(settings, 'utf8')).hooks?.PreToolUse)
    throw Error('Uninstall retained the hook.')
  const portProbe = createServer().listen(0, '127.0.0.1')
  await once(portProbe, 'listening')
  const port = portProbe.address().port
  await new Promise((done) => portProbe.close(done))
  const hostPackage = JSON.parse(
    readFileSync(join(root, 'node_modules/openclaw/package.json'), 'utf8'),
  )
  const gateway = spawn(
    process.execPath,
    [
      join(root, 'node_modules/openclaw', hostPackage.bin.openclaw),
      'gateway',
      'run',
      '--allow-unconfigured',
      '--bind',
      'loopback',
      '--port',
      String(port),
    ],
    { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let diagnostics = ''
  const collect = (data) => {
    diagnostics = (diagnostics + data.toString()).slice(-12000)
  }
  gateway.stdout.on('data', collect)
  gateway.stderr.on('data', collect)
  const exited = once(gateway, 'close')
  try {
    const until = Date.now() + 55000
    let live
    while (
      Date.now() < until &&
      gateway.exitCode === null &&
      gateway.signalCode === null
    ) {
      try {
        live = await requestGateway(
          env.BREAK_DELEGATE_STATE_DIR,
          { op: 'status' },
          750,
        )
        break
      } catch {
        await delay(250)
      }
    }
    if (live?.supervision?.threshold !== 45)
      throw Error(
        'Isolated Gateway did not start the packed service. ' +
          diagnostics.replaceAll(env.OPENCLAW_GATEWAY_TOKEN, '[redacted]'),
      )
    const status = host(['break-delegate', 'status'])
    if (!status.includes('"supervision"'))
      throw Error('Installed CLI could not read the live service.')
    console.log(
      'The real isolated Gateway started the installed service; workload threshold:',
      live.supervision.threshold,
    )
  } finally {
    if (gateway.exitCode === null && gateway.signalCode === null)
      gateway.kill('SIGTERM')
    const force = setTimeout(() => gateway.kill('SIGKILL'), 8000)
    force.unref()
    await exited
    clearTimeout(force)
  }
  console.log(
    'Isolated OpenClaw archive installation, plugin CLI registration and Claude hook setup/removal passed.',
  )
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
