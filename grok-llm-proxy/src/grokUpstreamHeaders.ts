/**
 * Identity headers stamped in the proxy.
 *
 * xAI's Grok Build proxy gates subscription inference on a client version: a
 * request without one is refused with 426 ("Your Grok CLI version (none) is
 * outdated"), recorded by the live probe on 2026-09-18. Evenfire therefore
 * sends the compatibility version xAI checks, but identifies itself honestly:
 * the client identifier and user agent name Evenfire, never `grok-shell` or
 * `xai-grok-workspace`. This mirrors the Codex adapter, which sends the
 * product headers OpenAI expects under `originator: evenfire` and explicitly
 * does not impersonate `codex_cli_rs`.
 *
 * `x-xai-token-auth` designates the token TYPE for any OAuth session token; it
 * is not a claim to be the CLI.
 *
 * The version is the only value xAI moves. Operators override it with
 * GROK_LLM_PROXY_CLIENT_VERSION when xAI raises the floor, so a bump is a
 * config change and not a release.
 */
export const GROK_UPSTREAM_USER_AGENT = 'evenfire-grok-subscription'
export const GROK_UPSTREAM_CLIENT_IDENTIFIER = 'evenfire'
export const GROK_UPSTREAM_CLIENT_MODE = 'headless'
export const GROK_UPSTREAM_TOKEN_AUTH = 'xai-grok-cli'
/** Pinned to a real published @xai-official/grok release (floor was 0.1.202). */
export const GROK_UPSTREAM_DEFAULT_CLIENT_VERSION = '1.0.34'

const CLIENT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/**
 * A real dotted release, or the pinned default. A malformed override falls back
 * rather than sending a value xAI would reject, which would look like an outage.
 */
export function resolveGrokClientVersion(raw: string | undefined): string {
  const value = raw?.trim() ?? ''
  return CLIENT_VERSION_PATTERN.test(value) ? value : GROK_UPSTREAM_DEFAULT_CLIENT_VERSION
}

export function grokUpstreamHeaders(
  accessToken: string,
  extra: Record<string, string> = {},
  clientVersion: string = resolveGrokClientVersion(process.env.GROK_LLM_PROXY_CLIENT_VERSION)
): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    'user-agent': `${GROK_UPSTREAM_USER_AGENT} grok-build/${clientVersion}`,
    'x-grok-client-version': clientVersion,
    'x-grok-client-identifier': GROK_UPSTREAM_CLIENT_IDENTIFIER,
    'x-grok-client-mode': GROK_UPSTREAM_CLIENT_MODE,
    'x-xai-token-auth': GROK_UPSTREAM_TOKEN_AUTH,
    accept: extra.accept ?? 'text/event-stream',
    ...extra,
  }
}
