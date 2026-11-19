import type { DatabaseSync } from 'node:sqlite'
import {
  classifyCard,
  instructionConstraints,
  normalizeLabel,
  permitsChoice,
  type Constraint,
  type QuestionCard,
} from './policy.js'
import { digest } from './repository.js'

export type EvidenceSource = 'claude' | 'codex'
export interface Origin {
  source: EvidenceSource
  sessionId: string
  toolUseId: string
}
export interface Session {
  source: EvidenceSource
  sessionId: string
}
export interface HumanResponse extends Session {
  responseId: string
  at: number
}
export interface EvidenceCard extends Origin {
  repo: string
  card: QuestionCard
  askedAt: number
}
export interface ReplayType {
  kind: string
  predictions: number
  correct: number
  held: number
  eligible: boolean
}
export interface ReplayReport {
  observations: number
  types: ReplayType[]
}
export interface PreferenceSummary {
  kind: string
  choices: { meaning: string; current: number; other: number }[]
  currentTotal: number
  otherTotal: number
  replay: { predictions: number; correct: number; held: number }
}
export interface PreferenceDecision {
  eligibleLabel: string | null
  reason: string | null
  summary: PreferenceSummary | null
}
interface Offer {
  source: EvidenceSource
  session: string
  tool: string
  question: string
  options: string
  repo: string
  kind: string
  signature: string
  asked: number
  answered: number | null
  selected: string | null
  conflict: number
}
const fields = (origin: Origin): [EvidenceSource, string, string] => [
  origin.source,
  origin.sessionId,
  origin.toolUseId,
]
const validId = (s: string) =>
  typeof s === 'string' &&
  s.length > 0 &&
  s.length <= 256 &&
  !/[\x00-\x1f]/u.test(s)
const time = (n: number) => Number.isSafeInteger(n) && n >= 0
const cleanQuestion = (q: string) =>
  q
    .replace(/<gstack-qid:[a-z0-9-]{1,64}(?:;signal=[a-z0-9-]{1,64})?>/giu, '')
    .normalize('NFKC')
    .trim()
const isEligible = (predictions: number, correct: number) =>
  predictions >= 20 && 100 * correct >= 95 * predictions
const dirty = 'UPDATE pref_state SET dirty=1 WHERE id=1'
const otherResponse = 'other-response'

/** Correlate one typed reply's live workload event with its later transcript entry.
 * @example typedResponseId('A', 1730000000123, 'native-prompt-id')
 */
export function typedResponseId(
  text: string,
  timestamp: number,
  clientId?: string,
): string {
  return clientId && validId(clientId)
    ? 'prompt:' + clientId
    : 'typed:' +
        digest(text.normalize('NFKC').trim()) +
        ':' +
        Math.floor(timestamp / 1000)
}

// Counts from another repository can describe a preference but cannot pass these two local thresholds.
function localWinner(counts: Map<string, number>): string | null {
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  if (total < 5) return null
  for (const [meaning, count] of counts)
    if (meaning !== otherResponse && count * 100 >= total * 80) return meaning
  return null
}

/** Own the SQLite evidence tables shared by imports, chronological replay, and the hook's bounded lookup.
 * @example new EvidenceDatabase(db)
 */
