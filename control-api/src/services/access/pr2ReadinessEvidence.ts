import { type DbClient, withTransaction } from '../../db.js'
import {
  PR2_READINESS_CONTRACT_VERSION,
  PR2_READINESS_HOPS,
  type Pr2ReadinessHop,
} from './pr2ReadinessContract.js'

export { PR2_READINESS_CONTRACT_VERSION, PR2_READINESS_HOPS, type Pr2ReadinessHop }
export type Pr2ReadinessEvidenceClass = 'build' | 'runtime'
export type Pr2ReadinessOutcome = 'passed' | 'failed' | 'withdrawn'
export type Pr2ReadinessWriter =
  | 'operator-build-importer'
  | 'control-api'
  | 'external-rest-api'
  | 'rpc-proxy'
  | 'mcp-host'
  | 'workflow-recipes'
  | 'gfs-controller'
  | 'workspace-files-controller'

export const PR2_BUILD_EVIDENCE_KINDS = [
  'exact_head_ci',
  'producer_contract',
  'static_analysis',
  'real_postgres',
  'deployment_render',
] as const
export type Pr2BuildEvidenceKind = (typeof PR2_BUILD_EVIDENCE_KINDS)[number]
export const PR2_RUNTIME_EVIDENCE_KIND = 'service_runtime' as const

const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/
const ENVIRONMENT_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,126}$/
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*(?::[A-Za-z0-9][A-Za-z0-9._+-]*){1,7}$/

const RUNTIME_OWNER_BY_HOP: Readonly<Record<Pr2ReadinessHop, Pr2ReadinessWriter>> = Object.freeze({
  action_contracts: 'control-api',
  control_action_delegation: 'control-api',
  external_rest_delegation_transport: 'external-rest-api',
  rpc_proxy_trusted_edge: 'rpc-proxy',
  mcp_host_live_effects: 'mcp-host',
  activity_session_search_provenance: 'mcp-host',
  rpc_admission_map: 'control-api',
  sandbox_derived_view: 'rpc-proxy',
  remote_desktop_derived_view: 'rpc-proxy',
  oauth_exact_target: 'rpc-proxy',
  workflow_service_edge: 'external-rest-api',
  workflow_authority_bindings: 'control-api',
  workflow_recipes_checkpoint: 'workflow-recipes',
  workflow_approval_child_transition: 'control-api',
  workflow_artifact_list: 'control-api',
  gfs_controller_checkpoint: 'gfs-controller',
  workspace_files_controller_checkpoint: 'workspace-files-controller',
})

const REAL_POSTGRES_HOPS = new Set<Pr2ReadinessHop>([
  'workflow_authority_bindings',
  'workflow_recipes_checkpoint',
  'gfs_controller_checkpoint',
  'workspace_files_controller_checkpoint',
])

const DEPLOYED_HOPS = new Set<Pr2ReadinessHop>(
  PR2_READINESS_HOPS.filter(hop => hop !== 'action_contracts')
)

export const PR2_RUNTIME_HOPS_BY_WRITER: Readonly<
  Record<Exclude<Pr2ReadinessWriter, 'operator-build-importer'>, readonly Pr2ReadinessHop[]>
> = Object.freeze(
  Object.fromEntries(
    [
      'control-api',
      'external-rest-api',
      'rpc-proxy',
      'mcp-host',
      'workflow-recipes',
      'gfs-controller',
      'workspace-files-controller',
    ].map(writer => [
      writer,
      Object.freeze(PR2_READINESS_HOPS.filter(hop => RUNTIME_OWNER_BY_HOP[hop] === writer)),
    ])
  ) as Record<Exclude<Pr2ReadinessWriter, 'operator-build-importer'>, readonly Pr2ReadinessHop[]>
)

export function requiredBuildEvidenceKinds(hop: Pr2ReadinessHop): readonly Pr2BuildEvidenceKind[] {
  return Object.freeze([
    'exact_head_ci',
    'producer_contract',
    'static_analysis',
    ...(REAL_POSTGRES_HOPS.has(hop) ? (['real_postgres'] as const) : []),
    ...(DEPLOYED_HOPS.has(hop) ? (['deployment_render'] as const) : []),
  ])
}

