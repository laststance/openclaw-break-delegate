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
import {
  uniqueTypedMatches,
  type TypedCandidate,
  type TypedReceipt,
} from './receipts.js'

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
  questionId?: string,
): string {
  if (clientId && validId(clientId)) return 'prompt:' + clientId
  if (questionId && validId(questionId))
    return (
      'typed:q:' +
      digest(text.normalize('NFKC').trim()) +
      ':' +
      digest(questionId)
    )
  return (
    'typed:' +
    digest(text.normalize('NFKC').trim()) +
    ':' +
    Math.floor(timestamp / 1000)
  )
}

/** Identify a preceding agent question across live and archived renderings when the provider omits its message ID.
 * @example typedQuestionId('Which option?',1730000000123)
 */
export function typedQuestionId(text: string, at: number): string {
  return 'question:' + digest(at + '\0' + text)
}

// Counts from another repository can describe a preference but cannot pass these two local thresholds.
function localWinner(counts: Map<string, number>): string | null {
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  if (total < 5) return null
  for (const [meaning, count] of counts)
    if (meaning !== otherResponse && count * 100 >= total * 80) return meaning
  return null
}

// Each row is already reduced by the provider decoder. Free-form human text never enters the support index.
const primaryTables = {
  pref_calls: 'source,session,tool,questions,asked',
  pref_pending_codex_outputs: 'session,tool',
  pref_offers: 'source,session,tool,question,options,repo,kind,signature,asked',
  pref_primary_choices: 'source,session,tool,question,selected,at',
  pref_responses: 'source,session,response_id,tool,at',
  pref_constraints: 'source,session,at,kind,required',
  pref_human_grants: 'source,session,tool,at',
  pref_gstack_selections: 'session,tool,summary,label,at',
  pref_instruction_candidates: 'source,session,hash,at,rules',
  pref_typed_candidates:
    'source,session,tool,question,hash,label,at,response_id',
  pref_misdirected_typed: 'source,session,tool,question,hash,at',
  pref_submissions: 'source,session,hash,at,submission',
  pref_direct_text: 'source,session,tool,response_id',
  pref_cancelled_instructions: 'source,session,hash,at',
} as const
type PrimaryTable = keyof typeof primaryTables
type FactValue = string | number

/** Own the SQLite evidence tables shared by imports, chronological replay, and the hook's bounded lookup.
 * @example new EvidenceDatabase(db)
 */
