import { typedQuestionId, typedResponseId } from '../preferences/index.js'
import {
  codexReplyLink,
  fromDecisionBrief,
  linkedBrief,
} from '../preferences/records.js'
import { constants } from 'node:fs'
import { open, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  automaticCodexRecord,
  automaticCodexRequest,
  codexCallId,
  codexInputTool,
  couldBeCodexQuestionResult,
  readCodexResult,
} from '../provenance.js'
import type { Activity, Observation } from './workload.js'

type Json = Record<string, unknown>
export interface VerifiedReply {
  sessionId: string
  responseId: string
  originId: string
  at: number
  observedLive: boolean
}
export interface DetectorResult {
  observations: Observation[]
  replies?: VerifiedReply[]
  excludedReplies?: VerifiedReply[]
  partial?: boolean
  detail: string
}

export function object(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined
}

/** Identify native clients without treating a VS Code extension or spawned agent as a Desktop chat. */
export function nativeClient(meta: Json): 'desktop' | 'cli' | undefined {
  if (
    meta.parent_thread_id ||
    (meta.threadSource && meta.threadSource !== 'user') ||
    (meta.thread_source && meta.thread_source !== 'user')
  )
    return
  if (meta.source === 'cli') return 'cli'
  if (meta.source !== 'vscode' && meta.source !== 'desktop') return
  // The native 0.170 TUI uses the app-server "vscode" source and its own originator.
  if (
    meta.source === 'vscode' &&
    typeof meta.originator === 'string' &&
    /^(?:codex[-_]tui|codex_cli_rs)$/i.test(meta.originator)
  )
    return 'cli'
  if (
    typeof meta.originator === 'string' &&
    /^(?:codex[ _-](?:desktop|app|for macos)|codex_desktop_app)$/i.test(
      meta.originator,
    )
  )
    return 'desktop'
}

const headerLimit = 1024 * 1024
const tailLimit = 2 * 1024 * 1024

/** Restrict local metadata reads to regular rollout files inside the configured Codex session directory. */
async function allowedPath(path: string, home: string): Promise<string> {
  const root = await realpath(resolve(home, 'sessions'))
  const file = await realpath(path)
  const inside = relative(root, file)
  if (
    !inside ||
    isAbsolute(inside) ||
    inside.startsWith('..' + sep) ||
    !/^rollout-[^/]+\.jsonl$/.test(file.split(sep).at(-1) ?? '')
  ) {
    throw Error('Outside the local session directory')
  }
  return file
}

/** Read just the bounded first record when app-server does not expose the originating native client. */
export async function rolloutMeta(
  path: string,
  home: string,
): Promise<Json | undefined> {
  const file = await open(
    await allowedPath(path, home),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const stat = await file.stat()
    if (!stat.isFile()) return
    return await readRolloutHeader(file, stat.size)
  } finally {
    await file.close()
  }
}

/** Read the session identity from the same inode that supplies native events across path rotation.
 * @example const meta = await readRolloutHeader(file, size)
 */
async function readRolloutHeader(
  file: FileHandle,
  size: number,
): Promise<Json | undefined> {
  const buffer = Buffer.alloc(Math.min(size, headerLimit))
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
  const end = buffer.subarray(0, bytesRead).indexOf(10)
  if (end < 0) return
  const header = object(JSON.parse(buffer.toString('utf8', 0, end)))
  return header?.type === 'session_meta' ? object(header.payload) : undefined
}

interface Request {
  blocking: boolean
  automatic: boolean
  questions: Map<string, Set<string> | null>
}
interface ObservedQuestion {
  tool: string
  messageId?: string
  answered?: true
}
interface Turn {
  state: Activity
  pending: Map<string, Request | null>
  calls: Map<
    string,
    {
      kind:
        'question' | 'completed' | 'other' | 'unidentified-result' | 'marked'
      at: number
    }
  >
  nextPruneAt: number
  recentQuestions: ObservedQuestion[]
  previousQuestion?: {
    question: ObservedQuestion
    text: string
    at: number
    item: boolean
  }
}
function unknownTurn(): Turn {
  return {
    state: 'unknown',
    pending: new Map(),
    calls: new Map(),
    nextPruneAt: 0,
    recentQuestions: [],
  }
}
interface Tail {
  client: 'cli' | 'desktop'
  ino: number
  offset: number
  state: Turn
  sessionId: string
}

