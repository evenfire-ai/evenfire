import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { MAX_LLM_FALLBACKS } from '@clerum/llm-providers'

// CRD-schema (K8s admission) invariants for the Host LLM policy, parsed from the
// shipped CRD. These pin backstops the apiserver enforces for direct
// kubectl/GitOps writes (bypassing control-api); control-api enforces the same
// rules on its write path. A drift between the two would reopen the bypass.
const crdsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../charts/clerum-crds/crds')

function hostSpecProperties(): Record<string, any> {
  const doc = parse(readFileSync(resolve(crdsDir, 'host.yaml'), 'utf8'))
  return doc.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties
}

function celRules(node: { 'x-kubernetes-validations'?: Array<{ rule: string }> }): string[] {
  return (node['x-kubernetes-validations'] ?? []).map(v => v.rule)
}

describe('Host CRD llmPolicy schema', () => {
  it('caps fallbacks at MAX_LLM_FALLBACKS via maxItems', () => {
    const fallbacks = hostSpecProperties().llmPolicy.properties.fallbacks
    expect(fallbacks.maxItems).toBe(8)
    expect(fallbacks.maxItems).toBe(MAX_LLM_FALLBACKS)
  })
})
