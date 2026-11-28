/** A single bounded allocator for final agent and session presentation strings.
 * See ui/docs/IDENTITY_PRESENTATION.md for the uniqueness proof and refresh contract.
 */
function identityLabels(items: Array<{ key: string; base: string; identity: string }>) {
  const records = [...new Map(items.map(item => [item.key, item])).values()]
  const counts = new Map<string, number>()
  for (const { base } of records) counts.set(base, (counts.get(base) ?? 0) + 1)
  // Reserve every original name, including unique names that look generated.
  const reserved = new Set(records.map(item => item.base))
  const resolved = new Map<string, { label: string; disambiguator: string | null }>()
  records.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
  for (const item of records) {
    if (counts.get(item.base) === 1) {
      resolved.set(item.key, { label: item.base, disambiguator: null })
      continue
    }
    // Each counter makes a distinct candidate. At most reserved.size candidates
    // can be occupied, so a free label must exist within this finite bound.
    const limit = reserved.size + 1
    for (let ordinal = 1; ordinal <= limit; ordinal += 1) {
      const disambiguator = ordinal === 1 ? item.identity : `${item.identity}; ${ordinal}`
      const label = `${item.base} (${disambiguator})`
      if (reserved.has(label)) continue
      reserved.add(label)
      resolved.set(item.key, { label, disambiguator })
      break
    }
    if (!resolved.has(item.key)) throw new Error('Identity presentation allocation exhausted')
  }
  return resolved
}

function catalogLabel(ref: string, names: Record<string, string>): string {
  return Object.hasOwn(names, ref) ? names[ref]! : ref
}

/** Friendly unique names stay concise; all final labels are unique, including fallbacks. */
export function agentDisplayLabels(refs: string[], displayByName: Record<string, string>) {
  return Object.fromEntries(
    [
      ...identityLabels(
        refs.map(ref => ({
          key: ref,
          base: catalogLabel(ref, displayByName),
          identity: ref,
        }))
      ),
    ].map(([ref, presentation]) => [ref, presentation.label])
  )
}

export function sessionPresentationKey(agentRef: string, id: string): string {
  return JSON.stringify([agentRef, id])
}

export function sessionDisplayLabels(
  sessions: ReadonlyArray<{ agentRef: string; id: string; title: string }>,
  agentLabels: Record<string, string>
) {
  const labels = identityLabels(
    sessions.map(session => ({
      key: sessionPresentationKey(session.agentRef, session.id),
      base: session.title,
      identity: `${catalogLabel(session.agentRef, agentLabels)} · ${session.id}`,
    }))
  )
  return Object.fromEntries(
    sessions.map(session => {
      const key = sessionPresentationKey(session.agentRef, session.id)
      // The allocator returns one result for every distinct input identity.
      const presentation = labels.get(key)!
      return [
        key,
        {
          label: presentation.label,
          secondary: presentation.disambiguator ?? catalogLabel(session.agentRef, agentLabels),
        },
      ]
    })
  )
}