function jsonValue(value: unknown): Json | undefined {
  if (typeof value !== 'string') return object(value)
  try {
    return object(JSON.parse(value))
  } catch {
    return undefined
  }
}

/** Read the documented answer format and exclude skipped, defaulted, and unrecognized selections. */
function selectionsMatch(request: Request, payload: Json): boolean {
  const answers = object(payload.answers)
  if (!answers || request.questions.size === 0) return false
  if (Object.keys(answers).length !== request.questions.size) return false
  for (const [key, choices] of request.questions) {
    const selected = object(answers[key])?.answers
    if (
      !Array.isArray(selected) ||
      selected.length === 0 ||
      !(choices
        ? selected.every((v) => typeof v === 'string' && choices.has(v))
        : selected.length === 1 &&
          typeof selected[0] === 'string' &&
          !!selected[0].trim() &&
          !/^__(?:unknown|skipped|missing)__$/iu.test(selected[0].trim()))
    )
      return false
  }
  return true
}

function requestFor(args: Json, ...envelopes: Json[]): Request {
  const questions = new Map<string, Set<string> | null>()
  for (const q of Array.isArray(args.questions) ? args.questions : []) {
    const row = object(q)
    // An unsupported sibling must not silently turn a partial response into a complete one.
    if (
      !row ||
      typeof row.id !== 'string' ||
      !row.id ||
      questions.has(row.id)
    ) {
      questions.clear()
      break
    }
    if (
      row.options == null &&
      typeof row.question === 'string' &&
      row.question.trim()
    ) {
      questions.set(row.id, null)
      continue
    }
    if (
      !Array.isArray(row.options) ||
      !row.options.length ||
      !row.options.every((o) => typeof object(o)?.label === 'string')
    ) {
      questions.clear()
      break
    }
    questions.set(
      row.id,
      new Set(
        row.options
          .map((o) => object(o)?.label)
          .filter((s): s is string => typeof s === 'string'),
      ),
    )
  }
  return {
    questions,
    blocking: args.isBlocking !== false && args.is_blocking !== false,
    automatic: automaticCodexRequest(args, ...envelopes),
  }
}

function ordinaryReply(text: string): boolean {
  // An unrelated new task after a question is not a reply. Wider free-form replies need a reply-to ID.
  return /^(?:yes|no|y|n|sure|okay|ok|go ahead|please do|do it|option [1-9]|[1-9]|はい|いいえ|お願い(?:します)?|進めて(?:ください)?|[1-9１-９](?:番|番目))[.!。！]?$/iu.test(
    text.trim(),
  )
}

/** Retain native offer identities for explicit replies while limiting unlinked replies to the preceding question.
 * Called by {@link applyEvent} for both supported assistant message envelopes.
 * @example observeQuestion(turn, { message: 'Proceed?', id: 'q' }, at, false)
 */
function observeQuestion(
  turn: Turn,
  payload: Json,
  at: number,
  item: boolean,
): void {
  const previous = turn.previousQuestion
  turn.previousQuestion = undefined
  const text = payload.message
  if (
    typeof text !== 'string' ||
    (payload.phase !== undefined && payload.phase !== 'final_answer') ||
    (!/[?？]\s*$/u.test(text) && !fromDecisionBrief(text, at))
  )
    return
  const messageId =
    (typeof payload.id === 'string' && payload.id) ||
    (typeof payload.message_id === 'string' && payload.message_id) ||
    undefined
  // A legacy mirror can omit the ID that its completed native item supplies.
  if (
    previous &&
    previous.text === text &&
    (previous.item !== item || previous.at === at) &&
    Math.abs(previous.at - at) <= 2000 &&
    (!previous.question.messageId ||
      !messageId ||
      previous.question.messageId === messageId)
  ) {
    previous.question.messageId ??= messageId
    turn.previousQuestion = previous
    return
  }
  const question: ObservedQuestion = {
    tool: typedQuestionId(text, at),
    messageId,
  }
  turn.recentQuestions.push(question)
  if (turn.recentQuestions.length > 8) turn.recentQuestions.shift()
  turn.previousQuestion = { question, text, at, item }
}

