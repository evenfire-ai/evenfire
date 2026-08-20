import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CODEX_EXECUTE_SCOPE,
  type CodexCatalogSnapshot,
  type CodexHostSpec,
  projectCodexExecution,
} from './codexExecutionProjection'

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../tests/e2e/fixtures/codex-subscription/codex-target-eligibility.json'
)

type EligibilityCase = {
  id: string
  expected: 'eligible' | 'ineligible' | 'uncertain'
  spec: CodexHostSpec
  snapshot: CodexCatalogSnapshot
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { cases: EligibilityCase[] }

describe('projectCodexExecution', () => {
  it('matches the shared HCC/WRC eligibility corpus', () => {
    expect(fixture.cases.length).toBeGreaterThan(0)
    for (const testCase of fixture.cases) {
      const projection = projectCodexExecution(testCase.spec, testCase.snapshot)
      expect(projection.eligibility, testCase.id).toBe(testCase.expected)
      if (testCase.expected === 'eligible') {
        expect(projection.derivedScopes, testCase.id).toEqual([CODEX_EXECUTE_SCOPE])
        expect(projection.requiresCodexProxyEgress, testCase.id).toBe(true)
        expect(projection.eligibleTargets.length, testCase.id).toBeGreaterThan(0)
      } else {
        expect(projection.derivedScopes, testCase.id).toEqual([])
        expect(projection.requiresCodexProxyEgress, testCase.id).toBe(false)
        expect(projection.eligibleTargets, testCase.id).toEqual([])
      }
    }
  })

  it('treats a malformed empty broker model as ineligible', () => {
    const projection = projectCodexExecution(
      { model: { provider: 'codex-subscription', name: '   ' } },
      {
        flagEnabled: true,
        connectionStatus: 'connected',
        enabledModels: ['codex-subscription:gpt-5.3-codex'],
        staleModels: [],
      }
    )
    expect(projection.eligibility).toBe('ineligible')
    expect(projection.derivedScopes).toEqual([])
    expect(projection.requiresCodexProxyEgress).toBe(false)
    expect(projection.reason).toBe('no_eligible_broker_target')
  })

  it('fails closed when the ConfigMap snapshot is missing', () => {
    const projection = projectCodexExecution(
      { model: { provider: 'codex-subscription', name: 'gpt-5.3-codex' } },
      { flagEnabled: true, snapshotError: 'missing' }
    )
    expect(projection.eligibility).toBe('uncertain')
    expect(projection.derivedScopes).toEqual([])
    expect(projection.requiresCodexProxyEgress).toBe(false)
    expect(projection.reason).toBe('snapshot_missing')
  })

  it('fails closed on incoherent catalog revisions', () => {
    const projection = projectCodexExecution(
      { model: { provider: 'codex-subscription', name: 'gpt-5.3-codex' } },
      { flagEnabled: true, snapshotError: 'malformed' }
    )
    expect(projection.eligibility).toBe('uncertain')
    expect(projection.derivedScopes).toEqual([])
    expect(projection.requiresCodexProxyEgress).toBe(false)
  })

  it('anti-false-positive: uncertain never defaults to eligible', () => {
    // A reversible mutation that defaulted eligibility to `eligible` must make
    // this assertion RED. The committed code stays fail-closed.
    const forbidden = fixture.cases.find(testCase => testCase.id === 'snapshot-forbidden')
    expect(forbidden).toBeDefined()
    const projection = projectCodexExecution(forbidden!.spec, forbidden!.snapshot)
    expect(projection.eligibility).toBe('uncertain')
    expect(projection.derivedScopes).not.toContain(CODEX_EXECUTE_SCOPE)
    expect(projection.requiresCodexProxyEgress).toBe(false)
  })
})