export type Pr2ReadinessEvidenceInput = Readonly<{
  environmentId: string
  sourceRevision: string
  hop: Pr2ReadinessHop
  evidenceClass: Pr2ReadinessEvidenceClass
  evidenceKind: Pr2BuildEvidenceKind | typeof PR2_RUNTIME_EVIDENCE_KIND
  writer: Pr2ReadinessWriter
  evidenceReference: string
  outcome: Pr2ReadinessOutcome
  serviceVersion: string
  contractVersion: typeof PR2_READINESS_CONTRACT_VERSION
  deploymentRevision: string | null
  imageRevision: string | null
  observedAt: Date
}>

export type Pr2ReadinessActivation = Readonly<{
  environmentId: string
  sourceRevision: string
  acceptedBy: string
  acceptedAt: Date
  maxRuntimeEvidenceAgeSeconds: number
}>

export type Pr2ReadinessTransactionRunner = <T>(work: (db: DbClient) => Promise<T>) => Promise<T>

function isExactObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const keys = [...expected].sort()
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}

function requiredString(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`pr2_readiness_${field}_invalid`)
  }
  return value
}

function optionalVersion(value: unknown, field: string): string | null {
  if (value === null) return null
  return requiredString(value, VERSION_PATTERN, field)
}

function databaseDate(value: Date | string | undefined): Date {
  return value instanceof Date ? new Date(value.getTime()) : new Date(String(value))
}

export function parsePr2ReadinessActivationRecord(value: string): Pr2ReadinessActivation {
  if (!value || value.length > 8_192) throw new Error('pr2_readiness_activation_invalid')
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('pr2_readiness_activation_invalid')
  }
  if (
    !isExactObject(parsed) ||
    !exactKeys(parsed, [
      'version',
      'environmentId',
      'sourceRevision',
      'acceptedBy',
      'acceptedAt',
      'maxRuntimeEvidenceAgeSeconds',
    ]) ||
    parsed.version !== 1 ||
    !Number.isSafeInteger(parsed.maxRuntimeEvidenceAgeSeconds) ||
    Number(parsed.maxRuntimeEvidenceAgeSeconds) < 1 ||
    Number(parsed.maxRuntimeEvidenceAgeSeconds) > 86_400
  ) {
    throw new Error('pr2_readiness_activation_invalid')
  }
  const acceptedAt = new Date(String(parsed.acceptedAt))
  if (!Number.isFinite(acceptedAt.getTime())) throw new Error('pr2_readiness_activation_invalid')
  return Object.freeze({
    environmentId: requiredString(parsed.environmentId, ENVIRONMENT_PATTERN, 'environment'),
    sourceRevision: requiredString(parsed.sourceRevision, SOURCE_REVISION_PATTERN, 'source'),
    acceptedBy: requiredString(parsed.acceptedBy, REFERENCE_PATTERN, 'accepted_by'),
    acceptedAt,
    maxRuntimeEvidenceAgeSeconds: Number(parsed.maxRuntimeEvidenceAgeSeconds),
  })
}

