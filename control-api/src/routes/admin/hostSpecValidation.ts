import { z } from 'zod'

const HostApprovalSchema = z
  .object({
    defaultPolicy: z.string().optional(),
    channels: z.any().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
  })
  .passthrough()
  .optional()

// spec.lifecycle follows the facade's contract for optional spec objects,
// exactly like spec.desktop: the admin facade forwards body.spec to the K8s
// client WHOLESALE (resourceService.updateResource is a full replace via
// replaceNamespacedCustomObject), so an update payload WITHOUT lifecycle
// strips it from the CR — absent means disabled. Control UI must always echo
// the full spec it read (get -> edit -> update); the round-trip regression in
// test/routes.resources.test.ts pins that guarantee. When present, lifecycle
// must be an object carrying a boolean `stateless`; unknown extra keys pass
// through, matching the HostApprovalSchema idiom above.
//
// AP-6 (docs/architecture/stateless-invariants.md): the echo alone cannot
// protect against a STALE echo — a form saved after the CR changed would
// replace the fresh spec with what the form read earlier. Control UI
// therefore also sends metadata.resourceVersion of the read the edit form
// was built from; resourceService.updateResource uses it as the replace
// precondition and surfaces 409 {error:'conflict', reason:'resource_changed'}
// instead of retrying with the stale payload.
const HostLifecycleSchema = z
  .object({
    stateless: z.boolean(),
  })
  .passthrough()
  .optional()

export function validateHostSpec(
  spec: Record<string, unknown>
): { errors: Array<{ field: string; message: string }> } | null {
  const errors: Array<{ field: string; message: string }> = []
  if (spec.approval !== undefined) {
    const result = HostApprovalSchema.safeParse(spec.approval)
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push({
          field: ['spec', 'approval', ...issue.path].join('.'),
          message: issue.message,
        })
      }
    }
  }
  if (spec.lifecycle !== undefined) {
    const result = HostLifecycleSchema.safeParse(spec.lifecycle)
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push({
          field: ['spec', 'lifecycle', ...issue.path].join('.'),
          message: issue.message,
        })
      }
    }
  }
  if (errors.length === 0) return null
  return { errors }
}
