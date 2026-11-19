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
  const near = (a: { at: number }, b: { at: number }) =>
    Math.abs(a.at - b.at) <= receiptWindow
  const identified = rawReceipts.filter((r) => r.submission)
  const receipts = rawReceipts.filter(
    (r) => r.submission || !identified.some((other) => near(r, other)),
  )
  // One native submission may appear in both the input log and a completed UI event.
  const copies = new Map<string, TypedReceipt[]>()
  for (const receipt of receipts) {
    const key = receipt.submission || 'at:' + receipt.at
    const existing = copies.get(key) ?? []
    existing.push(receipt)
    copies.set(key, existing)
  }
  const edges = new Map<TypedCandidate, TypedReceipt[]>()
  const callers = new Map<TypedReceipt, TypedCandidate[]>()
  const unique = new Set<TypedCandidate>()
  const reserved = new Set<string>()
  for (const id of copies.keys()) {
    if (!id.startsWith('prompt:')) continue
    const claimants = candidates.filter(
      (candidate) => candidate.response_id === id,
    )
    if (!claimants.length) continue
    reserved.add(id)
    if (claimants.length === 1) unique.add(claimants[0]!)
  }
  const available = [...copies]
    .filter(([id]) => !reserved.has(id))
    .map(([, group]) => group)
  for (const candidate of candidates) {
    const id = candidate.response_id.startsWith('prompt:')
      ? candidate.response_id
      : ''
    if (reserved.has(id)) continue
    const eligible = available
      .filter((group) =>
        group.some(
          (r) =>
            near(candidate, r) && (!id || !r.submission || r.submission === id),
        ),
      )
      .map((group) => group[0]!)
    edges.set(candidate, eligible)
    for (const receipt of eligible) {
      const matches = callers.get(receipt) ?? []
      matches.push(candidate)
      callers.set(receipt, matches)
    }
  }
  for (const [candidate, eligible] of edges) {
    if (eligible.length !== 1) continue
    const receipt = eligible[0]!
    const possible = callers.get(receipt)!
    if (possible.length === 1) unique.add(candidate)
  }
  return unique
}
