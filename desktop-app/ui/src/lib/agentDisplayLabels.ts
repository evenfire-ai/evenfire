/** Keep catalog names concise, adding identity only for colliding labels. */
export function agentDisplayLabels(refs: string[], displayByName: Record<string, string>) {
  const uniqueRefs = [...new Set(refs)]
  const counts = new Map<string, number>()
  for (const ref of uniqueRefs) {
    const display = displayByName[ref] ?? ref
    counts.set(display, (counts.get(display) ?? 0) + 1)
  }
  return Object.fromEntries(
    uniqueRefs.map(ref => {
      const display = displayByName[ref] ?? ref
      return [ref, (counts.get(display) ?? 0) > 1 ? `${display} (${ref})` : display]
    })
  )
}
