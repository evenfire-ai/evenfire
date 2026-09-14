import { describe, expect, it } from 'vitest'
import { redactUnknown } from './logger.js'

describe('mcp-host structured logger redaction', () => {
  it('does not serialize process.env or secret-bearing fields', () => {
    process.env.MCP_HOST_LOGGER_PROBE = 'env-secret-value'
    expect(redactUnknown(process.env)).toBe('[Redacted]')
    expect(redactUnknown({ accessToken: 'sk-live', ok: true })).toEqual({
      accessToken: '[Redacted]',
      ok: true,
    })
    expect(
      redactUnknown({ chatgptAccountId: 'acct_live', accountId: 'acct_live', ok: true })
    ).toEqual({
      chatgptAccountId: '[Redacted]',
      accountId: '[Redacted]',
      ok: true,
    })
    delete process.env.MCP_HOST_LOGGER_PROBE
  })

  it('retains Error classification without non-enumerable private messages or stacks', () => {
    const err = Object.assign(new Error('sensitive diagnostic content'), {
      code: 'ECONNRESET',
      status: 503,
    })
    expect(redactUnknown({ err })).toEqual({
      err: { name: 'Error', code: 'ECONNRESET', status: 503 },
    })
    expect(JSON.stringify(redactUnknown({ err }))).not.toContain('sensitive diagnostic content')
  })

  it('drops prototype-polluting keys instead of writing them onto the clone', () => {
    const input = { ok: true, constructor: { evil: true }, prototype: { evil: true } }
    expect(redactUnknown(input)).toEqual({ ok: true })
  })
})