export function parsePr2ReadinessEvidence(
  value: unknown,
  expectedClass?: Pr2ReadinessEvidenceClass,
  expectedWriter?: Pr2ReadinessWriter
): Pr2ReadinessEvidenceInput {
  if (
    !isExactObject(value) ||
    !exactKeys(value, [
      'version',
      'environmentId',
      'sourceRevision',
      'hop',
      'evidenceClass',
      'evidenceKind',
      'writer',
      'evidenceReference',
      'outcome',
      'serviceVersion',
      'contractVersion',
      'deploymentRevision',
      'imageRevision',
      'observedAt',
    ]) ||
    value.version !== 1 ||
    !PR2_READINESS_HOPS.includes(value.hop as Pr2ReadinessHop) ||
    (value.evidenceClass !== 'build' && value.evidenceClass !== 'runtime') ||
    !['passed', 'failed', 'withdrawn'].includes(String(value.outcome)) ||
    value.contractVersion !== PR2_READINESS_CONTRACT_VERSION
  ) {
    throw new Error('pr2_readiness_evidence_invalid')
  }
  const evidenceClass = value.evidenceClass as Pr2ReadinessEvidenceClass
  const writer = String(value.writer) as Pr2ReadinessWriter
  const hop = value.hop as Pr2ReadinessHop
  const evidenceKind = value.evidenceKind as Pr2ReadinessEvidenceInput['evidenceKind']
  const evidenceReference = requiredString(value.evidenceReference, REFERENCE_PATTERN, 'reference')
  if (
    (expectedClass && evidenceClass !== expectedClass) ||
    (expectedWriter && writer !== expectedWriter) ||
    (evidenceClass === 'build' &&
      (writer !== 'operator-build-importer' ||
        !PR2_BUILD_EVIDENCE_KINDS.includes(value.evidenceKind as Pr2BuildEvidenceKind))) ||
    (evidenceClass === 'runtime' &&
      (value.evidenceKind !== PR2_RUNTIME_EVIDENCE_KIND || RUNTIME_OWNER_BY_HOP[hop] !== writer))
  ) {
    throw new Error('pr2_readiness_writer_forbidden')
  }
  const expectedReferencePrefix =
    evidenceClass === 'build' ? `${evidenceKind}:` : `runtime:${writer}:`
  if (!evidenceReference.startsWith(expectedReferencePrefix)) {
    throw new Error('pr2_readiness_reference_kind_mismatch')
  }
  const observedAt = new Date(String(value.observedAt))
  if (!Number.isFinite(observedAt.getTime())) throw new Error('pr2_readiness_evidence_invalid')
  return Object.freeze({
    environmentId: requiredString(value.environmentId, ENVIRONMENT_PATTERN, 'environment'),
    sourceRevision: requiredString(value.sourceRevision, SOURCE_REVISION_PATTERN, 'source'),
    hop,
    evidenceClass,
    evidenceKind,
    writer,
    evidenceReference,
    outcome: value.outcome as Pr2ReadinessOutcome,
    serviceVersion: requiredString(value.serviceVersion, VERSION_PATTERN, 'service_version'),
    contractVersion: PR2_READINESS_CONTRACT_VERSION,
    deploymentRevision: optionalVersion(value.deploymentRevision, 'deployment_revision'),
    imageRevision: optionalVersion(value.imageRevision, 'image_revision'),
    observedAt,
  })
}

export function parsePr2BuildEvidenceRecord(value: string): readonly Pr2ReadinessEvidenceInput[] {
  if (!value || value.length > 256 * 1_024) throw new Error('pr2_build_evidence_invalid')
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('pr2_build_evidence_invalid')
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 128) {
    throw new Error('pr2_build_evidence_invalid')
  }
  return Object.freeze(
    parsed.map(item => parsePr2ReadinessEvidence(item, 'build', 'operator-build-importer'))
  )
}

export async function activatePr2ReadinessSource(
  db: DbClient,
  activation: Pr2ReadinessActivation
): Promise<void> {
  await db.query(
    `INSERT INTO pr2_readiness_activations (
       environment_id, source_revision, accepted_by, accepted_at,
       max_runtime_evidence_age_seconds, updated_at
     ) VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (environment_id) DO UPDATE SET
       source_revision = EXCLUDED.source_revision,
       accepted_by = EXCLUDED.accepted_by,
       accepted_at = EXCLUDED.accepted_at,
       max_runtime_evidence_age_seconds = EXCLUDED.max_runtime_evidence_age_seconds,
       updated_at = NOW()`,
    [
      activation.environmentId,
      activation.sourceRevision,
      activation.acceptedBy,
      activation.acceptedAt,
      activation.maxRuntimeEvidenceAgeSeconds,
    ]
  )
}

