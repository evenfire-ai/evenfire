import { describe, expect, it } from 'vitest'
import { createProxyLogger, logger } from '../src/logger.js'

describe('proxy redaction', () => {
  it('strips access tokens, tickets, receipts, and authorization headers', () => {
    const messages: string[] = []
    const stream = {
      write(chunk: string) {
        messages.push(chunk)
      },
    }
    const probe = createProxyLogger(stream)
    probe.info({
      accessToken: 'sk-live-secret',
      refreshToken: 'rt-secret',
      chatgptAccountId: 'acct_live_secret',
      accountId: 'acct_live_secret',
      executionTicket: 'ticket-secret',
      attemptReceipt: 'receipt-secret',
      authorization: 'Bearer secret',
      headers: { authorization: 'Bearer secret' },
      event: 'codex_proxy_probe',
    })
    const joined = messages.join('\n')
    expect(joined).toContain('codex_proxy_probe')
    expect(joined).not.toContain('sk-live-secret')
    expect(joined).not.toContain('rt-secret')
    expect(joined).not.toContain('acct_live_secret')
    expect(joined).not.toContain('ticket-secret')
    expect(joined).not.toContain('receipt-secret')
    expect(joined).not.toContain('Bearer secret')
    expect(logger.bindings()).toMatchObject({ svc: 'codex-llm-proxy' })
  })
})
