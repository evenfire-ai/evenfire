const CHATGPT_AUTH_CLAIM = 'https://api.openai.com/auth'

/**
 * ChatGPT Responses requires ChatGPT-Account-ID. The OAuth access token is
 * sometimes opaque, so the gateway also reads the id_token at grant time.
 */
export function chatgptAccountIdFromJwt(token: string | null | undefined): string | undefined {
  if (!token) return undefined
  const parts = token.split('.')
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
