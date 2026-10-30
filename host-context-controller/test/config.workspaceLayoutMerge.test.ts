import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseWorkspaceLayoutMerge } from '../src/config'

describe('parseWorkspaceLayoutMerge', () => {
  it('defaults to true when the env var is unset or empty', () => {
    expect(parseWorkspaceLayoutMerge(undefined)).toBe(true)
    expect(parseWorkspaceLayoutMerge('')).toBe(true)
  })

  it('accepts exactly true and false', () => {
    expect(parseWorkspaceLayoutMerge('true')).toBe(true)
    expect(parseWorkspaceLayoutMerge('false')).toBe(false)
  })

  it.each(['ture', 'yes', '1', '0', 'TRUE', 'False', 'off', 'false ', ' true'])(
    'refuses %j instead of guessing',
    raw => {
      expect(() => parseWorkspaceLayoutMerge(raw)).toThrow(
        `CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE must be 'true' or 'false', got '${raw}'`
      )
    }
  )
})

describe('config.workspaceLayoutMerge', () => {
  afterEach(() => {
    delete process.env.CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE
    vi.resetModules()
  })

  it('is enabled when the env var is absent', async () => {
    const { config } = await import('../src/config')
    expect(config.workspaceLayoutMerge).toBe(true)
  })

  it('is disabled by an explicit false', async () => {
    process.env.CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE = 'false'
    const { config } = await import('../src/config')
    expect(config.workspaceLayoutMerge).toBe(false)
  })

  it('fails config load on an invalid value', async () => {
    process.env.CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE = 'ture'
    await expect(import('../src/config')).rejects.toThrow(
      /CONTEXT_MAPPER_WORKSPACE_LAYOUT_MERGE must be 'true' or 'false'/
    )
  })
})
