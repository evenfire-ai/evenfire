const CHATGPT_AUTH_CLAIM = 'https://api.openai.com/auth'

/** Identifies this Evenfire client; do not impersonate `codex_cli_rs`. */
export const CODEX_UPSTREAM_ORIGINATOR = 'evenfire'
export const CODEX_UPSTREAM_VERSION = '1.0.0'
export const CODEX_OPENAI_BETA = 'responses=v1'

export function chatgptAccountIdFromAccessToken(accessToken: string): string | undefined {
  const parts = accessToken.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    const nested = payload[CHATGPT_AUTH_CLAIM]
    if (nested && typeof nested === 'object') {
      const accountId = (nested as { chatgpt_account_id?: unknown }).chatgpt_account_id
      if (typeof accountId === 'string' && accountId.trim()) return accountId.trim()
    }
    if (typeof payload.chatgpt_account_id === 'string' && payload.chatgpt_account_id.trim()) {
      return payload.chatgpt_account_id.trim()
    }
    const auth = payload.auth
    if (auth && typeof auth === 'object') {
      const accountId = (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id
      if (typeof accountId === 'string' && accountId.trim()) return accountId.trim()
    }
  } catch {
    return undefined
  }
  return undefined
}

export function chatgptUpstreamHeaders(
  accessToken: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    originator: CODEX_UPSTREAM_ORIGINATOR,
    'user-agent': 'evenfire-codex-subscription',
    'oai-product-sku': 'codex',
    'openai-beta': CODEX_OPENAI_BETA,
    version: CODEX_UPSTREAM_VERSION,
    ...extra,
  }
  const accountId = chatgptAccountIdFromAccessToken(accessToken)
  if (accountId) headers['chatgpt-account-id'] = accountId
  return headers
}
