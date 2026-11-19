export interface QuestionCard {
  question: string
  header?: string
  options: readonly { label: string; description?: string }[]
  multiSelect?: boolean
}

const questionFields = new Set([
  'question',
  'header',
  'options',
  'multiSelect',
  'id',
  'isOther',
  'isSecret',
])
const optionFields = new Set(['label', 'description', 'preview', 'markdown'])
const objectValue = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const shortString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && !!value.trim() && value.length <= max

/** Preserve every supported visible field from the provider's original card. Unknown surfaces may change what a person's choice means.
 * Used before both live delivery and historical learning. Codex's native per-question ID is routing metadata.
 * @example normalizeQuestionCard({header:'Scope',question:'Which tests should we run?',options:[{label:'Focused tests'},{label:'Full suite'}]})
 */
export function normalizeQuestionCard(raw: unknown): QuestionCard | null {
  if (
    !objectValue(raw) ||
    Object.keys(raw).some((key) => !questionFields.has(key)) ||
    !shortString(raw.question, 1000) ||
    (raw.header !== undefined &&
      (typeof raw.header !== 'string' || raw.header.length > 80)) ||
    (raw.id !== undefined && !shortString(raw.id, 256)) ||
    (raw.multiSelect !== undefined && typeof raw.multiSelect !== 'boolean') ||
    (raw.isOther !== undefined && typeof raw.isOther !== 'boolean') ||
    (raw.isSecret !== undefined && raw.isSecret !== false) ||
    !Array.isArray(raw.options) ||
    raw.options.length < 2 ||
    raw.options.length > 8
  )
    return null
  const options: { label: string; description?: string }[] = []
  for (const option of raw.options) {
    // A preview or unknown piece of display content can describe a second action absent from the label.
    if (
      !objectValue(option) ||
      Object.keys(option).some((key) => !optionFields.has(key)) ||
      !shortString(option.label, 160) ||
      (option.description !== undefined &&
        (typeof option.description !== 'string' ||
          option.description.length > 500)) ||
      [option.preview, option.markdown].some(
        (value) => value != null && value !== '',
      )
    )
      return null
    options.push({
      label: option.label,
      ...(typeof option.description === 'string'
        ? { description: option.description }
        : {}),
    })
  }
  if (
    new Set(options.map((option) => normalizeLabel(option.label))).size !==
    options.length
  )
    return null
  return {
    question: raw.question,
    ...(raw.header ? { header: String(raw.header) } : {}),
    options,
    multiSelect: raw.multiSelect === true,
  }
}

interface DecisionType {
  kind: string
  topic: RegExp
  vocabulary: string
  japanese: string
  choices: Record<string, RegExp>
}

// Every content word must belong to the decision. An added instruction, URL, or unfamiliar verb holds the entire card.
const sharedEnglish =
  'a an the should we i you would like how what which where do does did is are it its this that these those in on for of as with by or to from at into here instead would prefer want choose use using do our my your be being handle handled approach prefer preferred should go about take found discovered was has have been just now please option way would better shall can could when if between earlier same within entire all next me my new newly another currently any for this'
const sharedJapanese =
  'それとも どのように どちら どんな どの どこ どれ どう しますか しましょうか すべきですか します する して したい した 場合 なら でしょうか ですか です ました ますか ます か を は が に で と の も や な を へ から まで 今回 この その どっち 進め方 方法 方針 選択 選ぶ ください しましょう お願いします について として どうする'

