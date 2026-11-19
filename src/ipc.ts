import { randomBytes } from 'node:crypto'
import { chmod, lstat, rm, rmdir, unlink } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { resolveStateDir } from 'openclaw/plugin-sdk/state-paths'
import { dirname, join, resolve } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { connect, createServer } from 'node:tls'
import {
  gatewayEndpoint,
  gatewayIdentity,
  gatewayTls,
  keyBytes,
  privateDirectory,
  publishGatewayKey,
  readGatewayKey,
} from './ipc-auth.js'

const maxFrame = 256 * 1024
export type ObjectValue = Record<string, unknown>

/** Keep the CLI status within one authenticated response, reporting how many session rows did not fit.
 * @example
 * const response = boundedGatewayStatus({ supervision: coordinator.status(), native, history });
 */
export function boundedGatewayStatus<
  T extends { supervision: { sessions: readonly object[] } },
>(status: T) {
  const source = status.supervision.sessions
  const sessions: object[] = []
  const supervision = {
    ...status.supervision,
    sessions,
    sessionsOmitted: source.length,
  }
  const result = { ...status, supervision }
  // Reserve the envelope, delimiter and largest possible omission count before admitting rows.
  let available =
    maxFrame -
    Buffer.byteLength(JSON.stringify({ ok: true, value: result }) + '\n')
  for (const session of source) {
    const cost =
      Buffer.byteLength(JSON.stringify(session)) + (sessions.length ? 1 : 0)
    if (cost > available) break
    sessions.push(session)
    available -= cost
  }
  supervision.sessionsOmitted -= sessions.length
  return result
}

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
export async function requestGateway(
  directory: string,
  request: ObjectValue,
  timeout = 4500,
): Promise<unknown> {
  const endpoint = gatewayEndpoint(directory)
  const psk = await readGatewayKey(endpoint)
  return new Promise((success, failure) => {
    const socket = connect({
      ...gatewayTls,
      path: endpoint.address,
      pskCallback: () => ({ identity: gatewayIdentity, psk }),
      // The PSK handshake authenticates this profile without an X.509 hostname.
      checkServerIdentity: () => undefined,
    })
    const timer = setTimeout(
      () => socket.destroy(new Error('Break Delegate Gateway timed out.')),
      timeout,
    )
    socket.once('error', failure)
    socket.once('close', () => {
      clearTimeout(timer)
      failure(new Error('Break Delegate Gateway closed the connection.'))
    })
    socket.once('secureConnect', () => {
      if (!socket.authorized) {
        socket.destroy(new Error('Gateway authentication failed.'))
        return
      }
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
      try {
        const body = JSON.stringify(request)
        if (Buffer.byteLength(body) > maxFrame)
          throw new Error('Oversized local request.')
        socket.write(body + '\n')
      } catch {
        socket.destroy(new Error('Invalid or oversized local request.'))
      }
    })
  })
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
  const { profile, address, keyFile } = gatewayEndpoint(directory)
  const socketDirectory = dirname(address)
  const psk = randomBytes(keyBytes)
  const clients = new Set<Socket>()
  const server = createServer(
    {
      ...gatewayTls,
      handshakeTimeout: 4500,
      pskCallback: (_socket, identity) =>
        identity === gatewayIdentity ? psk : null,
    },
    (socket) => {
      const abort = new AbortController()
      socket.setTimeout(60_000, () => socket.destroy())
      socket.on('error', () => socket.destroy())
      socket.once('close', () => abort.abort())
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
            if (!ctx.connected()) return
            try {
              const frame = JSON.stringify({ ok: true, value }) + '\n'
              if (Buffer.byteLength(frame) <= maxFrame) {
                socket.end(frame)
                return
              }
            } catch {
              // Serialization failures and oversized responses receive a bounded diagnostic.
            }
            socket.end(
              '{"ok":false,"error":"Local response could not fit in an IPC frame."}\n',
            )
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
    },
  )
  // Include raw clients that are still negotiating TLS when startup or shutdown ends.
  server.on('connection', (socket) => {
    clients.add(socket)
    socket.once('close', () => clients.delete(socket))
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
  const owner = new DatabaseSync(join(profile, 'owner.sqlite'))
  let published = false
  let fallbackReady = false
  let closing: Promise<void> | undefined
  const stop = async () => {
    try {
      for (const socket of clients) socket.destroy()
      if (server.listening)
        await new Promise<void>((done) => server.close(() => done()))
      if (published) await rm(keyFile, { force: true })
      if (fallbackReady)
        await rmdir(socketDirectory).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error
        })
    } finally {
      owner.close()
    }
  }
  const close = () => (closing ??= stop())
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
    if (socketDirectory !== profile) {
      await privateDirectory(socketDirectory)
      fallbackReady = true
    }
    try {
      await bind()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
      // A live peer owns this profile; only a refused, unchanged socket may be removed.
      const old = await lstat(address)
      if (!old.isSocket() || (process.getuid && old.uid !== process.getuid()))
        throw err
      try {
        // A connect-only probe can detect a stale socket without sending a hook or credential.
        await new Promise<void>((ok, fail) => {
          const probe = createConnection(address)
          probe.once('connect', () => {
            probe.destroy()
            ok()
          })
          probe.once('error', fail)
          probe.setTimeout(1000, () =>
            probe.destroy(new Error('Gateway probe timed out.')),
          )
        })
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
    await publishGatewayKey(keyFile, psk)
    published = true
  } catch (error) {
    await close()
    throw error
  }
  return close
}
