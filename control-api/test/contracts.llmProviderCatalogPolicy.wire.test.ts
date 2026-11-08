// Regenerate after an intended contract change: `UPDATE_WIRE_GOLDENS=1 npx vitest run test/contracts.llmProviderCatalogPolicy.wire.test.ts`, then review the JSON diff.
import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT } from '@clerum/llm-providers'
import {
  CATALOG_POLICY_NOT_FOUND_BODY,
  CATALOG_POLICY_NOT_FOUND_STATUS,
  CATALOG_SYNC_IN_PROGRESS_BODY,
  CATALOG_SYNC_IN_PROGRESS_STATUS,
} from '../src/routes/admin/llmProviderCatalogPolicy.js'
import {
  type CatalogPolicyProviderId,
  type CatalogSettingsRow,
  toPolicy,
} from '../src/services/llmProviderCatalogSettings.js'
import { PROVIDER_KEY_MAP } from '../src/services/modelsDevClient.js'

/**
 * The catalog-policy wire contract, consumed by control-ui's tests instead of a
 * hand-written mirror of the producer. Every entry is what the real `toPolicy`
 * returns for a stored settings row, so a producer change turns this red until
 * the committed JSON moves with it.
 *
 * The inputs are settings rows as Postgres returns them (`auto_enable` boolean or
 * NULL, `updated_at` a Date); the real-Postgres suites pin that row shape.
 */

const UPDATE = process.env.UPDATE_WIRE_GOLDENS === '1'
const DIR = new URL('./fixtures/wire/', import.meta.url)
const FILE = new URL('llmProviderCatalogPolicy.wire.json', DIR)

const UPDATED_AT = new Date('2026-10-30T12:00:00.000Z')
const UPDATED_BY = '00000000-0000-4000-8000-000000000001'

function row(provider: CatalogPolicyProviderId, autoEnable: boolean | null): CatalogSettingsRow {
  return { provider, auto_enable: autoEnable, updated_at: UPDATED_AT, updated_by: UPDATED_BY }
}

function buildContract() {
  const providers = Object.keys(PROVIDER_KEY_MAP) as CatalogPolicyProviderId[]
  const cases: Record<string, unknown> = {}
  for (const provider of providers) cases[`${provider}.default`] = toPolicy(provider, undefined)
  // openai is ON by default, groq OFF: each override and reset is taken against
  // both, so a consumer can pick the direction it renders.
  cases['openai.override_off'] = toPolicy('openai', row('openai', false))
  cases['openai.override_same'] = toPolicy('openai', row('openai', true))
  cases['openai.reset'] = toPolicy('openai', row('openai', null))
  cases['groq.override_on'] = toPolicy('groq', row('groq', true))
  cases['groq.override_same'] = toPolicy('groq', row('groq', false))
  cases['groq.reset'] = toPolicy('groq', row('groq', null))
  return {
    cases,
    errors: {
      catalog_sync_in_progress: {
        status: CATALOG_SYNC_IN_PROGRESS_STATUS,
        body: CATALOG_SYNC_IN_PROGRESS_BODY,
      },
      not_found: {
        status: CATALOG_POLICY_NOT_FOUND_STATUS,
        body: CATALOG_POLICY_NOT_FOUND_BODY,
      },
    },
  }
}

describe('catalog-policy wire contract', () => {
  it('the cases cover a default-ON and a default-OFF provider', () => {
    expect(PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT.openai).toBe(true)
    expect(PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT.groq).toBe(false)
  })

  it('matches the committed fixture', () => {
    // A JSON round trip, so the comparison is against what a consumer parses.
    const actual = JSON.parse(JSON.stringify(buildContract())) as unknown
    if (UPDATE) {
      mkdirSync(DIR, { recursive: true })
      writeFileSync(FILE, `${JSON.stringify(actual, null, 2)}\n`)
    }
    const committed = JSON.parse(readFileSync(FILE, 'utf8')) as unknown
    expect(actual).toEqual(committed)
  })
})
