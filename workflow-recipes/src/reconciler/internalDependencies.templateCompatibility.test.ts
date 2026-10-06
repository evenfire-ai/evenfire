import { describe, expect, it } from 'vitest'
import { extractUnresolvedWorkloadTemplateReferences } from './internalDependencies'

describe('workload template delimiter compatibility', () => {
  it('preserves the legacy workload subset including nested-opening recovery', () => {
    const cases = [
      '{{db:host}}',
      '{{ db : port }}',
      '{{db:host}}{{api:port}}',
      '\\{{db:host}}',
      '{{invalid:{{db:host}}',
      '{{{{db:host}}',
      '{{:host}}',
      '{{ :host}}',
      '{{db:host}',
      '{{}}',
      '{{db:host }}',
      '{{x:y:host}}',
      '{{inputs.name}}',
      '{{db:host}}literal{{api:port}}',
    ]
    let seed = 427
    const tokens = ['{{', '}}', '}', ':', 'db', 'host', 'port', ' ', '\\', 'x']
    for (let i = 0; i < 5000; i++) {
      let value = ''
      for (let j = 0; j < 12; j++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        value += tokens[seed % tokens.length]
      }
      cases.push(value)
    }
    // Small bounded reference inputs only: never run the old regex on the attack fixture.
    for (const value of cases) {
      const expected = [...value.matchAll(/\{\{\s*([^}:]+)\s*:\s*(host|port)\s*\}\}/g)]
        .map(match => ({ workloadId: match[1].trim(), field: match[2] }))
        .filter(ref => Boolean(ref.workloadId))
      expect(extractUnresolvedWorkloadTemplateReferences(value), value).toEqual(expected)
    }
  })
})
