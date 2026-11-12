const DESKTOP_API_TOKEN_ENV = 'CONTEXT_MAPPER_DESKTOP_API_TOKEN'
const HINT =
  "It must equal rpc-proxy's RPC_PROXY_DESKTOP_API_TOKEN; deploy/scripts/gen-jwt-keys.sh writes both " +
  '(Secret inter-service-tokens, key desktop-api-token).'

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
