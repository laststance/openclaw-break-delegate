import {
  automated,
  automaticCodexRecord,
  automaticCodexRequest,
  codexCallId,
  codexInputTool,
  couldBeCodexQuestionResult,
  parseObject,
  readCodexResult,
  record,
  str,
  type Row,
} from '../provenance.js'
import {
  EvidenceDatabase,
  typedResponseId,
  typedQuestionId,
  type EvidenceSource,
  type Origin,
  type Session,
} from './database.js'
import {
  normalizeLabel,
  normalizeQuestionCard,
  isTypedReply,
  isStandingReplyInstruction,
  typedOptionIndex,
  type QuestionCard,
} from './policy.js'
import { canonicalRepository, digest } from './repository.js'

export type HistoryFormat =
  'claude' | 'codex' | 'gstack' | 'claude-input' | 'codex-input'
/** Detect a qualification attached to this exact Claude question without forwarding the person's note.
 * The live hook and transcript importer use identical semantics.
 * @example hasAnswerNotes({Scope:{notes:'Only after review'}}, 'Scope')
 */
export function hasAnswerNotes(
  annotations: unknown,
  question: string,
): boolean {
  const notes = record(record(annotations)[question]).notes
  return typeof notes === 'string' ? notes.trim().length > 0 : notes != null
}
function timestamp(v: unknown): number | null {
  const parsed =
    typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}
const pairableId = (v: string) =>
  v.length > 0 && v.length <= 256 && !/[\x00-\x1f]/u.test(v)
interface StoredQuestion {
  key: string
  card: QuestionCard
  freeText?: true
}
interface Brief {
  tool: string
  question: string
  labels: string[]
  messageId?: string
  fingerprint?: string
  answered?: true
}
export interface ParseState {
  session?: string
  cwd?: string
  repo?: string | null
  interactive?: boolean
  nativeUserThread?: boolean
  lastText?: {
    speaker: 'agent' | 'user'
    format: 'item' | 'legacy'
    hash: string
    at: number
    nativeId?: string
    replyTo?: string | null
    unmatched?: Brief
    inferred?: Brief
  }
  brief?: Brief
  recentBriefs?: Brief[]
}
export interface ParseCounts {
  unverified: number
  mirrors: number
}

function readQuestions(raw: unknown, codex = false): StoredQuestion[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 5) return []
  const questions: StoredQuestion[] = []
  for (const value of raw) {
    const item = record(value)
    const freeText =
      codex &&
      item.options == null &&
      pairableId(str(item.id)) &&
      !!str(item.question).trim()
    const card = freeText
      ? { question: str(item.question), options: [] }
      : normalizeQuestionCard(value)
    if (!card) return []
    const key = str(item.id) || card.question
    if (
      questions.some(
        (item) => item.key === key || item.card.question === card.question,
      )
    )
      return []
    questions.push(freeText ? { key, card, freeText: true } : { key, card })
  }
  return questions
}

function rememberCall(
  db: EvidenceDatabase,
  origin: Origin,
  repo: string | null | undefined,
  questions: StoredQuestion[],
  askedAt: number,
): void {
  if (!pairableId(origin.toolUseId) || !questions.length) return
  const args = [origin.source, origin.sessionId, origin.toolUseId] as const
  const value = JSON.stringify(questions)
  db.primary('pref_calls', origin, [...args, value, askedAt])
  const previous = db.db
    .prepare(
      'SELECT questions FROM pref_calls WHERE source=? AND session=? AND tool=?',
    )
    .get(...args)
  // Duplicated event_msg and response_item representations share the same call. Changes to the card make its origin ambiguous.
  if (previous && previous.questions !== value) {
    db.exclude(origin)
    return
  }
  db.db
    .prepare('INSERT OR IGNORE INTO pref_calls VALUES(?,?,?,?,?)')
    .run(...args, value, askedAt)
  if (repo)
    for (const { card } of questions)
      db.offer({ ...origin, repo, card, askedAt })
}

