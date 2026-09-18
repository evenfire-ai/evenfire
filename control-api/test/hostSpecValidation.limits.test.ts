import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import {
  HOST_ALLOWED_MODELS_MAX_ITEMS,
  HOST_LLM_POLICY_FALLBACKS_MAX_ITEMS,
  validateHostSpec,
} from '../src/routes/admin/hostSpecValidation.js'

// B-M8 / NV-03: host.yaml caps allowedModels (32) and llmPolicy.fallbacks (8).
// control-api mirrors them as a field-level 422 before any allowlist lookup, but
// only when the array GREW past the cap versus the stored Host, so an existing
// over-limit Host (written before the cap) can still be saved unchanged or shrunk.

const crdsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../charts/clerum-crds/crds')

const subset = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ provider: 'openai', model: `gpt-${i}` }))
const fallbacks = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ provider: 'openai', model: `gpt-${i}` }))
const hostRef = { namespace: 'mcp-host', name: 'agent' }

describe('Host array caps mirror the CRD maxItems', () => {
  it('exports the CRD caps', () => {
    expect(HOST_ALLOWED_MODELS_MAX_ITEMS).toBe(32)
    expect(HOST_LLM_POLICY_FALLBACKS_MAX_ITEMS).toBe(8)
  })

  it('matches host.yaml maxItems for allowedModels and llmPolicy.fallbacks', () => {
    const doc = parse(readFileSync(resolve(crdsDir, 'host.yaml'), 'utf8'))
    const spec = doc.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties
    expect(spec.allowedModels.maxItems).toBe(HOST_ALLOWED_MODELS_MAX_ITEMS)
    expect(spec.llmPolicy.properties.fallbacks.maxItems).toBe(HOST_LLM_POLICY_FALLBACKS_MAX_ITEMS)
  })

  it('accepts allowedModels and fallbacks exactly at the cap on create', async () => {
    const isModelAllowed = vi.fn().mockResolvedValue(true)
    const res = await validateHostSpec(
      {
        allowedModels: subset(HOST_ALLOWED_MODELS_MAX_ITEMS),
        llmPolicy: { fallbacks: fallbacks(HOST_LLM_POLICY_FALLBACKS_MAX_ITEMS) },
      },
      { isModelAllowed }
    )
    expect(res).toBeNull()
  })

  it('rejects allowedModels over the cap on create with a field-level 422 and no lookup', async () => {
    const isModelAllowed = vi.fn().mockResolvedValue(true)
    const res = await validateHostSpec(
      { allowedModels: subset(HOST_ALLOWED_MODELS_MAX_ITEMS + 1) },
      { isModelAllowed }
    )
    expect(res).toEqual({
      errors: [
        {
          field: 'spec.allowedModels',
          message: `spec.allowedModels must contain at most ${HOST_ALLOWED_MODELS_MAX_ITEMS} items`,
        },
      ],
    })
    expect(isModelAllowed).not.toHaveBeenCalled()
  })

  it('rejects llmPolicy.fallbacks over the cap on create with a field-level 422 and no lookup', async () => {
    const isModelAllowed = vi.fn().mockResolvedValue(true)
    const res = await validateHostSpec(
      { llmPolicy: { fallbacks: fallbacks(HOST_LLM_POLICY_FALLBACKS_MAX_ITEMS + 1) } },
      { isModelAllowed }
    )
    expect(res).toEqual({
      errors: [
        {
          field: 'spec.llmPolicy.fallbacks',
          message: `spec.llmPolicy.fallbacks must contain at most ${HOST_LLM_POLICY_FALLBACKS_MAX_ITEMS} items`,
        },
      ],
    })
    expect(isModelAllowed).not.toHaveBeenCalled()
  })

  it('rejects an update that grows past the cap from an under-cap stored Host', async () => {
    const isModelAllowed = vi.fn().mockResolvedValue(true)
    const res = await validateHostSpec(
      { allowedModels: subset(HOST_ALLOWED_MODELS_MAX_ITEMS + 1) },
      { isModelAllowed },
      { stored: { allowedModels: subset(3) }, hostRef, tolerations: [] }
    )
    expect(res?.errors[0].field).toBe('spec.allowedModels')
  })

  it('rejects an update that grows an already over-cap stored array', async () => {
    const isModelAllowed = vi.fn().mockResolvedValue(true)
    const res = await validateHostSpec(
      { llmPolicy: { fallbacks: fallbacks(HOST_LLM_POLICY_FALLBACKS_MAX_ITEMS + 2) } },
      { isModelAllowed },
      {
        stored: { llmPolicy: { fallbacks: fallbacks(HOST_LLM_POLICY_FALLBACKS_MAX_ITEMS + 1) } },
        hostRef,
        tolerations: [],
      }
    )
    expect(res?.errors[0].field).toBe('spec.llmPolicy.fallbacks')
  })

  it('tolerates an unchanged-size or shrinking over-cap stored Host', async () => {
    const isModelAllowed = vi.fn().mockResolvedValue(true)
    const stored = {
      allowedModels: subset(HOST_ALLOWED_MODELS_MAX_ITEMS + 2),
      llmPolicy: { fallbacks: fallbacks(HOST_LLM_POLICY_FALLBACKS_MAX_ITEMS + 2) },
    }
    const unchanged = await validateHostSpec(
      structuredClone(stored),
      { isModelAllowed },
      { stored, hostRef, tolerations: [] }
    )
    expect(unchanged).toBeNull()
    const shrunk = await validateHostSpec(
      {
        allowedModels: subset(HOST_ALLOWED_MODELS_MAX_ITEMS + 1),
        llmPolicy: { fallbacks: fallbacks(HOST_LLM_POLICY_FALLBACKS_MAX_ITEMS + 1) },
      },
      { isModelAllowed },
      { stored, hostRef, tolerations: [] }
    )
    expect(shrunk).toBeNull()
  })
})
