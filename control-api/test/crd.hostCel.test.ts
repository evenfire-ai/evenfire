import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

// B-M2: `spec.model.provider` is optional in host.yaml, and CEL errors on a
// missing field instead of treating it as false. Every Host CEL rule must guard a
// `self.model.provider` read with `has(self.model.provider)` so a Host whose
// `spec.model` omits provider (accepted before the oauth-broker rules) is not
// rejected by an evaluation error. No CEL runtime is available here, so this is a
// static contract over the rule text.
const crdsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../charts/clerum-crds/crds')

function collectRules(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach(child => collectRules(child, out))
    return out
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'x-kubernetes-validations' && Array.isArray(value)) {
        for (const entry of value) {
          if (entry && typeof (entry as { rule?: unknown }).rule === 'string') {
            out.push((entry as { rule: string }).rule)
          }
        }
      }
      collectRules(value, out)
    }
  }
  return out
}

const GUARDED_READ =
  /has\(self\.model\) && has\(self\.model\.provider\) && self\.model\.provider ==/g

describe('host.yaml CEL rules', () => {
  const rules = collectRules(parse(readFileSync(resolve(crdsDir, 'host.yaml'), 'utf8')))

  it('reads self.model.provider in at least one rule (the guard contract is not vacuous)', () => {
    expect(rules.some(rule => rule.includes('self.model.provider'))).toBe(true)
  })

  it('guards every self.model.provider read with has(self.model) and has(self.model.provider)', () => {
    for (const rule of rules) {
      const reads = rule.match(/(?<!has\()self\.model\.provider\b/g) ?? []
      const guarded = rule.match(GUARDED_READ) ?? []
      expect({ rule, reads: reads.length }).toEqual({ rule, reads: guarded.length })
    }
  })
})
