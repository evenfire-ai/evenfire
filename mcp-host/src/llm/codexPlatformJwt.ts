/**
 * Live mcp-host runtime JWT for Codex authorize/proxy hops.
 *
 * The boot env token expires (~300s). Heartbeat, usage, and approvals already
 * refresh `runtimeAuth.accessToken` in place. Codex must read that holder —
 * a frozen `process.env.MCP_HOST_RUNTIME_ACCESS_TOKEN` 401s after the first
 * access-token lifetime.
 */

let reader: () => string = () => (process.env.MCP_HOST_RUNTIME_ACCESS_TOKEN || '').trim()
let refresh: (() => Promise<void>) | undefined

export function setCodexPlatformJwtReader(fn: () => string): void {
  reader = fn
}

export function setCodexPlatformJwtRefresh(fn: () => Promise<void>): void {
  refresh = fn
}

export function readCodexPlatformJwt(): string {
  return reader().trim()
}

export async function refreshCodexPlatformJwt(): Promise<void> {
  if (!refresh) return
  await refresh()
}