export class EvidenceDatabase {
  constructor(readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pref_state(id INTEGER PRIMARY KEY, dirty INTEGER NOT NULL);
      INSERT OR IGNORE INTO pref_state VALUES(1,0);
      CREATE TABLE IF NOT EXISTS pref_offers(
        source TEXT NOT NULL, session TEXT NOT NULL, tool TEXT NOT NULL, question TEXT NOT NULL,
        options TEXT NOT NULL, repo TEXT NOT NULL, kind TEXT NOT NULL, signature TEXT NOT NULL, asked INTEGER NOT NULL,
        answered INTEGER, selected TEXT, conflict INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(source,session,tool,question));
      CREATE INDEX IF NOT EXISTS pref_local ON pref_offers(kind,signature,repo,answered);
      CREATE TABLE IF NOT EXISTS pref_exclusions(source TEXT,session TEXT,tool TEXT,PRIMARY KEY(source,session,tool));
      CREATE TABLE IF NOT EXISTS pref_constraints(source TEXT,session TEXT,at INTEGER,kind TEXT,required TEXT,
        PRIMARY KEY(source,session,at,kind,required));
      CREATE TABLE IF NOT EXISTS pref_predictions(source TEXT,session TEXT,tool TEXT,question TEXT,kind TEXT,answered INTEGER,
        predicted INTEGER,correct INTEGER,PRIMARY KEY(source,session,tool,question));
      CREATE INDEX IF NOT EXISTS pref_type_trials ON pref_predictions(kind,answered);
      CREATE TABLE IF NOT EXISTS pref_human_grants(source TEXT,session TEXT,tool TEXT,at INTEGER,PRIMARY KEY(source,session,tool));
      CREATE TABLE IF NOT EXISTS pref_calls(source TEXT,session TEXT,tool TEXT,questions TEXT,asked INTEGER,PRIMARY KEY(source,session,tool));
      CREATE TABLE IF NOT EXISTS pref_responses(source TEXT,session TEXT,response_id TEXT,tool TEXT,at INTEGER,PRIMARY KEY(source,session,response_id));
      CREATE INDEX IF NOT EXISTS pref_response_times ON pref_responses(at);
      CREATE TABLE IF NOT EXISTS pref_gstack_selections(session TEXT,tool TEXT,summary TEXT,label TEXT,at INTEGER,
        PRIMARY KEY(session,tool,summary,label));
      CREATE TABLE IF NOT EXISTS pref_typed_receipts(source TEXT,session TEXT,hash TEXT,at INTEGER,
        PRIMARY KEY(source,session,hash,at));
      CREATE TABLE IF NOT EXISTS pref_instruction_candidates(source TEXT,session TEXT,hash TEXT,at INTEGER,rules TEXT,
        PRIMARY KEY(source,session,hash,at));
      CREATE TABLE IF NOT EXISTS pref_typed_candidates(source TEXT,session TEXT,tool TEXT,question TEXT,hash TEXT,label TEXT,at INTEGER,response_id TEXT,
        PRIMARY KEY(source,session,tool,question,hash,at));
      CREATE TABLE IF NOT EXISTS pref_files(path TEXT PRIMARY KEY,identity TEXT,offset INTEGER,anchor TEXT,skipping INTEGER,state TEXT);
      CREATE VIEW IF NOT EXISTS pref_observations AS SELECT o.* FROM pref_offers o WHERE o.answered IS NOT NULL AND o.conflict=0
        AND NOT EXISTS(SELECT 1 FROM pref_exclusions x WHERE x.source=o.source AND x.session=o.session AND x.tool=o.tool);
    `)
  }

  /** Save independently confirmed human effort even when the card has no learned decision type.
   * @example evidence.humanResponse(origin, 'tool:t', at)
   */
  humanResponse(origin: Origin, responseId: string, at: number): void {
    if (
      !validId(origin.sessionId) ||
      !validId(origin.toolUseId) ||
      !responseId ||
      !time(at) ||
      this.isExcluded(origin)
    )
      return
    this.db
      .prepare('INSERT OR IGNORE INTO pref_responses VALUES(?,?,?,?,?)')
      .run(origin.source, origin.sessionId, responseId, origin.toolUseId, at)
  }

  /** Read recent local response identities so the activity supervisor can deduplicate import and live events.
   * @example evidence.responsesSince(Date.now()-3600000)
   */
  responsesSince(since: number): HumanResponse[] {
    const rows = this.db
      .prepare(
        `SELECT source,session AS sessionId,response_id AS responseId,at FROM pref_responses r WHERE at>=?
      AND NOT EXISTS(SELECT 1 FROM pref_exclusions x WHERE x.source=r.source AND x.session=r.session AND x.tool=r.tool) ORDER BY at`,
      )
      .all(since)
    return rows.map((row) => ({
      source: row.source as EvidenceSource,
      sessionId: String(row.sessionId),
      responseId: String(row.responseId),
      at: Number(row.at),
    }))
  }

  /** Check the durable identity before counting a workload event or accepting an answer from another source.
   * @example evidence.isExcluded(origin)
   */
  isExcluded(origin: Origin): boolean {
    return !!this.db
      .prepare(
        'SELECT 1 FROM pref_exclusions WHERE source=? AND session=? AND tool=?',
      )
      .get(...fields(origin))
  }

  /** Keep the source cursor and its observations consistent when a batch fails or the process restarts.
   * @example evidence.transaction(() => evidence.exclude(origin))
   */
  transaction<T>(work: () => T): T {
    this.db.exec('SAVEPOINT pref_batch')
    try {
      const result = work()
      this.db.exec('RELEASE pref_batch')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK TO pref_batch; RELEASE pref_batch')
      throw error
    }
  }

  /** Retain the offered card locally, including its stable call identity for later replies in any source.
   * @example evidence.offer({source:'claude', sessionId:'s', toolUseId:'t', repo, card, askedAt})
   */
  offer(input: EvidenceCard): boolean {
    if (
      !validId(input.sessionId) ||
      !validId(input.toolUseId) ||
      !time(input.askedAt) ||
      !input.repo
    )
      return false
    const classified = classifyCard(input.card)
    if (!('card' in classified)) return false
    const { kind, signature, choices } = classified.card
    const question = cleanQuestion(input.card.question)
    const args = [...fields(input), question] as const
    const saved = this.db
      .prepare(
        'SELECT repo,signature,kind,options FROM pref_offers WHERE source=? AND session=? AND tool=? AND question=?',
      )
      .get(...args)
    const options = JSON.stringify(choices)
    if (saved) {
      // Two conflicting originals for one call cannot establish what options were actually offered.
      if (
        saved.repo !== input.repo ||
        saved.signature !== signature ||
        saved.kind !== kind ||
        saved.options !== options
      ) {
        this.db
          .prepare(
            'UPDATE pref_offers SET conflict=1 WHERE source=? AND session=? AND tool=? AND question=?',
          )
          .run(...args)
        this.db.exec(dirty)
        return false
      }
      return true
    }
    this.db
      .prepare(
        'INSERT INTO pref_offers(source,session,tool,question,options,repo,kind,signature,asked) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(...args, options, input.repo, kind, signature, input.askedAt)
    return true
  }

  /** Apply one exact single-choice selection. Contradictory copies invalidate the observation.
   * @example evidence.answer(origin, question, 'Focused tests', answeredAt)
   */
  answer(
    origin: Origin,
    question: string,
    label: string,
    answeredAt: number,
    explicitOther = false,
  ): boolean {
    if (!time(answeredAt) || (!label && !explicitOther)) return false
    const args = [...fields(origin), cleanQuestion(question)] as const
    const offer = this.db
      .prepare(
        'SELECT * FROM pref_offers WHERE source=? AND session=? AND tool=? AND question=?',
      )
      .get(...args) as unknown as Offer | undefined
    if (
      !offer ||
      offer.conflict ||
      answeredAt < offer.asked ||
      this.db
        .prepare(
          'SELECT 1 FROM pref_exclusions WHERE source=? AND session=? AND tool=?',
        )
        .get(...fields(origin))
    )
      return false
    const options = JSON.parse(offer.options) as {
      label: string
      meaning: string
    }[]
    const selected =
      label.length <= 160
        ? options.find(
            (option) => normalizeLabel(option.label) === normalizeLabel(label),
          )
        : undefined
    if (!selected && !explicitOther) return false
    const meaning = selected?.meaning ?? otherResponse
    if (offer.selected === meaning) {
      // A direct result may later establish an earlier response time than the copy's capture timestamp.
      if (answeredAt < offer.answered!) {
        this.db
          .prepare(
            'UPDATE pref_offers SET answered=? WHERE source=? AND session=? AND tool=? AND question=?',
          )
          .run(answeredAt, ...args)
        this.db.exec(dirty)
      }
      return true
    }
    if (offer.selected !== null) {
      this.db
        .prepare(
          'UPDATE pref_offers SET conflict=1 WHERE source=? AND session=? AND tool=? AND question=?',
        )
        .run(...args)
    } else {
      this.db
        .prepare(
          'UPDATE pref_offers SET selected=?,answered=? WHERE source=? AND session=? AND tool=? AND question=?',
        )
        .run(meaning, answeredAt, ...args)
    }
    this.db.exec(dirty)
    return offer.selected === null
  }

  /** Tombstone the canonical provider/session/call before returning a delegated response or importing an automated decision.
   * @example evidence.exclude({source:'claude', sessionId:'s', toolUseId:'t'})
   */
  exclude(origin: Origin): void {
    if (!validId(origin.sessionId) || !validId(origin.toolUseId)) return
    const result = this.db
      .prepare('INSERT OR IGNORE INTO pref_exclusions VALUES(?,?,?)')
      .run(...fields(origin))
    if (
      result.changes &&
      this.db
        .prepare(
          'SELECT 1 FROM pref_offers WHERE source=? AND session=? AND tool=? AND answered IS NOT NULL LIMIT 1',
        )
        .get(...fields(origin))
    )
      this.db.exec(dirty)
  }

  /** Capture only the categorical meaning of a human instruction for live and historical conflict checks.
   * @example evidence.instruction({source:'claude', sessionId:'s'}, 'Read only', Date.now())
   */
  instruction(
    session: Session,
    text: string,
    at: number,
    explicit = false,
  ): void {
    if (!validId(session.sessionId) || !time(at) || typeof text !== 'string')
      return
    const rules =
      text.length > 16_384
        ? [{ kind: '*', required: '*' }]
        : instructionConstraints(text, explicit)
    this.saveRules(session, at, rules)
  }

  private saveRules(
    session: Session,
    at: number,
    rules: readonly Constraint[],
  ): void {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO pref_constraints VALUES(?,?,?,?,?)',
    )
    for (const rule of rules) {
      const write = insert.run(
        session.source,
        session.sessionId,
        at,
        rule.kind,
        rule.required,
      )
      // A late import can add an instruction that was in force when a scored historical card was asked.
      if (
        write.changes &&
        this.db
          .prepare(
            'SELECT 1 FROM pref_observations WHERE source=? AND session=? AND asked>=? LIMIT 1',
          )
          .get(session.source, session.sessionId, at)
      )
        this.db.exec(dirty)
    }
  }

  /** A role-only task message becomes a session constraint only when the user's typed history independently matches it.
   * @example evidence.typedInstructionCandidate(session, 'Only review the change', at)
   */
  typedInstructionCandidate(session: Session, text: string, at: number): void {
    const rules =
      text.length > 16_384
        ? [{ kind: '*', required: '*' }]
        : instructionConstraints(text, false)
    if (!rules.length) return
    const hash = digest(text.trim())
    this.db
      .prepare(
        'INSERT OR IGNORE INTO pref_instruction_candidates VALUES(?,?,?,?,?)',
      )
      .run(session.source, session.sessionId, hash, at, JSON.stringify(rules))
    const receipt = this.db
      .prepare(
        'SELECT 1 FROM pref_typed_receipts WHERE source=? AND session=? AND hash=? AND at BETWEEN ? AND ?',
      )
      .get(session.source, session.sessionId, hash, at - 2000, at + 2000)
    if (receipt) this.saveRules(session, at, rules)
  }

  private restrictions(session: Session, at: number): Constraint[] {
    return this.db
      .prepare(
        'SELECT DISTINCT kind,required FROM pref_constraints WHERE source=? AND session=? AND at<=?',
      )
      .all(session.source, session.sessionId, at) as unknown as Constraint[]
  }

  /** Recover selections from gstack only with the original card and independent proof of human input.
   * @example evidence.gstackSelection('s','t',question,'Focused tests',at)
   */
  gstackSelection(
    session: string,
    tool: string,
    question: string,
    label: string,
    at: number,
  ): boolean {
    if (
      !validId(session) ||
      !validId(tool) ||
      !time(at) ||
      !question ||
      question.length > 200 ||
      !label ||
      label.length > 160
    )
      return false
    this.db
      .prepare('INSERT OR IGNORE INTO pref_gstack_selections VALUES(?,?,?,?,?)')
      .run(session, tool, cleanQuestion(question), label, at)
    return this.reconcileGstack({
      source: 'claude',
      sessionId: session,
      toolUseId: tool,
    })
  }

  /** Save a one-time interactive Claude permission decision, including cases where its text result is opaque.
   * @example evidence.humanGrant(origin, answeredAt)
   */
  humanGrant(origin: Origin, at: number): void {
    if (!time(at)) return
    this.db
      .prepare('INSERT OR IGNORE INTO pref_human_grants VALUES(?,?,?,?)')
      .run(...fields(origin), at)
    this.reconcileGstack(origin)
  }

  private reconcileGstack(origin: Origin): boolean {
    const grant = this.db
      .prepare(
        'SELECT at FROM pref_human_grants WHERE source=? AND session=? AND tool=?',
      )
      .get(...fields(origin))
    if (!grant) return false
    const rows = this.db
      .prepare(
        'SELECT summary,label,at FROM pref_gstack_selections WHERE session=? AND tool=?',
      )
      .all(origin.sessionId, origin.toolUseId)
    const offers = this.db
      .prepare(
        'SELECT question FROM pref_offers WHERE source=? AND session=? AND tool=?',
      )
      .all(...fields(origin))
    let reconciled = false
    for (const row of rows) {
      // gstack stores at most 200 characters of the question. A shared prefix cannot identify a card.
      const matching = offers.filter(
        (offer) => String(offer.question).slice(0, 200) === row.summary,
      )
      const at = Math.max(Number(row.at), Number(grant.at))
      const freeResponse = row.label === '__explicit_other__'
      if (
        matching.length === 1 &&
        this.answer(
          origin,
          String(matching[0]!.question),
          freeResponse ? '' : String(row.label),
          at,
          freeResponse,
        )
      ) {
        this.humanResponse(origin, 'tool:' + origin.toolUseId, at)
        reconciled = true
      }
    }
    return reconciled
  }

  /** Join an older transcript's role-only reply to an exact session-scoped typed history entry.
   * @example evidence.typedCandidate(origin, question, 'A', label, at)
   */
  typedCandidate(
    origin: Origin,
    question: string,
    typed: string,
    label: string,
    at: number,
    responseId: string,
  ): boolean {
    const hash = digest(typed.trim())
    this.db
      .prepare(
        'INSERT OR IGNORE INTO pref_typed_candidates VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        ...fields(origin),
        cleanQuestion(question),
        hash,
        label,
        at,
        responseId,
      )
    // Codex's CLI history records whole seconds. Permit its one-second precision around the actual submission.
    const receipt = this.db
      .prepare(
        'SELECT 1 FROM pref_typed_receipts WHERE source=? AND session=? AND hash=? AND at BETWEEN ? AND ?',
      )
      .get(origin.source, origin.sessionId, hash, at - 2000, at + 2000)
    if (!receipt) return false
    this.humanResponse(origin, responseId, at)
    return this.answer(origin, question, label, at, true)
  }

  /** Index an explicitly typed CLI history entry without retaining the person's original text.
   * @example evidence.typedReceipt({source:'codex', sessionId:'s'}, 'A', at)
   */
  typedReceipt(session: Session, typed: string, at: number): void {
    if (!validId(session.sessionId) || !time(at) || !typed) return
    const hash = digest(typed.trim())
    this.db
      .prepare('INSERT OR IGNORE INTO pref_typed_receipts VALUES(?,?,?,?)')
      .run(session.source, session.sessionId, hash, at)
    const instructions = this.db
      .prepare(
        'SELECT at,rules FROM pref_instruction_candidates WHERE source=? AND session=? AND hash=? AND at BETWEEN ? AND ?',
      )
      .all(session.source, session.sessionId, hash, at - 2000, at + 2000)
    for (const item of instructions)
      this.saveRules(
        session,
        Number(item.at),
        JSON.parse(String(item.rules)) as Constraint[],
      )
    const candidates = this.db
      .prepare(
        'SELECT tool,question,label,at,response_id FROM pref_typed_candidates WHERE source=? AND session=? AND hash=? AND at BETWEEN ? AND ?',
      )
      .all(session.source, session.sessionId, hash, at - 2000, at + 2000)
    for (const c of candidates) {
      const origin = { ...session, toolUseId: String(c.tool) }
      this.humanResponse(origin, String(c.response_id), Number(c.at))
      this.answer(
        origin,
        String(c.question),
        String(c.label),
        Number(c.at),
        true,
      )
    }
  }

  /** Rebuild the withheld-answer trials only after actual inputs change. Answers must precede the next question strictly.
   * @example evidence.replay()
   */
  replay(): ReplayReport {
    return this.transaction(() => {
      if (
        this.db.prepare('SELECT dirty FROM pref_state WHERE id=1').get()?.dirty
      ) {
        const offers = this.db
          .prepare(
            'SELECT source,session,tool,question,repo,kind,signature,asked,answered,selected FROM pref_observations ORDER BY asked',
          )
          .all() as unknown as Offer[]
        const replies = [...offers].sort((a, b) => a.answered! - b.answered!)
        const counts = new Map<string, Map<string, number>>()
        const bucket = (offer: Offer) =>
          offer.repo + '/' + offer.kind + '/' + offer.signature
        let next = 0
        this.db.exec('DELETE FROM pref_predictions')
        const trial = this.db.prepare(
          'INSERT INTO pref_predictions VALUES(?,?,?,?,?,?,?,?)',
        )
        for (const offer of offers) {
          // Insert a historical answer only after the time it became available, across concurrent sessions as well.
          while (
            next < replies.length &&
            replies[next]!.answered! < offer.asked
          ) {
            const previous = replies[next++]!
            const key = bucket(previous)
            const byChoice = counts.get(key) ?? new Map<string, number>()
            byChoice.set(
              previous.selected!,
              (byChoice.get(previous.selected!) ?? 0) + 1,
            )
            counts.set(key, byChoice)
          }
          const winner = localWinner(counts.get(bucket(offer)) ?? new Map())
          const predict =
            winner !== null &&
            permitsChoice(
              this.restrictions(
                { source: offer.source, sessionId: offer.session },
                offer.asked,
              ),
              offer.kind,
              winner,
            )
          trial.run(
            offer.source,
            offer.session,
            offer.tool,
            offer.question,
            offer.kind,
            offer.answered!,
            Number(predict),
            Number(predict && winner === offer.selected),
          )
        }
        this.db.exec('UPDATE pref_state SET dirty=0 WHERE id=1')
      }
      const rows = this.db
        .prepare(
          'SELECT kind, SUM(predicted) predictions, SUM(correct) correct, COUNT(*)-SUM(predicted) held FROM pref_predictions GROUP BY kind ORDER BY kind',
        )
        .all()
      const types = rows.map((row) => ({
        kind: String(row.kind),
        predictions: Number(row.predictions),
        correct: Number(row.correct),
        held: Number(row.held),
        eligible: isEligible(Number(row.predictions), Number(row.correct)),
      }))
      return {
        observations: types.reduce(
          (n, type) => n + type.predictions + type.held,
          0,
        ),
        types,
      }
    })
  }

  /** Look up an indexed, repository-scoped proposal. Only category names and counts may leave this boundary.
   * @example evidence.evaluate(card, repository, Date.now(), [], {source:'claude', sessionId:'s'})
   */
  evaluate(
    card: QuestionCard,
    repo: string | null,
    now: number,
    instructions: readonly string[],
    session?: Session,
  ): PreferenceDecision {
    const hold = (
      reason: string,
      summary: PreferenceSummary | null = null,
    ) => ({ eligibleLabel: null, reason, summary })
    const policy = classifyCard(card)
    if (!('card' in policy)) return hold(policy.reason)
    if (!repo || !time(now)) return hold('repository-unknown')
    const { kind, signature, choices } = policy.card
    const rows = this.db
      .prepare(
        'SELECT selected, SUM(repo=?) here, SUM(repo<>?) elsewhere FROM pref_observations WHERE kind=? AND signature=? AND answered<? GROUP BY selected',
      )
      .all(repo, repo, kind, signature, now)
    const stats = this.db
      .prepare(
        'SELECT COALESCE(SUM(predicted),0) predictions, COALESCE(SUM(correct),0) correct, COUNT(*)-COALESCE(SUM(predicted),0) held FROM pref_predictions WHERE kind=? AND answered<?',
      )
      .get(kind, now)!
    const replay = {
      predictions: Number(stats.predictions),
      correct: Number(stats.correct),
      held: Number(stats.held),
    }
    const totals = choices.map(({ meaning }) => {
      const row = rows.find((r) => r.selected === meaning)
      return {
        meaning,
        current: Number(row?.here ?? 0),
        other: Number(row?.elsewhere ?? 0),
      }
    })
    // A verified person can choose Other or qualify an answer. It counts in the denominator, but can never be delivered as a choice.
    const other = rows.find((row) => row.selected === otherResponse)
    if (other)
      totals.push({
        meaning: otherResponse,
        current: Number(other.here),
        other: Number(other.elsewhere),
      })
    const summary: PreferenceSummary = {
      kind,
      choices: totals,
      currentTotal: totals.reduce((n, c) => n + c.current, 0),
      otherTotal: totals.reduce((n, c) => n + c.other, 0),
      replay,
    }
    if (!summary.currentTotal) return hold('no-local-evidence', summary)
    if (this.db.prepare('SELECT dirty FROM pref_state WHERE id=1').get()?.dirty)
      return hold('replay-required', summary)
    const winner = localWinner(
      new Map(totals.map((c) => [c.meaning, c.current])),
    )
    if (!winner) return hold('insufficient-local-consensus', summary)
    if (!isEligible(replay.predictions, replay.correct))
      return hold('replay-threshold', summary)
    const constraints = [
      ...(session ? this.restrictions(session, now) : []),
      ...instructions.flatMap((s) => instructionConstraints(s, true)),
    ]
    if (!permitsChoice(constraints, kind, winner))
      return hold('current-instructions', summary)
    return {
      eligibleLabel: choices.find((o) => o.meaning === winner)!.label,
      reason: null,
      summary,
    }
  }
}