function questionsFor(
  db: EvidenceDatabase,
  origin: Origin,
  at: number,
): StoredQuestion[] {
  const saved = db.db
    .prepare(
      'SELECT questions FROM pref_calls WHERE source=? AND session=? AND tool=? AND asked<=?',
    )
    .get(origin.source, origin.sessionId, origin.toolUseId, at)
  return saved ? (JSON.parse(String(saved.questions)) as StoredQuestion[]) : []
}

function answerCall(
  db: EvidenceDatabase,
  origin: Origin,
  raw: Row,
  at: number,
  nativeClaude: boolean,
  counts: ParseCounts,
): void {
  const questions = questionsFor(db, origin, at)
  if (!questions.length || db.isPermanentlyExcluded(origin)) return
  const answers = record(raw.answers)
  if (!Object.keys(answers).length || automated(raw)) {
    counts.unverified++
    return
  }
  const responses = questions.flatMap(({ key, card, freeText }) => {
    const value = answers[nativeClaude ? card.question : key]
    const selected = nativeClaude ? [value] : record(value).answers
    if (
      !Array.isArray(selected) ||
      !selected.length ||
      !selected.every(
        (v): v is string =>
          typeof v === 'string' &&
          !!v.trim() &&
          !/^__(?:unknown|skipped|missing)__$/iu.test(v.trim()),
      )
    )
      return []
    if (freeText && selected.length !== 1) return []
    return [{ card, freeText, selections: selected }]
  })
  // A free-form Codex form has only one completion event. Its other fields must validate before any answer is credited.
  if (
    questions.some((q) => q.freeText) &&
    (responses.length !== questions.length ||
      Object.keys(answers).length !== questions.length ||
      responses.some(
        ({ card, freeText, selections }) =>
          !freeText &&
          !selections.every((label) =>
            card.options.some((option) => option.label === label),
          ),
      ))
  )
    return
  for (const { card, freeText, selections } of responses) {
    if (freeText) continue
    // A typed condition or multiple selections cannot be converted to a single offered choice.
    const notes = hasAnswerNotes(raw.annotations, card.question)
    if (!card.multiSelect)
      db.answer(
        origin,
        card.question,
        selections.length === 1 && !notes ? str(selections[0]) : '',
        at,
        true,
      )
  }
  if (responses.length) db.humanResponse(origin, 'tool:' + origin.toolUseId, at)
}

function setCwd(state: ParseState, cwd: string, suppliedRemote?: string): void {
  if (!cwd || (cwd === state.cwd && !suppliedRemote)) return
  state.cwd = cwd
  state.repo = canonicalRepository(cwd, suppliedRemote)
}

/** Recognize an offered decision brief in a historical or live assistant message.
 * @example fromDecisionBrief('D1 — Which tests?\nA) Focused\nB) All', askedAt)
 */
export function fromDecisionBrief(
  text: string,
  at: number,
): { brief: Brief; card: QuestionCard } | undefined {
  if (text.length > 4000) return
  const header = /^\s*D\d+(?:\.\d+)*\s*[-—:]\s*(.+)$/imu.exec(text)
  const marker =
    /<gstack-qid:([a-z0-9-]{1,64})(?:;signal=[a-z0-9-]{1,64})?>/iu.exec(text)
  if (!header && !marker) return
  const clean = text
    .replace(/<gstack-qid:[a-z0-9-]{1,64}(?:;signal=[a-z0-9-]{1,64})?>/giu, '')
    .trim()
  const lines = clean
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  const question = lines
    .shift()
    ?.replace(/^D\d+(?:\.\d+)*\s*[-—:]\s*/iu, '')
    .trim()
  if (!question || lines.length < 2 || lines.length > 5) return
  const labels: string[] = []
  for (const [index, line] of lines.entries()) {
    const match = /^([A-E])[.)]\s+(.+)$/u.exec(line)
    if (
      !match ||
      match[1] !== String.fromCharCode(65 + index) ||
      match[2]!.length > 160
    )
      return
    labels.push(match[2]!)
  }
  // The timestamp is the original agent message's, matching gstack's Codex importer anchor. Repeated questions retain separate identities.
  const tool = 'brief-' + digest(JSON.stringify([at, question, labels]))
  return {
    brief: { tool, question, labels },
    card: { question, options: labels.map((label) => ({ label })) },
  }
}

