import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

function runtimeAccessProfile(): Map<string, string> {
  const source = readFileSync(
    new URL('../../deploy/scripts/control-api-runtime-access-profiles.tsv', import.meta.url),
    'utf8'
  )
  return new Map(
    source
      .split('\n')
      .filter(line => line && !line.startsWith('#'))
      .map(line => line.split('\t') as [string, string])
  )
}

describe('0109-0112 Grok subscription persistence', () => {
  const dbSource = readFileSync(new URL('../src/db.ts', import.meta.url), 'utf8')
  const schemaSource = readFileSync(
    new URL('../src/services/grokSubscriptionSchema.ts', import.meta.url),
    'utf8'
  )

  it('registers Grok migrations after the last published attempt-store version', () => {
    expect(dbSource).toContain("version: '0108_llm_provider_attempts_sdk_link_on_delete_set_null'")
    expect(dbSource).toContain("version: '0109_grok_subscription_connections'")
    expect(dbSource).toContain("version: '0110_grok_subscription_oauth_states'")
    expect(dbSource).toContain("version: '0111_grok_catalog_models'")
    expect(dbSource).toContain("version: '0112_llm_provider_attempts_grok_broker'")
    expect(
      dbSource.indexOf("version: '0108_llm_provider_attempts_sdk_link_on_delete_set_null'")
    ).toBeLessThan(dbSource.indexOf("version: '0109_grok_subscription_connections'"))
    expect(dbSource.indexOf("version: '0109_grok_subscription_connections'")).toBeLessThan(
      dbSource.indexOf("version: '0110_grok_subscription_oauth_states'")
    )
    expect(dbSource.indexOf("version: '0111_grok_catalog_models'")).toBeLessThan(
      dbSource.indexOf("version: '0112_llm_provider_attempts_grok_broker'")
    )
  })

  it('creates Grok grant tables without Codex reserved keys or ChatGPT columns', () => {
    expect(schemaSource).toContain('CREATE TABLE IF NOT EXISTS grok_subscription_connections')
    expect(schemaSource).toContain('CREATE TABLE IF NOT EXISTS grok_subscription_oauth_states')
    expect(schemaSource).toContain('CREATE TABLE IF NOT EXISTS grok_catalog_models')
    expect(schemaSource).toContain("CHECK (flow IN ('device'))")
    expect(schemaSource).toContain(
      "connection_key <> 'unassigned' AND connection_key <> 'deployment-default'"
    )
    expect(schemaSource).not.toContain('chatgpt_account_id')
    expect(schemaSource).toContain("attname = 'provider'")
    expect(schemaSource).toContain(
      "CHECK (provider IN ('codex-subscription', 'grok-subscription'))"
    )
    expect(schemaSource).toContain(
      "CHECK (provider <> 'grok-subscription' OR connection_id IS NOT NULL)"
    )
    expect(schemaSource).toContain("attname = 'connection_id'")
    expect(schemaSource).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE grok_subscription_connections'
    )
  })

  it('registers Grok tables in the runtime access TSV as upsert', () => {
    const profiles = runtimeAccessProfile()
    expect(profiles.get('grok_subscription_connections')).toBe('upsert')
    expect(profiles.get('grok_subscription_oauth_states')).toBe('upsert')
    expect(profiles.get('grok_catalog_models')).toBe('upsert')
  })
})
