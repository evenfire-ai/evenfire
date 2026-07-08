import type { WebhookDef, WorkflowRecipeCRD } from '../types'
import { resolveWorkloadResourceName } from './resourceBuilder'
import type { HandlerMeta } from './webhookGatewayBuilder'

/**
 * Result of validating a recipe's `spec.webhooks[]` against its
 * `spec.workloads[]`. Wraps the runtime equivalent of the W2 CEL rule
 * (which we can't express in CEL — see slice 1 commit).
 *
 * Invariant: callers MUST treat `kind: 'invalid'` as fail-closed —
 * gateway resources are NOT created and the recipe carries the
 * matching status condition instead.
 */
export type WebhookValidationResult =
  | {
      kind: 'ok'
      /** Per-webhook handler metadata, ready to feed into BuildInput.handlers. */
      handlers: Record<string, HandlerMeta>
    }
  | {
      kind: 'invalid'
      conditionType: 'WebhookHandlerInvalid'
      message: string
    }

const DEFAULT_HANDLER_PORT = 8080

/**
 * Validate W2 + resolve handler metadata for the gateway builder.
 *
 * W2 enforced here (not in CRD CEL because workloads[] is unbounded):
 *   - workloadRef must reference an existing workloads[] entry
 *   - the matched workload must be `type: deployment`
 *   - the matched workload must have NO `transport` field (MCP servers
 *     cannot be webhook handlers)
 *
 * Resolved fields:
 *   - podName via resolveWorkloadResourceName(...) so the gateway
 *     egress NetworkPolicy and the upstream URL agree on the actual
 *     pod label and Service name.
 *   - port from workload.port (default 8080 — same default the rest
 *     of the WRC uses).
 *   - path from webhook.path (the value the handler actually sees).
 */
export function validateWebhooks(
  recipe: WorkflowRecipeCRD,
  webhooks: ReadonlyArray<WebhookDef>
): WebhookValidationResult {
  const handlers: Record<string, HandlerMeta> = {}
  const workloadsById: Record<string, NonNullable<WorkflowRecipeCRD['spec']['workloads']>[number]> =
    Object.create(null)
  for (const w of recipe.spec.workloads ?? []) {
    workloadsById[w.id] = w
  }
  for (const wh of webhooks) {
    const workload = workloadsById[wh.workloadRef]
    if (!workload) {
      return {
        kind: 'invalid',
        conditionType: 'WebhookHandlerInvalid',
        message: `webhooks[${wh.id}].workloadRef "${wh.workloadRef}" does not match any workloads[].id`,
      }
    }
    if (workload.type !== 'deployment') {
      return {
        kind: 'invalid',
        conditionType: 'WebhookHandlerInvalid',
        message: `webhooks[${wh.id}].workloadRef "${wh.workloadRef}" must be type=deployment (found ${workload.type})`,
      }
    }
    if (workload.transport) {
      return {
        kind: 'invalid',
        conditionType: 'WebhookHandlerInvalid',
        message: `webhooks[${wh.id}].workloadRef "${wh.workloadRef}" must not have transport set (MCP servers cannot be webhook handlers)`,
      }
    }
    handlers[wh.id] = {
      podName: resolveWorkloadResourceName(recipe, workload.id),
      port: workload.port ?? DEFAULT_HANDLER_PORT,
      path: wh.path,
    }
  }
  return { kind: 'ok', handlers }
}