function rememberBrief(
  db: EvidenceDatabase,
  source: EvidenceSource,
  state: ParseState,
  text: string,
  at: number,
  messageId?: string,
): void {
  delete state.brief
  if (!state.session) return
  const parsed = fromDecisionBrief(text, at)
  if (!parsed) {
    // A direct human reply to an ordinary question is workload, though there were no offered choices to learn.
    if (/[?？]\s*$/u.test(text))
      state.brief = {
        tool: 'text-' + digest(at + '\0' + text),
        question: '',
        labels: [],
        messageId,
        fingerprint: typedQuestionId(text, at),
      }
    return
  }
  state.brief = {
    ...parsed.brief,
    messageId,
    fingerprint: typedQuestionId(text, at),
  }
  if (state.repo)
    db.offer({
      source,
      sessionId: state.session,
      toolUseId: parsed.brief.tool,
      repo: state.repo,
      card: parsed.card,
      askedAt: at,
    })
}

function humanText(
  db: EvidenceDatabase,
  source: EvidenceSource,
  state: ParseState,
  text: string,
  at: number,
  confirmed: boolean,
  clientId: string,
  counts: ParseCounts,
  replyTo?: string,
): void {
  const pending = state.brief
  delete state.brief
  if (!state.session || !text) return
  const session = { source, sessionId: state.session }
  if (
    !pending ||
    !isTypedReply(text, pending.labels, pending.messageId, replyTo)
  ) {
    // Role-only records must join independent input history. A response to one question is not a standing instruction.
    if (confirmed) db.instruction(session, text, at)
    else db.typedInstructionCandidate(session, text, at)
    return
  }
  const origin = { ...session, toolUseId: pending.tool }
  const typed = text.trim()
  const ordinal = typedOptionIndex(typed)
  const matching =
    ordinal !== undefined
      ? pending.labels[ordinal]
      : pending.labels.find(
          (label) => normalizeLabel(label) === normalizeLabel(typed),
        )
  const responseId = typedResponseId(
    typed,
    at,
    clientId,
    pending.messageId || pending.fingerprint || pending.tool,
  )
  if (confirmed) {
    // Later links to this same offer cannot turn a second submission into another solicited answer.
    const recent = state.recentBriefs?.find(
      (brief) => brief.tool === pending.tool,
    )
    if (recent) recent.answered = true
    db.directText(origin, responseId, pending.question, matching ?? '', at)
    if (!matching && isStandingReplyInstruction(text))
      db.instruction(session, text, at, true)
  } else {
    if (
      !db.typedCandidate(
        origin,
        pending.question,
        typed,
        matching ?? '',
        at,
        responseId,
      )
    )
      counts.unverified++
    if (!matching && isStandingReplyInstruction(text))
      db.typedInstructionCandidate(session, text, at, true)
  }
}

