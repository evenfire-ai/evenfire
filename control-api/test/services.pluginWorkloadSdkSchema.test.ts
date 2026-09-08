import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const full = join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.isFile() && full.endsWith('.ts') ? [full] : []
  })
}

describe('pluginWorkloadSdkSchema', () => {
  it('scopes quota counters by recipe namespace in the primary key', () => {
    const schemaPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../src/services/pluginWorkloadSdkSchema.ts'
    )
    const source = readFileSync(schemaPath, 'utf8')
    expect(source).toMatch(/PRIMARY KEY \(recipe_namespace, recipe_name, period_start\)/)
  })

  it('scopes idempotency uniqueness by recipe namespace', () => {
    const schemaPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../src/services/pluginWorkloadSdkSchema.ts'
    )
    const source = readFileSync(schemaPath, 'utf8')
    expect(source).toMatch(
      /plugin_workload_sdk_invocations \(recipe_namespace, recipe_name, method, idempotency_key_hash\)/
    )
  })

  it('declares the provider column on fresh grants and adds it on upgrade (R1)', () => {
    const schemaPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../src/services/pluginWorkloadSdkSchema.ts'
    )
    const source = readFileSync(schemaPath, 'utf8')
    const grantsCreate = source.slice(
      source.indexOf('CREATE TABLE IF NOT EXISTS plugin_workload_sdk_grants'),
      source.indexOf('CREATE TABLE IF NOT EXISTS plugin_workload_sdk_invocations')
    )
    expect(grantsCreate).toMatch(/\bprovider TEXT\b/)
    expect(source).toMatch(/ADD COLUMN IF NOT EXISTS provider TEXT/)
  })

  it('omits super_admin_approved from fresh grant schema and drops it on upgrade', () => {
    const schemaPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../src/services/pluginWorkloadSdkSchema.ts'
    )
    const source = readFileSync(schemaPath, 'utf8')
    const grantsCreate = source.slice(
      source.indexOf('CREATE TABLE IF NOT EXISTS plugin_workload_sdk_grants'),
      source.indexOf('CREATE TABLE IF NOT EXISTS plugin_workload_sdk_invocations')
    )
    expect(grantsCreate).not.toMatch(/super_admin_approved/)
    expect(source).toMatch(/DROP COLUMN IF EXISTS super_admin_approved/)
  })

  it('persists JIT ticket authorization and one-shot ticket identities on fresh and upgraded schemas', () => {
    const schemaPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../src/services/pluginWorkloadSdkSchema.ts'
    )
    const source = readFileSync(schemaPath, 'utf8')
    expect(source).toMatch(/prompt_authorization JSONB NULL/)
    expect(source).toMatch(/plugin_workload_sdk_credential_ticket_jtis/)
    expect(source).toMatch(/redeemed_at TIMESTAMPTZ NULL/)
    expect(source).toMatch(/addPluginWorkloadSdkJitCredentialTicketColumns/)
  })

  it('persists exact, unknown, and no-execution provider spend outcomes as an immutable attempt ledger', () => {
    const schemaPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../src/services/pluginWorkloadSdkSchema.ts'
    )
    const source = readFileSync(schemaPath, 'utf8')
    expect(source).toMatch(/plugin_workload_sdk_spend_outcomes/)
    expect(source).toMatch(/outcome IN \('exact', 'unknown', 'not_executed'\)/)
    expect(source).toMatch(/plugin_workload_sdk_spend_outcomes_token_pair_check/)
    expect(source).toMatch(/addPluginWorkloadSdkSpendOutcomeLedger/)
  })

  it('writes the spend ledger from exactly one INSERT and never updates or deletes it', () => {
    // The runtime role holds SELECT/INSERT only (access profile `append`), so
    // any UPDATE/DELETE here is a 42501 in production that no superuser test
    // can see. Pinning a single INSERT site also keeps token_pair_check
    // guaranteed by the PersistableSpend type in every writer.
    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '../src')
    const files = sourceFiles(srcRoot)
    expect(files.length).toBeGreaterThan(0)

    const inserts: string[] = []
    const mutations: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const _ of source.matchAll(/INSERT INTO plugin_workload_sdk_spend_outcomes/g)) {
        inserts.push(file)
      }
      if (
        /UPDATE plugin_workload_sdk_spend_outcomes/.test(source) ||
        /DELETE FROM plugin_workload_sdk_spend_outcomes/.test(source)
      ) {
        mutations.push(file)
      }
    }
    expect(mutations).toEqual([])
    expect(inserts).toEqual([join(srcRoot, 'services/pluginWorkloadSdkSpendLedger.ts')])
  })
})
