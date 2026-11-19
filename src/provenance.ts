export type Row = Record<string, unknown>
export const record = (v: unknown): Row =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {}
export const str = (v: unknown) => (typeof v === 'string' ? v : '')
export const parseObject = (v: unknown): Row => {
  if (typeof v !== 'string') return record(v)
  try {
    return record(JSON.parse(v))
  } catch {
    return {}
  }
}

const machineSources = new Set([
  'auto',
  'auto-decided',
  'agent',
  'hook',
  'model',
  'assistant',
  'automation',
  'delegated',
  'system',
  'subagent',
  'coordinator',
  'peer',
  'spawned-env-deny',
  'config',
])
const humanAuthors = new Set([
  'human',
  'person',
  'user',
  'typed',
  'interactive',
  'user_temporary',
])

/** Reject an explicit machine author before crediting provider evidence.
 * @example automated({ author: 'automation' })
 */
export function automated(row: Row): boolean {
  const author = record(row.author)
  const origin = record(row.origin)
  const claims = [
    typeof row.author === 'string' ? row.author : author.role,
    origin.kind,
    row.answerSource,
    row.answer_source,
    row.responder,
    row.authorship,
  ]
  return (
    row.isSidechain === true ||
    row.isMeta === true ||
    row.isCompactSummary === true ||
    row.isSynthetic === true ||
    row.isDelegated === true ||
    row.delegated === true ||
    !!row.agentId ||
    !!row.agent_id ||
    claims.some((v) => v != null && !humanAuthors.has(str(v).toLowerCase())) ||
    machineSources.has(str(row.source).toLowerCase())
  )
}

/** Read automation and timeout provenance from one native Codex envelope.
 * @example automaticCodexRecord({ autoResolved: true })
 */
export function automaticCodexRecord(row: Row): boolean {
  return (
    automated(row) ||
    row.autoResolutionMs != null ||
    row.auto_resolution_ms != null ||
    [
      row.automated,
      row.timedOut,
      row.timed_out,
      row.autoResolved,
      row.auto_resolved,
    ].some((flag) => flag != null && flag !== false)
  )
}

export const codexInputTool = (name: unknown) =>
  ['request_user_input', 'functions.request_user_input'].includes(str(name))

/** Match the same native call across the wire payload and the app-server item.
 * @example codexCallId({ call_id: 'call-1' })
 */
export const codexCallId = (part: Row): string =>
  str(part.call_id) || str(part.callId) || str(part.id)

function codexResult(raw: unknown): Row {
  // The wire output is a JSON string or a single text content item containing the same JSON.
  if (Array.isArray(raw)) {
    const block = record(raw[0])
    return raw.length === 1 &&
      ['text', 'input_text', 'output_text', 'Text'].includes(str(block.type))
      ? parseObject(block.text)
      : {}
  }
  return parseObject(raw)
}

/** Check the complete request for prefilled answers, a timer or machine authorship.
 * @example automaticCodexRequest({ questions: [] }, { autoResolutionMs: 0 })
 */
export function automaticCodexRequest(args: Row, ...envelopes: Row[]): boolean {
  return (
    args.answers !== undefined ||
    [args, ...envelopes].some(automaticCodexRecord)
  )
}

/** Decode a Codex selection and inspect its outer record, content item and individual answer provenance.
 * Both the history importer and the live observer use the same native boundaries.
 * @example readCodexResult('{"answers":{},"autoResolved":true}').automatic
 */
export function readCodexResult(
  raw: unknown,
  ...envelopes: Row[]
): { output: Row; automatic: boolean } {
  const output = codexResult(raw)
  const answers = Object.values(record(output.answers)).map(record)
  const content = Array.isArray(raw) ? raw.map(record) : []
  return {
    output,
    automatic: [...envelopes, record(raw), output, ...content, ...answers].some(
      automaticCodexRecord,
    ),
  }
}