function claudeRow(
  db: EvidenceDatabase,
  state: ParseState,
  row: Row,
  counts: ParseCounts,
): void {
  const at = timestamp(row.timestamp)
  const sessionId = str(row.sessionId)
  const noninteractive =
    row.entrypoint &&
    ![
      'cli',
      'claude-code',
      'claude-vscode',
      'claude-desktop',
      'claude-code-vscode',
    ].includes(str(row.entrypoint))
  if (
    !pairableId(sessionId) ||
    at === null ||
    automated(row) ||
    noninteractive
  ) {
    delete state.brief
    return
  }
  if (state.session && state.session !== sessionId) {
    delete state.brief
    delete state.cwd
    delete state.repo
  }
  state.session = sessionId
  setCwd(state, str(row.cwd))
  const msg = record(row.message)
  const blocks = Array.isArray(msg.content) ? msg.content.map(record) : []
  const origin = (toolUseId: string): Origin => ({
    source: 'claude',
    sessionId,
    toolUseId,
  })
  if (row.type === 'assistant' && msg.role === 'assistant') {
    delete state.brief
    // Ordinary assistant text becomes evidence only for a structured decision brief followed by an exact human reply.
    const texts = blocks.filter((block) => block.type === 'text')
    if (
      texts.length === 1 &&
      blocks.every((block) =>
        ['text', 'thinking', 'redacted_thinking'].includes(str(block.type)),
      )
    )
      rememberBrief(
        db,
        'claude',
        state,
        str(texts[0]!.text),
        at,
        str(row.uuid) || str(msg.id),
      )
    for (const block of blocks) {
      if (
        block.type !== 'tool_use' ||
        block.name !== 'AskUserQuestion' ||
        !pairableId(str(block.id))
      )
        continue
      const input = record(block.input)
      if (
        Object.keys(record(input.answers)).length ||
        Object.keys(record(input.annotations)).length
      ) {
        db.exclude(origin(str(block.id)))
        continue
      }
      rememberCall(
        db,
        origin(str(block.id)),
        state.repo,
        readQuestions(input.questions),
        at,
      )
    }
    return
  }
  if (row.type !== 'user' || msg.role !== 'user') return
  const results = blocks.filter((block) => block.type === 'tool_result')
  if (results.length) {
    delete state.brief
    // toolUseResult is attached to the transcript message, not to an individual block. Multiple results cannot be attributed safely.
    if (results.length !== 1 || results[0]!.is_error) {
      counts.unverified++
      return
    }
    const call = origin(str(results[0]!.tool_use_id))
    if (!questionsFor(db, call, at).length) return
    const grant = record(row.permissionDecision)
    const result = record(row.toolUseResult)
    if (
      automated(result) ||
      (grant.source && grant.source !== 'user_temporary')
    ) {
      db.exclude(call)
      counts.unverified++
      return
    }
    if (grant.decision !== 'accept' || grant.source !== 'user_temporary') {
      counts.unverified++
      return
    }
    db.humanGrant(call, at)
    answerCall(db, call, result, at, true, counts)
    return
  }
  const content =
    typeof msg.content === 'string'
      ? msg.content
      : blocks.length === 1 && blocks[0]!.type === 'text'
        ? str(blocks[0]!.text)
        : ''
  const human =
    row.promptSource === 'typed' || record(row.origin).kind === 'human'
  if (row.promptSource && row.promptSource !== 'typed' && !human) {
    delete state.brief
    return
  }
  humanText(
    db,
    'claude',
    state,
    content,
    at,
    human,
    str(row.promptId),
    counts,
    str(row.reply_to) ||
      str(row.in_reply_to) ||
      str(row.replyTo) ||
      str(msg.reply_to),
  )
}

/** Read the native reply link from its supported envelopes. A null result means the supplied IDs conflict or are malformed.
 * @example codexReplyLink({ reply_to: 'q1' }, { in_reply_to: 'q1' })
 */
export function codexReplyLink(...envelopes: Row[]): string | null | undefined {
  let reference: string | undefined
  for (const envelope of envelopes) {
    for (const id of [envelope.reply_to, envelope.in_reply_to]) {
      if (id == null) continue
      if (
        typeof id !== 'string' ||
        !pairableId(id) ||
        (reference !== undefined && reference !== id)
      )
        return null
      reference = id
    }
  }
  return reference
}

/** Resolve an explicit reply only when both Codex readers can identify a unique, unanswered offer.
 * @example linkedBrief(recentQuestions, 'agent-message-id')
 */
export function linkedBrief<
  T extends { tool: string; messageId?: string; answered?: true },
>(
  recent: readonly T[] | undefined,
  replyTo: string | null,
  inferred?: T,
): T | undefined {
  if (replyTo === null) return
  const targets = (recent ?? []).filter((brief) => brief.messageId === replyTo)
  if (
    inferred?.messageId === replyTo &&
    !targets.some((brief) => brief.tool === inferred.tool)
  )
    targets.push(inferred)
  return targets.length === 1 && !targets[0]!.answered ? targets[0] : undefined
}

