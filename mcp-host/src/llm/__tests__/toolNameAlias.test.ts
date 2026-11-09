import { describe, expect, it } from 'vitest'

import {
  ANTHROPIC_TOOL_NAME_RULE,
  BEDROCK_TOOL_NAME_RULE,
  OPENAI_TOOL_NAME_RULE,
  ToolNameAliaser,
  VERTEX_TOOL_NAME_RULE,
} from '../toolNameAlias'
import type { ToolNameRule } from '../toolNameAlias'

const RULES: Array<[string, ToolNameRule]> = [
  ['openai', OPENAI_TOOL_NAME_RULE],
  ['bedrock', BEDROCK_TOOL_NAME_RULE],
  ['anthropic', ANTHROPIC_TOOL_NAME_RULE],
  ['vertex', VERTEX_TOOL_NAME_RULE],
]

const NOTION_CASES = [
  'mcp-notion-atlassian-v27-9f21ac04__notion-query-multiple-data-sources',
  'mcp-notion-atlassian-v27-9f21ac04__atlassian.search/issues.and.more!',
  'notion__åäö-unicode/工具名',
]

describe('toolNameAlias', () => {
  it('passes names that already fit through byte-for-byte', () => {
    for (const [, rule] of RULES) {
      const aliaser = new ToolNameAliaser(rule)
      expect(aliaser.alias('get_user')).toBe('get_user')
      expect(aliaser.alias('mcp-srv__tool-1')).toBe('mcp-srv__tool-1')
      expect(aliaser.describe('get_user', 'desc')).toBe('desc')
    }
  })

  it('aliases over-long names into the rule shape', () => {
    for (const [label, rule] of RULES) {
      const aliaser = new ToolNameAliaser(rule)
      for (const name of NOTION_CASES) {
        const wire = aliaser.alias(name)
        expect(wire.length, `${label}: length`).toBeLessThanOrEqual(rule.maxLength)
        expect(rule.accepts(wire), `${label}: ${wire} fits its own rule`).toBe(true)
        expect(wire).toContain('-')
        expect(aliaser.resolve(wire)).toBe(name)
      }
    }
  })

  it('is deterministic: the same canonical name aliases identically in a fresh aliaser', () => {
    for (const [, rule] of RULES) {
      const first = new ToolNameAliaser(rule).alias(NOTION_CASES[0])
      const second = new ToolNameAliaser(rule).alias(NOTION_CASES[0])
      expect(first).toBe(second)
    }
  })

  it('stays injective within a request', () => {
    for (const [, rule] of RULES) {
      const aliaser = new ToolNameAliaser(rule)
      const names = [
        ...NOTION_CASES,
        'a'.repeat(70) + '__one',
        'a'.repeat(70) + '__two',
        'srv__plain',
        '9numeric__head',
        '..__dots',
      ]
      const wires = names.map(n => aliaser.alias(n))
      expect(new Set(wires).size).toBe(wires.length)
    }
  })

  it('is idempotent: aliasing a wire name returns it unchanged', () => {
    for (const [, rule] of RULES) {
      const aliaser = new ToolNameAliaser(rule)
      for (const name of NOTION_CASES) {
        expect(aliaser.alias(aliaser.alias(name))).toBe(aliaser.alias(name))
      }
    }
  })

  it('round-trips through resolve, including untouched names', () => {
    for (const [, rule] of RULES) {
      const aliaser = new ToolNameAliaser(rule)
      const names = [...NOTION_CASES, 'srv__plain', 'get_user']
      for (const name of names) {
        expect(aliaser.resolve(aliaser.alias(name))).toBe(name)
      }
      // A name the provider invented (unknown to the aliaser) resolves to itself.
      expect(aliaser.resolve('mystery_tool')).toBe('mystery_tool')
    }
  })

  it('annotates aliased descriptions with the canonical name and keeps valid ones untouched', () => {
    const aliaser = new ToolNameAliaser(OPENAI_TOOL_NAME_RULE)
    const canonical = NOTION_CASES[0]
    const description = aliaser.describe(canonical, 'Queries a data source.')
    expect(description).toContain('Queries a data source.')
    expect(description).toContain(canonical)
    expect(description).toContain(aliaser.alias(canonical))
    expect(aliaser.describe('srv__plain', 'Fine as-is.')).toBe('Fine as-is.')
  })

  it('keeps a digit-leading head acceptable for the vertex rule', () => {
    const aliaser = new ToolNameAliaser(VERTEX_TOOL_NAME_RULE)
    const wire = aliaser.alias('9numeric__head')
    expect(/^[A-Za-z_]/.test(wire)).toBe(true)
    expect(aliaser.resolve(wire)).toBe('9numeric__head')
  })

  it('collapsing every invalid character still yields a usable head', () => {
    const aliaser = new ToolNameAliaser(OPENAI_TOOL_NAME_RULE)
    const wire = aliaser.alias('___%%%___')
    expect(OPENAI_TOOL_NAME_RULE.accepts(wire)).toBe(true)
    expect(aliaser.resolve(wire)).toBe('___%%%___')
  })
})
