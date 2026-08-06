import type { McpServerCondition } from '@lib/api'

/**
 * Which credential surface the connector screen should render.
 *
 * - set:          the envSecret Secret does not exist; it must be CREATED (POST).
 * - rotate:       the Secret exists; values are rotated through the merge-patch (PUT).
 * - recipe-owned: the Secret is missing on a WorkflowRecipe-owned connector.
 *                 Neither operation belongs on this screen.
 */
export type CredentialSurface = 'set' | 'rotate' | 'recipe-owned'

/**
 * Matching on `reason` is load-bearing. `SecretNotFound` means the Secret does
 * not exist and must be created. `SecretMissingKey` means it EXISTS but lacks a
 * declared key — the PUT merge-patch already adds it, so that case must stay on
 * `rotate`. Matching only type+status would send it to `set`, where POST hits
 * AlreadyExists and control-api answers a bare 500 (see spec Non-goals).
 *
 * The `managed: false` check is applied ONLY when the Secret is missing. A
 * WRC-owned connector whose Secret resolves keeps today's rotate form; this
 * change fixes a dead end and does not restrict rotation that already works.
 */
export function resolveCredentialSurface(
  conditions: McpServerCondition[] | undefined,
  spec: { managed?: boolean } | undefined
): CredentialSurface {
  const missing = (conditions ?? []).some(
    c => c.type === 'SecretResolved' && c.status === 'False' && c.reason === 'SecretNotFound'
  )
  if (!missing) return 'rotate'
  return spec?.managed === false ? 'recipe-owned' : 'set'
}
