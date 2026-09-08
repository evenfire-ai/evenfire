export function workflowStatusTone(status: string | null | undefined): 'allowed' | 'denied' | '' {
  const normalized = String(status ?? '')
    .trim()
    .toLowerCase()
  if (['active', 'completed', 'running', 'succeeded'].includes(normalized)) return 'allowed'
  if (['canceled', 'cancelled', 'error', 'failed'].includes(normalized)) return 'denied'
  return ''
}

/**
 * Map a workflow/run status to a `Pill` tone so Plugins renders the same
 * primitive status chip as Agents/Connectors (spec 12 §6 uniformity). Derived
 * from `workflowStatusTone` so the allowed/denied buckets stay in one place.
 */
export function workflowStatusPillTone(
  status: string | null | undefined
): 'success' | 'danger' | 'neutral' {
  const tone = workflowStatusTone(status)
  if (tone === 'allowed') return 'success'
  if (tone === 'denied') return 'danger'
  return 'neutral'
}
