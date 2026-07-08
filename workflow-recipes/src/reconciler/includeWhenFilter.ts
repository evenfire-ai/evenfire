import type { BindingDef, ResourceDef, WorkloadDef } from '../types'

/**
 * Resolve a template reference like "{{inputs.KEY}}" against resolvedInputs.
 * Returns the raw value from resolvedInputs, or undefined if the template
 * doesn't match or the key is not present.
 */
function resolveTemplate(template: string, resolvedInputs: Record<string, unknown>): unknown {
  const match = template.match(/^\{\{\s*inputs\.(\w+)\s*\}\}$/)
  if (!match) return undefined
  const key = match[1]
  return resolvedInputs[key]
}

/**
 * Determine if a resolved value is "truthy" for includeWhen purposes.
 *
 * Truthy: true, "true", non-empty non-zero values.
 * Falsy: false, "false", 0, "", null, undefined.
 */
function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value !== '' && value !== 'false' && value !== '0'
  if (typeof value === 'number') return value !== 0
  return true
}

/**
 * Filter workloads, resources, and bindings based on `includeWhen` conditions.
 *
 * - Workloads with an `includeWhen` template that resolves to a falsy value are excluded.
 * - Bindings referencing excluded workload IDs (in `from` or `to`) are dropped.
 * - `dependsOn` entries referencing excluded workload IDs are removed from remaining workloads.
 * - Resources are passed through unchanged (ResourceDef has no `includeWhen` field).
 */
export function filterByIncludeWhen(
  workloads: WorkloadDef[],
  resources: ResourceDef[] | undefined,
  bindings: BindingDef[] | undefined,
  resolvedInputs: Record<string, unknown>
): {
  workloads: WorkloadDef[]
  resources: ResourceDef[]
  bindings: BindingDef[]
} {
  const excludedIds = new Set<string>()

  // --- Filter workloads ---
  const includedWorkloads: WorkloadDef[] = []
  for (const w of workloads) {
    if (w.includeWhen !== undefined) {
      const resolved = resolveTemplate(w.includeWhen, resolvedInputs)
      if (!isTruthy(resolved)) {
        excludedIds.add(w.id)
        continue
      }
    }
    includedWorkloads.push(w)
  }

  // --- Clean dependsOn on remaining workloads ---
  const cleanedWorkloads: WorkloadDef[] = includedWorkloads.map(w => {
    if (!w.dependsOn || w.dependsOn.length === 0) return w
    const filtered = w.dependsOn.filter(dep => !excludedIds.has(dep))
    if (filtered.length === w.dependsOn.length) return w
    return {
      ...w,
      dependsOn: filtered.length > 0 ? filtered : undefined,
    } as WorkloadDef
  })

  // --- Filter bindings ---
  const filteredBindings: BindingDef[] = (bindings ?? []).filter(
    b => !excludedIds.has(b.from) && !excludedIds.has(b.to)
  )

  return {
    workloads: cleanedWorkloads,
    resources: resources ?? [],
    bindings: filteredBindings,
  }
}
