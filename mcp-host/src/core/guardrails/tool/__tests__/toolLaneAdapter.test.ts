/**
 * Tool-lane adapter integration (spec §6): config → rules → decision.
 */
import { describe, expect, it } from 'vitest'
import type { GuardrailsConfig } from '../../config'
import type { ToolIdentity } from '../provenance'
import { type ToolLaneGuardrail, buildToolLaneGuardrail } from '../toolLaneAdapter'

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

  it('a PreToolUse installed hook can deny (no rules needed)', async () => {
    const fetchImpl = async (url: string) => ({
      status: 200,
      text: async () =>
        url.endsWith('/v1/pre_tool_use') ? '{"decision":"deny","reasonCode":"hook_blocked"}' : '{}',
    })
    const g = buildToolLaneGuardrail(
      {
        hookDescriptors: [
          {
            id: 'th',
            endpoint: 'http://svc',
            path: '/',
            lifecyclePoints: ['pre_tool_use'],
            capabilities: ['may_deny'],
            failMode: 'closed',
            order: 100,
          },
        ],
      },
      { getAuthToken: () => '', fetchImpl }
    )!
    const d = await g.decide(fileWrite, { path: '/etc/passwd' })
    expect(d.decision).toBe('deny')
    expect(d.reasonCode).toBe('hook_blocked')
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

  it('transformResult is absent when no post_tool_use hooks are configured', () => {
    const g = buildToolLaneGuardrail(config)!
    expect(g.transformResult).toBeUndefined()
  })

  it('a PostToolUse hook redacts the result content (is_error preserved)', async () => {
    const fetchImpl = async (url: string) => ({
      status: 200,
      text: async () =>
        url.endsWith('/v1/post_tool_use') ? '{"updatedResult":{"content":"[redacted]"}}' : '{}',
    })
    const g = buildToolLaneGuardrail(
      {
        hookDescriptors: [
          {
            id: 'th',
            endpoint: 'http://svc',
            path: '/',
            lifecyclePoints: ['post_tool_use'],
            capabilities: ['may_rewrite'],
            failMode: 'closed',
            order: 100,
          },
        ],
      },
      { getAuthToken: () => '', fetchImpl }
    )!
    const v = await g.transformResult!(fileWrite, {}, { content: 'secret', isError: true })
    expect(v).toEqual({ content: '[redacted]', isError: true })
  })
})

describe('derivedFileReadDecision', () => {
  const rules: GuardrailsConfig = {
    rules: [
      { id: 'allow-native', action: 'allow', match: { tool: { provenance: 'native', name: '*' } } },
      {
        id: 'ask-secrets',
        action: 'ask',
        reasonCode: 'secrets_read',
        match: {
          tool: { provenance: 'native', name: 'file_read' },
          arguments: [{ type: 'path', pointer: '/path', op: 'under', value: 'secrets' }],
        },
      },
    ],
  }

  it('returns the strictest file_read decision and its reason for the declared reads', () => {
    const g = buildToolLaneGuardrail(rules)!
    expect(g.derivedFileReadDecision?.({ paths: ['pub/a.json', 'secrets/a.json'] })).toEqual({
      decision: 'ask',
      reasonCode: 'secrets_read',
    })
    expect(g.derivedFileReadDecision?.({ paths: ['pub/a.json'] })).toEqual({
      decision: 'allow',
      reasonCode: 'rule:allow-native',
    })
  })

  it('is undefined on a Host with hooks but no rules, and never calls a hook', () => {
    let hookCalls = 0
    const fetchImpl = async () => {
      hookCalls++
      return { status: 200, text: async () => '{"decision":"deny","reasonCode":"hook_blocked"}' }
    }
    const g = buildToolLaneGuardrail(
      {
        hookDescriptors: [
          {
            id: 'th',
            endpoint: 'http://svc',
            path: '/',
            lifecyclePoints: ['pre_tool_use'],
            capabilities: ['may_deny'],
            failMode: 'closed',
            order: 100,
          },
        ],
      },
      { getAuthToken: () => '', fetchImpl }
    )!
    expect(g.derivedFileReadDecision?.({ paths: ['secrets/a.json'] })).toBeUndefined()
    expect(hookCalls).toBe(0)
  })
})

describe('ToolLaneGuardrail contract', () => {
  it('a guardrail without derivedFileReadDecision does not type-check', () => {
    // A guardrail that omitted the member would skip the derived file_read policy
    // without notice, so the member is required (checked by tsc --noEmit).
    // @ts-expect-error derivedFileReadDecision is required
    const partial: ToolLaneGuardrail = {
      async decide(_identity, input) {
        return { decision: 'allow', reasonCode: 'r', effectiveInput: input, source: 'current' }
      },
    }
    expect(partial.derivedFileReadDecision).toBeUndefined()
  })
})
