import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  type Dirent,
  type BigIntStats,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { setImmediate as yieldToGateway } from 'node:timers/promises'
import { EvidenceDatabase, type ReplayReport } from './database.js'
import {
  parseHistoryRow,
  type HistoryFormat,
  type ParseState,
} from './records.js'
import { digest } from './repository.js'

export interface HistoryRoots {
  claude?: string
  codex?: string
  gstack?: string
}
export interface ImportReport {
  files: number
  changedFiles: number
  bytesRead: number
  verificationBytesRead: number
  malformed: number
  oversized: number
  unreadable: number
  unverified: number
  mirrors: number
  unavailable: (keyof HistoryRoots)[]
  observations: number
  replay: ReplayReport
}
interface SourceFile {
  path: string
  format: HistoryFormat
}
const chunkSize = 128 * 1024
const maxLine = 512 * 1024
const end = 10

/** Detect the providers' standard or configured local state roots when no isolated roots were passed.
 * @example defaultHistoryRoots()
 */
export function defaultHistoryRoots(): HistoryRoots {
  const env = process.env
  const pluginData = /gstack/iu.test(env.CLAUDE_PLUGIN_ROOT ?? '')
    ? env.CLAUDE_PLUGIN_DATA
    : undefined
  return {
    claude: env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    codex: env.CODEX_HOME || join(homedir(), '.codex'),
    gstack:
      env.GSTACK_STATE_ROOT ||
      env.GSTACK_HOME ||
      env.GSTACK_STATE_DIR ||
      pluginData ||
      join(homedir(), '.gstack'),
  }
}

function entries(path: string, report: ImportReport): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report.unreadable++
    return []
  }
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

function* discover(
  roots: HistoryRoots,
  report: ImportReport,
): Generator<SourceFile> {
  for (const source of ['claude', 'codex', 'gstack'] as const) {
    const root = roots[source]
    if (!root) continue
    const folders =
      source === 'codex' ? ['sessions', 'archived_sessions'] : ['projects']
    const readable = folders.filter((folder) => {
      try {
        return lstatSync(join(root, folder)).isDirectory()
      } catch {
        return false
      }
    })
    if (!readable.length) report.unavailable.push(source)
    if (source !== 'gstack' && isFile(join(root, 'history.jsonl')))
      yield {
        path: join(root, 'history.jsonl'),
        format: (source + '-input') as HistoryFormat,
      }
    for (const folder of readable) {
      const base = join(root, folder)
      if (source === 'codex') {
        // Date partitions and the flat archive contain root rollout files. Skip symlinked or arbitrary deeper directory trees.
        const stack = [{ dir: base, depth: 0 }]
        while (stack.length) {
          const { dir, depth } = stack.pop()!
          for (const entry of entries(dir, report)) {
            const path = join(dir, entry.name)
            if (entry.isFile() && /^rollout-.+\.jsonl$/u.test(entry.name))
              yield { path, format: source }
            if (
              entry.isDirectory() &&
              depth < 3 &&
              /^\d{2,4}$/u.test(entry.name)
            )
              stack.push({ dir: path, depth: depth + 1 })
          }
        }
      } else {
        for (const project of entries(base, report)) {
          if (!project.isDirectory()) continue
          const projectDir = join(base, project.name)
          if (source === 'gstack') {
            const path = join(projectDir, 'question-log.jsonl')
            if (isFile(path)) yield { path, format: source }
          } else {
            // Claude's nested subagent files and tool-results are never assumed to contain human inputs.
            for (const file of entries(projectDir, report))
              if (file.isFile() && file.name.endsWith('.jsonl'))
                yield { path: join(projectDir, file.name), format: source }
          }
        }
      }
    }
  }
}

function checkpointHash(
  fd: number,
  offset: number,
  report: ImportReport,
): string {
  const size = Math.min(offset, 96)
  const first = Buffer.alloc(size)
  const last = Buffer.alloc(size)
  report.verificationBytesRead += readSync(fd, first, 0, size, 0)
  report.verificationBytesRead += readSync(fd, last, 0, size, offset - size)
  return createHash('sha256').update(first).update(last).digest('hex')
}

function rangeHash(
  fd: number,
  start: number,
  stop: number,
  report: ImportReport,
): string {
  const hash = createHash('sha256')
  const buf = Buffer.allocUnsafe(Math.min(chunkSize, stop - start))
  while (start < stop) {
    const bytes = readSync(
      fd,
      buf,
      0,
      Math.min(buf.length, stop - start),
      start,
    )
    if (!bytes) break
    report.verificationBytesRead += bytes
    hash.update(buf.subarray(0, bytes))
    start += bytes
  }
  return hash.digest('hex')
}

const fileVersion = (stat: BigIntStats) =>
  [stat.size, stat.mtimeNs, stat.ctimeNs].join(':')

/** Verify every committed segment before {@link importFile} reuses a changed file. Yield between blocks for live gateway requests.
 * @example await matchesPrefix(db,fd,key,offset)
 */
