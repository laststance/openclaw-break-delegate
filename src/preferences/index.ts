import type { DatabaseSync } from 'node:sqlite'
import {
  EvidenceDatabase,
  type EvidenceSource,
  type HumanResponse,
  type Origin,
  type PreferenceDecision,
  type ReplayReport,
  type Session,
} from './database.js'
import {
  defaultHistoryRoots,
  importLocalHistory,
  type HistoryRoots,
  type ImportReport,
} from './history.js'
import type { QuestionCard } from './policy.js'
import { canonicalRepository } from './repository.js'

export { typedResponseId } from './database.js'
export { canonicalRepository } from './repository.js'
export { classifyCard, normalizeQuestionCard } from './policy.js'
export type {
  EvidenceSource,
  HumanResponse,
  PreferenceDecision,
  PreferenceSummary,
  ReplayReport,
  ReplayType,
  Session,
} from './database.js'
export type { HistoryRoots, ImportReport } from './history.js'
export type { QuestionCard } from './policy.js'

export interface EvaluationContext {
  cwd: string
  instructions?: readonly string[]
  now?: number
  session?: Session
}
export interface HumanSelection extends Origin {
  cwd: string
  card: QuestionCard
  label: string
  askedAt: number
  answeredAt: number
  instructions?: readonly string[]
}

/** Give the gateway and CLI access to local evidence without exposing transcript contents in their results.
 * @example
 * const store = new PreferenceStore(db);
 * await store.importHistory({claude:'/tmp/test-profile/.claude'});
 * const decision = store.evaluate(card, {cwd:process.cwd()});
 */
export class PreferenceStore {
  private readonly evidence: EvidenceDatabase
  private importQueue: Promise<unknown> = Promise.resolve()

  constructor(db: DatabaseSync) {
    this.evidence = new EvidenceDatabase(db)
  }

  /** Read new local records and refresh held-out calibration. Explicit roots select only the named providers.
   * @example await store.importHistory({gstack:'/tmp/test-profile/.gstack'})
   */
  importHistory(
    roots: HistoryRoots = defaultHistoryRoots(),
  ): Promise<ImportReport> {
    const task = this.importQueue.then(() =>
      importLocalHistory(this.evidence, roots),
    )
    this.importQueue = task.catch(() => undefined)
    return task
  }

  /** Refresh type-level calibration after new evidence or an exclusion, outside the live hook.
   * @example store.replay().types
   */
  replay(): ReplayReport {
    return this.evidence.replay()
  }

  /** Return the exact offered label only after the type, current repository, and instruction gates pass.
   * @example store.evaluate(card,{cwd,session:{source:'claude',sessionId}})
   */
  evaluate(card: QuestionCard, context: EvaluationContext): PreferenceDecision {
    return this.evidence.evaluate(
      card,
      canonicalRepository(context.cwd),
      context.now ?? Date.now(),
      context.instructions ?? [],
      context.session,
    )
  }

  /** Accept a positively identified human selection and its original question time from a trusted local caller.
   * @returns Whether this selection was suitable for learning a preference.
   * @example store.recordHumanSelection({source:'claude',sessionId,toolUseId,cwd,card,label,askedAt,answeredAt})
   */
  recordHumanSelection(selection: HumanSelection): boolean {
    if (
      !Number.isSafeInteger(selection.askedAt) ||
      !Number.isSafeInteger(selection.answeredAt) ||
      selection.askedAt < 0 ||
      selection.answeredAt < selection.askedAt ||
      typeof selection.label !== 'string' ||
      !selection.label.trim() ||
      /^__(?:unknown|skipped|missing)__$/iu.test(selection.label.trim())
    )
      return false
    const repo = canonicalRepository(selection.cwd)
    return this.evidence.transaction(() => {
      if (this.evidence.isExcluded(selection)) return false
      this.evidence.humanResponse(
        selection,
        'tool:' + selection.toolUseId,
        selection.answeredAt,
      )
      for (const line of selection.instructions ?? [])
        this.evidence.instruction(selection, line, selection.askedAt, true)
      if (!repo || !this.evidence.offer({ ...selection, repo })) return false
      return this.evidence.answer(
        selection,
        selection.card.question,
        selection.label,
        selection.answeredAt,
        true,
      )
    })
  }

  /** Capture a submitted human task constraint locally for future decisions in that same session.
   * @example store.recordInstruction('claude',sessionId,'Read only',Date.now())
   */
  recordInstruction(
    source: EvidenceSource,
    sessionId: string,
    text: string,
    at: number,
  ): void {
    this.evidence.instruction({ source, sessionId }, text, at)
  }

  /** Persist a delivery's exclusion atomically with the caller's lease. Re-imports and previously learned copies both obey it.
   * @example store.excludeDelegated('claude',sessionId,toolUseId)
   */
  excludeDelegated(
    source: EvidenceSource,
    sessionId: string,
    toolUseId: string,
  ): void {
    this.evidence.transaction(() =>
      this.evidence.exclude({ source, sessionId, toolUseId }),
    )
  }

  /** Check a provider's exact delivery identity before recording human workload.
   * @example store.isDelegated('claude',sessionId,toolUseId)
   */
  isDelegated(
    source: EvidenceSource,
    sessionId: string,
    toolUseId: string,
  ): boolean {
    return this.evidence.isExcluded({ source, sessionId, toolUseId })
  }

  /** Return only recent verified event identities to the local workload counter.
   * @example store.humanResponsesSince(Date.now()-3_600_000)
   */
  humanResponsesSince(since: number): HumanResponse[] {
    return this.evidence.responsesSince(since)
  }
}