const decisionTypes: readonly DecisionType[] = [
  {
    kind: 'unrelated-bug',
    topic:
      /(?:\bunrelated\b|\bout[- ]of[- ]scope\b|\bpre[- ]existing\b).*(?:bug|defect|issue|regression)|(?:bug|defect|issue).*(?:unrelated|out[- ]of[- ]scope)|(?:無関係|関係のない|関係ない|関係がない|関連しない|別件|対象外|スコープ外).*(?:不具合|バグ|問題)/u,
    vocabulary:
      'unrelated out scope pre existing bug bugs issue issues defect regression incidental discovered encountered found spotted noticed fix fixes fixing address include it handle repair current pull request pr patch change changes work separate follow up followup open file create track log report ticket later defer backlog todo list add move put until outside leave resolve discovered during while reviewing code review separately another task this one same branch now newly in scope',
    japanese:
      '無関係 関係のない 関係ない 関係がない 関連しない 本題 作業 とは けど ですが 別件 対象外 スコープ外 不具合 バグ 問題 見つかりました 見つけました 見つけた 見つかった 発見した 発見 修正する 修正 対応する 対応 直しますか 直す 直し 扱う 扱い 今すぐ 今 一緒に 含める 現在 同じ 別の 別 別途 切り出す 切り出し 起票する 起票 作成する 作成 記録する 記録 あとで 後で 後回し 回しますか 回す 残す 課題 チケット プルリク 変更 本 件 立てる 立てますか 作る それとも このまま',
    choices: {
      'current-change':
        /\b(?:fix|address|resolve|repair)(?:\s+(?:it|the bug|the issue))?(?:\s+(?:in|within|as part of))?\s+(?:now|here|this|the current|the same)|\b(?:in|within|include in|use) (?:this|the current|current|the same|same) (?:pr|pull request|patch|change)|^(?:fix|fix now|this pr|current pr|current change)$|(?:今回|この|現在|同じ|今すぐ|今|一緒に).*(?:修正|対応|直す|直し|含める)|^(?:今回|この)(?:の)?pr$/u,
      'separate-issue':
        /\b(?:separate|follow[- ]?up|another|new) (?:issue|ticket)\b|\b(?:file|open|create|log|track) (?:an? )?(?:issue|ticket)\b|(?:別|後日).*(?:issue|チケット|課題|起票)|(?:issue|課題|チケット).*(?:切り出|起票)/u,
      defer: /\b(?:defer|leave it for later|backlog|todo)\b|後回し/u,
    },
  },
  {
    kind: 'test-scope',
    topic: /\b(?:tests?|suite|specs?)\b|テスト/u,
    vocabulary:
      'test tests testing spec specs suite suites scope coverage validation run rerun running verify verification checks check targeted focused affected related changed files full complete whole entire repository relevant only affected first start locally regression regressions unit broad select',
    japanese:
      'テスト 範囲 実行する 実行 回す 全体 全件 すべて 全部 一式 スイート 関連 対象 影響 箇所 絞る 絞った 限定 変更 分 だけ まず 確認',
    choices: {
      'focused-tests':
        /\b(?:targeted|focused|affected|related|relevant|changed)\b|(?:関連|影響|対象|変更箇所|限定|絞)/u,
      'full-suite':
        /\b(?:full|entire|whole|complete|all)\b|(?:全体|全件|すべて|全部|一式)/u,
    },
  },
  {
    kind: 'report-detail',
    topic:
      /\b(?:summary|summarize|report|write[- ]?up|explanation|update)\b|要約|報告|説明|レポート/u,
    vocabulary:
      'summary summarize report reporting write up writeup explanation update updates level format detail details detailed depth short brief concise compact thorough full comprehensive final findings changes results progress much long style bullets include enough present provide',
    japanese:
      '要約 報告 説明 レポート まとめる まとめ 内容 詳しさ 詳細 詳しく 簡潔 短く 簡単 長さ 結果 最終 粒度',
    choices: {
      concise: /\b(?:brief|short|concise|compact)\b|簡潔|短く|簡単/u,
      detailed:
        /\b(?:detailed|thorough|comprehensive|full|in detail)\b|詳細|詳しく/u,
    },
  },
  {
    kind: 'documentation-location',
    topic: /\b(?:docs|documentation|guide|readme)\b|ドキュメント|手順書/u,
    vocabulary:
      'document documentation docs guide instructions usage examples readme separate dedicated standalone page file put place write add live existing location new keep',
    japanese:
      'ドキュメント 手順書 ガイド 手順 書く 載せる 置く 既存 新規 専用 独立 別の 別 ページ ファイル 配置 追記',
    choices: {
      readme: /\breadme\b/u,
      'dedicated-document':
        /\b(?:dedicated|separate|standalone)\b|専用|独立|別/u,
    },
  },
  {
    kind: 'response-language',
    topic: /\b(?:language|english|japanese)\b|何語|言語|日本語|英語/u,
    vocabulary:
      'language english japanese reply replies response responses explanation report reports writing write written answer answers final summary provide present use chat conversation documentation document documents docs guide guides readme in',
    japanese:
      '何語 言語 日本語 英語 返答 回答 説明 レポート 報告 最終 文書 ドキュメント 資料 チャット 会話 書く 使う べきですか',
    choices: { english: /\benglish\b|英語/u, japanese: /\bjapanese\b|日本語/u },
  },
  {
    kind: 'test-structure',
    topic: /\b(?:tests?|cases?)\b|テスト|ケース/u,
    vocabulary:
      'write organize organize structure test tests cases individual separate named each one per case table driven parameterized parameterised style layout scenarios',
    japanese:
      'テスト ケース 書く 構成 個別 独立 別々 一つずつ テーブル 駆動 パラメータ化 形式',
    choices: {
      'individual-cases':
        /\b(?:individual|separate|one per case)\b|個別|独立|別々|一つずつ/u,
      'table-driven':
        /\b(?:table[- ]driven|parameteri[sz]ed)\b|テーブル|パラメータ化/u,
    },
  },
]

