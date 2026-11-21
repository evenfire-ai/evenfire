/**
 * Permission-rule engine tests (spec §6.1): compilation/admission validation and
 * matching (provenance + predicates, all-match AND, wildcard names).
 */
import { describe, expect, it } from 'vitest'
import type { GuardrailRule } from '../../config'
import { aggregateDecision } from '../../decision'
import type { ToolIdentity } from '../provenance'
import { compileRules, evaluateDerivedFileReads, evaluateRules } from '../rules'

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

describe('evaluateDerivedFileReads (file_read rules over another tool’s reads)', () => {
  const allowNative: GuardrailRule = {
    id: 'allow-native',
    action: 'allow',
    match: { tool: { provenance: 'native', name: '*' } },
  }
  const fileReadRule = (
    id: string,
    action: GuardrailRule['action'],
    op: string,
    value: unknown,
    type: 'path' | 'json' = 'path'
  ): GuardrailRule => ({
    id,
    action,
    match: {
      tool: { provenance: 'native', name: 'file_read' },
      arguments: [{ type, pointer: '/path', op, value }],
    },
  })
  const decisionOf = (
    rules: GuardrailRule[],
    reads: Parameters<typeof evaluateDerivedFileReads>[1]
  ) => aggregateDecision(evaluateDerivedFileReads(compileRules(rules), reads))

  it('a Host with no rules contributes nothing', () => {
    expect(evaluateDerivedFileReads(compileRules([]), { paths: ['secrets/a.json'] })).toEqual([])
  })

  it('a declared path gets exactly what file_read {path} gets', () => {
    const rules = [allowNative, fileReadRule('deny-secrets', 'deny', 'under', 'secrets')]
    expect(decisionOf(rules, { paths: ['secrets/a.json'] })).toBe('deny')
    expect(decisionOf(rules, { paths: ['pub/a.json'] })).toBe('allow')
    expect(evaluateDerivedFileReads(compileRules(rules), { paths: ['secrets/a.json'] })).toEqual([
      {
        phase: 'pre',
        source: 'host_rule',
        sourceId: 'allow-native',
        decision: 'allow',
        reasonCode: 'rule:allow-native',
      },
      {
        phase: 'pre',
        source: 'host_rule',
        sourceId: 'deny-secrets',
        decision: 'deny',
        reasonCode: 'rule:deny-secrets',
      },
    ])
  })

  it('a path no file_read rule matches gets the unmatched ask, as file_read would', () => {
    const allowlist: GuardrailRule[] = [
      {
        id: 'allow-json',
        action: 'allow',
        match: { tool: { provenance: 'native', name: 'json_transform' } },
      },
      fileReadRule('allow-pub', 'allow', 'under', 'pub'),
    ]
    expect(
      evaluateDerivedFileReads(compileRules(allowlist), { paths: ['secrets/a.json'] })
    ).toEqual([
      {
        phase: 'pre',
        source: 'current',
        sourceId: 'unmatched',
        decision: 'ask',
        reasonCode: 'unmatched_ask',
      },
    ])
    expect(decisionOf(allowlist, { paths: ['pub/a.json'] })).toBe('allow')
  })

  it('an allow on one path never hides a deny on another', () => {
    const rules = [allowNative, fileReadRule('deny-secrets', 'deny', 'under', 'secrets')]
    expect(decisionOf(rules, { paths: ['pub/a.json', 'secrets/a.json'] })).toBe('deny')
  })

  it('with subtrees, a rule on a path inside a declared directory applies', () => {
    const rules = [allowNative, fileReadRule('deny-pub-secret', 'deny', 'under', 'pub/secret')]
    // Control: file_read {path: 'pub'} alone does not match the nested rule.
    expect(decisionOf(rules, { paths: ['pub'] })).toBe('allow')
    expect(decisionOf(rules, { paths: ['pub'], subtrees: true })).toBe('deny')
    expect(decisionOf(rules, { paths: ['other'], subtrees: true })).toBe('allow')
  })

  it('with subtrees, equals, json equals, json one_of and json contains rules inside the directory apply', () => {
    const cases: GuardrailRule[] = [
      fileReadRule('eq', 'ask', 'equals', 'pub/secret/a.txt'),
      fileReadRule('json-eq', 'ask', 'equals', 'pub/secret/a.txt', 'json'),
      fileReadRule('json-one-of', 'ask', 'one_of', ['x', 'pub/secret/a.txt'], 'json'),
      fileReadRule('json-contains', 'ask', 'contains', 'secret', 'json'),
    ]
    for (const rule of cases) {
      expect(decisionOf([allowNative, rule], { paths: ['pub'] }), rule.id).toBe('allow')
      expect(decisionOf([allowNative, rule], { paths: ['pub'], subtrees: true }), rule.id).toBe(
        'ask'
      )
    }
  })

  it('without subtrees, a substring rule applies only as file_read would', () => {
    const rules = [allowNative, fileReadRule('json-contains', 'deny', 'contains', 'secret', 'json')]
    expect(decisionOf(rules, { paths: ['pub/a.json'] })).toBe('allow')
    expect(decisionOf(rules, { paths: ['pub/secret.json'] })).toBe('deny')
  })

  it('a whole-workspace read takes every ask or deny file_read rule with a /path predicate', () => {
    const outside = [allowNative, fileReadRule('deny-outside-pub', 'deny', 'outside', 'pub')]
    const under = [allowNative, fileReadRule('ask-secrets', 'ask', 'under', 'secrets')]
    expect(decisionOf(outside, { paths: ['.'], wholeWorkspace: true })).toBe('deny')
    expect(decisionOf(under, { paths: ['.'], wholeWorkspace: true })).toBe('ask')
    // Control: the root alone does not match `under secrets`.
    expect(decisionOf(under, { paths: ['.'] })).toBe('allow')
    // An allow rule with a /path predicate does not widen a whole-workspace read.
    const allowOnly = [allowNative, fileReadRule('allow-pub', 'allow', 'under', 'pub')]
    expect(decisionOf(allowOnly, { paths: ['.'], wholeWorkspace: true })).toBe('allow')
  })

  it('rules for other tools never contribute', () => {
    const rules: GuardrailRule[] = [
      allowNative,
      {
        id: 'deny-write-secrets',
        action: 'deny',
        match: {
          tool: { provenance: 'native', name: 'file_write' },
          arguments: [{ type: 'path', pointer: '/path', op: 'under', value: 'secrets' }],
        },
      },
      {
        id: 'deny-mcp-read',
        action: 'deny',
        match: { tool: { provenance: 'mcp', name: 'file_read' } },
      },
    ]
    expect(
      decisionOf(rules, { paths: ['secrets/a.json'], subtrees: true, wholeWorkspace: true })
    ).toBe('allow')
  })
})
