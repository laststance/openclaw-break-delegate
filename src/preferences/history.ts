import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  type Dirent,
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

function checkpointHash(fd: number, offset: number): string {
  const size = Math.min(offset, 96)
  const first = Buffer.alloc(size)
  const last = Buffer.alloc(size)
  readSync(fd, first, 0, size, 0)
  readSync(fd, last, 0, size, offset - size)
  return createHash('sha256').update(first).update(last).digest('hex')
}

async function importFile(
  db: EvidenceDatabase,
  file: SourceFile,
  report: ImportReport,
): Promise<void> {
  const fd = openSync(file.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = fstatSync(fd, { bigint: true })
    if (!info.isFile() || info.size > BigInt(Number.MAX_SAFE_INTEGER)) return
    const identity = info.dev.toString() + ':' + info.ino.toString()
    const key = digest(file.format + '\0' + file.path)
    const old = db.db.prepare('SELECT * FROM pref_files WHERE path=?').get(key)
    const size = Number(info.size)
    const resume =
      old?.identity === identity &&
      Number(old.offset) <= size &&
      old.anchor === checkpointHash(fd, Number(old.offset))
    const state: ParseState = resume
      ? (JSON.parse(String(old!.state)) as ParseState)
      : {}
    let offset = resume ? Number(old!.offset) : 0
    let saved = offset
    let skipping = resume && Boolean(old!.skipping)
    const save = db.db.prepare(
      'INSERT OR REPLACE INTO pref_files VALUES(?,?,?,?,?,?)',
    )
    if (offset >= size) return
    report.changedFiles++
    let pending: Buffer[] = []
    let length = 0
    while (offset < size) {
      const chunk = Buffer.allocUnsafe(Math.min(chunkSize, size - offset))
      const received = readSync(fd, chunk, 0, chunk.length, offset)
      if (!received) break
      report.bytesRead += received
      let start = 0
      let commit = saved
      let skipAtCommit = skipping
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
              report.oversized++
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
              report.malformed++
              delete state.brief
            }
            if (parsed !== undefined)
              parseHistoryRow(db, file.format, state, parsed, report)
          }
          pending = []
          length = 0
          skipping = false
          start = until + 1
          commit = offset + start
          skipAtCommit = false
        }
        if (commit > saved) {
          save.run(
            key,
            identity,
            commit,
            checkpointHash(fd, commit),
            Number(skipAtCommit),
            JSON.stringify(state),
          )
          saved = commit
        }
      })
      offset += received
      // The synchronous SQLite transaction has committed before live hooks or other source readers can run.
      await yieldToGateway()
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
    malformed: 0,
    oversized: 0,
    unreadable: 0,
    unverified: 0,
    mirrors: 0,
    unavailable: [],
    observations: 0,
    replay: { observations: 0, types: [] },
  }
  for (const file of discover(roots, report)) {
    report.files++
    try {
      await importFile(db, file, report)
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
  report.replay = db.replay()
  report.observations = report.replay.observations
  return report
}
