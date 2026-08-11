import fs from 'node:fs'
import path from 'node:path'

export const GFS_OPERATOR_REQUIRED_SCENARIOS = [
  '@gfs-operator/setup-linked-operator',
  '@gfs-operator/operator-root-crud',
  '@gfs-operator/grant-share-lifecycle',
  '@gfs-operator/ordinary-unlinked-regression',
  '@gfs-operator/live-control-ui-unlink',
  '@gfs-operator/audit-correlation',
] as const

export type GfsOperatorScenarioId = (typeof GFS_OPERATOR_REQUIRED_SCENARIOS)[number]
export type GfsOperatorScenarioStatus =
  | 'passed'
  | 'failed'
  | 'timedOut'
  | 'skipped'
  | 'interrupted'
  | 'unknown'

export interface GfsOperatorScenarioResult {
  id: GfsOperatorScenarioId
  status: GfsOperatorScenarioStatus
  title: string
}

export interface GfsOperatorContractVerdict {
  ok: boolean
  errors: string[]
  required: number
  observed: number
  passed: number
  failed: number
  skipped: number
}

const RUN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const GFS_OPERATOR_SETUP_PATH = '/api/v1/admin/auth/setup'

export function requireGfsOperatorRunId(value = process.env.E2E_GFS_OPERATOR_RUN_ID): string {
  const runId = value?.trim() ?? ''
  if (!RUN_ID_RE.test(runId)) {
    throw new Error(
      '[GFS-OPERATOR-E2E] E2E_GFS_OPERATOR_RUN_ID is required and must match ' +
        `${RUN_ID_RE}. Use a distinct run id for each fresh-profile execution.`
    )
  }
  return runId
}

export function gfsOperatorEvidenceDirectory(runId = requireGfsOperatorRunId()): string {
  const configured = process.env.E2E_GFS_OPERATOR_EVIDENCE_DIR?.trim()
  const base = configured
    ? path.resolve(configured)
    : path.resolve(__dirname, 'test-results', 'gfs-desktop-operator-parity')
  return path.join(base, runId)
}

export function gfsOperatorRuntimeEvidencePath(runId = requireGfsOperatorRunId()): string {
  return path.join(gfsOperatorEvidenceDirectory(runId), 'runtime-evidence.json')
}

export function gfsOperatorResultSummaryPath(runId = requireGfsOperatorRunId()): string {
  return path.join(gfsOperatorEvidenceDirectory(runId), 'required-scenarios.json')
}

/**
 * Creates the evidence directory exactly once. A run id is an immutable
 * reservation, not a filename prefix: reusing it must fail before a browser,
 * runtime-evidence record, or Playwright report can replace prior evidence.
 */
export function reserveGfsOperatorEvidenceRun(runId = requireGfsOperatorRunId()): string {
  const evidenceDirectory = gfsOperatorEvidenceDirectory(runId)
  fs.mkdirSync(path.dirname(evidenceDirectory), { recursive: true })
  try {
    fs.mkdirSync(evidenceDirectory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `[GFS-OPERATOR-E2E] evidence run id ${runId} is already reserved at ${evidenceDirectory}; choose a new E2E_GFS_OPERATOR_RUN_ID.`
      )
    }
    throw error
  }
  writeJsonAtomically(path.join(evidenceDirectory, 'attempt-manifest.json'), {
    schemaVersion: 1,
    suite: 'gfs-desktop-operator-parity',
    runId,
    reservedAt: new Date().toISOString(),
    immutable: true,
  })
  return evidenceDirectory
}

export function scenarioIdFromTitle(title: string): GfsOperatorScenarioId | null {
  const matches = GFS_OPERATOR_REQUIRED_SCENARIOS.filter(
    id => title === id || title.startsWith(`${id} `)
  )
  return matches.length === 1 ? (matches[0] ?? null) : null
}

export function evaluateGfsOperatorScenarioResults(
  results: readonly GfsOperatorScenarioResult[],
  runtimeEvidencePresent: boolean
): GfsOperatorContractVerdict {
  const errors: string[] = []
  const byId = new Map<GfsOperatorScenarioId, GfsOperatorScenarioResult[]>()
  for (const result of results) {
    const current = byId.get(result.id) ?? []
    current.push(result)
    byId.set(result.id, current)
  }

  if (results.length === 0) {
    errors.push('zero required scenarios executed')
  }
  if (!runtimeEvidencePresent) {
    errors.push('runtime evidence is missing')
  }

  for (const id of GFS_OPERATOR_REQUIRED_SCENARIOS) {
    const matches = byId.get(id) ?? []
    if (matches.length === 0) {
      errors.push(`required scenario missing: ${id}`)
      continue
    }
    if (matches.length > 1) {
      errors.push(`required scenario executed ${matches.length} times: ${id}`)
      continue
    }
    const status = matches[0]?.status ?? 'unknown'
    if (status !== 'passed') {
      errors.push(`required scenario ${id} ended with status=${status}`)
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    required: GFS_OPERATOR_REQUIRED_SCENARIOS.length,
    observed: results.length,
    passed: results.filter(result => result.status === 'passed').length,
    failed: results.filter(result =>
      ['failed', 'timedOut', 'interrupted', 'unknown'].includes(result.status)
    ).length,
    skipped: results.filter(result => result.status === 'skipped').length,
  }
}

export function writeJsonAtomically(filePath: string, value: unknown): void {
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    })
    // `link` provides an exclusive finalization step. Unlike rename(2), it
    // never replaces a pre-existing destination if a second attempt races us.
    fs.linkSync(temporaryPath, filePath)
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath)
  }
}
