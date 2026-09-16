/**
 * Identity headers stamped in the proxy. Live SuperGrok may later require
 * Grok-CLI impersonation headers; the starting freeze uses Evenfire identity
 * only and never sends OpenAI-Beta or api.x.ai headers.
 */
export const GROK_UPSTREAM_USER_AGENT = 'evenfire-grok-subscription'

export function grokUpstreamHeaders(
  accessToken: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    'user-agent': GROK_UPSTREAM_USER_AGENT,
    accept: extra.accept ?? 'text/event-stream',
    ...extra,
  }
}
