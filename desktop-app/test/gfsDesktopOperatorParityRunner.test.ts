import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  GFS_OPERATOR_REQUIRED_SCENARIOS,
  type GfsOperatorLinkGeneration,
  type GfsOperatorScenarioResult,
  assertGenerationChain,
  evaluateGfsOperatorScenarioResults,
  gfsOperatorEvidenceDirectory,
  requireGfsOperatorRunId,
  reserveGfsOperatorEvidenceRun,
  scenarioIdFromTitle,
  writeJsonAtomically,
} from './e2e-playwright/gfsDesktopOperatorParityContract'

const evidenceRoots: string[] = []
const DESKTOP_USER_ID = '5a50453e-04d1-4403-8473-23013eaa56c7'
const CONTROL_ADMIN_ID = 'ef72208d-783a-4574-9181-440a6764fa27'
const LINEAGE_ID = 'd4d2c593-6932-488e-844c-c5852b910783'
const FIRST_GENERATION_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_GENERATION_ID = '22222222-2222-4222-8222-222222222222'

function activeGeneration(
  overrides: Partial<GfsOperatorLinkGeneration> = {}
): GfsOperatorLinkGeneration {
  return {
    id: FIRST_GENERATION_ID,
    lineageId: LINEAGE_ID,
    generation: 1,
    predecessorId: null,
    state: 'active',
    desktopUserId: DESKTOP_USER_ID,
    controlAdminId: CONTROL_ADMIN_ID,
    source: 'initial_setup',
    createdByControlAdminId: CONTROL_ADMIN_ID,
    rowVersion: 1,
    revokedAt: null,
    revokedByType: null,
    revokedById: null,
    revokedByControlAdminId: null,
    revokedByDesktopUserId: null,
    revocationReason: null,
    ...overrides,
  }
}

function controlAdminTombstone(
  overrides: Partial<GfsOperatorLinkGeneration> = {}
): GfsOperatorLinkGeneration {
  return activeGeneration({
    state: 'revoked',
    rowVersion: 2,
    revokedAt: '2026-08-11T09:00:00.000Z',
    revokedByType: 'control_admin',
    revokedById: CONTROL_ADMIN_ID,
    revokedByControlAdminId: CONTROL_ADMIN_ID,
    revocationReason: 'control_ui_revoke',
    ...overrides,
  })
}

afterEach(() => {
  for (const root of evidenceRoots.splice(0)) fs.rmSync(root, { recursive: true })
  delete process.env.E2E_GFS_OPERATOR_EVIDENCE_DIR
})

function passedResults(): GfsOperatorScenarioResult[] {
  return GFS_OPERATOR_REQUIRED_SCENARIOS.map(id => ({ id, status: 'passed', title: id }))
}

