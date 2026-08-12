/**
 * Tool-lane adapter integration (spec §6): config → rules → boundary outcome.
 */
import { describe, expect, it, vi } from 'vitest'
import type { GuardrailsConfig } from '../../config'
import type { ToolIdentity } from '../provenance'
import { buildToolLaneBoundary } from '../toolLaneAdapter'

const fileWrite = (path: string) => ({
  input: { path },
  identity: { provenance: 'native', name: 'file_write' } as ToolIdentity,
})

const config: GuardrailsConfig = {
  rules: [
    {
      id: 'deny-writes-outside-workspace',
      action: 'deny',
      reasonCode: 'path_out_of_bounds',
      match: {
        tool: { provenance: 'native', name: 'file_write' },
        arguments: [{ type: 'path', pointer: '/path', op: 'outside', value: '/workspace' }],
      },
    },
  ],
}

describe('buildToolLaneBoundary', () => {
  it('returns undefined with no rules (no-config compatibility)', () => {
    expect(buildToolLaneBoundary(undefined)).toBeUndefined()
    expect(buildToolLaneBoundary({})).toBeUndefined()
  })

  it('denies a matching call and never executes it', async () => {
    const b = buildToolLaneBoundary(config)!
    const execute = vi.fn(async () => 'ran')
    const { input, identity } = fileWrite('/etc/passwd')
    const out = await b.guard({ identity, input, execute })
    expect(out).toEqual({ kind: 'denied', reasonCode: 'path_out_of_bounds' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('unmatched call falls to the ask default (non-empty rule set)', async () => {
    const b = buildToolLaneBoundary(config)!
    const { input, identity } = fileWrite('/workspace/notes.txt')
    const out = await b.guard({ identity, input, execute: async () => 'ran' })
    expect(out.kind).toBe('ask')
  })

  it('an allow rule executes a matching call', async () => {
    const b = buildToolLaneBoundary({
      rules: [
        {
          id: 'allow-read',
          action: 'allow',
          match: { tool: { provenance: 'mcp', server: 'github', name: 'get_issue' } },
        },
      ],
    })!
    const execute = vi.fn(async () => 'issue-body')
    const out = await b.guard({
      identity: { provenance: 'mcp', server: 'github', name: 'get_issue' },
      input: {},
      execute,
    })
    expect(out).toEqual({ kind: 'executed', result: 'issue-body' })
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