function codexText(
  db: EvidenceDatabase,
  state: ParseState,
  speaker: 'agent' | 'user',
  format: 'item' | 'legacy',
  text: string,
  at: number,
  human: boolean,
  clientId: string,
  counts: ParseCounts,
  messageId?: string,
  replyTo?: string | null,
): void {
  const hash = digest(text)
  const previous = state.lastText
  const nativeId = speaker === 'user' ? clientId : messageId
  // Some Codex versions fan a completed item out as a legacy event. Never pair that mirror with a later question or treat it as a standing instruction.
  if (
    previous &&
    previous.speaker === speaker &&
    previous.format !== format &&
    previous.hash === hash &&
    Math.abs(at - previous.at) <= 2000 &&
    (!previous.nativeId || !nativeId || previous.nativeId === nativeId)
  ) {
    if (
      speaker === 'user' &&
      human &&
      (replyTo !== undefined || previous.replyTo !== undefined)
    ) {
      const session = { source: 'codex' as const, sessionId: state.session! }
      const inferred = previous.inferred ?? previous.unmatched
      if (inferred)
        db.rejectTypedTarget(
          { ...session, toolUseId: inferred.tool },
          inferred.question,
          text,
          previous.at,
        )
      db.cancelTypedInstruction(session, text, previous.at)
      // An unlinked mirror inherits the explicit reference. Disagreeing explicit references cannot verify each other.
      const link =
        replyTo === undefined
          ? previous.replyTo!
          : previous.replyTo === undefined || previous.replyTo === replyTo
            ? replyTo
            : null
      const target = linkedBrief(state.recentBriefs, link, inferred)
      delete previous.unmatched
      delete previous.inferred
      if (target) {
        state.brief = target
        humanText(
          db,
          'codex',
          state,
          text,
          at,
          true,
          clientId,
          counts,
          link ?? undefined,
        )
      }
      return
    }
    if (speaker === 'user' && human)
      db.typedReceipt(
        { source: 'codex', sessionId: state.session! },
        text,
        at,
        clientId,
      )
    if (
      speaker === 'agent' &&
      state.brief &&
      !state.brief.messageId &&
      messageId
    )
      state.brief.messageId = messageId
    if (speaker === 'agent' && state.brief?.messageId && state.recentBriefs) {
      const saved = state.recentBriefs.find((b) => b.tool === state.brief!.tool)
      if (saved) saved.messageId = state.brief.messageId
    }
    return
  }
  state.lastText = { speaker, format, hash, at, nativeId, replyTo }
  if (speaker === 'agent') {
    rememberBrief(db, 'codex', state, text, at, messageId)
    if (state.brief)
      state.recentBriefs = [
        ...(state.recentBriefs ?? []).filter(
          (b) => b.tool !== state.brief!.tool,
        ),
        state.brief,
      ].slice(-8)
  } else {
    if (replyTo !== undefined) {
      const target = linkedBrief(state.recentBriefs, replyTo, state.brief)
      delete state.brief
      // Unknown or ambiguous explicit links cannot act as either a reply to the latest brief or a new standing instruction.
      if (!target) return
      state.brief = target
    }
    if (!human && state.brief) state.lastText.inferred = state.brief
    humanText(
      db,
      'codex',
      state,
      text,
      at,
      human,
      clientId,
      counts,
      replyTo ?? undefined,
    )
  }
}

