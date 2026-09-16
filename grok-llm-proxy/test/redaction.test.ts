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
      device_code: 'device-secret',
      user_code: 'ABCD-EFGH',
      accountId: 'acct_live_secret',
      executionTicket: 'ticket-secret',
      attemptReceipt: 'receipt-secret',
      authorization: 'Bearer secret',
      headers: { authorization: 'Bearer secret' },
      event: 'grok_proxy_probe',
    })
    const joined = messages.join('\n')
    expect(joined).toContain('grok_proxy_probe')
    expect(joined).not.toContain('sk-live-secret')
    expect(joined).not.toContain('rt-secret')
    expect(joined).not.toContain('acct_live_secret')
    expect(joined).not.toContain('device-secret')
    expect(joined).not.toContain('ABCD-EFGH')
    expect(joined).not.toContain('ticket-secret')
    expect(joined).not.toContain('receipt-secret')
    expect(joined).not.toContain('Bearer secret')
    expect(logger.bindings()).toMatchObject({ svc: 'grok-llm-proxy' })
  })
})
