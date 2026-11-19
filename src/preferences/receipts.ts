export interface TypedCandidate {
  tool: string
  question: string
  label: string
  at: number
  response_id: string
}
export interface TypedReceipt {
  at: number
  submission: string
}
export const receiptWindow = 2000

/** Match a typed receipt to exactly one candidate in both directions, giving matching native submission IDs priority.
 * Anonymous records near an identified receipt may be another rendering of that receipt.
 * @example uniqueTypedMatches(candidates, receipts)
 */
export function uniqueTypedMatches(
  candidates: readonly TypedCandidate[],
  rawReceipts: readonly TypedReceipt[],
): Set<TypedCandidate> {
  const sorted = [...rawReceipts].sort((a, b) => a.at - b.at)
  const identified = sorted.filter((r) => r.submission)
  const idOf = (r: TypedReceipt) => r.submission || 'at:' + r.at
  const firstCopy = new Map<string, TypedReceipt>()
  for (const receipt of sorted)
    if (!firstCopy.has(idOf(receipt))) firstCopy.set(idOf(receipt), receipt)
  const exact = new Map<string, TypedCandidate[]>()
  for (const candidate of candidates) {
    if (
      !candidate.response_id.startsWith('prompt:') ||
      !firstCopy.has(candidate.response_id)
    )
      continue
    const list = exact.get(candidate.response_id) ?? []
    list.push(candidate)
    exact.set(candidate.response_id, list)
  }
  const matches = new Set<TypedCandidate>()
  for (const group of exact.values())
    if (group.length === 1) matches.add(group[0]!)
  // A native ID can claim a receipt across any clock skew. Anonymous matching still inspects only the two-second neighborhood.
  const startAt = (records: readonly TypedReceipt[], at: number) => {
    let low = 0,
      high = records.length
    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      if (records[mid]!.at < at - receiptWindow) low = mid + 1
      else high = mid
    }
    return low
  }
  const edges = new Map<TypedCandidate, Set<TypedReceipt>>()
  const callers = new Map<TypedReceipt, number>()
  for (const candidate of candidates) {
    if (exact.has(candidate.response_id)) continue
    const id = candidate.response_id.startsWith('prompt:')
      ? candidate.response_id
      : ''
    const eligible = new Set<TypedReceipt>()
    for (
      let i = startAt(sorted, candidate.at);
      i < sorted.length && sorted[i]!.at <= candidate.at + receiptWindow;
      i++
    ) {
      const receipt = sorted[i]!
      if (
        exact.has(receipt.submission) ||
        (id && receipt.submission && id !== receipt.submission)
      )
        continue
      eligible.add(firstCopy.get(idOf(receipt))!)
    }
    edges.set(candidate, eligible)
    for (const receipt of eligible)
      callers.set(receipt, (callers.get(receipt) ?? 0) + 1)
  }
  for (const [candidate, eligible] of edges) {
    if (eligible.size !== 1) continue
    const receipt = eligible.values().next().value!
    if (callers.get(receipt) !== 1) continue
    // A nearby identified event can be a second rendering of this anonymous entry, so it cannot certify another person input.
    const nearby = identified[startAt(identified, receipt.at)]
    if (
      !receipt.submission &&
      nearby &&
      nearby.at <= receipt.at + receiptWindow
    )
      continue
    matches.add(candidate)
  }
  return matches
}
