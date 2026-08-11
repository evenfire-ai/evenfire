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

/**
 * A persisted generation is deliberately more detailed than the status shown
 * in Control UI. The E2E reads this evidence after a visible lifecycle action;
 * it never uses it to manufacture a link or advance the browser journey.
 */
export interface GfsOperatorLinkGeneration {
  id: string
  lineageId: string
  generation: number
  predecessorId: string | null
  state: 'active' | 'revoked'
  desktopUserId: string
  controlAdminId: string
  source: string
  createdByControlAdminId: string
  rowVersion: number
  revokedAt: string | null
  revokedByType: 'control_admin' | 'platform_user' | null
  revokedById: string | null
  revokedByControlAdminId: string | null
  revokedByDesktopUserId: string | null
  revocationReason: string | null
}

export interface GfsOperatorGenerationChainExpectation {
  desktopUserId: string
  controlAdminId: string
  source: string
  activeCount: number
  revokedCount: number
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

/**
 * Verifies the immutable operator-link lineage independently of UI rendering.
 * The caller supplies rows ordered by generation so a non-contiguous or
 * reordered history is a failure rather than being normalized away.
 */
export function assertGenerationChain(
  history: readonly GfsOperatorLinkGeneration[],
  expected: GfsOperatorGenerationChainExpectation
): void {
  const prefix = '[GFS-OPERATOR-E2E] generation history invariant failed:'
  const fail = (message: string): never => {
    throw new Error(`${prefix} ${message}`)
  }
  const requireCount = (name: string, value: number): void => {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail(`${name} must be a non-negative integer`)
    }
  }

  requireCount('activeCount', expected.activeCount)
  requireCount('revokedCount', expected.revokedCount)
  if (history.length !== expected.activeCount + expected.revokedCount) {
    fail(
      `expected ${expected.activeCount} active and ${expected.revokedCount} revoked generations; received ${history.length} rows`
    )
  }
  if (history.length === 0) fail('history must contain at least one generation')

  const first = history[0]!
  const activeRows: GfsOperatorLinkGeneration[] = []
  const revokedRows: GfsOperatorLinkGeneration[] = []

  for (const [index, row] of history.entries()) {
    const expectedGeneration = index + 1
    if (row.generation !== expectedGeneration) {
      fail(
        `expected generation ${expectedGeneration} at index ${index}, received ${row.generation}`
      )
    }
    if (
      row.desktopUserId !== expected.desktopUserId ||
      row.controlAdminId !== expected.controlAdminId
    ) {
      fail(
        `generation ${row.generation} does not preserve the exact Desktop-user/Control-Admin pair`
      )
    }
    if (row.source !== expected.source) {
      fail(`generation ${row.generation} changed source from ${expected.source} to ${row.source}`)
    }
    if (row.lineageId !== first.lineageId) {
      fail(`generation ${row.generation} does not preserve lineage ${first.lineageId}`)
    }
    if (!Number.isSafeInteger(row.rowVersion) || row.rowVersion < 1) {
      fail(`generation ${row.generation} has an invalid row version`)
    }
    if (index === 0) {
      if (row.predecessorId !== null) fail('generation 1 must not have a predecessor')
    } else {
      const predecessor = history[index - 1]
      if (!predecessor || row.predecessorId !== predecessor.id) {
        fail(`generation ${row.generation} must point to generation ${expectedGeneration - 1}`)
      }
    }

    if (row.state === 'active') {
      activeRows.push(row)
      if (
        row.revokedAt !== null ||
        row.revokedByType !== null ||
        row.revokedById !== null ||
        row.revokedByControlAdminId !== null ||
        row.revokedByDesktopUserId !== null ||
        row.revocationReason !== null
      ) {
        fail(`active generation ${row.generation} contains revocation evidence`)
      }
      continue
    }

    if (row.state !== 'revoked') fail(`generation ${row.generation} has invalid state ${row.state}`)
    revokedRows.push(row)
    if (!row.revokedAt || !row.revocationReason) {
      fail(`revoked generation ${row.generation} is missing timestamp or reason`)
    }
    if (row.revokedByType === 'control_admin') {
      if (
        !row.revokedById ||
        row.revokedById !== row.revokedByControlAdminId ||
        row.revokedByDesktopUserId !== null
      ) {
        fail(`control-admin revocation actor is malformed for generation ${row.generation}`)
      }
      continue
    }
    if (row.revokedByType === 'platform_user') {
      if (
        row.revokedById !== null ||
        row.revokedByControlAdminId !== null ||
        !row.revokedByDesktopUserId
      ) {
        fail(`platform-user revocation actor is malformed for generation ${row.generation}`)
      }
      continue
    }
    fail(`revoked generation ${row.generation} has no typed revocation actor`)
  }

  if (activeRows.length !== expected.activeCount) {
    fail(`expected ${expected.activeCount} active generations, received ${activeRows.length}`)
  }
  if (revokedRows.length !== expected.revokedCount) {
    fail(`expected ${expected.revokedCount} revoked generations, received ${revokedRows.length}`)
  }
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