function codexRow(
  db: EvidenceDatabase,
  state: ParseState,
  row: Row,
  counts: ParseCounts,
): void {
  const payload = record(row.payload)
  if (row.type === 'session_meta') {
    state.session = str(payload.id)
    const threadSource = payload.thread_source ?? payload.threadSource
    const originator = str(payload.originator).toLowerCase()
    // Both the desktop app and newer interactive terminals can report "vscode". Automations and custom app-server clients cannot attest to a human selection.
    state.interactive =
      ['cli', 'vscode', 'desktop', 'codex_desktop'].includes(
        str(payload.source),
      ) &&
      (threadSource == null || threadSource === 'user') &&
      (!originator ||
        [
          'codex-tui',
          'codex desktop',
          'codex-desktop',
          'codex_vscode',
          'codex-vscode',
          'codex_cli_rs',
          'codex-cli',
          'codex cli',
        ].includes(originator))
    state.nativeUserThread =
      state.interactive && threadSource === 'user' && !!originator
    delete state.lastText
    delete state.brief
    delete state.recentBriefs
    setCwd(
      state,
      str(payload.cwd),
      str(record(payload.git).repository_url) ||
        str(record(row.git).repository_url),
    )
    return
  }
  if (!state.session || !pairableId(state.session) || !state.interactive) return
  const at = timestamp(row.timestamp)
  if (at === null) {
    delete state.brief
    return
  }
  if (row.type === 'turn_context') {
    setCwd(state, str(payload.cwd))
    return
  }
  const origin = (id: string): Origin => ({
    source: 'codex',
    sessionId: state.session!,
    toolUseId: id,
  })
  const nativeCall = (part: Row) => origin(codexCallId(part))
  const request = (call: Origin, args: Row, ...envelopes: Row[]) => {
    delete state.brief
    const marked = db.db
      .prepare(
        'DELETE FROM pref_pending_codex_outputs WHERE session=? AND tool=?',
      )
      .run(call.sessionId, call.toolUseId)
    if (
      marked.changes ||
      automaticCodexRequest(args, row, payload, ...envelopes)
    ) {
      db.exclude(call)
      counts.unverified++
      return
    }
    rememberCall(db, call, state.repo, readQuestions(args.questions, true), at)
  }
  const result = (
    call: Origin,
    raw: unknown,
    namedQuestion: boolean,
    ...envelopes: Row[]
  ) => {
    if (!pairableId(call.toolUseId)) return
    const known =
      namedQuestion ||
      !!db.db
        .prepare(
          'SELECT 1 FROM pref_calls WHERE source=? AND session=? AND tool=?',
        )
        .get(call.source, call.sessionId, call.toolUseId)
    if (!known && !couldBeCodexQuestionResult(raw)) return
    const { output, automatic } = readCodexResult(
      raw,
      row,
      payload,
      ...envelopes,
    )
    // A mirror may supply provenance before or after the unmarked copy of the same call.
    if (automatic) {
      if (!known) {
        // A generic result can resemble a question, including an empty answer map. Only a later matching request can establish its tool identity.
        db.primary('pref_pending_codex_outputs', call, [
          call.sessionId,
          call.toolUseId,
        ])
        db.db
          .prepare(
            'INSERT OR IGNORE INTO pref_pending_codex_outputs VALUES(?,?)',
          )
          .run(call.sessionId, call.toolUseId)
        return
      }
      db.exclude(call)
      counts.unverified++
      return
    }
    if (payload.type !== 'item_started')
      answerCall(db, call, output, at, false, counts)
  }
  if (row.type === 'event_msg') {
    if (payload.thread_id && payload.thread_id !== state.session) return
    if (payload.type === 'request_user_input') {
      request(nativeCall(payload), payload)
      return
    }
    if (payload.type === 'item_completed' || payload.type === 'item_started') {
      const item = record(payload.item)
      if (
        item.type === 'FunctionCallOutput' &&
        codexInputTool(item.name) &&
        (!item.namespace || item.namespace === 'functions')
      ) {
        result(nativeCall(item), item.output, true, item)
        return
      }
      if (
        item.type === 'RequestUserInput' ||
        (item.type === 'FunctionCall' &&
          codexInputTool(item.name) &&
          (!item.namespace || item.namespace === 'functions'))
      ) {
        request(
          nativeCall(item),
          item.questions ? item : parseObject(item.arguments ?? item.input),
          item,
        )
        return
      }
    }
    if (automaticCodexRecord(row) || automaticCodexRecord(payload)) {
      delete state.brief
      return
    }
    if (payload.type === 'agent_message')
      codexText(
        db,
        state,
        'agent',
        'legacy',
        str(payload.message),
        at,
        false,
        '',
        counts,
        str(payload.id) || str(payload.message_id),
      )
    if (payload.type === 'user_message') {
      const human =
        record(payload.origin).kind === 'human' ||
        payload.prompt_source === 'typed'
      codexText(
        db,
        state,
        'user',
        'legacy',
        str(payload.message),
        at,
        human,
        str(payload.client_id),
        counts,
        undefined,
        codexReplyLink(payload),
      )
    }
    if (payload.type === 'item_completed') {
      const item = record(payload.item)
      if (
        (payload.thread_id && payload.thread_id !== state.session) ||
        automaticCodexRecord(item)
      ) {
        delete state.brief
        return
      }
      const blocks = Array.isArray(item.content) ? item.content.map(record) : []
      if (item.type === 'UserMessage' || item.type === 'AgentMessage') {
        const user = item.type === 'UserMessage'
        if (
          blocks.length !== 1 ||
          blocks[0]!.type !== (user ? 'text' : 'Text') ||
          !str(blocks[0]!.text)
        ) {
          delete state.brief
          return
        }
        const clientId = str(item.client_id)
        const verified =
          !!state.nativeUserThread &&
          pairableId(clientId) &&
          payload.thread_id === state.session
        codexText(
          db,
          state,
          user ? 'user' : 'agent',
          'item',
          str(blocks[0]!.text),
          at,
          verified,
          clientId,
          counts,
          str(item.id),
          codexReplyLink(item, payload),
        )
      } else if (item.type === 'HookPrompt') delete state.brief
    }
    if (payload.type === 'turn_aborted') delete state.brief
    return
  }
  if (row.type !== 'response_item') return
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    delete state.brief
    if (!codexInputTool(payload.name)) return
    if (payload.namespace && payload.namespace !== 'functions') return
    request(
      nativeCall(payload),
      parseObject(payload.arguments ?? payload.input),
    )
  }
  if (
    payload.type === 'function_call_output' ||
    payload.type === 'custom_tool_call_output'
  ) {
    if (payload.name && !codexInputTool(payload.name)) return
    if (payload.namespace && payload.namespace !== 'functions') return
    result(nativeCall(payload), payload.output, codexInputTool(payload.name))
  }
}

