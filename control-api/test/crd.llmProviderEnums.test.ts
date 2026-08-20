import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

// These are CRD-enum (K8s admission) invariants, not control-api code paths:
// a provider missing from a CRD enum is rejected by the apiserver on write. We
// assert them here so the enum edits can't silently drift from the shared
// provider list. `bailian` is unique to the LLM provider enums, so collecting
// every enum array that contains it yields exactly the provider enums.
const crdsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../charts/clerum-crds/crds')

const NEW_SINGLE_KEY = [
  'openrouter',
  'gemini',
  'deepseek',
  'groq',
  'together',
  'fireworks',
  'mistral',
  'xai',
  'cerebras',
  'deepinfra',
  'perplexity',
  'moonshot',
  'nebius',
  'novita',
  'minimax',
] as const

function collectProviderEnums(crdFile: string): string[][] {
  const doc = parse(readFileSync(resolve(crdsDir, crdFile), 'utf8'))
  const found: string[][] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (
          key === 'enum' &&
          Array.isArray(value) &&
          value.includes('bailian') &&
          value.includes('openai')
        ) {
          found.push(value as string[])
        }
        walk(value)
      }
    }
  }
  walk(doc)
  return found
}

describe('LLM provider CRD enums', () => {
  it('host.yaml carries all 16 new providers (incl. azure) in both provider enums', () => {
    const enums = collectProviderEnums('host.yaml')
    // spec.model.provider + spec.llmPolicy.fallbacks[].provider
    expect(enums).toHaveLength(2)
    for (const e of enums) {
      for (const id of [...NEW_SINGLE_KEY, 'azure', 'codex-subscription']) {
        expect(e).toContain(id)
      }
      // additive: original providers preserved
      expect(e).toContain('bedrock')
      expect(e).toContain('vertex')
    }
  })

  it('workflowrecipe.yaml carries the 15 single-key providers but EXCLUDES azure and bedrock', () => {
    const enums = collectProviderEnums('workflowrecipe.yaml')
    // the two WRC provider enums (model.provider + a second one ~line 543)
    expect(enums).toHaveLength(2)
    for (const e of enums) {
      for (const id of [...NEW_SINGLE_KEY, 'codex-subscription']) {
        expect(e).toContain(id)
      }
      // azure and bedrock must fail at admission (mono-credential WRC transport).
      expect(e).not.toContain('azure')
      expect(e).not.toContain('bedrock')
    }
  })
})
