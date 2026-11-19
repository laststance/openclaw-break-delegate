import { createHash, randomUUID } from 'node:crypto'
import { constants, realpathSync, type Stats } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Both Node TLS endpoints must prove possession of the profile key before application data flows.
export const gatewayTls = {
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.2',
  ciphers: 'PSK-AES128-GCM-SHA256',
} as const
export const gatewayIdentity = 'break-delegate-v1'
export const keyBytes = 32

/** Locate the profile's socket and credential for both ends of {@link gatewayTls}.
 * @example
 * const { profile, address } = gatewayEndpoint(directory);
 */
export function gatewayEndpoint(directory: string) {
  const profile = realpathSync(directory)
  const direct = join(profile, 'gateway.sock')
  // Darwin sun_path holds 104 bytes including the terminating NUL.
  const address =
    Buffer.byteLength(direct) < 104
      ? direct
      : join(
          '/tmp',
          'bd-' +
            (process.getuid?.() ?? 'user') +
            '-' +
            createHash('sha256').update(profile).digest('hex').slice(0, 24),
          's',
        )
  return { profile, address, keyFile: join(profile, 'gateway.key') }
}

function owned(stat: Stats): boolean {
  return !process.getuid || stat.uid === process.getuid()
}

/** Reserve a user-owned directory before {@link gatewayEndpoint} binds its listener.
 * @example
 * await privateDirectory(profile);
 */
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory() || !owned(stat))
    throw new Error('Local state directory must be owned by this user.')
  await chmod(path, 0o700)
}

/** Read the private key only after checking the endpoint and its containing directories.
 * Called before connecting to the socket chosen by {@link gatewayEndpoint}.
 * @example
 * const psk = await readGatewayKey(gatewayEndpoint(directory));
 */
export async function readGatewayKey(
  endpoint: ReturnType<typeof gatewayEndpoint>,
): Promise<Buffer> {
  const folders = new Set([endpoint.profile, dirname(endpoint.address)])
  for (const path of folders) {
    const stat = await lstat(path)
    if (!stat.isDirectory() || !owned(stat) || (stat.mode & 0o077) !== 0)
      throw new Error('Gateway socket directory must be private to this user.')
  }
  const socket = await lstat(endpoint.address)
  if (!socket.isSocket() || !owned(socket) || (socket.mode & 0o077) !== 0)
    throw new Error('Gateway socket must be private to this user.')

  const key = await open(
    endpoint.keyFile,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const stat = await key.stat()
    if (
      !stat.isFile() ||
      !owned(stat) ||
      (stat.mode & 0o077) !== 0 ||
      stat.size !== keyBytes
    )
      throw new Error('Gateway credential must be a private profile file.')
    const psk = Buffer.alloc(keyBytes)
    if ((await key.read(psk)).bytesRead !== keyBytes)
      throw new Error('Gateway credential is incomplete.')
    return psk
  } finally {
    await key.close()
  }
}

/** Publish a complete startup credential for {@link readGatewayKey} under the profile lock.
 * @example
 * await publishGatewayKey(endpoint.keyFile, psk);
 */
export async function publishGatewayKey(
  path: string,
  key: Buffer,
): Promise<void> {
  const staged = path + '.' + randomUUID()
  const file = await open(staged, 'wx', 0o600)
  try {
    try {
      await file.writeFile(key)
    } finally {
      await file.close()
    }
    await rename(staged, path)
  } finally {
    await rm(staged, { force: true })
  }
}
