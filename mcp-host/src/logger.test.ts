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
    delete process.env.MCP_HOST_LOGGER_PROBE
  })
})