/** Unwrap native TUI items while excluding hook prompts, generated context and tool output. */
function nativeMessage(payload: Json): Json {
  if (payload.type !== 'item_completed') return payload
  const item = object(payload.item)
  if (
    !item ||
    !['UserMessage', 'AgentMessage'].includes(String(item.type)) ||
    !Array.isArray(item.content)
  )
    return payload
  const human = item.type === 'UserMessage',
    blocks = item.content.map(object)
  if (
    !blocks.length ||
    !blocks.every(
      (b) =>
        b?.type === (human ? 'text' : 'Text') && typeof b.text === 'string',
    )
  )
    return payload
  return {
    ...payload,
    ...item,
    type: human ? 'user_message' : 'agent_message',
    message: blocks.map((b) => b!.text).join(''),
  }
}

/** Consume only typed native protocol events observed on an identifiable, live interactive thread. */
function applyEvent(
  value: Json,
  sessionId: string,
  turn: Turn,
  replies: VerifiedReply[],
  excludedReplies: VerifiedReply[],
  observedLive: boolean,
) {
  const payload = object(value.payload)
  if (!payload || (payload.thread_id && payload.thread_id !== sessionId)) return
  const p = value.type === 'event_msg' ? nativeMessage(payload) : payload
  const id = codexCallId(p)
  const at =
    typeof value.timestamp === 'string' ? Date.parse(value.timestamp) : NaN
  if (at >= turn.nextPruneAt) {
    // Keep tool identities and reordered partial records for the workload window.
    for (const [key, call] of turn.calls)
      if (call.at < at - 3_600_000) turn.calls.delete(key)
    turn.nextPruneAt = at + 60_000
  }
  const record = (responseId: string, excluded = false) => {
    if (Number.isFinite(at))
      (excluded ? excludedReplies : replies).push({
        sessionId,
        responseId,
        originId: 'codex:' + sessionId + ':' + responseId,
        at,
        observedLive,
      })
  }
  const trackRequest = (
    id: string,
    args: Json | undefined,
    ...envelopes: Json[]
  ) => {
    turn.previousQuestion = undefined
    const known = turn.calls.get(id)?.kind
    const marked = known === 'marked'
    // Offers can be mirrored after the provider's final result. Keep provenance without recreating a wait.
    if (known === 'completed' || known === 'unidentified-result' || marked) {
      if (
        marked ||
        automaticCodexRequest(args ?? {}, value, payload, ...envelopes)
      )
        record('tool:' + id, true)
      turn.calls.set(id, { kind: 'completed', at })
      return
    }
    turn.calls.set(id, { kind: 'question', at })
    if (!args) {
      if ([value, payload, ...envelopes].some(automaticCodexRecord))
        record('tool:' + id, true)
      return
    }
    const request = requestFor(args, value, payload, ...envelopes)
    const previous = turn.pending.get(id)
    // The app-server may report an automatic choice on another envelope for the same call.
    if (previous) {
      request.automatic ||= previous.automatic
      request.blocking &&= previous.blocking
      if (!request.questions.size) request.questions = previous.questions
    }
    if (request.automatic) record('tool:' + id, true)
    turn.pending.set(id, request)
  }
  const finishRequest = (
    id: string,
    raw: unknown,
    complete: boolean,
    namedQuestion: boolean,
    ...envelopes: Json[]
  ) => {
    const request = turn.pending.get(id)
    const known = turn.calls.get(id)?.kind
    if (complete) turn.pending.delete(id)
    const question =
      namedQuestion ||
      !!request ||
      known === 'question' ||
      known === 'completed'
    if (!question && (known === 'other' || !couldBeCodexQuestionResult(raw)))
      return
    const { output, automatic } = readCodexResult(
      raw,
      value,
      payload,
      ...envelopes,
    )
    if (!question) {
      // An unnamed answer can precede its offer. Only a later question identity confirms this exclusion.
      if (automatic || complete)
        turn.calls.set(id, {
          kind:
            automatic || known === 'marked' ? 'marked' : 'unidentified-result',
          at,
        })
      return
    }
    turn.calls.set(id, {
      kind: complete || known === 'completed' ? 'completed' : 'question',
      at,
    })
    // A late marked mirror excludes the same call even after its pending request has closed.
    if (automatic || known === 'marked' || request?.automatic)
      record('tool:' + id, true)
    else if (complete && request && selectionsMatch(request, output))
      record('tool:' + id)
  }
  if (value.type === 'event_msg') {
    const item = object(payload.item)
    if (
      item &&
      (payload.type === 'item_started' || payload.type === 'item_completed')
    ) {
      const id = codexCallId(item)
      const inputTool =
        codexInputTool(item.name) &&
        (!item.namespace || item.namespace === 'functions')
      if (id) {
        if (
          (item.type === 'FunctionCall' ||
            item.type === 'FunctionCallOutput') &&
          item.name &&
          !inputTool
        ) {
          turn.calls.set(id, { kind: 'other', at })
          if (
            item.type === 'FunctionCallOutput' &&
            payload.type === 'item_completed'
          )
            turn.pending.delete(id)
          return
        }
        if (item.type === 'FunctionCallOutput' && inputTool) {
          finishRequest(
            id,
            item.output,
            payload.type === 'item_completed',
            true,
            item,
          )
          return
        }
        if (
          item.type === 'RequestUserInput' ||
          (item.type === 'FunctionCall' && inputTool)
        ) {
          trackRequest(
            id,
            item.questions ? item : jsonValue(item.arguments ?? item.input),
            item,
          )
          return
        }
      }
    }
    if (
      (p.type === 'agent_message' || p.type === 'user_message') &&
      [value, payload, p].some(automaticCodexRecord)
    ) {
      turn.previousQuestion = undefined
      return
    }
    if (p.type === 'task_started' || p.type === 'turn_started') {
      turn.state = 'running'
      turn.pending.clear()
    } else if (
      [
        'task_complete',
        'turn_complete',
        'turn_aborted',
        'turn_failed',
      ].includes(String(p.type))
    ) {
      turn.state = 'idle'
      turn.pending.clear()
      if (p.type === 'turn_aborted' || p.type === 'turn_failed')
        turn.previousQuestion = undefined
    } else if (p.type === 'agent_message') {
      observeQuestion(turn, p, at, payload.type === 'item_completed')
    } else if (p.type === 'user_message') {
      const replyTo = codexReplyLink(payload, object(payload.item) ?? {})
      const target =
        replyTo !== undefined
          ? linkedBrief(turn.recentQuestions, replyTo)
          : turn.previousQuestion?.question
      turn.previousQuestion = undefined
      const text = p.message
      if (
        !target ||
        target.answered ||
        typeof text !== 'string' ||
        !text.trim() ||
        text.startsWith('<') ||
        text.length > 8192
      )
        return
      if (
        (p.source && !['user', 'human'].includes(String(p.source))) ||
        (p.author && !['user', 'human'].includes(String(p.author)))
      )
        return
      if (replyTo === undefined && !ordinaryReply(text)) return
      target.answered = true
      const answerKey = typedResponseId(
        text,
        at,
        typeof p.client_id === 'string' ? p.client_id : undefined,
        target.messageId || target.tool,
      )
      record(answerKey)
    } else if (
      [
        'exec_approval_request',
        'apply_patch_approval_request',
        'request_permissions',
        'request_user_input',
      ].includes(String(p.type)) &&
      id
    ) {
      if (p.type === 'request_user_input') trackRequest(id, p)
      else turn.pending.set(id, null)
      turn.previousQuestion = undefined
    }
  } else if (value.type === 'response_item') {
    if (!id) return
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      turn.previousQuestion = undefined
      const name =
        typeof p.name === 'string' ? p.name.split('.').at(-1) : undefined
      const args = jsonValue(p.arguments ?? p.input)
      if (
        codexInputTool(p.name) &&
        (!p.namespace || p.namespace === 'functions')
      )
        trackRequest(id, args)
      else {
        turn.calls.set(id, { kind: 'other', at })
        if (name === 'request_permissions') turn.pending.set(id, null)
      }
    } else if (
      p.type === 'function_call_output' ||
      p.type === 'custom_tool_call_output'
    ) {
      const namedQuestion =
        codexInputTool(p.name) && (!p.namespace || p.namespace === 'functions')
      if (p.name && !namedQuestion) {
        turn.calls.set(id, { kind: 'other', at })
        turn.pending.delete(id)
      } else finishRequest(id, p.output, true, namedQuestion)
    }
  }
}