async function writePr2ReadinessEvidenceInTransaction(
  db: DbClient,
  evidence: Pr2ReadinessEvidenceInput
): Promise<'inserted' | 'updated' | 'idempotent' | 'superseded'> {
  const activation = await db.query(
    `SELECT source_revision, clock_timestamp() AS received_at
       FROM pr2_readiness_activations WHERE environment_id = $1 FOR SHARE`,
    [evidence.environmentId]
  )
  const activationRow = activation.rows[0] as
    | { source_revision?: string; received_at?: Date | string }
    | undefined
  const activeSource = activationRow?.source_revision
  if (!activeSource || activeSource !== evidence.sourceRevision) {
    throw new Error('pr2_readiness_source_inactive')
  }
  // Always lock the activation row before the per-evidence advisory key.
  // The operator importer updates that row before writing its evidence batch;
  // keeping one lock order prevents a runtime writer and an activation import
  // from deadlocking each other.
  await db.query(
    `SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2 || ':' || $3 || ':' || $4))`,
    [evidence.environmentId, evidence.hop, evidence.evidenceClass, evidence.evidenceKind]
  )
  const effectiveObservedAt =
    evidence.evidenceClass === 'runtime'
      ? databaseDate(activationRow?.received_at)
      : evidence.observedAt
  if (!Number.isFinite(effectiveObservedAt.getTime())) {
    throw new Error('pr2_readiness_observed_at_invalid')
  }
  const existing = await db.query(
    `SELECT evidence_reference, outcome, service_version, contract_version,
            deployment_revision, image_revision, observed_at, invalidated_at
       FROM pr2_readiness_evidence
      WHERE environment_id = $1 AND source_revision = $2 AND hop = $3
        AND evidence_class = $4 AND evidence_kind = $5 AND writer_principal = $6
      FOR UPDATE`,
    [
      evidence.environmentId,
      evidence.sourceRevision,
      evidence.hop,
      evidence.evidenceClass,
      evidence.evidenceKind,
      evidence.writer,
    ]
  )
  const row = existing.rows[0] as Record<string, unknown> | undefined
  if (row) {
    const currentTime = databaseDate(row.observed_at as Date | string).getTime()
    if (evidence.evidenceClass === 'runtime' && effectiveObservedAt.getTime() <= currentTime) {
      effectiveObservedAt.setTime(currentTime + 1)
    }
    const incomingTime = effectiveObservedAt.getTime()
    const same =
      row.evidence_reference === evidence.evidenceReference &&
      row.outcome === evidence.outcome &&
      row.service_version === evidence.serviceVersion &&
      row.contract_version === evidence.contractVersion &&
      row.deployment_revision === evidence.deploymentRevision &&
      row.image_revision === evidence.imageRevision
    if (incomingTime < currentTime) return 'superseded'
    if (incomingTime === currentTime) {
      if (same) return 'idempotent'
      if (row.outcome === 'withdrawn' || evidence.outcome !== 'withdrawn') {
        throw new Error('pr2_readiness_evidence_conflict')
      }
    }
    await db.query(
      `UPDATE pr2_readiness_evidence SET
         evidence_reference = $7, outcome = $8, service_version = $9,
         contract_version = $10, deployment_revision = $11, image_revision = $12,
         observed_at = $13,
         invalidated_at = CASE
           WHEN $8::text = 'passed' THEN NULL::timestamptz ELSE $13::timestamptz
         END,
         updated_at = NOW()
       WHERE environment_id = $1 AND source_revision = $2 AND hop = $3
         AND evidence_class = $4 AND evidence_kind = $5 AND writer_principal = $6`,
      [
        evidence.environmentId,
        evidence.sourceRevision,
        evidence.hop,
        evidence.evidenceClass,
        evidence.evidenceKind,
        evidence.writer,
        evidence.evidenceReference,
        evidence.outcome,
        evidence.serviceVersion,
        evidence.contractVersion,
        evidence.deploymentRevision,
        evidence.imageRevision,
        effectiveObservedAt,
      ]
    )
    return 'updated'
  }
  await db.query(
    `INSERT INTO pr2_readiness_evidence (
       environment_id, source_revision, hop, evidence_class, evidence_kind,
       writer_principal, evidence_reference, outcome, service_version, contract_version,
       deployment_revision, image_revision, observed_at, invalidated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
       CASE WHEN $8::text = 'passed' THEN NULL::timestamptz ELSE $13::timestamptz END)`,
    [
      evidence.environmentId,
      evidence.sourceRevision,
      evidence.hop,
      evidence.evidenceClass,
      evidence.evidenceKind,
      evidence.writer,
      evidence.evidenceReference,
      evidence.outcome,
      evidence.serviceVersion,
      evidence.contractVersion,
      evidence.deploymentRevision,
      evidence.imageRevision,
      effectiveObservedAt,
    ]
  )
  return 'inserted'
}

