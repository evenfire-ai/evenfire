import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type CodexCatalogSnapshot,
  type CodexHostSpec,
  projectCodexExecution as projectSharedCodexExecution,
} from '@clerum/codex-catalog-projection'
import type { LlmProviderId } from '@clerum/llm-providers'
import type { WorkflowRecipeSpec } from '../types'
import {
  CODEX_EXECUTE_SCOPE,
  type CodexCatalogSnapshot as WrcSnapshot,
  projectCodexExecution,
  projectRecipeCodexExecution,
  resolveCodexAuthoritativeSpec,
} from './codexExecutionProjection'

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../tests/e2e/fixtures/codex-subscription/codex-target-eligibility.json'
)

type EligibilityCase = {
  id: string
  expected: 'eligible' | 'ineligible' | 'uncertain'
  spec: CodexHostSpec
  snapshot: CodexCatalogSnapshot
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { cases: EligibilityCase[] }

const eligibleSnapshot: WrcSnapshot = {
  flagEnabled: true,
  connectionStatus: 'connected',
  catalogContentHash: 'aa',
  catalogRevision: 1,
  connectionRevision: 1,
  enabledModels: ['codex-subscription:gpt-5.3-codex'],
  staleModels: [],
}

function recipeSpec(provider: LlmProviderId, model: string): WorkflowRecipeSpec {
  return {
    agent: { provider, model },
    steps: [{ id: 'step-1', instruction: 'run' }],
  }
}

describe('projectCodexExecution (WRC)', () => {
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

  it('keeps HCC/WRC derivedScopes and driftHashInput identical on the shared fixture', () => {
    for (const testCase of fixture.cases) {
      const wrc = projectCodexExecution(testCase.spec, testCase.snapshot)
      const hcc = projectSharedCodexExecution(testCase.spec, testCase.snapshot)
      expect(wrc.derivedScopes, testCase.id).toEqual(hcc.derivedScopes)
      expect(wrc.driftHashInput, testCase.id).toBe(hcc.driftHashInput)
    }
  })

  it('does not roll the drift hash on catalog or credential-revision refresh', () => {
    const eligible = fixture.cases.find(testCase => testCase.id === 'flag-on-connected-ready')
    expect(eligible).toBeDefined()
    const baseline = projectCodexExecution(eligible!.spec, eligible!.snapshot)
    const catalogOnly = projectCodexExecution(eligible!.spec, {
      ...eligible!.snapshot,
      catalogRevision: (eligible!.snapshot.catalogRevision ?? 1) + 99,
      catalogContentHash: 'catalog-only-refresh',
    })
    const credentialChanged = projectCodexExecution(eligible!.spec, {
      ...eligible!.snapshot,
      connectionRevision: (eligible!.snapshot.connectionRevision ?? 1) + 1,
    })
    expect(catalogOnly.derivedScopes).toEqual(baseline.derivedScopes)
    expect(catalogOnly.driftHashInput).toBe(baseline.driftHashInput)
    expect(credentialChanged.driftHashInput).toBe(baseline.driftHashInput)
  })

  it('treats a malformed empty broker model as ineligible', () => {
    const projection = projectCodexExecution(
      { model: { provider: 'codex-subscription', name: '   ' } },
      eligibleSnapshot
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

  it('anti-false-positive: uncertain never defaults to eligible', () => {
    const forbidden = fixture.cases.find(testCase => testCase.id === 'snapshot-forbidden')
    expect(forbidden).toBeDefined()
    const projection = projectCodexExecution(forbidden!.spec, forbidden!.snapshot)
    expect(projection.eligibility).toBe('uncertain')
    expect(projection.derivedScopes).not.toContain(CODEX_EXECUTE_SCOPE)
    expect(projection.requiresCodexProxyEgress).toBe(false)
  })
})

describe('resolveCodexAuthoritativeSpec', () => {
  const parent = recipeSpec('codex-subscription', 'gpt-5.3-codex')
  const child = recipeSpec('openai', 'gpt-5.4-mini')

  it('uses the parent spec when runtime scope provenance is verified', () => {
    const resolved = resolveCodexAuthoritativeSpec({
      recipeName: 'child-run',
      runtimeScopeRecipeName: 'parent-recipe',
      claimedParent: true,
      ownSpec: child,
      parentSpec: parent,
    })
    expect(resolved.provenance).toBe('authoritative')
    expect(resolved.spec).toBe(parent)
    expect(resolved.reason).toBe('inherited_parent')
  })

  it('rejects a claimed parent when runtime scope falls back to the child', () => {
    const resolved = resolveCodexAuthoritativeSpec({
      recipeName: 'child-run',
      runtimeScopeRecipeName: 'child-run',
      claimedParent: true,
      ownSpec: recipeSpec('codex-subscription', 'gpt-5.3-codex'),
      parentSpec: parent,
    })
    expect(resolved.provenance).toBe('uncertain')
    expect(resolved.reason).toBe('parent_provenance_rejected')
    const projection = projectRecipeCodexExecution(
      resolved.spec,
      eligibleSnapshot,
      resolved.provenance
    )
    expect(projection.derivedScopes).toEqual([])
    expect(projection.requiresCodexProxyEgress).toBe(false)
    expect(projection.eligibility).toBe('uncertain')
  })

  it('fails closed when an inherited child cannot load the parent spec', () => {
    const resolved = resolveCodexAuthoritativeSpec({
      recipeName: 'child-run',
      runtimeScopeRecipeName: 'parent-recipe',
      claimedParent: true,
      ownSpec: child,
      parentSpec: null,
    })
    expect(resolved.provenance).toBe('uncertain')
    expect(resolved.reason).toBe('parent_spec_unavailable')
  })

  it('treats a standalone recipe as authoritative over its own spec', () => {
    const own = recipeSpec('codex-subscription', 'gpt-5.3-codex')
    const resolved = resolveCodexAuthoritativeSpec({
      recipeName: 'standalone',
      runtimeScopeRecipeName: 'standalone',
      claimedParent: false,
      ownSpec: own,
      parentSpec: null,
    })
    expect(resolved.provenance).toBe('authoritative')
    expect(resolved.spec).toBe(own)
    expect(resolved.reason).toBe('standalone')
  })
})
