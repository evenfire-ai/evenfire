/**
 * Pure routing for the `clerum://oauth-completed?…` deep link the control-api
 * OAuth callback bounces to. Extracted from `main.ts` (which has no testable
 * exports) so the source-branching invariant is unit-testable — mirrors the
 * `mainWindowCoordinator` extraction pattern.
 *
 * Two producers land on the SAME `oauth-completed` host:
 *  - sandbox-ui / recipe OAuth — FROZEN wire shape: `clientId` + `provider`, no
 *    `source`. Routed to the active sandbox-ui embed (`dispatchSandboxUiOauthCompleted`).
 *  - mcp-server OAuth (U5 reactive consent) — control-api appends `&source=mcp`
 *    (and, per the option-(b) deep-link, `&mcpServerName=<X>`). Routed to the
 *    renderer to resume the suspended conversation, correlated by `mcpServerName`.
 *
 * The `source`-absent / `source!=='mcp'` path is byte-identical to the pre-U5
 * behaviour: same guard order, same `clientId`-required rejection, same sandbox
 * envelope.
 */
export type ClerumOauthCompletedRoute =
  | { kind: 'ignore' }
  | { kind: 'sandbox'; oauthClientId: string; provider: string }
  | { kind: 'mcp'; mcpServerName: string; provider: string }

export function routeClerumOauthCompleted(
  rawUrl: string,
  clerumProtocol: string
): ClerumOauthCompletedRoute {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { kind: 'ignore' }
  }
  if (parsed.protocol !== `${clerumProtocol}:`) return { kind: 'ignore' }
  if (parsed.hostname.toLowerCase() !== 'oauth-completed') return { kind: 'ignore' }

  const oauthClientId = parsed.searchParams.get('clientId') || ''
  const provider = parsed.searchParams.get('provider') || ''
  // clientId is required for BOTH producers (control-api builds it
  // unconditionally, even for the mcp subject), so the guard precedes the
  // source branch exactly as before — an mcp completion still carries clientId.
  if (!oauthClientId) return { kind: 'ignore' }

  if ((parsed.searchParams.get('source') || '') === 'mcp') {
    return {
      kind: 'mcp',
      mcpServerName: parsed.searchParams.get('mcpServerName') || '',
      provider,
    }
  }

  return { kind: 'sandbox', oauthClientId, provider }
}
