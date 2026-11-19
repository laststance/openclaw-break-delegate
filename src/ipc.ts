import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { realpathSync } from 'node:fs'
import { resolveStateDir } from 'openclaw/plugin-sdk/state-paths'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createConnection, createServer, type Socket } from 'node:net'

const maxFrame = 256 * 1024
export type ObjectValue = Record<string, unknown>

/** Identify a JSON object before reading external hook or socket data.
 * @example
 * if (isObject(value)) console.log(Object.keys(value));
 */
export function isObject(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Resolve the same local profile for CLI commands, installed hooks and the Gateway.
 * @example
 * const dir = dataDirectory();
 */
export function dataDirectory(stateDir?: string): string {
  return resolve(
    process.env.BREAK_DELEGATE_STATE_DIR ||
      join(stateDir || resolveStateDir(), 'break-delegate'),
  )
}

function socketAddress(directory: string): string {
  const key = createHash('sha256')
    .update(realpathSync(directory))
    .digest('hex')
    .slice(0, 20)
  return join(tmpdir(), 'bd-' + (process.getuid?.() ?? 'user') + '-' + key, 's')
}

/** A Gateway result may release a provisional delivery when its hook connection disappears. */
export interface RpcContext {
  signal: AbortSignal
  connected(): boolean
}
type Handler = (request: ObjectValue, context: RpcContext) => Promise<unknown>

function readFrame(socket: Socket, receive: (value: unknown) => void): void {
  const chunks: Buffer[] = []
  let size = 0
  function onData(chunk: Buffer): void {
    const newline = chunk.indexOf(10)
    const part = newline < 0 ? chunk : chunk.subarray(0, newline)
    size += part.length
    if (size > maxFrame) {
      socket.destroy(new Error('Local message exceeds the size limit.'))
      return
    }
    chunks.push(part)
    if (newline < 0) return
    socket.off('data', onData)
    try {
      receive(JSON.parse(Buffer.concat(chunks, size).toString('utf8')))
    } catch {
      socket.destroy(new Error('Invalid local message.'))
    }
  }
  socket.on('data', onData)
}

/** Send one bounded request to the local Gateway service and discard late responses.
 * @example
 * const status = await requestGateway(dataDirectory(), { op: "status" });
 */
export function requestGateway(
  directory: string,
  request: ObjectValue,
  timeout = 4500,
): Promise<unknown> {
  return new Promise((success, failure) => {
    const socket = createConnection(socketAddress(directory))
    const timer = setTimeout(
      () => socket.destroy(new Error('Break Delegate Gateway timed out.')),
      timeout,
    )
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.once('error', failure)
    socket.once('close', () => {
      clearTimeout(timer)
      failure(new Error('Break Delegate Gateway closed the connection.'))
    })
    readFrame(socket, (frame) => {
      if (isObject(frame) && frame.ok === true) success(frame.value)
      else
        failure(
          new Error(
            isObject(frame) && typeof frame.error === 'string'
              ? frame.error
              : 'Break Delegate request failed.',
          ),
        )
      socket.destroy()
    })
  })
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const st = await lstat(path)
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    (process.getuid && st.uid !== process.getuid())
  )
    throw new Error('Local state directory must be owned by this user.')
  await chmod(path, 0o700)
}

/** Bind the user-private socket before opening the coordinator's writable database.
 * @example
 * const close = await listenGateway(directory, handler);
 */
export async function listenGateway(
  directory: string,
  handler: Handler,
): Promise<() => Promise<void>> {
  await privateDirectory(directory)
  const address = socketAddress(directory)
  await privateDirectory(resolve(address, '..'))
  const clients = new Set<Socket>()
  const server = createServer((socket) => {
    clients.add(socket)
    const abort = new AbortController()
    socket.setTimeout(60_000, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      abort.abort()
      clients.delete(socket)
    })
    const ctx = {
      signal: abort.signal,
      connected: () => !socket.destroyed && !abort.signal.aborted,
    }
    readFrame(socket, (msg) => {
      if (!isObject(msg)) {
        socket.destroy()
        return
      }
      if (
        msg.op === 'authorize-notifications' ||
        msg.op === 'import' ||
        msg.op === 'replay'
      )
        socket.setTimeout(190000)
      void handler(msg, ctx).then(
        (value) => {
          if (ctx.connected())
            socket.end(JSON.stringify({ ok: true, value }) + '\n')
        },
        () => {
          if (ctx.connected())
            socket.end(
              JSON.stringify({
                ok: false,
                error: 'Local operation failed. Check Gateway diagnostics.',
              }) + '\n',
            )
        },
      )
    })
  })
  const bind = () =>
    new Promise<void>((ok, reject) => {
      const fail = (err: Error) => {
        server.off('listening', ready)
        reject(err)
      }
      const ready = () => {
        server.off('error', fail)
        ok()
      }
      server.once('error', fail)
      server.once('listening', ready)
      server.listen(address)
    })
  // The OS releases this SQLite file lock when its owner exits, including after a crash.
  const owner = new DatabaseSync(join(resolve(address, '..'), 'owner.sqlite'))
  try {
    owner.exec('BEGIN EXCLUSIVE')
  } catch (error) {
    owner.close()
    if ((error as { errcode?: number }).errcode === 5)
      throw Object.assign(
        new Error('This profile already has a live Gateway owner.'),
        { code: 'EADDRINUSE' },
      )
    throw error
  }
  try {
    try {
      await bind()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
      // A live peer owns this profile; only a refused, unchanged socket may be removed.
      const old = await lstat(address)
      if (!old.isSocket() || (process.getuid && old.uid !== process.getuid()))
        throw err
      try {
        await requestGateway(
          directory,
          { op: 'ping', nonce: randomUUID() },
          1000,
        )
        throw err
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== 'ECONNREFUSED') throw err
      }
      const current = await lstat(address)
      if (current.ino !== old.ino || current.dev !== old.dev) throw err
      await unlink(address)
      await bind()
    }
    await chmod(address, 0o600)
  } catch (error) {
    owner.close()
    throw error
  }
  return async () => {
    for (const socket of clients) socket.destroy()
    try {
      await new Promise<void>((done) => server.close(() => done()))
    } finally {
      owner.close()
    }
  }
}