const operation =
  /\b(?:approv\w*|allow\w*|authori[sz]\w*|permission|consent|confirm\w*|go ahead|go-ahead|may i|can i|could i|is it (?:ok|okay)|deploy\w*|production|prod|publish\w*|push\w*|merge\w*|release\w*|delet\w*|remov\w*|destroy\w*|drop|wipe|reset|overwrite|secret\w*|credential\w*|password\w*|token|payment|purchase|charge|billing|send|email|upload|execute|sudo|install|ssh|curl|ignore|bypass|skip|never|not|except|unless)\b|承認|許可|同意|よろしい|いいですか|してよい|してもよい|してもいい|本番|デプロイ|リリース|公開|プッシュ|マージ|削除|消去|上書き|認証|秘密|課金|送信|アップロード|しない|せず|禁止|無視|[\x00-\x08\x0b-\x1f\x7f]/iu
const restriction =
  /\b(?:only|always|never|must|shall|no|not|don['’]t|do not|avoid|exclude|except|unless|instead|restrict\w*|limit\w*|wait|hold|pause|stop|until|before|without|forbid\w*|read[- ]only|out of scope|prefer|require\w*|audit|inspect|research only)\b|だけ|のみ|限[る定り]|しない|禁止|するな|する前|以外|必ず|絶対|控え|待[つっ]|止め|やめ|不要|優先|見送|せず|まだ|まで|読み取[りる]|調査だけ/iu
const annotation = /\s*[（(](?:recommended|推奨|おすすめ)[）)]\s*$/iu

/** Strip display-only recommendations and list bullets before comparing the person's exact selection.
 * @example normalizeLabel('A) Separate issue (Recommended)')
 */
export function normalizeLabel(label: string): string {
  return label
    .normalize('NFKC')
    .trim()
    .replace(/^\s*[A-Z0-9][.)]\s+/iu, '')
    .replace(annotation, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
}

const simpleReply =
  /^(?:yes|no|y|n|sure|okay|ok|go ahead|please do|do it|not now|neither|both|other|the (?:first|second|third|last) one(?:,? please)?|はい|いいえ|お願いします|お願い|進めて(?:ください)?|どちらでも|どちらも|その他)[.!。！]?$/iu
const qualification =
  /(?:\s*[,;:、，—]\s*|\s+)(?=(?:but|if|only|unless|provided|except|after|before|because|as long as)\b|ただし|但し|もし|条件|その場合)/iu
const replyOrdinal = /^(?:option\s+)?([a-e1-5])(?:[.)]|番(?:目)?)?$/iu

/** Identify explicit ongoing scope in a reply before {@link instructionConstraints} applies it to future questions.
 * @example isStandingReplyInstruction('A for now, but always ask first from now on')
 */
export function isStandingReplyInstruction(text: string): boolean {
  return /(?:^|[,;.!?、。]|\b(?:but|and)\b)\s*(?:(?:but|and|please)\s+)*(?:(?:always|never)\s+(?:ask|use|choose|run|prefer|write|answer|do|change|fix|send|apply|wait|check|keep|make|take|skip|allow)|from now on|going forward|for (?:all future|future|the rest of (?:this|the) session)|throughout (?:this|the) session|every time)\b|(?:^|[、。]|ただし|但し)\s*(?:今後|これからは|毎回|このセッション(?:全体|中))/iu.test(
    text,
  )
}

function languageTargets(text: string): string[] {
  const document =
    /\b(?:documents?|documentation|docs|guides?|readme|reports?)\b|文書|ドキュメント|資料|報告|レポート/u.test(
      text,
    )
  const chat =
    /\b(?:chat|repl(?:y|ies)|responses?|answers?|conversation|explanation)\b|会話|返答|回答|チャット|説明/u.test(
      text,
    )
  return [
    ...(document ? ['documentation-language'] : []),
    ...(chat ? ['response-language'] : []),
  ]
}
const languageTarget = (text: string) => {
  const targets = languageTargets(text)
  return targets.length === 1 ? targets[0]! : null
}

/** Return the offered option index when a typed answer explicitly names its letter or number.
 * @example typedOptionIndex('option 2')
 */
export function typedOptionIndex(text: string): number | undefined {
  const ordinal = replyOrdinal
    .exec(text.normalize('NFKC').trim())?.[1]
    ?.toUpperCase()
  if (!ordinal) return undefined
  return /\d/u.test(ordinal) ? Number(ordinal) - 1 : ordinal.charCodeAt(0) - 65
}

/** Correlate independently verified human input with the preceding question. An ordinary new task remains a standalone instruction.
 * @example isTypedReply('A, if the tests pass', ['Fix now','Defer'])
 */
export function isTypedReply(
  text: string,
  labels: readonly string[] = [],
  questionId?: string,
  replyTo?: string,
): boolean {
  if (replyTo) return !!questionId && replyTo === questionId
  const typed = text.normalize('NFKC').trim()
  if (!typed || typed.length > 2000) return false
  const recognizable = (candidate: string) => {
    const normalized = normalizeLabel(candidate)
    if (
      labels.some((label) => normalizeLabel(label) === normalized) ||
      simpleReply.test(candidate)
    )
      return true
    const index = typedOptionIndex(candidate)
    if (index === undefined) return false
    return labels.length === 0 || index < labels.length
  }
  if (recognizable(typed) || /^(?:other|その他)\s*[:：]\s*\S/iu.test(typed))
    return true
  const split = qualification.exec(typed)
  return !!split && recognizable(typed.slice(0, split.index).trim())
}

function questionText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/<gstack-qid:[a-z0-9-]{1,64}(?:;signal=[a-z0-9-]{1,64})?>/giu, '')
    .trim()
    .toLowerCase()
}

