/**
 * Producer fixtures — the entries and error bodies control-api's catalog-policy
 * routes return (`GET /admin/llm-providers/catalog-policy` and the PUT).
 *
 * control-api is not importable from this package, so these come from the wire
 * file control-api generates with its real `toPolicy`:
 * control-api/test/contracts.llmProviderCatalogPolicy.wire.test.ts →
 * control-api/test/fixtures/wire/llmProviderCatalogPolicy.wire.json. A producer
 * change turns that generator red before it can drift here. Never build an entry
 * by hand: a state the file lacks is added to the generator.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { LlmProviderCatalogPolicy } from '../../lib/api.types'

type CatalogPolicyErrorCapture = {
  status: number
  body: { error: string; message: string }
}

type CatalogPolicyWire = {
  cases: Record<string, LlmProviderCatalogPolicy>
  errors: Record<string, CatalogPolicyErrorCapture>
}

const WIRE = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '../../../control-api/test/fixtures/wire/llmProviderCatalogPolicy.wire.json'
    ),
    'utf8'
  )
) as CatalogPolicyWire

/**
 * One generated entry, e.g. `openai.default`, `openai.override_off`, `groq.reset`.
 * Returns a copy so a test that mutates it cannot leak into another.
 */
export function catalogPolicyCase(key: string): LlmProviderCatalogPolicy {
  const entry = WIRE.cases[key]
  if (!entry) throw new Error(`catalog-policy wire fixture has no case "${key}"`)
  return structuredClone(entry)
}

/** One generated error response: `catalog_sync_in_progress` (503) or `not_found` (404). */
export function catalogPolicyError(name: string): CatalogPolicyErrorCapture {
  const capture = WIRE.errors[name]
  if (!capture) throw new Error(`catalog-policy wire fixture has no error "${name}"`)
  return structuredClone(capture)
}
