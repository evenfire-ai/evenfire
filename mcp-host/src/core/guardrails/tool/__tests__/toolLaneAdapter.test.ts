/**
 * Tool-lane adapter integration (spec §6): config → rules → decision.
 */
import { describe, expect, it } from 'vitest'
import type { GuardrailsConfig } from '../../config'
import type { ToolIdentity } from '../provenance'
import { buildToolLaneGuardrail } from '../toolLaneAdapter'

const fileWrite: ToolIdentity = { provenance: 'native', name: 'file_write' }

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

describe('buildToolLaneGuardrail', () => {
  it('returns undefined with no rules (no-config compatibility)', () => {
    expect(buildToolLaneGuardrail(undefined)).toBeUndefined()
    expect(buildToolLaneGuardrail({})).toBeUndefined()
  })

  it('denies a matching call', async () => {
    const g = buildToolLaneGuardrail(config)!
    const d = await g.decide(fileWrite, { path: '/etc/passwd' })
    expect(d.decision).toBe('deny')
    expect(d.reasonCode).toBe('path_out_of_bounds')
  })

  it('unmatched call → ask default (non-empty rule set)', async () => {
    const g = buildToolLaneGuardrail(config)!
    const d = await g.decide(fileWrite, { path: '/workspace/notes.txt' })
    expect(d.decision).toBe('ask')
  })

  it('an allow rule → allow', async () => {
    const g = buildToolLaneGuardrail({
      rules: [
        {
          id: 'allow-read',
          action: 'allow',
          match: { tool: { provenance: 'mcp', server: 'github', name: 'get_issue' } },
        },
      ],
    })!
    const d = await g.decide({ provenance: 'mcp', server: 'github', name: 'get_issue' }, {})
    expect(d.decision).toBe('allow')
  })
})
