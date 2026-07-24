export const LEGACY_STANDALONE_SUBJECT_KEY = 'host:1st:mcp-host/standalone'

export interface LegacyGrantMigrationApi {
  getLegacyGrants(): Promise<unknown>
  getTrustedHostDirectory(): Promise<unknown>
  putGrant(body: Record<string, unknown>): Promise<{ ok: boolean; status?: number; error?: string }>
}

export interface LegacyGrantInventoryItem {
  id: string
  drive: string
  resourceId: string
  permissions: string[]
  inherit: boolean
}

export interface TrustedHostCandidate {
  name: string
  namespace: string
  displayName: string
  active: true
  gfsSubject: { type: 'host'; id: string }
}

const K8S_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_INVENTORY_ITEMS = 1000
const MAX_TARGETS_PER_SOURCE = 100
const MIGRATABLE_MANAGED_AGENT_PERMISSIONS = new Set(['read', 'write'])

function isK8sName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 63 && K8S_NAME_RE.test(value)
}

function normalizeCandidate(value: unknown): TrustedHostCandidate | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (item.active !== true || !isK8sName(item.name) || !isK8sName(item.namespace)) return null
  const subject = item.gfsSubject as Record<string, unknown> | undefined
  const expectedId = `1st:${item.namespace}/${item.name}`
  const displayName = typeof item.displayName === 'string' ? item.displayName : item.name
  if (subject?.type !== 'host' || subject.id !== expectedId) return null
  if (`host:${expectedId}` === LEGACY_STANDALONE_SUBJECT_KEY) return null
  if (/^all([ -]clerum)?[ -]agents$/i.test(displayName.trim())) return null
  if (item.hidden === true || item.deleted === true || item.status === 'deleted') return null
  return {
    name: item.name,
    namespace: item.namespace,
    displayName,
    active: true,
    gfsSubject: { type: 'host', id: expectedId },
  }
}

