import type { ApprovalConfig } from './approvalTypes'

/**
 * Validate and audit-log the `tools` overrides in an ApprovalConfig.
 *
 * Emits console warnings for:
 *   1. Override key references a tool name not in `knownToolNames`.
 *   2. `http_request: false` is set while `httpAllowlist` is empty
 *      (operator skipped approval but didn't constrain outbound HTTP).
 *
 * Always emits a positive `console.log` audit summary listing every active
 * override, so operators tailing logs can confirm the CRD took effect and spot
 * risky configurations (any `tools.X: false` is a per-call approval bypass).
 *
 * Never throws. Validation is best-effort visibility, not enforcement.
 *
 * @param config The parsed ApprovalConfig (or undefined — no-op).
 * @param knownToolNames Set of native tool names registered at runtime.
 * @param httpAllowlist Effective CLERUM_HTTP_ALLOWLIST (parsed array).
 */
export function validateApprovalConfig(
  config: ApprovalConfig | undefined,
  knownToolNames: Set<string>,
  httpAllowlist: string[]
): void {
  const tools = config?.tools
  if (!tools) return

  for (const name of Object.keys(tools)) {
    if (!knownToolNames.has(name)) {
      // The known set covers the always-on registry only. Conditionally
      // registered tools (memory_*, cron_*, desktop_*, workspace) are NOT
      // listed here but their overrides ARE honored at runtime if/when those
      // tools register. So the message points at typo detection without
      // claiming the override was ignored.
      console.warn(
        `[approval-config] Override for native tool "${name}" — not in the ` +
          `always-on set. Verify this is the correct tool name. If "${name}" ` +
          `is a conditional tool (memory/cron/desktop/workspace), the override ` +
          `will apply at runtime. Always-on tools: ` +
          `${[...knownToolNames].sort().join(', ')}`
      )
    }
  }

  if (tools.http_request === false && httpAllowlist.length === 0) {
    console.warn(
      `[approval-config] tools.http_request: false is set without CLERUM_HTTP_ALLOWLIST. ` +
        `Outbound HTTP is unrestricted; review your network egress policy or set an allowlist.`
    )
  }

  // Audit summary — always emitted when at least one override is configured.
  // Operators rely on this line to verify the CRD took effect.
  const summary = Object.entries(tools)
    .map(([name, value]) => `${name}=${value}`)
    .join(', ')
  console.log(
    `[approval-config] Per-tool approval overrides in effect: ${summary}. ` +
      `Verify your trust boundaries.`
  )
}
