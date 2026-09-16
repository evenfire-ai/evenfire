import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveMcpRequestTimeoutMs } from './mcp/requestOptions'

const names = [
  'CLERUM_AGENT_TASK_DELAY',
  'CLERUM_AGENT_MAX_TASK_DURATION',
  'CLERUM_AGENT_MAX_TOOL_CALLS',
  'CLERUM_SHELL_TIMEOUT',
  'CLERUM_TOOL_TIMEOUT',
]
afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('execution limit empty-value policy', () => {
  it.each(names)('rejects an explicitly empty %s', async name => {
    vi.resetModules()
    vi.stubEnv(name, '')
    await expect(import('./config')).rejects.toThrow(name)
  })
  it.each(['CLERUM_MCP_TOOL_TIMEOUT_MS', 'CLERUM_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS'])(
    'rejects an explicitly empty %s',
    name => {
      vi.stubEnv(name, '')
      expect(() => resolveMcpRequestTimeoutMs()).toThrow(name)
    }
  )
  it('keeps defaults when execution variables are absent', async () => {
    vi.resetModules()
    for (const name of [
      ...names,
      'CLERUM_MCP_TOOL_TIMEOUT_MS',
      'CLERUM_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS',
    ])
      vi.stubEnv(name, undefined)
    const { config } = await import('./config')
    expect(config.agentTaskDelay).toBe(3)
    expect(config.agentMaxTaskDuration).toBe(86400000)
    expect(config.agentMaxToolCallsPerTask).toBe(1000)
    expect(config.nativeTool.shellTimeout).toBe(1500000)
    expect(config.nativeTool.toolTimeout).toBe(1500000)
    expect(resolveMcpRequestTimeoutMs()).toBe(1500000)
  })
})