function normalizeGrant(value: unknown): LegacyGrantInventoryItem {
  if (!value || typeof value !== 'object') throw new Error('legacy_grant_report_invalid')
  const item = value as Record<string, unknown>
  if (!UUID_RE.test(String(item.id ?? '')) || !UUID_RE.test(String(item.resourceId ?? ''))) {
    throw new Error('legacy_grant_report_invalid')
  }
  if (typeof item.drive !== 'string' || !Array.isArray(item.permissions)) {
    throw new Error('legacy_grant_report_invalid')
  }
  if (item.permissions.some(permission => typeof permission !== 'string')) {
    throw new Error('legacy_grant_report_invalid')
  }
  if (
    item.permissions.length === 0 ||
    item.permissions.some(permission => !MIGRATABLE_MANAGED_AGENT_PERMISSIONS.has(permission))
  ) {
    // Never silently reduce or reproduce historical authority. An operator
    // must review and replace a legacy grant containing forbidden bits before
    // it can be migrated to individual HCC-managed agents.
    throw new Error('legacy_grant_permissions_forbidden')
  }
  return {
    id: String(item.id),
    drive: item.drive,
    resourceId: String(item.resourceId),
    permissions: [...new Set(item.permissions as string[])].sort(),
    inherit: item.inherit === true,
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function sameReviewedInventory(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

export async function buildLegacyGrantMigrationReport(api: LegacyGrantMigrationApi) {
  const [legacyValue, directoryValue] = await Promise.all([
    api.getLegacyGrants(),
    api.getTrustedHostDirectory(),
  ])
  const legacy = legacyValue as { sourceSubject?: unknown; grants?: unknown }
  const directory = directoryValue as { agents?: unknown }
  if (legacy?.sourceSubject !== LEGACY_STANDALONE_SUBJECT_KEY || !Array.isArray(legacy.grants)) {
    throw new Error('legacy_grant_report_invalid')
  }
  if (!Array.isArray(directory?.agents)) throw new Error('trusted_host_directory_invalid')
  if (legacy.grants.length > MAX_INVENTORY_ITEMS || directory.agents.length > MAX_INVENTORY_ITEMS) {
    throw new Error('migration_inventory_limit_exceeded')
  }

  const sourceGrants = legacy.grants.map(normalizeGrant).sort(
    (a, b) =>
      a.drive.localeCompare(b.drive) ||
      a.resourceId.localeCompare(b.resourceId) ||
      a.id.localeCompare(b.id)
  )
  const validIndividualHostCandidates = directory.agents
    .map(normalizeCandidate)
    .filter((candidate): candidate is TrustedHostCandidate => candidate !== null)
    .sort((a, b) => a.gfsSubject.id.localeCompare(b.gfsSubject.id))
  if (
    new Set(validIndividualHostCandidates.map(candidate => candidate.gfsSubject.id)).size !==
    validIndividualHostCandidates.length
  ) {
    throw new Error('trusted_host_directory_duplicate')
  }
  return {
    mode: 'report' as const,
    sourceSubject: LEGACY_STANDALONE_SUBJECT_KEY,
    sourceGrants,
    validIndividualHostCandidates,
    mappingTemplate: {
      version: 1,
      reviewedSourceGrants: sourceGrants,
      reviewedHostCandidates: validIndividualHostCandidates,
      mappings: sourceGrants.map(grant => ({ sourceGrantId: grant.id, targets: [] as string[] })),
    },
    note: 'Candidate Hosts are inventory only; no assignment is inferred.',
  }
}

export function validateReviewedLegacyGrantMapping(
  report: Awaited<ReturnType<typeof buildLegacyGrantMigrationReport>>,
  mappingValue: unknown
): Map<string, string[]> {
  if (!mappingValue || typeof mappingValue !== 'object') throw new Error('mapping_invalid')
  const mapping = mappingValue as Record<string, unknown>
  if (mapping.version !== 1 || !Array.isArray(mapping.mappings)) throw new Error('mapping_invalid')
  if (!sameReviewedInventory(mapping.reviewedSourceGrants, report.sourceGrants)) {
    throw new Error('source_inventory_changed')
  }
  if (!sameReviewedInventory(mapping.reviewedHostCandidates, report.validIndividualHostCandidates)) {
    throw new Error('trusted_host_directory_changed')
  }
  const grants = new Set(report.sourceGrants.map(grant => grant.id))
  const candidates = new Set(
    report.validIndividualHostCandidates.map(candidate => `host:${candidate.gfsSubject.id}`)
  )
  const reviewed = new Map<string, string[]>()
  for (const value of mapping.mappings) {
    if (!value || typeof value !== 'object') throw new Error('mapping_invalid')
    const entry = value as Record<string, unknown>
    if (typeof entry.sourceGrantId !== 'string' || reviewed.has(entry.sourceGrantId)) {
      throw new Error('mapping_source_duplicate_or_invalid')
    }
    if (!grants.has(entry.sourceGrantId)) throw new Error('mapping_source_unknown')
    if (
      !Array.isArray(entry.targets) ||
      entry.targets.length === 0 ||
      entry.targets.length > MAX_TARGETS_PER_SOURCE
    ) {
      throw new Error('mapping_targets_required_or_excessive')
    }
    const targets = entry.targets.map(String)
    if (new Set(targets).size !== targets.length) throw new Error('mapping_target_duplicate')
    for (const target of targets) {
      if (
        target === LEGACY_STANDALONE_SUBJECT_KEY ||
        !target.startsWith('host:1st:') ||
        !candidates.has(target)
      ) {
        throw new Error('mapping_target_not_current_trusted_host')
      }
    }
    reviewed.set(entry.sourceGrantId, targets.sort())
  }
  if (reviewed.size !== grants.size) throw new Error('mapping_source_missing')
  return reviewed
}

export async function applyReviewedLegacyGrantMigration(
  api: LegacyGrantMigrationApi,
  mapping: unknown
) {
  // This fresh report is intentionally the final inventory read before any
  // mutation. The exact reviewed snapshots must still match current truth.
  const report = await buildLegacyGrantMigrationReport(api)
  const reviewed = validateReviewedLegacyGrantMapping(report, mapping)
  const sources = []
  for (const grant of report.sourceGrants) {
    const targets = []
    for (const target of reviewed.get(grant.id) ?? []) {
      const result = await api.putGrant({
        drive: grant.drive,
        resourceId: grant.resourceId,
        subject: { type: 'host', id: target.slice('host:'.length) },
        permissions: grant.permissions,
        inherit: grant.inherit,
      })
      targets.push({
        target,
        ok: result.ok,
        status: result.status ?? null,
        error: result.error ?? null,
      })
    }
    sources.push({
      sourceGrantId: grant.id,
      legacyGrantPreserved: true,
      readyForRetirement: targets.every(target => target.ok),
      targets,
    })
  }
  return {
    mode: 'apply' as const,
    sourceSubject: LEGACY_STANDALONE_SUBJECT_KEY,
    allApprovedIndividualGrantsSucceeded: sources.every(source => source.readyForRetirement),
    legacyGrantsDeleted: false,
    sources,
  }
}
