const DESKTOP_API_TOKEN_ENV = 'CONTEXT_MAPPER_DESKTOP_API_TOKEN'
const HINT =
  "It must equal rpc-proxy's RPC_PROXY_DESKTOP_API_TOKEN (Secret inter-service-tokens, key " +
  'desktop-api-token). deploy/scripts/gen-jwt-keys.sh writes both only on a new install; on an ' +
  'existing install it rotates every key, so follow "Required secrets without code defaults" in ' +
  'docs/deploy/releases-and-upgrades.md.'

/** Refuses an empty or placeholder desktop API token. Never echoes the value. */
export function assertDesktopApiToken(token: string): void {
  const trimmed = token.trim()
  if (!trimmed) {
    throw new Error(`${DESKTOP_API_TOKEN_ENV} env var is required outside CLERUM_DEV_MODE. ${HINT}`)
  }
  if (/^replace-with-/.test(trimmed)) {
    throw new Error(`${DESKTOP_API_TOKEN_ENV} has placeholder value. ${HINT}`)
  }
}
