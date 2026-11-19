import { open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { isObject, requestGateway, type ObjectValue } from './ipc.js'
import { claudeTerminal } from './terminal.js'
import { toolInputFingerprint } from './supervision/index.js'
import {
  normalizeQuestionCard,
  hasAnswerNotes,
  isTypedReply,
  type QuestionCard,
} from './preferences/index.js'

const limit = 128 * 1024
/** Preserve supported display content for policy and model review. Reject the whole prompt if a card cannot be interpreted.
 * @example
 * const cards = decodeCards(input.questions);
 */
export function decodeCards(value: unknown): QuestionCard[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 8) return
  const cards: QuestionCard[] = []
  for (const raw of value) {
    const card = normalizeQuestionCard(raw)
    if (!card || cards.some((prior) => prior.question === card.question)) return
    cards.push(card)
  }
  return cards
}

async function recentTranscript(path: unknown): Promise<ObjectValue[]> {
  if (typeof path !== 'string') return []
  try {
    const base = await realpath(
      join(
        process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
        'projects',
      ),
    )
    const target = await realpath(path)
    const rel = relative(base, target)
    if (rel.startsWith('..') || isAbsolute(rel) || !rel.endsWith('.jsonl'))
      return []
    const file = await open(target, 'r')
    try {
      const st = await file.stat()
      if (!st.isFile()) return []
      const start = Math.max(0, st.size - limit)
      const buffer = Buffer.alloc(st.size - start)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start)
      const rows: ObjectValue[] = []
      for (const line of buffer.toString('utf8', 0, bytesRead).split('\n')) {
        try {
          const v: unknown = JSON.parse(line)
          if (isObject(v)) rows.push(v)
        } catch {
          /* A partial first or final record has no usable provenance. */
        }
      }
      return rows
    } finally {
      await file.close()
    }
  } catch {
    return []
  }
}

function previousQuestion(
  rows: ObjectValue[],
  sessionId: string,
  submittedId: unknown,
): string | undefined {
  for (const row of [...rows].reverse()) {
    if (row.sessionId !== sessionId || !isObject(row.message)) continue
    // Some Claude builds persist this submission before running UserPromptSubmit.
    if (
      row.type === 'user' &&
      typeof submittedId === 'string' &&
      (row.uuid === submittedId || row.promptId === submittedId)
    )
      continue
    if (row.type === 'user') return
    if (row.type !== 'assistant' || !Array.isArray(row.message.content))
      continue
    const last = row.message.content.at(-1)
    if (
      !isObject(last) ||
      last.type !== 'text' ||
      typeof last.text !== 'string' ||
      !/[?？]\s*$/.test(last.text.trim())
    )
      return
    return typeof row.uuid === 'string' ? row.uuid : undefined
  }
}

function humanMarker(value: unknown): boolean {
  if (!isObject(value)) return false
  const marker = value.permissionDecision
  return (
    isObject(marker) &&
    marker.decision === 'accept' &&
    marker.source === 'user_temporary'
  )
}

/** Carry the verified logical session when {@link runHook} receives a prompt too large to retain.
 * @example new IncompleteHookInstruction('terminal-session')
 */
export class IncompleteHookInstruction {
  constructor(readonly sessionId: string) {}
}

/** Forward an actual interactive Claude hook; a missing service leaves Claude's normal prompt in control.
 * The original stdout belongs to this exact tool request, so no terminal keystrokes or resumed conversation are needed.
 * @example
 * await runHook(directory, input, writeToClaude);
 */