export class EvidenceDatabase {
  private owner = 'live'
  private deriving = false
  private frameEnd = 0
  private directSubmission?: { id: string; tool: string; rejected: boolean }

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
      CREATE TABLE IF NOT EXISTS pref_provisional_claims(source TEXT,session TEXT,tool TEXT,PRIMARY KEY(source,session,tool));
      CREATE TABLE IF NOT EXISTS pref_withdrawals(source TEXT,session TEXT,tool TEXT,seen INTEGER,PRIMARY KEY(source,session,tool));
      CREATE INDEX IF NOT EXISTS pref_withdrawal_times ON pref_withdrawals(seen);
      CREATE TABLE IF NOT EXISTS pref_decoder_versions(version TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS pref_constraints(source TEXT,session TEXT,at INTEGER,kind TEXT,required TEXT,
        PRIMARY KEY(source,session,at,kind,required));
      CREATE TABLE IF NOT EXISTS pref_predictions(source TEXT,session TEXT,tool TEXT,question TEXT,kind TEXT,answered INTEGER,
        predicted INTEGER,correct INTEGER,PRIMARY KEY(source,session,tool,question));
      CREATE INDEX IF NOT EXISTS pref_type_trials ON pref_predictions(kind,answered);
      CREATE TABLE IF NOT EXISTS pref_human_grants(source TEXT,session TEXT,tool TEXT,at INTEGER,PRIMARY KEY(source,session,tool));
      CREATE TABLE IF NOT EXISTS pref_calls(source TEXT,session TEXT,tool TEXT,questions TEXT,asked INTEGER,PRIMARY KEY(source,session,tool));
      CREATE TABLE IF NOT EXISTS pref_pending_codex_outputs(session TEXT,tool TEXT,PRIMARY KEY(session,tool));
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
      CREATE TABLE IF NOT EXISTS pref_misdirected_typed(source TEXT,session TEXT,tool TEXT,question TEXT,hash TEXT,at INTEGER,
        PRIMARY KEY(source,session,tool,question,hash,at));
      CREATE INDEX IF NOT EXISTS pref_typed_candidate_times ON pref_typed_candidates(source,session,hash,at);
      CREATE TABLE IF NOT EXISTS pref_submissions(source TEXT,session TEXT,hash TEXT,at INTEGER,submission TEXT,PRIMARY KEY(source,session,hash,at,submission));
      CREATE TABLE IF NOT EXISTS pref_fallback_links(source TEXT,session TEXT,tool TEXT,question TEXT,at INTEGER,PRIMARY KEY(source,session,tool,question,at));
      CREATE TABLE IF NOT EXISTS pref_direct_text(source TEXT,session TEXT,tool TEXT,response_id TEXT,PRIMARY KEY(source,session,tool,response_id));
      CREATE TABLE IF NOT EXISTS pref_direct_answers(source TEXT,session TEXT,tool TEXT,question TEXT,selected TEXT,at INTEGER,
        PRIMARY KEY(source,session,tool,question));
      CREATE TABLE IF NOT EXISTS pref_lost_typed(source TEXT,session TEXT,response_id TEXT,seen INTEGER,PRIMARY KEY(source,session,response_id));
      CREATE INDEX IF NOT EXISTS pref_lost_typed_times ON pref_lost_typed(seen);
      CREATE TABLE IF NOT EXISTS pref_files(path TEXT PRIMARY KEY,identity TEXT,offset INTEGER,anchor TEXT,skipping INTEGER,state TEXT);
      CREATE TABLE IF NOT EXISTS pref_file_segments(path TEXT,start INTEGER,stop INTEGER,hash TEXT,PRIMARY KEY(path,start));
      CREATE TABLE IF NOT EXISTS pref_file_versions(path TEXT PRIMARY KEY,stamp TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pref_legacy_refresh(path TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS pref_source_facts(owner TEXT, source TEXT, session TEXT, table_name TEXT, row_data TEXT,
        UNIQUE(owner,source,session,table_name,row_data));
      CREATE INDEX IF NOT EXISTS pref_source_sessions ON pref_source_facts(source,session);
      CREATE TABLE IF NOT EXISTS pref_structured_witnesses(owner TEXT,source TEXT,session TEXT,tool TEXT,shape TEXT,
        question TEXT,repo TEXT,selected TEXT,at INTEGER,PRIMARY KEY(owner,source,session,tool,shape,question,repo,selected,at));
      CREATE INDEX IF NOT EXISTS pref_structured_call ON pref_structured_witnesses(source,session,tool,shape,question,repo,at);
      CREATE TABLE IF NOT EXISTS pref_deferred_outputs(owner TEXT, source TEXT, session TEXT, tool TEXT, at INTEGER, frame INTEGER,
        PRIMARY KEY(owner,source,session,tool,at,frame));
      CREATE TABLE IF NOT EXISTS pref_direct_submissions(owner TEXT,source TEXT,session TEXT,response_id TEXT,tool TEXT,table_name TEXT,row_data TEXT,
        PRIMARY KEY(owner,source,session,response_id,tool,table_name,row_data));
      CREATE INDEX IF NOT EXISTS pref_direct_submission_id ON pref_direct_submissions(source,session,response_id,tool);
      CREATE TABLE IF NOT EXISTS pref_refuted_submissions(owner TEXT,source TEXT,session TEXT,response_id TEXT,PRIMARY KEY(owner,source,session,response_id));
      CREATE INDEX IF NOT EXISTS pref_refuted_submission_id ON pref_refuted_submissions(source,session,response_id);
      CREATE TABLE IF NOT EXISTS pref_native_targets(owner TEXT,source TEXT,session TEXT,response_id TEXT,target TEXT,PRIMARY KEY(owner,source,session,response_id,target));
      CREATE INDEX IF NOT EXISTS pref_native_target_id ON pref_native_targets(source,session,response_id,target);
      CREATE VIEW IF NOT EXISTS pref_ambiguous_submissions AS
        SELECT source,session,response_id FROM pref_refuted_submissions UNION ALL
        SELECT source,session,response_id FROM pref_native_targets GROUP BY source,session,response_id HAVING MIN(target)<>MAX(target) UNION ALL
        SELECT source,session,response_id FROM pref_direct_submissions GROUP BY source,session,response_id HAVING MIN(tool)<>MAX(tool);
      CREATE TABLE IF NOT EXISTS pref_primary_choices(source TEXT,session TEXT,tool TEXT,question TEXT,selected TEXT,at INTEGER,
        PRIMARY KEY(source,session,tool,question,selected,at));
      CREATE TABLE IF NOT EXISTS pref_shape_conflicts(source TEXT,session TEXT,tool TEXT,question TEXT,PRIMARY KEY(source,session,tool,question));
      CREATE TABLE IF NOT EXISTS pref_cancelled_instructions(source TEXT,session TEXT,hash TEXT,at INTEGER,PRIMARY KEY(source,session,hash,at));
      CREATE VIEW IF NOT EXISTS pref_observations AS SELECT o.* FROM pref_offers o WHERE o.answered IS NOT NULL AND o.conflict=0
        AND NOT EXISTS(SELECT 1 FROM pref_exclusions x WHERE x.source=o.source AND x.session=o.session AND x.tool=o.tool);
    `)
    this.transaction(() => {
      const applied = db
        .prepare('INSERT OR IGNORE INTO pref_decoder_versions VALUES(?)')
        .run('codex-explicit-origin-v2')
      if (!applied.changes) return
      // Older decoders could import a timed-out choice and checkpoint beyond its provenance. Quarantine just their structured Codex answers until re-read.
      db.prepare(
        `INSERT OR IGNORE INTO pref_withdrawals SELECT r.source,r.session,r.tool,? FROM pref_responses r
        JOIN pref_calls c USING(source,session,tool) WHERE r.source='codex'`,
      ).run(Date.now())
      db.exec(`DELETE FROM pref_responses WHERE source='codex' AND EXISTS
        (SELECT 1 FROM pref_calls c WHERE c.source=pref_responses.source AND c.session=pref_responses.session AND c.tool=pref_responses.tool);
        UPDATE pref_offers SET selected=NULL,answered=NULL WHERE source='codex' AND selected IS NOT NULL AND EXISTS
        (SELECT 1 FROM pref_calls c WHERE c.source=pref_offers.source AND c.session=pref_offers.session AND c.tool=pref_offers.tool);
        DELETE FROM pref_files WHERE json_type(state,'$.interactive') IS NOT NULL;`)
      db.exec(dirty)
    })
    this.transaction(() => {
      if (
        !db
          .prepare('INSERT OR IGNORE INTO pref_decoder_versions VALUES(?)')
          .run('unique-typed-receipts-v1').changes
      )
        return
      db.exec(`INSERT OR IGNORE INTO pref_submissions SELECT source,session,hash,at,'' FROM pref_typed_receipts;
        INSERT OR IGNORE INTO pref_fallback_links SELECT c.source,c.session,c.tool,c.question,c.at FROM pref_typed_candidates c
        WHERE EXISTS(SELECT 1 FROM pref_responses r WHERE r.source=c.source AND r.session=c.session AND r.tool=c.tool AND r.response_id=c.response_id)
        OR EXISTS(SELECT 1 FROM pref_offers o WHERE o.source=c.source AND o.session=c.session AND o.tool=c.tool AND o.question=c.question AND o.answered=c.at);`)
      for (const item of db
        .prepare(
          'SELECT DISTINCT source,session,hash,at FROM pref_typed_candidates',
        )
        .all()) {
        this.reconcileTyped(
          {
            source: item.source as EvidenceSource,
            sessionId: String(item.session),
          },
          String(item.hash),
          Number(item.at),
        )
      }
    })
    this.transaction(() => {
      if (
        !db
          .prepare('INSERT OR IGNORE INTO pref_decoder_versions VALUES(?)')
          .run('validated-direct-answer-v1').changes
      )
        return
      // The old marker proved authorship, but contained neither the question nor the validated selection. Revisit only sessions with those markers.
      db.exec(
        `DELETE FROM pref_files WHERE json_extract(state,'$.session') IN (SELECT session FROM pref_direct_text);`,
      )
      const stale = db
        .prepare(
          `UPDATE pref_offers AS o SET answered=NULL,selected=NULL WHERE o.answered IS NOT NULL
        AND EXISTS(SELECT 1 FROM pref_direct_text d WHERE (d.source,d.session,d.tool)=(o.source,o.session,o.tool))
        AND EXISTS(SELECT 1 FROM pref_typed_candidates c WHERE (c.source,c.session,c.tool,c.question)=(o.source,o.session,o.tool,o.question))
        AND NOT EXISTS(SELECT 1 FROM pref_fallback_links f WHERE (f.source,f.session,f.tool,f.question)=(o.source,o.session,o.tool,o.question))`,
        )
        .run()
      if (stale.changes) db.exec(dirty)
    })
    this.transaction(() => {
      if (
        !db
          .prepare('INSERT OR IGNORE INTO pref_decoder_versions VALUES(?)')
          .run('language-target-and-typed-question-v1').changes
      )
        return
      const language = db
        .prepare(
          "SELECT source,session,tool,question,options FROM pref_offers WHERE kind='response-language'",
        )
        .all()
      for (const row of language) {
        const result = classifyCard({
          question: String(row.question),
          options: (JSON.parse(String(row.options)) as { label: string }[]).map(
            ({ label }) => ({ label }),
          ),
        })
        const kind = 'card' in result ? result.card.kind : null
        db.prepare(
          'UPDATE pref_offers SET kind=?, conflict=MAX(conflict,?) WHERE source=? AND session=? AND tool=? AND question=?',
        ).run(
          kind ?? 'response-language',
          Number(!kind),
          row.source,
          row.session,
          row.tool,
          row.question,
        )
      }
      if (language.length) db.exec(dirty)
      // Older fallback identities can merge separate simultaneous replies. Re-read affected sessions and withdraw their previous aggregate identity.
      for (const row of db
        .prepare(
          `SELECT DISTINCT c.source,c.session,c.tool,c.question FROM pref_typed_candidates c
          JOIN pref_fallback_links f USING(source,session,tool,question,at) WHERE c.response_id GLOB 'typed:[0-9a-f]*'`,
        )
        .all()) {
        this.restoreDirectSelection(
          {
            source: row.source as EvidenceSource,
            sessionId: String(row.session),
            toolUseId: String(row.tool),
          },
          String(row.question),
          false,
        )
      }
      db.prepare(
        "INSERT OR REPLACE INTO pref_lost_typed SELECT source,session,response_id,? FROM pref_responses WHERE response_id GLOB 'typed:[0-9a-f]*'",
      ).run(Date.now())
      db.exec(`DELETE FROM pref_files WHERE json_extract(state,'$.session') IN (SELECT session FROM pref_responses WHERE response_id GLOB 'typed:[0-9a-f]*' UNION SELECT session FROM pref_typed_candidates WHERE response_id GLOB 'typed:[0-9a-f]*');
        DELETE FROM pref_fallback_links AS f WHERE EXISTS(SELECT 1 FROM pref_typed_candidates c WHERE (c.source,c.session,c.tool,c.question,c.at)=(f.source,f.session,f.tool,f.question,f.at) AND c.response_id GLOB 'typed:[0-9a-f]*');
        DELETE FROM pref_typed_candidates WHERE response_id GLOB 'typed:[0-9a-f]*';
        DELETE FROM pref_responses WHERE response_id GLOB 'typed:[0-9a-f]*';`)
    })
    this.transaction(() => {
      if (
        !db
          .prepare('INSERT OR IGNORE INTO pref_decoder_versions VALUES(?)')
          .run('orphaned-typed-selection-v1').changes
      )
        return
      // Earlier upgrades could remove a legacy receipt before clearing its learned answer. The historical workload withdrawal identifies the affected sessions.
      for (const row of db
        .prepare(
          `SELECT o.source,o.session,o.tool,o.question FROM pref_offers o WHERE o.tool GLOB 'brief-*' AND o.answered IS NOT NULL
        AND EXISTS(SELECT 1 FROM pref_lost_typed l WHERE l.source=o.source AND l.session=o.session AND l.response_id GLOB 'typed:[0-9a-f]*')
        AND NOT EXISTS(SELECT 1 FROM pref_fallback_links f WHERE (f.source,f.session,f.tool,f.question)=(o.source,o.session,o.tool,o.question))
        AND NOT EXISTS(SELECT 1 FROM pref_responses r WHERE (r.source,r.session,r.tool)=(o.source,o.session,o.tool))`,
        )
        .all()) {
        this.restoreDirectSelection(
          {
            source: row.source as EvidenceSource,
            sessionId: String(row.session),
            toolUseId: String(row.tool),
          },
          String(row.question),
        )
      }
      // Reassess older accepted matches when both native and anonymous receipts were available, and reread Codex sessions whose native reply links were previously ignored.
      const mixed = db
        .prepare(
          `SELECT DISTINCT c.source,c.session,c.hash,c.at FROM pref_typed_candidates c
        WHERE EXISTS(SELECT 1 FROM pref_submissions r WHERE (r.source,r.session,r.hash)=(c.source,c.session,c.hash) AND r.submission='' AND r.at BETWEEN c.at-2000 AND c.at+2000)
        AND EXISTS(SELECT 1 FROM pref_submissions r WHERE (r.source,r.session,r.hash)=(c.source,c.session,c.hash) AND r.submission<>'' AND r.at BETWEEN c.at-2000 AND c.at+2000)`,
        )
        .all()
      for (const row of mixed)
        this.reconcileTyped(
          {
            source: row.source as EvidenceSource,
            sessionId: String(row.session),
          },
          String(row.hash),
          Number(row.at),
        )
      db.exec(`DELETE FROM pref_files WHERE json_type(state,'$.interactive') IS NOT NULL AND json_extract(state,'$.session') IN
        (SELECT DISTINCT c.session FROM pref_typed_candidates c WHERE c.source='codex' AND EXISTS
          (SELECT 1 FROM pref_submissions r WHERE (r.source,r.session,r.hash)=(c.source,c.session,c.hash) AND r.submission<>'' AND r.at BETWEEN c.at-2000 AND c.at+2000))`)
    })
    this.transaction(() => {
      const upgrade = db
        .prepare('INSERT OR IGNORE INTO pref_decoder_versions VALUES(?)')
        .run('history-source-ownership-v1')
      if (
        !upgrade.changes ||
        db.prepare('SELECT 1 FROM pref_source_facts LIMIT 1').get()
      )
        return
      // Earlier checkpoints had no per-file provenance. Re-index them once, preserving separately witnessed live or native replies.
      db.exec(
        'INSERT OR IGNORE INTO pref_legacy_refresh SELECT path FROM pref_files',
      )
      const sessions = db
        .prepare(
          `SELECT source,session FROM pref_responses UNION SELECT source,session FROM pref_calls
        UNION SELECT source,session FROM pref_typed_candidates UNION SELECT source,session FROM pref_instruction_candidates
        UNION SELECT source,session FROM pref_submissions UNION SELECT source,session FROM pref_constraints`,
        )
        .all()
      for (const item of sessions) {
        const session = {
          source: item.source as EvidenceSource,
          sessionId: String(item.session),
        }
        this.adoptLegacySession(session)
        this.derived(() => this.restoreSession(session))
      }
    })
    this.transaction(() => {
      if (
        !db
          .prepare('INSERT OR IGNORE INTO pref_decoder_versions VALUES(?)')
          .run('revalidated-native-links-and-structured-witnesses-v1').changes
      )
        return
      const affected = this.upgradeStructuredWitnesses()
      // The older decoder could assign an explicitly linked native reply to the adjacent brief or retain its text as a standing rule.
      const typedFiles = db
        .prepare(
          `SELECT path,identity FROM pref_files WHERE json_type(state,'$.interactive') IS NOT NULL AND
        (json_type(state,'$.lastText') IS NOT NULL OR EXISTS(SELECT 1 FROM pref_source_facts f
          WHERE f.owner=pref_files.path||'/'||pref_files.identity AND f.table_name IN ('pref_constraints','pref_instruction_candidates','pref_typed_candidates','pref_direct_text')))`,
        )
        .all()
      const legacy = db
        .prepare(
          "SELECT DISTINCT source,session FROM pref_source_facts WHERE source='codex' AND owner='legacy-instruction' AND table_name='pref_constraints'",
        )
        .all()
      db.exec(
        "DELETE FROM pref_source_facts WHERE source='codex' AND owner='legacy-instruction' AND table_name='pref_constraints'",
      )
      for (const file of typedFiles) {
        db.prepare('INSERT OR IGNORE INTO pref_legacy_refresh VALUES(?)').run(
          file.path,
        )
        this.withdrawSource(String(file.path) + '/' + String(file.identity))
      }
      this.derived(() => {
        for (const row of legacy)
          affected.set(JSON.stringify(['codex', row.session]), {
            source: 'codex',
            sessionId: String(row.session),
          })
        for (const session of affected.values()) this.restoreSession(session)
      })
    })
    this.transaction(() => {
      if (
        !db
          .prepare('INSERT OR IGNORE INTO pref_decoder_versions VALUES(?)')
          .run('native-submission-attribution-v2').changes
      )
        return
      // Older native IDs were not tied to each choice and standing instruction they produced.
      // An older result-first scan left no indication of its ignored frames. Schedule every interactive Codex transcript once.
      const files = db
        .prepare(
          `SELECT path,identity, (json_type(state,'$.lastText') IS NOT NULL OR EXISTS(SELECT 1 FROM pref_source_facts f
        WHERE f.owner=pref_files.path||'/'||pref_files.identity AND f.table_name='pref_direct_text')) AS typed
        FROM pref_files WHERE json_extract(state,'$.interactive')=1`,
        )
        .all()
      for (const row of files) {
        db.prepare('INSERT OR IGNORE INTO pref_legacy_refresh VALUES(?)').run(
          row.path,
        )
        if (row.typed)
          this.withdrawSource(String(row.path) + '/' + String(row.identity))
      }
    })
  }

  /** Recover original shapes from a pre-fingerprint cache, rereading a split result's own source when the call's old shape cannot be proved.
   * @example this.upgradeStructuredWitnesses()
   */
  private upgradeStructuredWitnesses(): Map<string, Session> {
    const affected = new Map<string, Session>()
    const outputs = this.db
      .prepare(
        `SELECT rowid,owner,source,session,row_data FROM pref_source_facts WHERE owner<>'live' AND table_name='pref_responses'
      AND json_extract(row_data,'$[2]')='tool:'||json_extract(row_data,'$[3]')`,
      )
      .all()
    const choices = this.db
      .prepare(`SELECT rowid,row_data FROM pref_source_facts WHERE owner=? AND source=? AND session=? AND table_name='pref_primary_choices'
      AND json_extract(row_data,'$[2]')=? AND json_extract(row_data,'$[5]')=?`)
    const original = this.db
      .prepare(`SELECT 1 FROM pref_source_facts f JOIN pref_calls c
      ON c.source=f.source AND c.session=f.session AND c.tool=json_extract(f.row_data,'$[2]') AND c.questions=json_extract(f.row_data,'$[3]')
      WHERE f.owner=? AND f.source=? AND f.session=? AND f.table_name='pref_calls' AND c.tool=? AND c.asked<=? AND json_extract(f.row_data,'$[4]')<=?`)
    const refresh = this.db.prepare(
      "INSERT OR IGNORE INTO pref_legacy_refresh SELECT path FROM pref_files WHERE path||'/'||identity=?",
    )
    const retire = this.db.prepare(
      'DELETE FROM pref_source_facts WHERE rowid=?',
    )
    for (const row of outputs) {
      const session = {
        source: row.source as EvidenceSource,
        sessionId: String(row.session),
      }
      const owner = String(row.owner)
      const response = JSON.parse(String(row.row_data)) as FactValue[]
      const scope = [
        owner,
        session.source,
        session.sessionId,
        response[3]!,
        response[4]!,
      ] as const
      const selections = choices.all(...scope)
      // A different physical source might have changed the question since this unlabelled result was first decoded.
      if (original.get(...scope, response[4]!)) {
        this.rememberStructured('pref_responses', session, response, owner)
        for (const choice of selections)
          this.rememberStructured(
            'pref_primary_choices',
            session,
            JSON.parse(String(choice.row_data)) as FactValue[],
            owner,
          )
      } else refresh.run(owner)
      retire.run(row.rowid)
      for (const choice of selections) retire.run(choice.rowid)
      affected.set(JSON.stringify([session.source, session.sessionId]), session)
    }
    return affected
  }

  /** Preserve provable live and native replies when {@link EvidenceDatabase} upgrades an unowned history cache.
   * @example this.adoptLegacySession({source:'codex',sessionId:'s'})
   */
  private adoptLegacySession(session: Session): void {
    const args = [session.source, session.sessionId] as const
    // Archived structured answers always had a native call. Only a positively witnessed live hook could have produced one without it.
    const live = `r.response_id='tool:'||r.tool AND NOT EXISTS(SELECT 1 FROM pref_calls c WHERE (c.source,c.session,c.tool)=(r.source,r.session,r.tool))`
    const candidateFiles = this.db
      .prepare(
        `SELECT path||'/'||identity AS owner FROM pref_files WHERE json_extract(state,'$.session')=?
      AND CASE WHEN json_type(state,'$.interactive') IS NULL THEN 'claude' ELSE 'codex' END=?`,
      )
      .all(session.sessionId, session.source)
    const directOwner =
      candidateFiles.length > 1
        ? undefined
        : candidateFiles.length
          ? String(candidateFiles[0]!.owner)
          : 'legacy-confirmed-native'
    const adopt = (
      table: PrimaryTable,
      values: readonly FactValue[],
      owner: string,
    ) => this.primary(table, session, values, owner)
    const offers = this.db
      .prepare(
        `SELECT o.*, EXISTS(SELECT 1 FROM pref_responses r WHERE (r.source,r.session,r.tool)=(o.source,o.session,o.tool) AND ${live}) AS live,
      d.selected AS confirmed,d.at AS confirmed_at FROM pref_offers o LEFT JOIN pref_direct_answers d USING(source,session,tool,question)
      WHERE o.source=? AND o.session=?`,
      )
      .all(...args)
    for (const item of offers) {
      const owner = item.live ? 'live' : item.confirmed && directOwner
      if (typeof owner !== 'string' || item.conflict) continue
      const key = [...args, String(item.tool), String(item.question)]
      adopt(
        'pref_offers',
        [
          ...key,
          String(item.options),
          String(item.repo),
          String(item.kind),
          String(item.signature),
          Number(item.asked),
        ],
        owner,
      )
      const selected = item.live ? item.selected : item.confirmed
      const at = item.live ? item.answered : item.confirmed_at
      if (selected !== null && at !== null)
        adopt(
          'pref_primary_choices',
          [...key, String(selected), Number(at)],
          owner,
        )
    }
    const responses = this.db
      .prepare(
        `SELECT r.*,(${live}) AS live, EXISTS(SELECT 1 FROM pref_direct_text d
      WHERE (d.source,d.session,d.tool,d.response_id)=(r.source,r.session,r.tool,r.response_id)) AS direct FROM pref_responses r WHERE source=? AND session=?`,
      )
      .all(...args)
    for (const row of responses) {
      const owner = row.live ? 'live' : row.direct && directOwner
      if (typeof owner !== 'string') continue
      adopt(
        'pref_responses',
        [...args, String(row.response_id), String(row.tool), Number(row.at)],
        owner,
      )
      if (row.direct)
        adopt(
          'pref_direct_text',
          [...args, String(row.tool), String(row.response_id)],
          owner,
        )
    }
    // Only Claude had an independent live instruction hook. An unowned Codex constraint needs its original transcript.
    if (session.source !== 'claude') return
    for (const row of this.db
      .prepare(
        'SELECT at,kind,required FROM pref_constraints WHERE source=? AND session=?',
      )
      .all(...args))
      adopt(
        'pref_constraints',
        [...args, Number(row.at), String(row.kind), String(row.required)],
        'legacy-instruction',
      )
  }

  /** Keep joins between independent inputs from certifying their own conclusions during later reconstruction.
   * @example this.derived(() => this.reconcileGstack(origin))
   */
  private derived<T>(work: () => T): T {
    const previous = this.deriving
    this.deriving = true
    try {
      return work()
    } finally {
      this.deriving = previous
    }
  }

  /** Bind an archived output to the exact form it answered so its input file can be re-indexed independently.
   * Only the form fingerprint, normalized meaning, and source metadata enter this record.
   * @example this.rememberStructured('pref_responses', session, ['codex','s','tool:t','t',2000], owner)
   */
  private rememberStructured(
    table: PrimaryTable,
    session: Session,
    values: readonly FactValue[],
    owner: string,
  ): boolean {
    if (
      owner === 'live' ||
      (table !== 'pref_responses' && table !== 'pref_primary_choices')
    )
      return false
    const choice = table === 'pref_primary_choices'
    const tool = String(values[choice ? 2 : 3])
    if (!choice && values[2] !== 'tool:' + tool) return false
    const at = Number(values[choice ? 5 : 4])
    const key = [session.source, session.sessionId, tool] as const
    const call = this.db
      .prepare(
        'SELECT questions FROM pref_calls WHERE source=? AND session=? AND tool=? AND asked<=?',
      )
      .get(...key, at)
    if (!call) return false
    const question = choice ? String(values[3]) : ''
    const repo = choice
      ? this.db
          .prepare(
            'SELECT repo FROM pref_offers WHERE source=? AND session=? AND tool=? AND question=? AND asked<=?',
          )
          .get(...key, question, at)?.repo
      : ''
    if (typeof repo !== 'string') return false
    this.db
      .prepare(
        'INSERT OR IGNORE INTO pref_structured_witnesses VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        owner,
        ...key,
        digest(String(call.questions)),
        question,
        repo,
        choice ? String(values[4]) : '',
        at,
      )
    return true
  }

  /** Re-enable a surviving provider result when this exact form and its original chronology are known again.
   * @example this.restoreStructuredResponse(origin, serializedQuestions, askedAt)
   */
  private restoreStructuredResponse(
    origin: Origin,
    questions: string,
    askedAt: number,
  ): void {
    const response = this.db
      .prepare(
        "SELECT MIN(at) AS at FROM pref_structured_witnesses WHERE source=? AND session=? AND tool=? AND shape=? AND question='' AND at>=?",
      )
      .get(...fields(origin), digest(questions), askedAt)
    if (typeof response?.at === 'number')
      this.derived(() =>
        this.humanResponse(
          origin,
          'tool:' + origin.toolUseId,
          Number(response.at),
        ),
      )
  }

  /** Rejoin verified option meanings only after their source question, repo and response order agree.
   * @example this.restoreStructuredChoices(origin,question,repo)
   */
  private restoreStructuredChoices(
    origin: Origin,
    question: string,
    repo: string,
  ): void {
    const call = this.db
      .prepare(
        'SELECT questions,asked FROM pref_calls WHERE source=? AND session=? AND tool=?',
      )
      .get(...fields(origin))
    if (!call || this.isPermanentlyExcluded(origin)) return
    const proof = this.db
      .prepare(
        'SELECT selected,at FROM pref_structured_witnesses WHERE source=? AND session=? AND tool=? AND shape=? AND question=? AND repo=? AND at>=?',
      )
      .all(
        ...fields(origin),
        digest(String(call.questions)),
        question,
        repo,
        call.asked!,
      )
    if (!proof.length) return
    const offer = this.db
      .prepare(
        'SELECT options FROM pref_offers WHERE source=? AND session=? AND tool=? AND question=? AND repo=?',
      )
      .get(...fields(origin), question, repo)
    if (!offer) return
    const choices = JSON.parse(String(offer.options)) as {
      label: string
      meaning: string
    }[]
    this.derived(() => {
      for (const row of proof) {
        const label = choices.find(
          (choice) => choice.meaning === row.selected,
        )?.label
        if (!label && row.selected !== otherResponse) continue
        this.insertPrimary('pref_primary_choices', origin, [
          ...fields(origin),
          question,
          String(row.selected),
          Number(row.at),
        ])
        // Replaying an already verified choice must retain disagreement from any other surviving witness.
        this.answer(origin, question, label ?? '', Number(row.at), true)
      }
    })
  }

  /** Keep the exact byte boundary of a decoded frame so only that authenticated result is revisited later.
   * @example evidence.decodeFrame(end, () => parseHistoryRow(evidence, format, state, row, counts))
   */
  decodeFrame(end: number, decode: () => void): void {
    const old = this.frameEnd
    this.frameEnd = end
    try {
      decode()
    } finally {
      this.frameEnd = old
    }
  }

  /** Remember which local source to revisit after a matching Codex question arrives, without retaining the unbound answer text.
   * @example evidence.deferStructuredResult(origin, answeredAt)
   */
  deferStructuredResult(origin: Origin, at: number): void {
    if (
      !this.frameEnd ||
      origin.source !== 'codex' ||
      !validId(origin.sessionId) ||
      !validId(origin.toolUseId) ||
      !time(at) ||
      this.isPermanentlyExcluded(origin)
    )
      return
    this.db
      .prepare(
        'INSERT OR IGNORE INTO pref_deferred_outputs VALUES(?,?,?,?,?,?)',
      )
      .run(this.owner, ...fields(origin), at, this.frameEnd)
  }

  /** Settle the exact source frame when the importer can validate its offer, including a known repository mismatch.
   * @example evidence.settleStructuredResult(origin, answeredAt, repo)
   */
  settleStructuredResult(
    origin: Origin,
    at: number,
    repo?: string | null,
  ): boolean {
    this.db
      .prepare(
        'DELETE FROM pref_deferred_outputs WHERE owner=? AND source=? AND session=? AND tool=? AND at=? AND frame=?',
      )
      .run(this.owner, ...fields(origin), at, this.frameEnd)
    return (
      !repo ||
      !this.db
        .prepare(
          'SELECT 1 FROM pref_offers WHERE source=? AND session=? AND tool=? AND repo<>? LIMIT 1',
        )
        .get(...fields(origin), repo)
    )
  }

  /** Locate only committed local files whose previously unbound outputs now have an eligible earlier question.
   * @example evidence.readyResultFiles()
   */
  readyResultFiles(): Map<string, Set<number>> {
    const ready = new Map<string, Set<number>>()
    const query = this.db
      .prepare(`SELECT f.path,d.frame FROM pref_deferred_outputs d JOIN pref_calls c USING(source,session,tool)
      JOIN pref_files f ON d.owner=f.path||'/'||f.identity WHERE c.asked<=d.at AND NOT EXISTS(SELECT 1 FROM pref_exclusions x
      WHERE (x.source,x.session,x.tool)=(d.source,d.session,d.tool) AND NOT EXISTS(SELECT 1 FROM pref_provisional_claims p WHERE (p.source,p.session,p.tool)=(x.source,x.session,x.tool)))`)
    for (const row of query.iterate()) {
      const path = String(row.path),
        ends = ready.get(path) ?? new Set<number>()
      ends.add(Number(row.frame))
      ready.set(path, ends)
    }
    return ready
  }

  /** Attach an independently decoded record even when another file or live hook has already supplied the same canonical row.
   * @example evidence.primary('pref_calls', origin, ['claude','s','t','[]',1])
   */
  primary(
    table: PrimaryTable,
    session: Session,
    values: readonly FactValue[],
    owner = this.owner,
  ): void {
    if (this.deriving) return
    if (this.directSubmission) {
      this.db
        .prepare(
          'INSERT OR IGNORE INTO pref_direct_submissions VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          owner,
          session.source,
          session.sessionId,
          this.directSubmission.id,
          this.directSubmission.tool,
          table,
          JSON.stringify(values),
        )
      return
    }
    if (this.rememberStructured(table, session, values, owner)) return
    // The decoder supplies this validated request before writing its materialized row; workload needs no policy-classifiable option.
    if (table === 'pref_calls')
      this.restoreStructuredResponse(
        { ...session, toolUseId: String(values[2]) },
        String(values[3]),
        Number(values[4]),
      )
    this.db
      .prepare('INSERT OR IGNORE INTO pref_source_facts VALUES(?,?,?,?,?)')
      .run(
        owner,
        session.source,
        session.sessionId,
        table,
        JSON.stringify(values),
      )
  }

  private insertPrimary(
    table: PrimaryTable,
    session: Session,
    values: readonly FactValue[],
  ) {
    this.primary(table, session, values)
    if (!this.deriving && this.directSubmission?.rejected) return { changes: 0 }
    const placeholders = values.map(() => '?').join(',')
    return this.db
      .prepare(
        'INSERT OR IGNORE INTO ' +
          table +
          '(' +
          primaryTables[table] +
          ') VALUES(' +
          placeholders +
          ')',
      )
      .run(...values)
  }

  /** Remove the changed generation's claims, then rebuild only its affected sessions from independent normalized records.
   * Permanent provider and delivery exclusions remain authoritative throughout the transaction.
   * @example evidence.withdrawSource(sourceKey)
   */
  withdrawSource(owner: string): void {
    const tables = [
      'pref_source_facts',
      'pref_structured_witnesses',
      'pref_direct_submissions',
      'pref_refuted_submissions',
      'pref_native_targets',
    ]
    const sessions = this.db
      .prepare(
        tables
          .map(
            (table) => 'SELECT source,session FROM ' + table + ' WHERE owner=?',
          )
          .join(' UNION '),
      )
      .all(...tables.map(() => owner))
    for (const table of [...tables, 'pref_deferred_outputs'])
      this.db.prepare('DELETE FROM ' + table + ' WHERE owner=?').run(owner)
    this.derived(() => {
      for (const row of sessions)
        this.restoreSession({
          source: row.source as EvidenceSource,
          sessionId: String(row.session),
        })
    })
  }

  /** Rebuild the affected session after {@link EvidenceDatabase.withdrawSource} removes one physical witness.
   * @example this.restoreSession({source:'claude',sessionId:'s'})
   */
  private restoreSession(session: Session): void {
    const args = [session.source, session.sessionId] as const
    // Workload withdrawals are reversible. A surviving independent response is filtered out again by unmatchedSince.
    this.db
      .prepare(
        'INSERT OR REPLACE INTO pref_lost_typed SELECT source,session,response_id,? FROM pref_responses WHERE source=? AND session=?',
      )
      .run(Date.now(), ...args)
    const tables = Object.keys(primaryTables) as PrimaryTable[]
    for (const table of [
      ...tables,
      'pref_fallback_links',
      'pref_direct_answers',
      'pref_shape_conflicts',
      'pref_typed_receipts',
    ]) {
      if (
        table === 'pref_gstack_selections' ||
        table === 'pref_pending_codex_outputs'
      ) {
        if (
          session.source ===
          (table === 'pref_gstack_selections' ? 'claude' : 'codex')
        )
          this.db
            .prepare('DELETE FROM ' + table + ' WHERE session=?')
            .run(session.sessionId)
      } else
        this.db
          .prepare('DELETE FROM ' + table + ' WHERE source=? AND session=?')
          .run(...args)
    }
    const load = this.db.prepare(
      `SELECT row_data FROM pref_source_facts WHERE source=? AND session=? AND table_name=?
       UNION SELECT d.row_data FROM pref_direct_submissions d WHERE d.source=? AND d.session=? AND d.table_name=? AND NOT EXISTS
       (SELECT 1 FROM pref_ambiguous_submissions r WHERE (r.source,r.session,r.response_id)=(d.source,d.session,d.response_id))`,
    )
    for (const table of tables) {
      for (const fact of load.iterate(...args, table, ...args, table)) {
        const values = JSON.parse(String(fact.row_data)) as FactValue[]
        if (table === 'pref_offers') this.noteShape(values)
        this.insertPrimary(table, session, values)
      }
    }
    this.db
      .prepare(
        `DELETE FROM pref_responses AS r WHERE source=? AND session=? AND response_id GLOB 'tool:*'
      AND NOT EXISTS(SELECT 1 FROM pref_calls c WHERE (c.source,c.session,c.tool)=(r.source,r.session,r.tool))
      AND NOT EXISTS(SELECT 1 FROM pref_source_facts f WHERE f.owner='live' AND f.table_name='pref_responses'
        AND (f.source,f.session)=(r.source,r.session) AND json_extract(f.row_data,'$[2]')=r.response_id)`,
      )
      .run(...args)
    this.db
      .prepare(
        'INSERT OR IGNORE INTO pref_typed_receipts SELECT source,session,hash,at FROM pref_submissions WHERE source=? AND session=?',
      )
      .run(...args)
    this.db
      .prepare(
        `DELETE FROM pref_instruction_candidates AS c WHERE source=? AND session=? AND EXISTS
       (SELECT 1 FROM pref_cancelled_instructions x WHERE (x.source,x.session,x.hash,x.at)=(c.source,c.session,c.hash,c.at))`,
      )
      .run(...args)
    const rules = this.db
      .prepare(`SELECT c.at,c.rules FROM pref_instruction_candidates c WHERE source=? AND session=? AND EXISTS
      (SELECT 1 FROM pref_typed_receipts r WHERE (r.source,r.session,r.hash)=(c.source,c.session,c.hash) AND r.at BETWEEN c.at-2000 AND c.at+2000)`)
    for (const row of rules.all(...args))
      this.saveRules(
        session,
        Number(row.at),
        JSON.parse(String(row.rules)) as Constraint[],
      )
    const calls = this.db.prepare(
      'SELECT tool,questions,asked FROM pref_calls WHERE source=? AND session=?',
    )
    for (const row of calls.all(...args))
      this.restoreStructuredResponse(
        { ...session, toolUseId: String(row.tool) },
        String(row.questions),
        Number(row.asked),
      )
    const offers = this.db
      .prepare(
        'SELECT tool,question,repo FROM pref_offers WHERE source=? AND session=?',
      )
      .all(...args)
    for (const row of offers) {
      const origin = { ...session, toolUseId: String(row.tool) }
      this.restoreStructuredChoices(
        origin,
        String(row.question),
        String(row.repo),
      )
      this.restoreDirectSelection(origin, String(row.question))
    }
    for (const row of this.db
      .prepare(
        'SELECT DISTINCT hash FROM pref_typed_candidates WHERE source=? AND session=?',
      )
      .all(...args))
      this.reconcileTyped(session, String(row.hash), 0)
    for (const row of this.db
      .prepare(
        'SELECT tool FROM pref_human_grants WHERE source=? AND session=?',
      )
      .all(...args))
      this.reconcileGstack({ ...session, toolUseId: String(row.tool) })
    this.db.exec(dirty)
  }

  private noteShape(values: readonly FactValue[]): void {
    const key = values.slice(0, 4)
    const previous = this.db
      .prepare(
        'SELECT options,repo,kind,signature FROM pref_offers WHERE source=? AND session=? AND tool=? AND question=?',
      )
      .get(...key)
    if (
      previous &&
      ['options', 'repo', 'kind', 'signature'].some(
        (field, index) => previous[field] !== values[index + 4],
      )
    )
      this.db
        .prepare('INSERT OR IGNORE INTO pref_shape_conflicts VALUES(?,?,?,?)')
        .run(...key)
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
      this.isPermanentlyExcluded(origin)
    )
      return
    if (responseId.startsWith('typed:q:')) {
      const legacy =
        'typed:' + responseId.split(':')[2] + ':' + Math.floor(at / 1000)
      const prior = this.db
        .prepare(
          'DELETE FROM pref_responses WHERE source=? AND session=? AND tool=? AND response_id=?',
        )
        .run(...fields(origin), legacy)
      if (prior.changes)
        this.db
          .prepare('INSERT OR REPLACE INTO pref_lost_typed VALUES(?,?,?,?)')
          .run(origin.source, origin.sessionId, legacy, Date.now())
    }
    this.insertPrimary('pref_responses', origin, [
      origin.source,
      origin.sessionId,
      responseId,
      origin.toolUseId,
      at,
    ])
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

  /** Expose newly disqualified origins to the workload owner, without returning raw input or removing freshly revalidated replies.
   * @example evidence.withdrawalsSince(Date.now()-3600000)
   */
  withdrawalsSince(since: number): HumanResponse[] {
    const rows = this.db
      .prepare(
        `SELECT w.source,w.session,w.tool,w.seen FROM pref_withdrawals w WHERE w.seen>=?
      AND NOT EXISTS(SELECT 1 FROM pref_provisional_claims p WHERE p.source=w.source AND p.session=w.session AND p.tool=w.tool)
      AND (EXISTS(SELECT 1 FROM pref_exclusions x WHERE x.source=w.source AND x.session=w.session AND x.tool=w.tool)
        OR NOT EXISTS(SELECT 1 FROM pref_responses r WHERE r.source=w.source AND r.session=w.session AND r.tool=w.tool)) ORDER BY w.seen`,
      )
      .all(since)
    return rows.map((row) => ({
      source: row.source as EvidenceSource,
      sessionId: String(row.session),
      responseId: 'tool:' + String(row.tool),
      at: Number(row.seen),
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

  /** Retain positively attributed human evidence behind a provisional claim in case the original hook later proves it wrote zero bytes.
   * @example evidence.isPermanentlyExcluded(origin)
   */
  isPermanentlyExcluded(origin: Origin): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM pref_exclusions x WHERE x.source=? AND x.session=? AND x.tool=?
      AND NOT EXISTS(SELECT 1 FROM pref_provisional_claims p WHERE p.source=x.source AND p.session=x.session AND p.tool=x.tool)`,
      )
      .get(...fields(origin))
  }

  /** Keep the source cursor, its provenance, and its observations consistent when a batch fails or the process restarts.
   * @example evidence.transaction(() => evidence.exclude(origin))
   */
  transaction<T>(work: () => T, owner = this.owner): T {
    const previous = this.owner
    this.db.exec('SAVEPOINT pref_batch')
    this.owner = owner
    try {
      const result = work()
      this.db.exec('RELEASE pref_batch')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK TO pref_batch; RELEASE pref_batch')
      throw error
    } finally {
      this.owner = previous
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
    const values = [
      ...args,
      options,
      input.repo,
      kind,
      signature,
      input.askedAt,
    ]
    this.primary('pref_offers', input, values)
    if (saved) {
      // Two conflicting originals for one call cannot establish what options were actually offered.
      if (
        saved.repo !== input.repo ||
        saved.signature !== signature ||
        saved.kind !== kind ||
        saved.options !== options
      ) {
        this.noteShape(values)
        this.db
          .prepare(
            'UPDATE pref_offers SET conflict=1 WHERE source=? AND session=? AND tool=? AND question=?',
          )
          .run(...args)
        this.db.exec(dirty)
        return false
      }
    } else
      this.db
        .prepare(
          'INSERT INTO pref_offers(source,session,tool,question,options,repo,kind,signature,asked) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(...args, options, input.repo, kind, signature, input.askedAt)
    this.restoreStructuredChoices(input, question, input.repo)
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
      answeredAt < offer.asked ||
      this.isPermanentlyExcluded(origin)
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
    if (!this.deriving) {
      const values = [...args, meaning, answeredAt]
      this.insertPrimary('pref_primary_choices', origin, values)
    }
    if (offer.conflict || (!this.deriving && this.directSubmission?.rejected))
      return false
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

  /** Permanently exclude an automated or ambiguous provider result, including a call already hidden by a delivery claim.
   * @example evidence.exclude({source:'claude', sessionId:'s', toolUseId:'t'})
   */
  exclude(origin: Origin, seenAt = Date.now()): void {
    if (!validId(origin.sessionId) || !validId(origin.toolUseId)) return
    const provisional = this.db
      .prepare(
        'DELETE FROM pref_provisional_claims WHERE source=? AND session=? AND tool=?',
      )
      .run(...fields(origin))
    const result = this.db
      .prepare('INSERT OR IGNORE INTO pref_exclusions VALUES(?,?,?)')
      .run(...fields(origin))
    if (result.changes || provisional.changes)
      this.db
        .prepare(
          'INSERT INTO pref_withdrawals VALUES(?,?,?,?) ON CONFLICT(source,session,tool) DO UPDATE SET seen=MAX(seen,excluded.seen)',
        )
        .run(...fields(origin), seenAt)
    if (result.changes) this.invalidateAnswered(origin)
  }

  private invalidateAnswered(origin: Origin): void {
    if (
      this.db
        .prepare(
          'SELECT 1 FROM pref_offers WHERE source=? AND session=? AND tool=? AND answered IS NOT NULL LIMIT 1',
        )
        .get(...fields(origin))
    )
      this.db.exec(dirty)
  }

  /** Hide a pending delivery's evidence from replay and workload without issuing a permanent withdrawal.
   * @example evidence.claimDelivery(origin)
   */
  claimDelivery(origin: Origin): void {
    if (
      !validId(origin.sessionId) ||
      !validId(origin.toolUseId) ||
      this.isExcluded(origin)
    )
      return
    this.db
      .prepare('INSERT INTO pref_provisional_claims VALUES(?,?,?)')
      .run(...fields(origin))
    this.db
      .prepare('INSERT INTO pref_exclusions VALUES(?,?,?)')
      .run(...fields(origin))
    this.invalidateAnswered(origin)
  }

  /** Remove only this plugin's provisional quarantine once the original hook establishes zero bytes were written.
   * Legacy or explicit provider exclusions have no provisional marker and remain in force.
   * @example evidence.releaseClaim(origin)
   */
  releaseClaim(origin: Origin): boolean {
    const own = this.db
      .prepare(
        'DELETE FROM pref_provisional_claims WHERE source=? AND session=? AND tool=?',
      )
      .run(...fields(origin))
    if (!own.changes) return false
    this.db
      .prepare(
        'DELETE FROM pref_exclusions WHERE source=? AND session=? AND tool=?',
      )
      .run(...fields(origin))
    this.invalidateAnswered(origin)
    return true
  }

  /** Capture only the categorical meaning of a human instruction for live and historical conflict checks.
   * @example evidence.instruction({source:'claude', sessionId:'s'}, 'Read only', Date.now())
   */
  instruction(
    session: Session,
    text: string,
    at: number,
    explicit = false,
    truncated = false,
  ): void {
    if (!validId(session.sessionId) || !time(at) || typeof text !== 'string')
      return
    const rules =
      truncated || text.length > 16_384
        ? [{ kind: '*', required: '*' }]
        : instructionConstraints(text, explicit)
    this.saveRules(session, at, rules)
  }

  private saveRules(
    session: Session,
    at: number,
    rules: readonly Constraint[],
  ): void {
    for (const rule of rules) {
      const write = this.insertPrimary('pref_constraints', session, [
        session.source,
        session.sessionId,
        at,
        rule.kind,
        rule.required,
      ])
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
  typedInstructionCandidate(
    session: Session,
    text: string,
    at: number,
    explicit = false,
  ): void {
    const rules =
      text.length > 16_384
        ? [{ kind: '*', required: '*' }]
        : instructionConstraints(text, explicit)
    if (!rules.length) return
    const hash = digest(text.trim())
    this.insertPrimary('pref_instruction_candidates', session, [
      session.source,
      session.sessionId,
      hash,
      at,
      JSON.stringify(rules),
    ])
    const receipt = this.db
      .prepare(
        'SELECT 1 FROM pref_typed_receipts WHERE source=? AND session=? AND hash=? AND at BETWEEN ? AND ?',
      )
      .get(session.source, session.sessionId, hash, at - 2000, at + 2000)
    if (receipt) this.derived(() => this.saveRules(session, at, rules))
  }

  /** Remove a role-only instruction after the native mirror identifies it as an answer to a specific question.
   * @example evidence.cancelTypedInstruction(session,typed,at)
   */
  cancelTypedInstruction(session: Session, text: string, at: number): void {
    const row = this.db
      .prepare(
        'DELETE FROM pref_instruction_candidates WHERE source=? AND session=? AND hash=? AND at=? RETURNING rules',
      )
      .get(session.source, session.sessionId, digest(text.trim()), at)
    const values = [session.source, session.sessionId, digest(text.trim()), at]
    if (
      !row &&
      !this.db
        .prepare(
          'SELECT 1 FROM pref_cancelled_instructions WHERE source=? AND session=? AND hash=? AND at=?',
        )
        .get(...values)
    )
      return
    this.insertPrimary('pref_cancelled_instructions', session, values)
    if (!row) return
    for (const rule of JSON.parse(String(row.rules)) as Constraint[]) {
      const removed = this.db
        .prepare(
          'DELETE FROM pref_constraints WHERE source=? AND session=? AND at=? AND kind=? AND required=?',
        )
        .run(session.source, session.sessionId, at, rule.kind, rule.required)
      if (removed.changes) this.db.exec(dirty)
    }
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
    this.insertPrimary(
      'pref_gstack_selections',
      { source: 'claude', sessionId: session },
      [session, tool, cleanQuestion(question), label, at],
    )
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
    this.insertPrimary('pref_human_grants', origin, [...fields(origin), at])
    this.reconcileGstack(origin)
  }

  private reconcileGstack(origin: Origin): boolean {
    if (!this.deriving) return this.derived(() => this.reconcileGstack(origin))
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
    this.insertPrimary('pref_typed_candidates', origin, [
      ...fields(origin),
      cleanQuestion(question),
      hash,
      label,
      at,
      responseId,
    ])
    this.reconcileTyped(origin, hash, at)
    return !!this.db
      .prepare(
        'SELECT 1 FROM pref_fallback_links WHERE source=? AND session=? AND tool=? AND question=? AND at=?',
      )
      .get(...fields(origin), cleanQuestion(question), at)
  }

  private reconcileTyped(session: Session, hash: string, at: number): void {
    if (!this.deriving)
      return this.derived(() => this.reconcileTyped(session, hash, at))
    const query = [session.source, session.sessionId, hash] as const
    const candidates = this.db
      .prepare(
        `SELECT c.tool,c.question,c.label,c.at,c.response_id, EXISTS(SELECT 1 FROM pref_misdirected_typed x WHERE (x.source,x.session,x.tool,x.question,x.hash,x.at)=(c.source,c.session,c.tool,c.question,c.hash,c.at)) OR EXISTS(SELECT 1 FROM pref_ambiguous_submissions r WHERE (r.source,r.session,r.response_id)=(c.source,c.session,c.response_id)) AS misdirected,
         EXISTS(SELECT 1 FROM pref_fallback_links f WHERE (f.source,f.session,f.tool,f.question,f.at)=(c.source,c.session,c.tool,c.question,c.at)) AS linked
         FROM pref_typed_candidates c WHERE c.source=? AND c.session=? AND c.hash=?`,
      )
      .all(...query) as unknown as (TypedCandidate & {
      misdirected: number
      linked: number
    })[]
    const receipts = this.db
      .prepare(
        'SELECT at,submission FROM pref_submissions WHERE source=? AND session=? AND hash=?',
      )
      .all(...query) as unknown as TypedReceipt[]
    const matches = uniqueTypedMatches(candidates, receipts)
    // A native correction disqualifies that inferred target. Its receipt still cannot verify another nearby ambiguous candidate.
    for (const c of candidates) if (c.misdirected) matches.delete(c)
    for (const c of candidates) {
      if (!c.linked || matches.has(c)) continue
      const origin = { ...session, toolUseId: c.tool }
      const previous = this.db
        .prepare(
          'DELETE FROM pref_fallback_links WHERE source=? AND session=? AND tool=? AND question=? AND at=?',
        )
        .run(...fields(origin), c.question, c.at)
      if (!previous.changes) continue
      // Retract only evidence established by this fallback. A separately attested native submission still stands.
      this.restoreDirectSelection(origin, c.question)
      if (
        !this.db
          .prepare(
            'SELECT 1 FROM pref_direct_text WHERE source=? AND session=? AND tool=? AND response_id=?',
          )
          .get(...fields(origin), c.response_id)
      ) {
        const removed = this.db
          .prepare(
            'DELETE FROM pref_responses WHERE source=? AND session=? AND tool=? AND response_id=?',
          )
          .run(...fields(origin), c.response_id)
        if (removed.changes)
          this.db
            .prepare(
              'INSERT INTO pref_lost_typed VALUES(?,?,?,?) ON CONFLICT(source,session,response_id) DO UPDATE SET seen=excluded.seen',
            )
            .run(session.source, session.sessionId, c.response_id, Date.now())
      }
    }
    // Release new unambiguous pairs only after obsolete matches have freed their canonical response identities.
    for (const c of candidates) {
      if (c.linked || !matches.has(c)) continue
      const origin = { ...session, toolUseId: c.tool }
      const added = this.db
        .prepare('INSERT OR IGNORE INTO pref_fallback_links VALUES(?,?,?,?,?)')
        .run(...fields(origin), c.question, c.at)
      if (!added.changes) continue
      this.humanResponse(origin, c.response_id, c.at)
      this.answer(origin, c.question, c.label, c.at, true)
    }
  }

  /** Reassess a disputed offer from remaining direct choices and receipt matches when an attribution is lost.
   * @example this.restoreDirectSelection(origin, question)
   */
  private restoreDirectSelection(
    origin: Origin,
    question: string,
    includeFallback = true,
  ): void {
    const key = [...fields(origin), question] as const
    const offer = this.db
      .prepare(
        'SELECT options,asked FROM pref_offers WHERE source=? AND session=? AND tool=? AND question=?',
      )
      .get(...key)
    if (!offer) return
    const verified = this.db
      .prepare(
        `SELECT selected,at FROM pref_primary_choices WHERE source=? AND session=? AND tool=? AND question=? AND at>=?
      UNION ALL SELECT selected,at FROM pref_direct_answers WHERE source=? AND session=? AND tool=? AND question=? AND at>=?`,
      )
      .all(...key, offer.asked!, ...key, offer.asked!)
    const fallback = !includeFallback
      ? []
      : this.db
          .prepare(
            `SELECT c.label,c.at FROM pref_fallback_links f JOIN pref_typed_candidates c USING(source,session,tool,question,at)
        WHERE f.source=? AND f.session=? AND f.tool=? AND f.question=? AND c.at>=?`,
          )
          .all(...key, offer.asked!)
    const options = JSON.parse(String(offer.options)) as {
      label: string
      meaning: string
    }[]
    const surviving = [
      ...verified.map((row) => ({
        meaning: String(row.selected),
        at: Number(row.at),
      })),
      ...fallback.map((row) => ({
        meaning:
          options.find(
            (option) =>
              normalizeLabel(option.label) ===
              normalizeLabel(String(row.label)),
          )?.meaning ?? otherResponse,
        at: Number(row.at),
      })),
    ].sort((a, b) => a.at - b.at)
    const conflict = this.db
      .prepare(
        'SELECT 1 FROM pref_shape_conflicts WHERE source=? AND session=? AND tool=? AND question=?',
      )
      .get(...key)
    this.db
      .prepare(
        'UPDATE pref_offers SET selected=?,answered=?,conflict=? WHERE source=? AND session=? AND tool=? AND question=?',
      )
      .run(
        surviving[0]?.meaning ?? null,
        surviving[0]?.at ?? null,
        Number(
          !!conflict || new Set(surviving.map((row) => row.meaning)).size > 1,
        ),
        ...key,
      )
    this.db.exec(dirty)
  }

  /** Withdraw a role-only pairing when the native user event identifies a different target or submission.
   * @example evidence.rejectTypedTarget(origin,question,text,at)
   */
  rejectTypedTarget(
    origin: Origin,
    question: string,
    text: string,
    at: number,
  ): void {
    const hash = digest(text.trim())
    const values = [...fields(origin), cleanQuestion(question), hash, at]
    if (
      !this.db
        .prepare(
          'SELECT 1 FROM pref_typed_candidates WHERE source=? AND session=? AND tool=? AND question=? AND hash=? AND at=?',
        )
        .get(...values)
    )
      return
    // Each native correction independently rejects this pairing, even when another transcript already materialized the rejection.
    if (this.insertPrimary('pref_misdirected_typed', origin, values).changes)
      this.reconcileTyped(origin, hash, at)
  }

  /** Check an authenticated provider target across file copies and restarts, even when its question is outside the recent transcript window.
   * @example evidence.observeNativeTarget(session,'prompt:submitted-id','provider-question-id')
   */
  observeNativeTarget(
    session: Session,
    responseId: string,
    targetId: string,
  ): boolean {
    if (
      session.source !== 'codex' ||
      !validId(session.sessionId) ||
      !responseId.startsWith('prompt:') ||
      !validId(responseId.slice(7)) ||
      !validId(targetId)
    )
      return false
    const key = [session.source, session.sessionId, responseId] as const
    const added = this.db
      .prepare('INSERT OR IGNORE INTO pref_native_targets VALUES(?,?,?,?,?)')
      .run(this.owner, ...key, targetId)
    const conflict = !!this.db
      .prepare(
        'SELECT 1 FROM pref_ambiguous_submissions WHERE source=? AND session=? AND response_id=? LIMIT 1',
      )
      .get(...key)
    if (conflict && added.changes)
      this.derived(() => this.restoreSession(session))
    return !conflict
  }

  /** Quarantine the single native submission whose authenticated links disagree, leaving other witnesses in the session available.
   * @example evidence.rejectDirectText(origin,'prompt:native-id',question,answeredAt)
   */
  rejectDirectText(
    origin: Origin,
    responseId: string,
    question: string,
    at: number,
  ): void {
    if (
      origin.source !== 'codex' ||
      !responseId.startsWith('prompt:') ||
      !validId(responseId.slice(7)) ||
      !time(at) ||
      typeof question !== 'string'
    )
      return
    const added = this.db
      .prepare('INSERT OR IGNORE INTO pref_refuted_submissions VALUES(?,?,?,?)')
      .run(this.owner, origin.source, origin.sessionId, responseId)
    if (added.changes) this.derived(() => this.restoreSession(origin))
  }

  /** Preserve an independently human-authored text reply when a separate role-only mirror later becomes ambiguous.
   * @example evidence.directText(origin, responseId, question, label, answeredAt)
   */
  directText(
    origin: Origin,
    responseId: string,
    question: string,
    label: string,
    at: number,
    standingInstruction?: string,
  ): void {
    const previous = this.directSubmission
    const scoped =
      origin.source === 'codex' &&
      responseId.startsWith('prompt:') &&
      validId(responseId.slice(7))
    const different =
      scoped &&
      !!this.db
        .prepare(
          'SELECT 1 FROM pref_direct_submissions WHERE source=? AND session=? AND response_id=? AND tool<>? LIMIT 1',
        )
        .get(origin.source, origin.sessionId, responseId, origin.toolUseId)
    if (scoped) {
      const refuted = !!this.db
        .prepare(
          'SELECT 1 FROM pref_ambiguous_submissions WHERE source=? AND session=? AND response_id=? LIMIT 1',
        )
        .get(origin.source, origin.sessionId, responseId)
      this.directSubmission = {
        id: responseId,
        tool: origin.toolUseId,
        rejected: refuted || different,
      }
    }
    try {
      this.insertPrimary('pref_direct_text', origin, [
        ...fields(origin),
        responseId,
      ])
      this.humanResponse(origin, responseId, at)
      if (this.answer(origin, question, label, at, true)) {
        // A validated direct answer has its own chronology even if an earlier fallback currently owns the observation.
        this.db
          .prepare(
            `INSERT INTO pref_direct_answers
        SELECT source,session,tool,question,selected,? FROM pref_offers WHERE source=? AND session=? AND tool=? AND question=?
        ON CONFLICT(source,session,tool,question) DO UPDATE SET selected=excluded.selected,at=MIN(at,excluded.at)`,
          )
          .run(at, ...fields(origin), cleanQuestion(question))
      }
      if (standingInstruction)
        this.instruction(origin, standingInstruction, at, true)
    } finally {
      this.directSubmission = previous
    }
    if (different) this.derived(() => this.restoreSession(origin))
  }

  /** Expose temporary loss of typed-reply attribution separately from durable automation exclusions.
   * @example evidence.unmatchedSince(Date.now()-3600000)
   */
  unmatchedSince(since: number): HumanResponse[] {
    return this.db
      .prepare(
        `SELECT s.source,s.session,s.response_id,s.seen FROM pref_lost_typed s WHERE s.seen>=? AND NOT EXISTS(
       SELECT 1 FROM pref_responses r WHERE r.source=s.source AND r.session=s.session AND r.response_id=s.response_id)`,
      )
      .all(since)
      .map((row) => ({
        source: row.source as EvidenceSource,
        sessionId: String(row.session),
        responseId: String(row.response_id),
        at: Number(row.seen),
      }))
  }

  /** Index an explicitly typed CLI history entry without retaining the person's original text.
   * @example evidence.typedReceipt({source:'codex', sessionId:'s'}, 'A', at)
   */
  typedReceipt(
    session: Session,
    typed: string,
    at: number,
    nativeId?: string,
  ): void {
    if (!validId(session.sessionId) || !time(at) || !typed) return
    const hash = digest(typed.trim())
    const submission = nativeId && validId(nativeId) ? 'prompt:' + nativeId : ''
    this.insertPrimary('pref_submissions', session, [
      session.source,
      session.sessionId,
      hash,
      at,
      submission,
    ])
    this.db
      .prepare('INSERT OR IGNORE INTO pref_typed_receipts VALUES(?,?,?,?)')
      .run(session.source, session.sessionId, hash, at)
    const instructions = this.db
      .prepare(
        'SELECT at,rules FROM pref_instruction_candidates WHERE source=? AND session=? AND hash=? AND at BETWEEN ? AND ?',
      )
      .all(session.source, session.sessionId, hash, at - 2000, at + 2000)
    for (const item of instructions)
      this.derived(() =>
        this.saveRules(
          session,
          Number(item.at),
          JSON.parse(String(item.rules)) as Constraint[],
        ),
      )
    this.reconcileTyped(session, hash, at)
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
