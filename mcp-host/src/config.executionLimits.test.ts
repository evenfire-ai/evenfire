import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeWithTimeout } from './core/orchestration/toolExecutionTimeout'
import { ShellTool } from './core/tools/shell'
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

describe('execution limit validation', () => {
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
  it.each(
    names.flatMap(name => ['abc', '-1', '1.5', '2147483648'].map(value => ({ name, value })))
  )('rejects $name=$value', async ({ name, value }) => {
    vi.resetModules()
    vi.stubEnv(name, value)
    await expect(import('./config')).rejects.toThrow(name)
  })
  it.each(
    ['CLERUM_MCP_TOOL_TIMEOUT_MS', 'CLERUM_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS'].flatMap(name =>
      ['abc', '-1', '1.5', '2147483648'].map(value => ({ name, value }))
    )
  )('rejects $name=$value', ({ name, value }) => {
    vi.stubEnv(name, value)
    expect(() => resolveMcpRequestTimeoutMs()).toThrow(name)
  })
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

describe('tool timeouts bounded to the executable timer range (#1021)', () => {
  const maxTimerDelayMs = 2_147_483_647
  const shellCleanupMs = new ShellTool(undefined, 1, ['PATH']).timeoutCleanupMs()
  const largestTimeout = maxTimerDelayMs - shellCleanupMs

  it('reserves the 6s cleanup the shell declares', () => {
    expect(shellCleanupMs).toBe(6_000)
    expect(largestTimeout).toBe(2_147_477_647)
  })

  it.each(['CLERUM_TOOL_TIMEOUT', 'CLERUM_SHELL_TIMEOUT'])(
    'U11: accepts %s at 2^31-1 minus the shell cleanup and rejects one more',
    async name => {
      vi.resetModules()
      vi.stubEnv(name, String(largestTimeout))
      const { config } = await import('./config')
      const field = name === 'CLERUM_TOOL_TIMEOUT' ? 'toolTimeout' : 'shellTimeout'
      expect(config.nativeTool[field]).toBe(largestTimeout)

      vi.resetModules()
      vi.stubEnv(name, String(largestTimeout + 1))
      await expect(import('./config')).rejects.toThrow(
        `${name} must be a valid bounded integer from 1 to 2147477647 (inclusive)`
      )
    }
  )

  it.each([
    { name: 'CLERUM_AGENT_MAX_TASK_DURATION', field: 'agentMaxTaskDuration' as const },
    { name: 'CLERUM_AGENT_MAX_TOOL_CALLS', field: 'agentMaxToolCallsPerTask' as const },
  ])(
    'accepts $name at the full timer range 2^31-1 and rejects one more',
    async ({ name, field }) => {
      vi.resetModules()
      vi.stubEnv(name, String(maxTimerDelayMs))
      const { config } = await import('./config')
      expect(config[field]).toBe(maxTimerDelayMs)

      vi.resetModules()
      vi.stubEnv(name, String(maxTimerDelayMs + 1))
      await expect(import('./config')).rejects.toThrow(
        `${name} must be a valid bounded integer from 1 to 2147483647 (inclusive)`
      )
    }
  )

  it('U11: the accepted maximum runs a shell call and one more is refused by the timer guard', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'clerum-timeout-bound-'))
    try {
      const shell = new ShellTool(workspace, largestTimeout, ['PATH'])
      const output = await executeWithTimeout(
        shell,
        { command: 'printf u11-ok' },
        { onOutput: () => undefined },
        largestTimeout
      )
      expect(output.is_error).toBe(false)
      expect(output.content).toContain('u11-ok')
      await expect(
        executeWithTimeout(
          shell,
          { command: 'printf u11-never' },
          { onOutput: () => undefined },
          largestTimeout + 1
        )
      ).rejects.toThrow('Invalid tool execution or cleanup timeout')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