export async function writePr2ReadinessEvidence(
  evidence: Pr2ReadinessEvidenceInput,
  transactionRunner: Pr2ReadinessTransactionRunner = withTransaction
): Promise<'inserted' | 'updated' | 'idempotent' | 'superseded'> {
  return transactionRunner(db => writePr2ReadinessEvidenceInTransaction(db, evidence))
}

export async function importPr2BuildEvidence(
  activation: Pr2ReadinessActivation,
  evidence: readonly Pr2ReadinessEvidenceInput[],
  transactionRunner: Pr2ReadinessTransactionRunner = withTransaction
): Promise<void> {
  for (const item of evidence) {
    if (
      item.environmentId !== activation.environmentId ||
      item.sourceRevision !== activation.sourceRevision
    ) {
      throw new Error('pr2_build_evidence_activation_mismatch')
    }
  }
  await transactionRunner(async db => {
    await activatePr2ReadinessSource(db, activation)
    for (const item of evidence) {
      await writePr2ReadinessEvidenceInTransaction(db, item)
    }
  })
}

type EvidenceRow = Readonly<{
  hop: string
  evidence_class: string
  evidence_kind: string
  writer_principal: string
  outcome: string
  service_version: string
  contract_version: string
  deployment_revision: string | null
  image_revision: string | null
  observed_at: Date | string
  invalidated_at: Date | string | null
}>

export async function assemblePr2Readiness(
  db: DbClient,
  environmentId: string,
  now: Date | undefined = undefined,
  servingSourceRevision = ''
): Promise<Readonly<Record<Pr2ReadinessHop, 'ready' | 'unavailable'>>> {
  const activationResult = await db.query(
    `SELECT source_revision, updated_at AS activation_epoch,
            max_runtime_evidence_age_seconds, clock_timestamp() AS assembled_at
       FROM pr2_readiness_activations WHERE environment_id = $1`,
    [environmentId]
  )
  const activation = activationResult.rows[0] as
    | {
        source_revision: string
        activation_epoch: Date | string
        assembled_at: Date | string
        max_runtime_evidence_age_seconds: number
      }
    | undefined
  if (
    !activation ||
    !Number.isSafeInteger(Number(activation.max_runtime_evidence_age_seconds)) ||
    activation.source_revision !== servingSourceRevision
  ) {
    return unavailablePr2Readiness()
  }
  const evidenceResult = await db.query(
    `SELECT hop, evidence_class, evidence_kind, writer_principal, outcome, service_version,
            contract_version, deployment_revision, image_revision, observed_at, invalidated_at
       FROM pr2_readiness_evidence
      WHERE environment_id = $1 AND source_revision = $2`,
    [environmentId, activation.source_revision]
  )
  const rows = evidenceResult.rows as EvidenceRow[]
  const result = unavailablePr2Readiness()
  const maxAgeMs = Number(activation.max_runtime_evidence_age_seconds) * 1_000
  const activatedAt = databaseDate(activation.activation_epoch).getTime()
  const assembledAt = (now ?? databaseDate(activation.assembled_at)).getTime()
  if (!Number.isFinite(activatedAt) || !Number.isFinite(assembledAt)) return Object.freeze(result)
  for (const hop of PR2_READINESS_HOPS) {
    const buildRows = rows.filter(row => row.hop === hop && row.evidence_class === 'build')
    const runtimeRows = rows.filter(row => row.hop === hop && row.evidence_class === 'runtime')
    const runtime = runtimeRows.find(
      row =>
        row.evidence_kind === PR2_RUNTIME_EVIDENCE_KIND &&
        row.writer_principal === RUNTIME_OWNER_BY_HOP[hop]
    )
    const buildKinds = requiredBuildEvidenceKinds(hop)
    const build = buildKinds.map(kind => buildRows.find(row => row.evidence_kind === kind))
    const runtimeAge = runtime
      ? assembledAt - databaseDate(runtime.observed_at).getTime()
      : Infinity
    const compatibleBuild = build.every(
      row =>
        row?.outcome === 'passed' &&
        !row.invalidated_at &&
        row.contract_version === PR2_READINESS_CONTRACT_VERSION &&
        row.service_version === runtime?.service_version &&
        (row.evidence_kind !== 'deployment_render' ||
          (row.deployment_revision === runtime?.deployment_revision &&
            row.image_revision === runtime?.image_revision))
    )
    if (
      runtime?.outcome === 'passed' &&
      !runtime.invalidated_at &&
      runtime.contract_version === PR2_READINESS_CONTRACT_VERSION &&
      runtime.image_revision === activation.source_revision &&
      (!DEPLOYED_HOPS.has(hop) || Boolean(runtime.deployment_revision)) &&
      runtimeAge >= 0 &&
      runtimeAge <= maxAgeMs &&
      databaseDate(runtime.observed_at).getTime() >= activatedAt &&
      compatibleBuild
    ) {
      result[hop] = 'ready'
    }
  }
  return Object.freeze(result)
}