const vocabulary = new Map(
  decisionTypes.map((type) => {
    const english = new Set((sharedEnglish + ' ' + type.vocabulary).split(' '))
    const japanese = (sharedJapanese + ' ' + type.japanese)
      .split(' ')
      .sort((a, b) => b.length - a.length)
    return [
      type.kind,
      { english, japanese: new RegExp(japanese.join('|'), 'gu') },
    ]
  }),
)
const neutralHeaders = new Set([
  '',
  'choice',
  'decision',
  'preference',
  'policy',
  'approach',
  'workflow',
  'plan',
  'scope',
  '選択',
  '方針',
  '判断',
  '進め方',
  '質問',
  '範囲',
  'スコープ',
])
const topicHeaders: Record<string, readonly string[]> = {
  'unrelated-bug': [
    'bug',
    'bug scope',
    'bug handling',
    'unrelated bug',
    'issue',
    'bug policy',
    'triage',
    'バグ',
    '不具合',
    'バグ対応',
    '別件',
    '別件対応',
  ],
  'test-scope': [
    'test',
    'tests',
    'test scope',
    'coverage',
    'testing',
    'テスト',
    'テスト範囲',
    '検証範囲',
  ],
  'test-structure': [
    'test',
    'tests',
    'test style',
    'test structure',
    'テスト',
    'テスト形式',
    'テスト構成',
  ],
  'report-detail': [
    'detail',
    'report',
    'report detail',
    'summary',
    'format',
    '報告',
    '詳細',
    '要約',
    '粒度',
  ],
  'documentation-location': [
    'documentation',
    'docs',
    'location',
    'docs location',
    'ガイド',
    'ドキュメント',
    '配置',
  ],
  'response-language': [
    'language',
    'reply language',
    'output language',
    '言語',
    '回答言語',
  ],
}

