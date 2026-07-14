import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateApprovalConfig } from '../approvalConfigValidation'
import type { ApprovalConfig } from '../approvalTypes'

describe('validateApprovalConfig', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('emits no warnings or audit log when config has no tools field', () => {
    const config: ApprovalConfig = {
      defaultPolicy: 'channel_users',
      channels: {},
    }
    validateApprovalConfig(config, new Set(['http_request', 'shell_exec']), [])
    expect(warnSpy).not.toHaveBeenCalled()
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('warns once per unknown tool name in tools map', () => {
    const config: ApprovalConfig = {
      defaultPolicy: 'channel_users',
      channels: {},
      tools: { typo_one: false, typo_two: true, http_request: false },
    }
    validateApprovalConfig(
      config,
      new Set(['http_request', 'shell_exec']),
      ['api.example.com'] // non-empty allowlist to avoid secondary http_request warning
    )
    const warnings = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]))
    // Unknown tools get "not in the always-on set" warnings mentioning them by name
    expect(
      warnings.some((w: string) => w.includes('"typo_one"') && w.includes('always-on set'))
    ).toBe(true)
    expect(
      warnings.some((w: string) => w.includes('"typo_two"') && w.includes('always-on set'))
    ).toBe(true)
    // Known tools do not get the not-in-set warning
    expect(
      warnings.some((w: string) => w.includes('"http_request"') && w.includes('always-on set'))
    ).toBe(false)
    // The new wording explicitly mentions conditional tools so operators know
    // the override may still apply at runtime.
    expect(warnings.some((w: string) => w.includes('conditional tool'))).toBe(true)
  })

  it('warns when http_request:false is set with empty httpAllowlist', () => {
    const config: ApprovalConfig = {
      defaultPolicy: 'channel_users',
      channels: {},
      tools: { http_request: false },
    }
    validateApprovalConfig(
      config,
      new Set(['http_request']),
      [] // empty allowlist
    )
    const warnings = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(
      warnings.some((w: string) => w.includes('http_request') && w.includes('allowlist'))
    ).toBe(true)
  })

  it('does NOT warn when http_request:false is set with non-empty httpAllowlist', () => {
    const config: ApprovalConfig = {
      defaultPolicy: 'channel_users',
      channels: {},
      tools: { http_request: false },
    }
    validateApprovalConfig(config, new Set(['http_request']), ['api.github.com'])
    const warnings = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(
      warnings.some((w: string) => w.includes('http_request') && w.includes('allowlist'))
    ).toBe(false)
  })

  it('does NOT warn for http_request:true with empty allowlist (no loosening)', () => {
    const config: ApprovalConfig = {
      defaultPolicy: 'channel_users',
      channels: {},
      tools: { http_request: true },
    }
    validateApprovalConfig(config, new Set(['http_request']), [])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('emits a positive audit log listing every active override', () => {
    const config: ApprovalConfig = {
      defaultPolicy: 'channel_users',
      channels: {},
      tools: { http_request: false, shell_exec: true, file_read: false },
    }
    validateApprovalConfig(config, new Set(['http_request', 'shell_exec', 'file_read']), [
      'api.github.com',
    ])
    const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(logs.length).toBe(1)
    const summary = logs[0]
    expect(summary).toContain('Per-tool approval overrides in effect')
    expect(summary).toContain('http_request=false')
    expect(summary).toContain('shell_exec=true')
    expect(summary).toContain('file_read=false')
  })

  it('does not emit the audit log when tools is empty', () => {
    const config: ApprovalConfig = {
      defaultPolicy: 'channel_users',
      channels: {},
      // tools field absent
    }
    validateApprovalConfig(config, new Set(['http_request']), [])
    expect(logSpy).not.toHaveBeenCalled()
  })
})
