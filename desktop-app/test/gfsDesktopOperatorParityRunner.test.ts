import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  GFS_OPERATOR_REQUIRED_SCENARIOS,
  type GfsOperatorScenarioResult,
  evaluateGfsOperatorScenarioResults,
  gfsOperatorEvidenceDirectory,
  requireGfsOperatorRunId,
  reserveGfsOperatorEvidenceRun,
  scenarioIdFromTitle,
} from './e2e-playwright/gfsDesktopOperatorParityContract'

const evidenceRoots: string[] = []

afterEach(() => {
  for (const root of evidenceRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
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
})
