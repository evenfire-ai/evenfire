/**
 * Permission-rule engine tests (spec §6.1): compilation/admission validation and
 * matching (provenance + predicates, all-match AND, wildcard names).
 */
import { describe, expect, it } from 'vitest'
import type { GuardrailRule } from '../../config'
import type { ToolIdentity } from '../provenance'
import { compileRules, evaluateRules } from '../rules'

const nativeTool = (name: string): ToolIdentity => ({ provenance: 'native', name })
const mcpTool = (server: string, name: string): ToolIdentity => ({
  provenance: 'mcp',
  server,
  name,
})

const denyWritesOutsideWorkspace: GuardrailRule = {
  id: 'deny-writes-outside-workspace',
  action: 'deny',
  reasonCode: 'path_out_of_bounds',
  match: {
    tool: { provenance: 'native', name: 'file_write' },
    arguments: [{ type: 'path', pointer: '/path', op: 'outside', value: '/workspace' }],
  },
}

describe('compileRules (admission)', () => {
  it('accepts a valid set and reports hasRules', () => {
    const c = compileRules([denyWritesOutsideWorkspace])
    expect(c.hasRules).toBe(true)
    expect(c.rules).toHaveLength(1)
  })
  it('absent/empty → hasRules false (no-config compatibility)', () => {
    expect(compileRules(undefined).hasRules).toBe(false)
    expect(compileRules([]).hasRules).toBe(false)
  })
  it('rejects duplicate ids, bad action, missing provenance, over-limit', () => {
    expect(() => compileRules([denyWritesOutsideWorkspace, denyWritesOutsideWorkspace])).toThrow(
      /duplicate/
    )
    expect(() =>
      compileRules([{ ...denyWritesOutsideWorkspace, id: 'x', action: 'nope' as never }])
    ).toThrow(/invalid rule action/)
    expect(() => compileRules([denyWritesOutsideWorkspace], 0)).toThrow(/too many/)
  })
})

describe('evaluateRules (matching)', () => {
  const compiled = compileRules([denyWritesOutsideWorkspace])

  it('emits a host_rule deny when tool + predicate match', () => {
    const out = evaluateRules(compiled, nativeTool('file_write'), { path: '/etc/passwd' })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      source: 'host_rule',
      decision: 'deny',
      sourceId: 'deny-writes-outside-workspace',
    })
  })

  it('no contribution when the predicate does not match (in-workspace write)', () => {
    expect(
      evaluateRules(compiled, nativeTool('file_write'), { path: '/workspace/n.txt' })
    ).toHaveLength(0)
  })

  it('no contribution when the tool name differs', () => {
    expect(evaluateRules(compiled, nativeTool('file_read'), { path: '/etc/passwd' })).toHaveLength(
      0
    )
  })

  it('provenance must match (native rule does not fire on an mcp tool)', () => {
    expect(
      evaluateRules(compiled, mcpTool('github', 'file_write'), { path: '/etc/passwd' })
    ).toHaveLength(0)
  })

  it('all predicates must match (AND)', () => {
    const rule: GuardrailRule = {
      id: 'deny-rm-rf',
      action: 'deny',
      match: {
        tool: { provenance: 'native', name: 'run_command' },
        arguments: [
          { type: 'command', pointer: '/command', op: 'executable_is', value: 'rm' },
          { type: 'command', pointer: '/command', op: 'argv_prefix', value: ['-rf'] },
        ],
      },
    }
    const c = compileRules([rule])
    expect(
      evaluateRules(c, nativeTool('run_command'), { command: ['rm', '-rf', '/tmp/x'] })
    ).toHaveLength(1)
    expect(
      evaluateRules(c, nativeTool('run_command'), { command: ['rm', '-v', 'f'] })
    ).toHaveLength(0)
  })

  it('matches mcp server + wildcard name', () => {
    const rule: GuardrailRule = {
      id: 'ask-gh-writes',
      action: 'ask',
      match: { tool: { provenance: 'mcp', server: 'github', name: 'create_*' } },
    }
    const c = compileRules([rule])
    expect(evaluateRules(c, mcpTool('github', 'create_issue'), {})).toHaveLength(1)
    expect(evaluateRules(c, mcpTool('github', 'get_issue'), {})).toHaveLength(0)
    expect(evaluateRules(c, mcpTool('gitlab', 'create_issue'), {})).toHaveLength(0)
  })
})
