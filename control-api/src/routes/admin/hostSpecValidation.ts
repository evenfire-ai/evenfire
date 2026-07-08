import { z } from 'zod'

const HostApprovalSchema = z
  .object({
    defaultPolicy: z.string().optional(),
    channels: z.any().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
  })
  .passthrough()
  .optional()

export function validateHostSpec(
  spec: Record<string, unknown>
): { errors: Array<{ field: string; message: string }> } | null {
  if (spec.approval === undefined) return null
  const result = HostApprovalSchema.safeParse(spec.approval)
  if (result.success) return null
  const errors = result.error.issues.map(issue => ({
    field: ['spec', 'approval', ...issue.path].join('.'),
    message: issue.message,
  }))
  return { errors }
}
