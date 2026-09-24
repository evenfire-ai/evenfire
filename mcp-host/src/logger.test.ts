import { describe, expect, it, vi } from 'vitest'
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

  it('emits a structured fallback through the public logger when fields cannot be serialized', async () => {
    const previousConsole = { log: console.log, error: console.error, warn: console.warn }
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubEnv('LOG_LEVEL', 'info')
    vi.resetModules()
    try {
      // The module binds its sinks at import time, so capture the sink before
      // loading it and restore its console adapters after this isolated check.
      const { logger } = await import('./logger.js')
      logger.info({ taskId: 'task-1' }, 'valid fields')
      const fields = Object.defineProperty({ taskId: 'task-2' }, 'unreadable', {
        enumerable: true,
        get() {
          throw new Error('fixture field cannot be read')
        },
      })
      logger.info(fields, 'unserializable fields')

      expect(output).toHaveBeenCalledTimes(2)
      expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({
        taskId: 'task-1',
        level: 'info',
        msg: 'valid fields',
      })
      expect(JSON.parse(output.mock.calls[1]![0] as string)).toEqual({
        fields: '[Unserializable]',
        timestamp: expect.any(String),
        level: 'info',
        msg: 'unserializable fields',
      })
    } finally {
      output.mockRestore()
      console.log = previousConsole.log
      console.error = previousConsole.error
      console.warn = previousConsole.warn
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
})