function withinVocabulary(text: string, type: DecisionType): boolean {
  const words = vocabulary.get(type.kind)!
  const remainder = text
    .replace(/[a-z]+/gu, (word) => (words.english.has(word) ? ' ' : word))
    .replace(words.japanese, '')
    .replace(/[\s.,?!()'’、。・ー–—-]/gu, '')
  return remainder.length === 0
}

function meanings(text: string, type: DecisionType): string[] {
  return Object.keys(type.choices).filter((key) =>
    type.choices[key]!.test(text),
  )
}

export interface ClassifiedCard {
  kind: string
  signature: string
  choices: { label: string; meaning: string }[]
}

export type PolicyResult =
  | { card: ClassifiedCard }
  | { reason: 'operational-or-mixed' | 'unrecognized-question' }

/** Identify a preference only when the entire question and every available option express one known decision.
 * The gateway applies the same rule during historical replay and delivery.
 * @example classifyCard({question:'Which tests should we run?', options:[{label:'Focused tests'}, {label:'Full suite'}]})
 */
export function classifyCard(raw: QuestionCard): PolicyResult {
  const card = normalizeQuestionCard(raw)
  if (!card || card.multiSelect || card.options.length > 5)
    return { reason: 'unrecognized-question' }
  const question = questionText(card.question)
  const header = (card.header ?? '').normalize('NFKC').trim().toLowerCase()
  const options = card.options.map((option) => ({
    label: option.label,
    text: normalizeLabel(option.label),
    description: questionText(option.description ?? ''),
  }))
  if (
    [
      header,
      question,
      ...options.flatMap((option) => [option.text, option.description]),
    ].some((text) => operation.test(text))
  )
    return { reason: 'operational-or-mixed' }
  const matches: ClassifiedCard[] = []
  for (const type of decisionTypes) {
    // Shared terms such as "tests" must also match this type's vocabulary and its distinct meanings.
    if (
      (!neutralHeaders.has(header) &&
        !topicHeaders[type.kind]?.includes(header)) ||
      !type.topic.test(question) ||
      !withinVocabulary(question, type)
    )
      continue
    const choices: ClassifiedCard['choices'] = []
    for (const option of options) {
      if (
        !withinVocabulary(option.text, type) ||
        !withinVocabulary(option.description, type)
      )
        break
      const choice = meanings(option.text, type)
      const described = meanings(option.description, type)
      // Filing a separate issue can defer the fix. A standalone deferral does not itself promise to create an issue.
      const compatible = (key: string) =>
        key === choice[0] || (choice[0] === 'separate-issue' && key === 'defer')
      if (choice.length !== 1 || described.some((key) => !compatible(key)))
        break
      choices.push({ label: option.label, meaning: choice[0]! })
    }
    const unique = new Set(choices.map((choice) => choice.meaning))
    const kind =
      type.kind === 'response-language' ? languageTarget(question) : type.kind
    if (
      type.kind === 'response-language' &&
      languageTarget(
        [question, ...options.flatMap((o) => [o.text, o.description])].join(
          ' ',
        ),
      ) !== kind
    )
      continue
    if (kind && unique.size === options.length)
      matches.push({
        kind,
        signature: [...unique].sort().join('|'),
        choices,
      })
  }
  return matches.length === 1
    ? { card: matches[0]! }
    : { reason: 'unrecognized-question' }
}

export interface Constraint {
  kind: string
  required: string
}

/** Convert session instructions to local categorical restrictions before saving them. Unknown restrictions veto delivery.
 * @param explicit - The caller has already identified the text as an explicit constraint.
 * @example instructionConstraints('Please use Japanese', true)
 */
export function instructionConstraints(
  value: string,
  explicit: boolean,
): Constraint[] {
  const text = questionText(value)
  if (!text) return []
  // Remove a directive lead-in only at a sentence boundary so factual mentions and questions keep their original meaning.
  const asksForApproval = (clause: string) => {
    const approvalText = clause.replace(
      /(^|[.!?。！？]\s*)(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:(?:remember|be sure|make sure) to|(?:be sure|make sure) (?:that )?you|i (?:want|need) you to|you (?:must|should|need to))\s+/gu,
      '$1',
    )
    return /(?:^|[.!?。！？]\s*)(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:(?:ask|consult|check with)\s+(?:me|the (?:user|owner))\s+(?:for (?:approval|permission|confirmation)|before\b|first\b)|(?:ask for|obtain|get|require|wait for) (?:my|the (?:user's|owner's)) (?:approval|permission|confirmation))|(?:承認|許可|確認)を(?:取って|求めて|得て|待って|取ること|求めること)|(?:私|本人|ユーザー)に(?:必ず)?確認して/u.test(
      approvalText,
    )
  }
  if (asksForApproval(text)) return [{ kind: '*', required: '*' }]
  // A question asking for information does not impose a standing constraint. Polite requests can still contain an explicit limit.
  if (
    !explicit &&
    /^[^.!?。！？]*[?？]$/u.test(text) &&
    !/^(?:please |(?:can|could|would|will) you (?!explain|tell me|describe))|ください|お願いします/u.test(
      text,
    )
  ) {
    const clauses = text
      .split(/\b(?:and|but)\s+|[,;、]|ただし\s*/u)
      .slice(1)
      .map((clause) => clause.trim())
      .filter((clause) => restriction.test(clause) || asksForApproval(clause))
    return clauses.flatMap((clause) =>
      instructionConstraints(clause.replace(/[?？]$/u, ''), true),
    )
  }
  // A negation, exception, second instruction or unparsed text must never be reduced to an affirmative choice.
  if (!operation.test(text)) {
    const normalized = text
      .replace(/^(?:please |i (?:prefer|want) |always |only )+/u, '')
      .replace(/^(?:always |only )+/u, '')
      .replace(/(?:だけ|のみ|でお願いします|をお願いします|でお願い)$/u, '')
    const result = decisionTypes.flatMap((type) => {
      const targets =
        type.kind === 'response-language' ? languageTargets(normalized) : []
      const terms =
        targets.length === 2
          ? normalized.replace(/\band\b|および|及び/gu, ' ')
          : normalized
      if (!withinVocabulary(terms, type)) return []
      const choices = meanings(normalized, type)
      if (choices.length !== 1) return []
      if (type.kind !== 'response-language')
        return [{ kind: type.kind, required: choices[0]! }]
      // Explicitly named scopes may each use the same language. An unspecified target cannot narrow the rule to chat alone.
      return (
        targets.length
          ? targets
          : ['response-language', 'documentation-language']
      ).map((kind) => ({ kind, required: targets.length ? choices[0]! : '*' }))
    })
    if (
      result.length === 1 ||
      (result.length === 2 && result.every((r) => r.kind.endsWith('-language')))
    )
      return result
    if (
      /^(?:please\s+)?(?:use|write|reply|answer|speak|communicate|i (?:prefer|want))\b/u.test(
        text,
      ) &&
      /\b(?:japanese|english)\b|英語|日本語/u.test(text)
    ) {
      const targets = languageTargets(text)
      return (
        targets.length
          ? targets
          : ['response-language', 'documentation-language']
      ).map((kind) => ({ kind, required: '*' }))
    }
  }
  return explicit || restriction.test(text) || isStandingReplyInstruction(text)
    ? [{ kind: '*', required: '*' }]
    : []
}

/** Constrain the learned winner to all applicable human instructions when replay or live evaluation selects a label.
 * @example permitsChoice([{kind:'response-language', required:'japanese'}], 'response-language', 'english')
 */
export function permitsChoice(
  constraints: readonly Constraint[],
  kind: string,
  meaning: string,
): boolean {
  return constraints.every(
    (rule) =>
      rule.kind !== '*' && (rule.kind !== kind || rule.required === meaning),
  )
}