async function matchesPrefix(
  db: EvidenceDatabase,
  fd: number,
  key: string,
  stop: number,
  report: ImportReport,
): Promise<boolean> {
  const next = db.db.prepare(
    'SELECT start,stop,hash FROM pref_file_segments WHERE path=? AND start=?',
  )
  const buffer = Buffer.allocUnsafe(chunkSize)
  let cursor = 0
  while (cursor < stop) {
    const segment = next.get(key, cursor)
    if (
      !segment ||
      Number(segment.stop) <= cursor ||
      Number(segment.stop) > stop
    )
      return false
    const hash = createHash('sha256'),
      end = Number(segment.stop)
    while (cursor < end) {
      const n = readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, end - cursor),
        cursor,
      )
      if (!n) return false
      report.verificationBytesRead += n
      hash.update(buffer.subarray(0, n))
      cursor += n
      await yieldToGateway()
    }
    if (hash.digest('hex') !== segment.hash) return false
  }
  return true
}

async function importFile(
  db: EvidenceDatabase,
  file: SourceFile,
  report: ImportReport,
  retries = 0,
  revisit?: ReadonlySet<number>,
): Promise<void> {
  const fd = openSync(file.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = fstatSync(fd, { bigint: true })
    if (!info.isFile() || info.size > BigInt(Number.MAX_SAFE_INTEGER)) return
    const identity = info.dev.toString() + ':' + info.ino.toString()
    const key = digest(file.format + '\0' + file.path)
    const old = db.db.prepare('SELECT * FROM pref_files WHERE path=?').get(key)
    const owner = key + '/' + identity
    let size = Number(info.size)
    const version = db.db
      .prepare('SELECT stamp FROM pref_file_versions WHERE path=?')
      .get(key)?.stamp
    const unchanged = version === fileVersion(info)
    const refresh = !!db.db
      .prepare('SELECT 1 FROM pref_legacy_refresh WHERE path=?')
      .get(key)
    let resume =
      !refresh &&
      old?.identity === identity &&
      Number(old.offset) <= size &&
      (unchanged ||
        old.anchor === checkpointHash(fd, Number(old.offset), report))
    const saveVersion = db.db.prepare(
      'INSERT OR REPLACE INTO pref_file_versions VALUES(?,?)',
    )
    if (resume && !unchanged) {
      resume = await matchesPrefix(db, fd, key, Number(old!.offset), report)
      if (fileVersion(info) !== fileVersion(fstatSync(fd, { bigint: true }))) {
        if (retries < 2)
          await importFile(db, file, report, retries + 1, revisit)
        else report.unreadable++
        return
      }
      if (resume) saveVersion.run(key, fileVersion(info))
    }
    // A question in another file can unlock an already committed result. Re-read only that original source without withdrawing its independently verified facts.
    const replayCommitted = !!revisit && resume
    if (replayCommitted) {
      let lastResult = 0
      for (const end of revisit!) lastResult = Math.max(lastResult, end)
      size = Math.min(Number(old!.offset), lastResult)
    }
    const useCursor = resume && !replayCommitted
    const state: ParseState = useCursor
      ? (JSON.parse(String(old!.state)) as ParseState)
      : {}
    let offset = useCursor ? Number(old!.offset) : 0
    let saved = offset
    let skipping = useCursor && Boolean(old!.skipping)
    const save = db.db.prepare(
      'INSERT OR REPLACE INTO pref_files VALUES(?,?,?,?,?,?)',
    )
    if (!resume && old) {
      db.transaction(() => {
        // In-place edits invalidate this physical generation. A rotation starts a separate historical source.
        if (old.identity === identity) db.withdrawSource(owner)
        db.db.prepare('DELETE FROM pref_file_segments WHERE path=?').run(key)
        db.db.prepare('DELETE FROM pref_files WHERE path=?').run(key)
        db.db.prepare('DELETE FROM pref_legacy_refresh WHERE path=?').run(key)
        db.db.prepare('DELETE FROM pref_file_versions WHERE path=?').run(key)
      })
    }
    if (offset >= size) {
      if (!resume && old) report.changedFiles++
      return
    }
    if (!replayCommitted) report.changedFiles++
    const addSegment = db.db.prepare(
      'INSERT OR REPLACE INTO pref_file_segments VALUES(?,?,?,?)',
    )
    let stat = info
    let pending: Buffer[] = []
    let length = 0
    const changedDuringParse = Symbol('source changed during parse')
    const retry = async () => {
      if (retries < 2) await importFile(db, file, report, retries + 1, revisit)
      else report.unreadable++
    }
    while (offset < size) {
      const chunk = Buffer.allocUnsafe(Math.min(chunkSize, size - offset))
      const received = readSync(fd, chunk, 0, chunk.length, offset)
      if (!received) break
      report.bytesRead += received
      // Keep this chunk private until the source bytes and the parser state they extend have been verified.
      await yieldToGateway()
      const current = fstatSync(fd, { bigint: true })
      if (fileVersion(current) !== fileVersion(stat)) {
        if (replayCommitted) {
          await retry()
          return
        }
        const bytesMatch =
          rangeHash(fd, offset, offset + received, report) ===
          createHash('sha256').update(chunk.subarray(0, received)).digest('hex')
        const partialMatches =
          offset === saved ||
          rangeHash(fd, saved, offset, report) ===
            createHash('sha256')
              .update(Buffer.concat(pending, length))
              .digest('hex')
        const valid =
          Number(current.size) >= offset + received &&
          bytesMatch &&
          partialMatches &&
          (await matchesPrefix(db, fd, key, saved, report)) &&
          fileVersion(current) === fileVersion(fstatSync(fd, { bigint: true }))
        if (!valid) {
          await retry()
          return
        }
        stat = current
      }
      const counts = { oversized: 0, malformed: 0, unverified: 0, mirrors: 0 }
      let start = 0
      let commit = saved
      let skipAtCommit = skipping
      try {
        db.transaction(() => {
          while (start < received) {
            const newline = chunk.subarray(0, received).indexOf(end, start)
            const until = newline === -1 ? received : newline
            const part = chunk.subarray(start, until)
            if (!skipping) {
              length += part.length
              if (length > maxLine) {
                skipping = true
                pending = []
                delete state.brief
                counts.oversized++
              } else if (part.length) pending.push(part)
            }
            if (newline === -1) {
              // Do not consume an unfinished ordinary line. An oversized one can be discarded before its newline arrives.
              if (skipping) {
                commit = offset + received
                skipAtCommit = true
              }
              break
            }
            if (!skipping && length) {
              const line = Buffer.concat(pending, length).toString('utf8')
              let parsed: unknown
              try {
                parsed = JSON.parse(line)
              } catch {
                counts.malformed++
                delete state.brief
              }
              if (parsed !== undefined) {
                const frameEnd = offset + until + 1
                const type =
                  typeof parsed === 'object' &&
                  parsed !== null &&
                  'type' in parsed
                    ? parsed.type
                    : null
                // Only session metadata, worktree context and the outstanding result may affect this second pass.
                if (
                  !replayCommitted ||
                  revisit!.has(frameEnd) ||
                  type === 'session_meta' ||
                  type === 'turn_context'
                )
                  db.decodeFrame(frameEnd, () =>
                    parseHistoryRow(db, file.format, state, parsed, counts),
                  )
              }
            }
            pending = []
            length = 0
            skipping = false
            start = until + 1
            commit = offset + start
            skipAtCommit = false
          }
          if (commit > saved && !replayCommitted) {
            addSegment.run(
              key,
              saved,
              commit,
              rangeHash(fd, saved, commit, report),
            )
            save.run(
              key,
              identity,
              commit,
              checkpointHash(fd, commit, report),
              Number(skipAtCommit),
              JSON.stringify(state),
            )
            saved = commit
            saveVersion.run(key, fileVersion(stat))
          }
          // An external writer can run while synchronous row decoding performs Git or filesystem I/O.
          if (
            fileVersion(stat) !== fileVersion(fstatSync(fd, { bigint: true }))
          )
            throw changedDuringParse
        }, owner)
      } catch (error) {
        if (error !== changedDuringParse) throw error
        await retry()
        return
      }
      report.oversized += counts.oversized
      report.malformed += counts.malformed
      report.unverified += counts.unverified
      report.mirrors += counts.mirrors
      offset += received
    }
  } finally {
    closeSync(fd)
  }
}

