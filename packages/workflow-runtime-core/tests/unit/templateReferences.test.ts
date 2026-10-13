import { describe, expect, it } from 'vitest'
import { replaceTemplateReferences, scanTemplateReferences } from '../../src/templateReferences'

describe('template reference scanner', () => {
  it('preserves the legacy delimiter contract on bounded generated inputs', () => {
    const cases = [
      '{{inputs.name}}',
      '{{computed.name}}{{db:host}}{{db:port}}',
      'literal {{ resource:FIELD }} trailing',
      '\\{{name}}',
      '{{}}',
      '{{ }}',
      '{{',
      '{{body}',
      '{{body}x}}',
      '{{{{body}}',
      '{{a}}}{{b}}',
    ]
    let seed = 427
    const tokens = ['{{', '}}', '{', '}', 'name', ' ', '\\', ':', 'x']
    for (let i = 0; i < 10000; i++) {
      let value = ''
      for (let j = 0; j < 12; j++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        value += tokens[seed % tokens.length]
      }
      cases.push(value)
    }
    for (const value of cases) {
      const expected = [...value.matchAll(/\{\{([^}]+)\}\}/g)].map(match => ({
        start: match.index,
        end: match.index + match[0].length,
        body: match[1],
      }))
      expect([...scanTemplateReferences(value)], value).toEqual(expected)
      expect(
        replaceTemplateReferences(value, body => `[${body}]`),
        value
      ).toBe(value.replace(/\{\{([^}]+)\}\}/g, (_match, body) => `[${body}]`))
    }
  })

  it('does not rescan replacements or interpret replacement dollar sequences', () => {
    expect(replaceTemplateReferences('a{{x}}{{y}}b', () => '{{z}}$&')).toBe('a{{z}}$&{{z}}$&b')
  })

  it('preserves large malformed text and advances through many adjacent references', () => {
    const malformed = '{{{{|'.repeat(200_000)
    expect([...scanTemplateReferences(malformed)]).toEqual([])
    expect(replaceTemplateReferences(malformed, () => 'unexpected')).toBe(malformed)
    expect([...scanTemplateReferences('{{x}}'.repeat(100_000))]).toHaveLength(100_000)
  })
})
