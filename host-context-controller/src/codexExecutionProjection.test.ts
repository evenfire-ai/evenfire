import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CODEX_EXECUTE_SCOPE,
  CODEX_UNASSIGNED_CONNECTION_KEY,
  type CodexCatalogSnapshot,
  type CodexHostSpec,
  assignedHostCodexConnectionRef,
  projectCodexExecution,
} from './codexExecutionProjection'

const fixturePath = join(
  __dirname,
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

  it('keeps the runtime drift hash stable across catalog content refreshes', () => {
    const spec = { model: { provider: 'codex-subscription', name: 'gpt-5.3-codex' } }
    const first = projectCodexExecution(spec, {
      flagEnabled: true,
      connectionStatus: 'connected',
      catalogContentHash: 'aaa',
      catalogRevision: 1,
      connectionRevision: 4,
      enabledModels: ['codex-subscription:gpt-5.3-codex'],
      staleModels: [],
    })
    const second = projectCodexExecution(spec, {
      flagEnabled: true,
      connectionStatus: 'connected',
      catalogContentHash: 'bbb',
      catalogRevision: 9,
      connectionRevision: 4,
      enabledModels: ['codex-subscription:gpt-5.3-codex'],
      staleModels: [],
    })
    expect(first.driftHashInput).toBe(second.driftHashInput)
    expect(first.catalogContentHash).not.toBe(second.catalogContentHash)
  })

  it('keeps the runtime drift hash stable when only connectionRevision changes', () => {
    const spec = { model: { provider: 'codex-subscription', name: 'gpt-5.3-codex' } }
    const first = projectCodexExecution(spec, {
      flagEnabled: true,
      connectionStatus: 'connected',
      catalogContentHash: 'aaa',
      catalogRevision: 1,
      connectionRevision: 4,
      enabledModels: ['codex-subscription:gpt-5.3-codex'],
      staleModels: [],
    })
    const second = projectCodexExecution(spec, {
      flagEnabled: true,
      connectionStatus: 'connected',
      catalogContentHash: 'aaa',
      catalogRevision: 1,
      connectionRevision: 12,
      enabledModels: ['codex-subscription:gpt-5.3-codex'],
      staleModels: [],
    })
    expect(first.driftHashInput).toBe(second.driftHashInput)
  })

  it('treats a missing Host connectionRef as unassigned, not the reserved grant', () => {
    expect(assignedHostCodexConnectionRef(undefined)).toBe(CODEX_UNASSIGNED_CONNECTION_KEY)
    expect(assignedHostCodexConnectionRef('')).toBe(CODEX_UNASSIGNED_CONNECTION_KEY)
    expect(assignedHostCodexConnectionRef('deployment-default')).toBe('deployment-default')
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