describe('GFS Desktop operator Playwright gate', () => {
  it('requires an explicit safe run id so evidence from two executions cannot overwrite', () => {
    expect(() => requireGfsOperatorRunId(undefined)).toThrow(/E2E_GFS_OPERATOR_RUN_ID is required/)
    expect(() => requireGfsOperatorRunId('../escape')).toThrow(/must match/)
    expect(() => requireGfsOperatorRunId('run one')).toThrow(/must match/)
    expect(requireGfsOperatorRunId('run_1-fresh')).toBe('run_1-fresh')
  })

  it('reserves an immutable evidence run and rejects a colliding run id before execution', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gfs-operator-e2e-'))
    evidenceRoots.push(root)
    process.env.E2E_GFS_OPERATOR_EVIDENCE_DIR = root

    const directory = reserveGfsOperatorEvidenceRun('collision-proof')
    expect(directory).toBe(gfsOperatorEvidenceDirectory('collision-proof'))
    expect(fs.existsSync(path.join(directory, 'attempt-manifest.json'))).toBe(true)
    expect(() => reserveGfsOperatorEvidenceRun('collision-proof')).toThrow(/already reserved/)
    expect(
      JSON.parse(fs.readFileSync(path.join(directory, 'attempt-manifest.json'), 'utf8'))
    ).toMatchObject({
      runId: 'collision-proof',
      immutable: true,
    })
  })

  it('creates the evidence directory before an atomic reporter write', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gfs-operator-write-'))
    evidenceRoots.push(root)
    const output = path.join(root, 'nested', 'summary.json')

    writeJsonAtomically(output, { ok: true })

    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toEqual({ ok: true })
  })

  it('recognizes only one exact required scenario prefix', () => {
    expect(scenarioIdFromTitle('@gfs-operator/setup-linked-operator visible login')).toBe(
      '@gfs-operator/setup-linked-operator'
    )
    expect(scenarioIdFromTitle('setup-linked-operator')).toBeNull()
  })

  it('passes only when all six required scenarios pass once with runtime evidence', () => {
    expect(evaluateGfsOperatorScenarioResults(passedResults(), true)).toMatchObject({
      ok: true,
      required: 6,
      observed: 6,
      passed: 6,
      failed: 0,
      skipped: 0,
      errors: [],
    })
  })

  it('fails loudly when zero required scenarios execute', () => {
    const verdict = evaluateGfsOperatorScenarioResults([], true)
    expect(verdict.ok).toBe(false)
    expect(verdict.errors).toContain('zero required scenarios executed')
    for (const id of GFS_OPERATOR_REQUIRED_SCENARIOS) {
      expect(verdict.errors).toContain(`required scenario missing: ${id}`)
    }
  })

  it('fails loudly on a skipped required scenario', () => {
    const results = passedResults()
    results[2] = { ...results[2]!, status: 'skipped' }
    const verdict = evaluateGfsOperatorScenarioResults(results, true)
    expect(verdict.ok).toBe(false)
    expect(verdict.skipped).toBe(1)
    expect(verdict.errors).toContain(
      'required scenario @gfs-operator/grant-share-lifecycle ended with status=skipped'
    )
  })

  it('fails loudly on missing, duplicate, failed, or interrupted scenarios', () => {
    const results = passedResults()
    results.splice(1, 1)
    results.push({ ...results[0]! })
    results[1] = { ...results[1]!, status: 'failed' }
    results[2] = { ...results[2]!, status: 'interrupted' }
    const verdict = evaluateGfsOperatorScenarioResults(results, true)
    expect(verdict.ok).toBe(false)
    expect(verdict.errors).toEqual(
      expect.arrayContaining([
        'required scenario missing: @gfs-operator/operator-root-crud',
        'required scenario executed 2 times: @gfs-operator/setup-linked-operator',
      ])
    )
  })

  it('fails when exact runtime/HEAD/artifact evidence is absent', () => {
    const verdict = evaluateGfsOperatorScenarioResults(passedResults(), false)
    expect(verdict.ok).toBe(false)
    expect(verdict.errors).toContain('runtime evidence is missing')
  })

  it('keeps active authority separate from retained revoked generations across a full lifecycle', () => {
    const firstTombstone = controlAdminTombstone()
    assertGenerationChain([firstTombstone], {
      desktopUserId: DESKTOP_USER_ID,
      controlAdminId: CONTROL_ADMIN_ID,
      source: 'initial_setup',
      activeCount: 0,
      revokedCount: 1,
    })

    const successor = activeGeneration({
      id: SECOND_GENERATION_ID,
      generation: 2,
      predecessorId: FIRST_GENERATION_ID,
    })
    assertGenerationChain([firstTombstone, successor], {
      desktopUserId: DESKTOP_USER_ID,
      controlAdminId: CONTROL_ADMIN_ID,
      source: 'initial_setup',
      activeCount: 1,
      revokedCount: 1,
    })

    const secondTombstone = controlAdminTombstone({
      id: SECOND_GENERATION_ID,
      generation: 2,
      predecessorId: FIRST_GENERATION_ID,
      rowVersion: 2,
    })
    assertGenerationChain([firstTombstone, secondTombstone], {
      desktopUserId: DESKTOP_USER_ID,
      controlAdminId: CONTROL_ADMIN_ID,
      source: 'initial_setup',
      activeCount: 0,
      revokedCount: 2,
    })
  })

  it('rejects malformed predecessor, source, active-state, and revocation-actor evidence', () => {
    const expected = {
      desktopUserId: DESKTOP_USER_ID,
      controlAdminId: CONTROL_ADMIN_ID,
      source: 'initial_setup',
      activeCount: 0,
      revokedCount: 2,
    }
    const firstTombstone = controlAdminTombstone()
    const secondTombstone = controlAdminTombstone({
      id: SECOND_GENERATION_ID,
      generation: 2,
      predecessorId: FIRST_GENERATION_ID,
    })

    expect(() =>
      assertGenerationChain([firstTombstone, { ...secondTombstone, predecessorId: null }], expected)
    ).toThrow('must point to generation 1')
    expect(() =>
      assertGenerationChain(
        [firstTombstone, { ...secondTombstone, source: 'migrated_source' }],
        expected
      )
    ).toThrow('changed source')
    expect(() =>
      assertGenerationChain(
        [
          firstTombstone,
          {
            ...secondTombstone,
            state: 'active',
            revokedAt: '2026-08-11T09:05:00.000Z',
          },
        ],
        { ...expected, activeCount: 1, revokedCount: 1 }
      )
    ).toThrow('active generation 2 contains revocation evidence')
    expect(() =>
      assertGenerationChain(
        [
          firstTombstone,
          {
            ...secondTombstone,
            revokedById: DESKTOP_USER_ID,
          },
        ],
        expected
      )
    ).toThrow('control-admin revocation actor is malformed')
  })
})