function unavailablePr2Readiness(): Record<Pr2ReadinessHop, 'ready' | 'unavailable'> {
  return Object.fromEntries(PR2_READINESS_HOPS.map(hop => [hop, 'unavailable'])) as Record<
    Pr2ReadinessHop,
    'ready' | 'unavailable'
  >
}

export async function bootstrapConfiguredPr2Readiness(
  env: NodeJS.ProcessEnv = process.env,
  transactionRunner: Pr2ReadinessTransactionRunner = withTransaction
): Promise<void> {
  const activationRaw = env.CONTROL_API_PR2_READINESS_ACTIVATION_RECORD?.trim()
  const evidenceRaw = env.CONTROL_API_PR2_BUILD_EVIDENCE_RECORD?.trim()
  if (!activationRaw && !evidenceRaw) return
  if (!activationRaw || !evidenceRaw) throw new Error('pr2_readiness_operator_record_incomplete')
  const activation = parsePr2ReadinessActivationRecord(activationRaw)
  const evidence = parsePr2BuildEvidenceRecord(evidenceRaw)
  await importPr2BuildEvidence(activation, evidence, transactionRunner)
}

export function startControlApiPr2RuntimeEvidence(): () => void {
  const activationRaw = process.env.CONTROL_API_PR2_READINESS_ACTIVATION_RECORD?.trim()
  const sourceRevision = process.env.EVENFIRE_SOURCE_REVISION?.trim() ?? ''
  const serviceVersion = process.env.EVENFIRE_SERVICE_VERSION?.trim() ?? ''
  if (!activationRaw || !/^[0-9a-f]{40}$/.test(sourceRevision) || !serviceVersion) {
    return () => undefined
  }
  let activation: Pr2ReadinessActivation
  try {
    activation = parsePr2ReadinessActivationRecord(activationRaw)
  } catch {
    return () => undefined
  }
  if (activation.sourceRevision !== sourceRevision) return () => undefined
  const deploymentRevision = process.env.EVENFIRE_DEPLOYMENT_REVISION?.trim() ?? ''
  const imageRevision = process.env.EVENFIRE_IMAGE_REVISION?.trim() ?? ''
  if (!deploymentRevision || imageRevision !== sourceRevision) return () => undefined
  const intervalMs = Math.max(1_000, Math.floor(activation.maxRuntimeEvidenceAgeSeconds * 500))
  const report = async () => {
    const observedAt = new Date()
    for (const hop of PR2_RUNTIME_HOPS_BY_WRITER['control-api']) {
      await writePr2ReadinessEvidence({
        environmentId: activation.environmentId,
        sourceRevision,
        hop,
        evidenceClass: 'runtime',
        evidenceKind: PR2_RUNTIME_EVIDENCE_KIND,
        writer: 'control-api',
        evidenceReference: `runtime:control-api:${sourceRevision}`,
        outcome: 'passed',
        serviceVersion,
        contractVersion: PR2_READINESS_CONTRACT_VERSION,
        deploymentRevision,
        imageRevision,
        observedAt,
      })
    }
  }
  void report().catch(() => undefined)
  const timer = setInterval(() => void report().catch(() => undefined), intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
