'use client'

function uniqueTrimmed(values: unknown[]): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  for (const value of values) {
    const trimmed = String(value || '').trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    output.push(trimmed)
  }
  return output
}

export function partitionVisibleAccess(
  assignedValues: unknown[],
  visibleValues: unknown[],
  deletedValues: unknown[] = []
): { active: string[]; deleted: string[] } {
  const visible = new Set(uniqueTrimmed(visibleValues))
  const active: string[] = []
  const deleted = uniqueTrimmed(deletedValues)
  const deletedSet = new Set(deleted)

  for (const value of uniqueTrimmed(assignedValues)) {
    if (visible.has(value)) {
      active.push(value)
    } else if (!deletedSet.has(value)) {
      deletedSet.add(value)
      deleted.push(value)
    }
  }

  return { active, deleted }
}
