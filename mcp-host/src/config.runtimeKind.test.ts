import { describe, expect, it } from 'vitest'
import { resolveMcpHostRuntimeKind } from './config'

describe('resolveMcpHostRuntimeKind', () => {
  it('derives legacy workflow and standalone pods when no explicit mode exists', () => {
    expect(resolveMcpHostRuntimeKind({ workflowEnabled: true })).toBe('workflow')
    expect(resolveMcpHostRuntimeKind({ workflowEnabled: false })).toBe('standalone')
  })

  it('selects sdk-only only from an explicit non-workflow contract', () => {
    expect(
      resolveMcpHostRuntimeKind({
        workflowEnabled: false,
        pluginWorkloadSdkRuntimeMode: 'sdk-only',
      })
    ).toBe('sdk-only')
  })

  it.each([
    [true, 'sdk-only'],
    [false, 'workflow'],
  ])('fails closed for contradictory workflow=%s mode=%s', (workflowEnabled, mode) => {
    expect(() =>
      resolveMcpHostRuntimeKind({
        workflowEnabled,
        pluginWorkloadSdkRuntimeMode: mode,
      })
    ).toThrow(/Contradictory mcp-host runtime configuration/)
  })

  it('rejects unknown runtime modes', () => {
    expect(() =>
      resolveMcpHostRuntimeKind({
        workflowEnabled: false,
        pluginWorkloadSdkRuntimeMode: 'legacy',
      })
    ).toThrow(/Invalid PLUGIN_WORKLOAD_SDK_RUNTIME_MODE/)
  })
})