/** Incrementally ingest local JSONL and refresh the derived replay index. Explicit roots isolate tests and alternate profiles.
 * @example await importLocalHistory(evidence, {codex:'/tmp/fixture/.codex'})
 */
export async function importLocalHistory(
  db: EvidenceDatabase,
  roots: HistoryRoots,
): Promise<ImportReport> {
  const report: ImportReport = {
    files: 0,
    changedFiles: 0,
    bytesRead: 0,
    verificationBytesRead: 0,
    malformed: 0,
    oversized: 0,
    unreadable: 0,
    unverified: 0,
    mirrors: 0,
    unavailable: [],
    observations: 0,
    replay: { observations: 0, types: [] },
  }
  const read = async (file: SourceFile, revisit?: ReadonlySet<number>) => {
    try {
      await importFile(db, file, report, 0, revisit)
    } catch (error) {
      // Files may disappear or become inaccessible while applications rotate them. Database errors must remain visible to the caller.
      if (
        !['ENOENT', 'EACCES', 'EPERM', 'ESTALE', 'ELOOP', 'ENOTDIR'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error
      report.unreadable++
    }
  }
  const files = new Map<string, SourceFile>()
  for (const file of discover(roots, report)) {
    report.files++
    files.set(digest(file.format + '\0' + file.path), file)
    await read(file)
  }
  for (const [key, frames] of db.readyResultFiles()) {
    const file = files.get(key)
    if (file) await read(file, frames)
  }
  report.replay = db.replay()
  report.observations = report.replay.observations
  return report
}
