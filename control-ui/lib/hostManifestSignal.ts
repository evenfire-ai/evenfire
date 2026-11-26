import type { HostResource } from './api'

/** What `manifestSignal` found: no manifest, or one, with its approval values when it left them. */
export type ManifestSignal =
  | { managed: false }
  | { managed: true; values: Record<string, unknown> | null }

const LAST_APPLIED_ANNOTATION = 'kubectl.kubernetes.io/last-applied-configuration'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The `spec.approval` a client-side apply recorded, or undefined when it recorded none. */
function lastAppliedApproval(
  annotation: unknown
): { found: false } | { found: true; values: Record<string, unknown> | null } {
  if (typeof annotation !== 'string') return { found: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(annotation)
  } catch {
    // Dropped on purpose: an annotation that is not JSON is not a manifest's
    // record (nothing in it can be read as spec.approval), and this banner is
    // advice, so it never blocks the page. A server-side apply entry in
    // managedFields can still show the banner.
    return { found: false }
  }
  const spec = isRecord(parsed) ? parsed.spec : undefined
  if (!isRecord(spec) || !Object.hasOwn(spec, 'approval')) return { found: false }
  return { found: true, values: isRecord(spec.approval) ? spec.approval : null }
}

/** Whether a managedFields entry is a server-side apply that owns `spec.approval`. */
function appliesApproval(entry: unknown): boolean {
  if (!isRecord(entry) || entry.operation !== 'Apply') return false
  const fields = isRecord(entry.fieldsV1) ? entry.fieldsV1['f:spec'] : undefined
  return isRecord(fields) && Object.hasOwn(fields, 'f:approval')
}

/**
 * Spec §6.7: whether a deployment manifest manages this agent's approval
 * settings. Either signal counts: a `last-applied-configuration` annotation
 * that holds `spec.approval` (client-side apply; its values show), or a
 * managedFields entry of operation `Apply` that owns `f:spec.f:approval`
 * (server-side apply; no values). `Update` entries never count, so a Host
 * edited through this UI or by `kubectl patch` shows nothing.
 */
export function manifestSignal(host: HostResource): ManifestSignal {
  const metadata: Record<string, unknown> = isRecord(host.metadata) ? host.metadata : {}
  const annotations = metadata.annotations
  const applied = lastAppliedApproval(
    isRecord(annotations) ? annotations[LAST_APPLIED_ANNOTATION] : undefined
  )
  if (applied.found) return { managed: true, values: applied.values }
  const fields = metadata.managedFields
  if (Array.isArray(fields) && fields.some(appliesApproval)) return { managed: true, values: null }
  return { managed: false }
}