/** Decode only supported local source records and keep incomplete or unattributable replies out of the evidence.
 * @example parseHistoryRow(evidence, 'codex', state, json, counts)
 */
export function parseHistoryRow(
  db: EvidenceDatabase,
  format: HistoryFormat,
  state: ParseState,
  value: unknown,
  counts: ParseCounts,
): void {
  const row = record(value)
  if (format === 'claude') {
    claudeRow(db, state, row, counts)
    return
  }
  if (format === 'codex') {
    codexRow(db, state, row, counts)
    return
  }
  if (format === 'claude-input' || format === 'codex-input') {
    const claude = format === 'claude-input'
    const session: Session = {
      source: claude ? 'claude' : 'codex',
      sessionId: str(claude ? row.sessionId : row.session_id),
    }
    const at = timestamp(
      claude
        ? row.timestamp
        : typeof row.ts === 'number'
          ? row.ts * 1000
          : null,
    )
    if (at !== null && !automated(row))
      db.typedReceipt(
        session,
        str(claude ? row.display : row.text),
        at,
        str(claude ? row.promptId : row.client_id),
      )
    return
  }
  const session = str(row.session_id)
  const tool = str(row.tool_use_id)
  if (
    row.source === 'codex-import-marker' ||
    row.source === 'codex-import-pattern'
  ) {
    // gstack's Codex importer copies assistant timestamps and guesses free-text choices. Only its original transcript proves the reply.
    counts.mirrors++
    return
  }
  if (row.source === 'auto-decided' || row.source === 'spawned-env-deny') {
    db.exclude({ source: 'claude', sessionId: session, toolUseId: tool })
    return
  }
  const at = timestamp(row.ts)
  if (
    !['hook', 'auq-other'].includes(str(row.source)) ||
    at === null ||
    row.user_choice === '__unknown__'
  ) {
    counts.unverified++
    return
  }
  const label = str(row.choice_label) || str(row.user_choice)
  const conditional =
    row.source === 'auq-other' &&
    str(row.free_text) &&
    normalizeLabel(str(row.free_text)) !== normalizeLabel(label)
  if (
    !db.gstackSelection(
      session,
      tool,
      str(row.question_summary),
      conditional ? '__explicit_other__' : label,
      at,
    )
  )
    counts.unverified++
}