/**
 * Tail only rollouts attested by their native writer or a live app-server read.
 * A stored file or a recent modification alone supplies no current activity. Missing turn
 * boundaries after truncation leave the state unknown until a later explicit boundary.
 *
 * @example
 * const result = await detector.read(liveWriterPaths)
 */
export class RolloutDetector {
  readonly #home: string
  readonly #tails = new Map<string, Tail>()

  constructor(home: string) {
    this.#home = home
  }

  async read(paths: string[]): Promise<DetectorResult> {
    const observations: Observation[] = [],
      replies: VerifiedReply[] = [],
      excludedReplies: VerifiedReply[] = []
    const live = new Set(paths.slice(0, 64))
    let misses = Math.max(0, paths.length - live.size)
    for (const path of this.#tails.keys())
      if (!live.has(path)) this.#tails.delete(path)
    for (const path of live) {
      try {
        const file = await open(
          await allowedPath(path, this.#home),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        )
        try {
          const stat = await file.stat()
          if (!stat.isFile()) {
            misses++
            continue
          }
          let tail = this.#tails.get(path)
          let observedLive = true
          if (
            !tail ||
            tail.ino !== stat.ino ||
            tail.offset > stat.size ||
            stat.size - tail.offset > tailLimit
          ) {
            // A first read can reconstruct a reply, but only a continuing native writer witnesses new bytes.
            observedLive = false
            const meta = await readRolloutHeader(file, stat.size)
            const client = meta && nativeClient(meta)
            if (!meta || !client || typeof meta.id !== 'string') {
              misses++
              continue
            }
            tail = {
              ino: stat.ino,
              offset: Math.max(0, stat.size - tailLimit),
              state: unknownTurn(),
              sessionId: meta.id,
              client,
            }
            // Include the preceding byte: a newline there makes the record at the cutoff complete.
            if (tail.offset > 0) {
              const preceding = tail.offset - 1
              const block = Buffer.alloc(stat.size - preceding)
              const read = await file.read(block, 0, block.length, preceding)
              const newline = block.subarray(0, read.bytesRead).indexOf(10)
              tail.offset =
                preceding + (newline < 0 ? read.bytesRead : newline + 1)
            }
          }
          const buffer = Buffer.alloc(stat.size - tail.offset)
          const read = await file.read(buffer, 0, buffer.length, tail.offset)
          if (read.bytesRead < buffer.length) {
            misses++
            continue
          }
          const complete =
            buffer.subarray(0, read.bytesRead).lastIndexOf(10) + 1
          if (complete) {
            for (const line of buffer
              .toString('utf8', 0, complete)
              .split('\n')) {
              if (!line) continue
              const event = jsonValue(line)
              if (event)
                applyEvent(
                  event,
                  tail.sessionId,
                  tail.state,
                  replies,
                  excludedReplies,
                  observedLive,
                )
              else {
                tail.state = unknownTurn()
                misses++
              }
            }
            tail.offset += complete
          }
          this.#tails.set(path, tail)
          observations.push({
            provider: 'codex',
            sessionId: tail.sessionId,
            client: tail.client,
            status: [...tail.state.pending.values()].some(
              (request) => request === null || request.blocking,
            )
              ? 'waiting'
              : tail.state.state === 'running'
                ? 'unknown'
                : tail.state.state,
          })
        } finally {
          await file.close()
        }
      } catch {
        misses++
      }
    }
    const excludedIds = new Set(excludedReplies.map((reply) => reply.originId))
    return {
      observations,
      replies: replies.filter((reply) => !excludedIds.has(reply.originId)),
      excludedReplies,
      partial:
        misses > 0 ||
        observations.some((observation) => observation.status === 'unknown'),
      detail:
        'Native rollout writers confirm reported waits, idle turns and attributable replies. Running time requires live provider status because transient approval waits are not persisted.',
    }
  }
}