export async function runHook(
  directory: string,
  body: unknown,
  output: (value: string) => Promise<void>,
  incarnation = claudeTerminal(),
  expectedEvent?: string,
): Promise<void> {
  if (
    (!body || body instanceof IncompleteHookInstruction) &&
    incarnation &&
    (expectedEvent === 'UserPromptSubmit' ||
      expectedEvent === undefined ||
      expectedEvent.startsWith('openclaw-break-delegate-hook-'))
  ) {
    // An identified task follows the logical session across restarts. An unreadable envelope holds only the originating process.
    await requestGateway(
      directory,
      {
        op: 'incomplete-instruction',
        incarnation,
        ...(body instanceof IncompleteHookInstruction
          ? { sessionId: body.sessionId }
          : {}),
      },
      1800,
    ).catch(() => undefined)
    return
  }
  if (
    !incarnation ||
    !isObject(body) ||
    typeof body.session_id !== 'string' ||
    typeof body.cwd !== 'string' ||
    typeof body.hook_event_name !== 'string' ||
    body.agent_id ||
    body.agent_type
  )
    return
  const sessionId = body.session_id
  const common = {
    op: 'hook',
    sessionId,
    cwd: body.cwd,
    incarnation,
    event: body.hook_event_name,
    at: Date.now(),
  }
  const questionId =
    typeof body.tool_use_id === 'string' ? body.tool_use_id : undefined
  try {
    if (body.hook_event_name === 'UserPromptSubmit') {
      if (typeof body.prompt !== 'string') return
      const rows = await recentTranscript(body.transcript_path)
      const previous = previousQuestion(rows, sessionId, body.prompt_id)
      const explicit =
        typeof body.in_reply_to === 'string' ? body.in_reply_to : undefined
      const prior =
        previous && isTypedReply(body.prompt, [], previous, explicit)
          ? previous
          : undefined
      await requestGateway(directory, {
        ...common,
        prompt: body.prompt.slice(0, 16_384),
        truncated: body.prompt.length > 16_384,
        replyTo: prior,
        clientId:
          typeof body.prompt_id === 'string' ? body.prompt_id : undefined,
      })
      return
    }
    const event = body.hook_event_name
    if (
      (event === 'PermissionRequest' && body.tool_name !== 'AskUserQuestion') ||
      (body.tool_name !== 'AskUserQuestion' &&
        ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event))
    ) {
      if (typeof body.tool_name !== 'string') return
      // For execution events only the tool identity and an opaque fingerprint leave the hook.
      await requestGateway(
        directory,
        {
          ...common,
          questionId,
          toolName: body.tool_name,
          fingerprint: toolInputFingerprint(body.tool_input),
        },
        1800,
      )
      return
    }
    if (
      body.hook_event_name === 'PreToolUse' ||
      body.hook_event_name === 'PostToolUse'
    ) {
      if (
        body.tool_name !== 'AskUserQuestion' ||
        !questionId ||
        !isObject(body.tool_input)
      )
        return
      const prefilled =
        event === 'PreToolUse' &&
        [body.tool_input.answers, body.tool_input.annotations].some(
          (value) =>
            value !== undefined &&
            (!isObject(value) || Object.keys(value).length > 0),
        )
      const cards = prefilled
        ? undefined
        : decodeCards(body.tool_input.questions)
      // Unsupported cards must still pause the workload clock and appear in the local return review.
      const fallback = Array.isArray(body.tool_input.questions)
        ? body.tool_input.questions
            .slice(0, 8)
            .filter(isObject)
            .map((c) =>
              typeof c.question === 'string' ? c.question.slice(0, 1000) : '',
            )
            .filter(Boolean)
            .join('\n')
        : ''
      const surface = cards
        ? { cards }
        : { unsupported: true, question: fallback || 'Claude Code question' }
      if (body.hook_event_name === 'PostToolUse') {
        const result = isObject(body.tool_response) ? body.tool_response : {}
        const rows = await recentTranscript(body.transcript_path)
        const witnessed =
          humanMarker(result) ||
          rows.some(
            (row) =>
              row.sessionId === sessionId &&
              isObject(row.message) &&
              Array.isArray(row.message.content) &&
              row.message.content.some(
                (c) =>
                  isObject(c) &&
                  c.type === 'tool_result' &&
                  c.tool_use_id === questionId,
              ) &&
              (humanMarker(row) || humanMarker(row.toolUseResult)),
          )
        await requestGateway(directory, {
          ...common,
          questionId,
          ...surface,
          answers: cards ? result.answers : undefined,
          conditional: cards
            ?.filter((c) => hasAnswerNotes(result.annotations, c.question))
            .map((c) => c.question),
          selected:
            !cards &&
            isObject(result.answers) &&
            Object.keys(result.answers).length > 0,
          human: witnessed,
        })
        return
      }
      const v = await requestGateway(
        directory,
        { ...common, questionId, ...surface },
        12000,
      )
      if (
        !cards ||
        !isObject(v) ||
        !isObject(v.answers) ||
        typeof v.receipt !== 'string' ||
        typeof v.deliverBefore !== 'number' ||
        !Number.isFinite(v.deliverBefore)
      )
        return
      const answers = v.answers
      if (
        cards.some(
          (c) => !c.options.some((opt) => opt.label === answers[c.question]),
        )
      )
        return
      // Recheck consent on the live Gateway and the absolute deadline after a paused or sleeping hook resumes.
      const live = await requestGateway(
        directory,
        { op: 'can-deliver', receipt: v.receipt },
        1200,
      ).catch(() => false)
      if (live !== true || Date.now() >= v.deliverBefore) {
        await requestGateway(
          directory,
          { op: 'undelivered', receipt: v.receipt },
          1200,
        )
        return
      }
      await output(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: {
              ...body.tool_input,
              questions: body.tool_input.questions,
              answers,
            },
          },
        }) + '\n',
      )
      await requestGateway(directory, { op: 'ack', receipt: v.receipt }, 1200)
      return
    }
    const reason =
      typeof body.notification_type === 'string'
        ? body.notification_type
        : typeof body.source === 'string'
          ? body.source
          : undefined
    await requestGateway(
      directory,
      {
        ...common,
        questionId,
        reason,
        toolName:
          typeof body.tool_name === 'string' ? body.tool_name : undefined,
      },
      1800,
    )
  } catch {
    /* Claude can still present its original question when the delegate is unavailable. */
  }
}
