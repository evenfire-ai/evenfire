import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { firstDataLine, kubectlContext, runControlPostgresSql, sqlLiteral } from './gfsFixtureCore'
import { GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES } from './gfsUploadV2Fixtures'

export { GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES } from './gfsUploadV2Fixtures'

const execFileAsync = promisify(execFile)
const HCC_NAMESPACE = 'control-plane'
const HCC_DEPLOYMENT = 'host-context-controller'
const GFS_NAMESPACE = 'gfs'
const GFS_WRITER_DEPLOYMENT = 'gfsc-writer'
const GFS_READER_DEPLOYMENT = 'gfsc-reader'
const GFS_V2_HCC_ENV = 'CONTEXT_MAPPER_GFSC_UPLOAD_V2_ENABLED'
const GFS_V2_WRITER_ENV = 'GFS_UPLOAD_V2_ENABLED'
const GFS_PRODUCT_MAX_HCC_ENV = 'CONTEXT_MAPPER_GFSC_UPLOAD_PRODUCT_MAX_FILE_BYTES'
const GFS_PRODUCT_MAX_HCC_ALIAS_ENV = 'CONTEXT_MAPPER_GFSC_UPLOAD_MAX_FILE_BYTES'
const GFS_PRODUCT_MAX_WRITER_ENV = 'GFS_UPLOAD_PRODUCT_MAX_FILE_BYTES'
const BRANCH_CONTEXT_RE = /^clerum-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$/

export interface GfsRuntimeImageMarker {
  clusterFingerprint?: string
  imageSource?: string
  imageTag?: string
  imagesGeneratedAt?: string
}

export interface ExpectedGfsRuntimeImageMarker {
  imageSource?: string
  imageTag?: string
  clusterFingerprint?: string
  imagesGeneratedAt?: string
}

export type GfsUploadProductMaxState = { kind: 'absent' } | { kind: 'explicit'; value: number }

/**
 * Local Minikube image mode intentionally has no registry tag. GHCR mode must
 * carry one because it is the immutable image coordinate that proves which
 * artifact was deployed. Both modes still require the marker's source and
 * acquisition timestamp so an empty local tag cannot be confused with a
 * missing marker field.
 */
export function validateGfsRuntimeImageMarker(
  marker: GfsRuntimeImageMarker,
  expected: ExpectedGfsRuntimeImageMarker = {}
): void {
  if (
    !marker.clusterFingerprint ||
    !marker.imageSource ||
    typeof marker.imageTag !== 'string' ||
    !marker.imagesGeneratedAt
  ) {
    throw new Error(
      'refusing GFS E2E mutation: pre-gate marker lacks cluster fingerprint, image coordinates, or acquisition stamp'
    )
  }
  if (marker.imageSource !== 'local' && marker.imageSource !== 'ghcr') {
    throw new Error(`refusing GFS E2E mutation: unsupported imageSource ${marker.imageSource}`)
  }
  if (marker.imageSource === 'ghcr' && marker.imageTag.length === 0) {
    throw new Error(
      'refusing GFS E2E mutation: GHCR image marker is missing its immutable imageTag'
    )
  }
  if (expected.imageSource && marker.imageSource !== expected.imageSource) {
    throw new Error(
      'refusing GFS E2E mutation: imageSource does not match the caller-owned profile'
    )
  }
  if (expected.imageTag !== undefined && marker.imageTag !== expected.imageTag) {
    throw new Error('refusing GFS E2E mutation: imageTag does not match the caller-owned profile')
  }
  if (expected.clusterFingerprint && marker.clusterFingerprint !== expected.clusterFingerprint) {
    throw new Error(
      'refusing GFS E2E mutation: clusterFingerprint does not match the caller-owned profile'
    )
  }
  if (expected.imagesGeneratedAt && marker.imagesGeneratedAt !== expected.imagesGeneratedAt) {
    throw new Error(
      'refusing GFS E2E mutation: imagesGeneratedAt does not match the caller-owned profile'
    )
  }
}

function profilePorts(context: string): Map<string, string> {
  const path =
    process.env.CLERUM_PROFILE_PORTS_ENV ||
    process.env.E2E_PROFILE_PORTS_ENV ||
    resolve(homedir(), '.cache/clerum/minikube-profiles', context, 'ports.env')
  if (!existsSync(path)) {
    throw new Error(`refusing GFS E2E mutation: profile ports.env is missing at ${path}`)
  }
  const values = new Map<string, string>()
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (match) values.set(match[1]!, match[2]!.replace(/^['"]|['"]$/g, ''))
  }
  return values
}

function normalizeUrl(value: string): string {
  return value.replace(/\/$/, '')
}

/**
 * Mutating negative journeys are allowed only on the exact branch profile
 * whose generated port map is present in the caller environment. A context
 * name alone is not ownership proof: another healthy Minikube profile could
 * otherwise receive an HCC mutation or writer restart.
 */
async function assertOwnedRuntimeContext(): Promise<void> {
  const context = kubectlContext()
  if (/prod|production/i.test(context)) {
    throw new Error(`refusing GFS E2E mutation on production-like context ${context}`)
  }
  const explicitlyAllowed = new Set(
    (process.env.E2E_ALLOWED_CONTEXTS || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
  )
  if (!BRANCH_CONTEXT_RE.test(context) && !explicitlyAllowed.has(context)) {
    throw new Error(
      `refusing GFS E2E mutation on unscoped context ${context}; use a generated branch profile or E2E_ALLOWED_CONTEXTS`
    )
  }
  const ports = profilePorts(context)
  const required = [
    ['CONTROL_UI_BASE_URL', 'CONTROL_UI_URL'],
    ['EXTERNAL_REST_API_BASE_URL', 'EXTERNAL_REST_API_URL'],
  ] as const
  for (const [actualKey, profileKey] of required) {
    const actual = process.env[actualKey] || process.env[actualKey.replace('_BASE_URL', '_URL')]
    const expected = ports.get(profileKey)
    if (!expected || !actual || normalizeUrl(actual) !== normalizeUrl(expected)) {
      throw new Error(
        `refusing GFS E2E mutation: ${actualKey} does not match ${profileKey} in profile ports.env`
      )
    }
  }
  const rpcActual = process.env.RPC_PROXY_BASE_URL || process.env.RPC_PROXY_URL
  if (rpcActual) {
    const rpcExpected = ports.get('RPC_PROXY_URL')
    if (!rpcExpected || normalizeUrl(rpcActual) !== normalizeUrl(rpcExpected)) {
      throw new Error(
        'refusing GFS E2E mutation: RPC_PROXY_BASE_URL does not match RPC_PROXY_URL in profile ports.env'
      )
    }
  }

  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim()
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim()
  if (dirty) {
    throw new Error(
      'refusing GFS E2E mutation: the worktree is dirty; commit and run pre-gate-sync before fault injection'
    )
  }
  const expectedWorktreeId = createHash('sha1').update(repoRoot).digest('hex')
  const expectedHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim()
  const marker = JSON.parse(
    await kubectl([
      '-n',
      HCC_NAMESPACE,
      'get',
      'configmap/clerum-pre-gate-sync-state',
      '-o',
      'json',
    ])
  ) as {
    data?: {
      worktreeId?: string
      gitHead?: string
      clusterFingerprint?: string
      imageSource?: string
      imageTag?: string
      imagesGeneratedAt?: string
    }
  }
  if (marker.data?.worktreeId !== expectedWorktreeId) {
    throw new Error(
      'refusing GFS E2E mutation: cluster ownership marker does not match this worktree; run pre-gate-sync first'
    )
  }
  if (marker.data?.gitHead !== expectedHead) {
    throw new Error(
      `refusing GFS E2E mutation: cluster gitHead ${marker.data?.gitHead || '<missing>'} does not match ${expectedHead}`
    )
  }
  const markerData = marker.data
  const expectedImageSource = process.env.E2E_IMAGE_SOURCE || process.env.IMAGE_SOURCE || 'local'
  const expectedImageTag = process.env.E2E_IMAGE_TAG || process.env.IMAGE_TAG
  const expectedClusterFingerprint =
    process.env.E2E_EXPECTED_CLUSTER_FINGERPRINT || process.env.E2E_CLUSTER_FINGERPRINT
  const expectedImagesGeneratedAt = process.env.E2E_EXPECTED_IMAGES_GENERATED_AT
  validateGfsRuntimeImageMarker(markerData ?? {}, {
    imageSource: expectedImageSource,
    ...(expectedImageTag !== undefined ? { imageTag: expectedImageTag } : {}),
    ...(expectedClusterFingerprint ? { clusterFingerprint: expectedClusterFingerprint } : {}),
    ...(expectedImagesGeneratedAt ? { imagesGeneratedAt: expectedImagesGeneratedAt } : {}),
  })
}

async function kubectl(args: string[], timeout = 240_000): Promise<string> {
  const result = await execFileAsync('kubectl', ['--context', kubectlContext(), ...args], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  })
  return result.stdout
}

async function renderedWriterFlag(): Promise<string> {
  return (
    await kubectl([
      '-n',
      GFS_NAMESPACE,
      'get',
      `deployment/${GFS_WRITER_DEPLOYMENT}`,
      '-o',
      `jsonpath={range .spec.template.spec.containers[*]}{range .env[?(@.name=="${GFS_V2_WRITER_ENV}")]}{.value}{end}{end}`,
    ])
  ).trim()
}

interface RenderedWriterEnv {
  name?: unknown
  value?: unknown
}

interface RenderedWriterDeployment {
  spec?: {
    template?: {
      spec?: {
        containers?: Array<{ env?: RenderedWriterEnv[] }>
      }
    }
  }
}

/**
 * Reads the complete deployment object so an absent env can be distinguished
 * from a present-but-malformed value. A malformed deployment or duplicate
 * authoritative env fails closed instead of being treated as the default.
 */
export function parseRenderedGfsUploadProductMax(raw: string): string | undefined {
  let deployment: RenderedWriterDeployment
  try {
    deployment = JSON.parse(raw) as RenderedWriterDeployment
  } catch {
    throw new Error(`invalid rendered ${GFS_PRODUCT_MAX_WRITER_ENV} deployment JSON`)
  }

  const containers = deployment.spec?.template?.spec?.containers
  if (!Array.isArray(containers)) {
    throw new Error(`invalid rendered ${GFS_PRODUCT_MAX_WRITER_ENV} deployment shape`)
  }
  const matches = containers.flatMap(container => {
    if (container === null || typeof container !== 'object') {
      throw new Error(`invalid rendered ${GFS_PRODUCT_MAX_WRITER_ENV} container shape`)
    }
    if (container.env === undefined) return []
    if (!Array.isArray(container.env)) {
      throw new Error(`invalid rendered ${GFS_PRODUCT_MAX_WRITER_ENV} env shape`)
    }
    return container.env.filter(env => env?.name === GFS_PRODUCT_MAX_WRITER_ENV)
  })
  if (matches.length === 0) return undefined
  if (matches.length !== 1 || typeof matches[0]?.value !== 'string') {
    throw new Error(`invalid rendered ${GFS_PRODUCT_MAX_WRITER_ENV} value`)
  }
  return matches[0].value
}

export function parseGfsUploadProductMaxState(raw: string): GfsUploadProductMaxState {
  const value = parseRenderedGfsUploadProductMax(raw)
  if (value === undefined) return { kind: 'absent' }
  return {
    kind: 'explicit',
    value: validateGfsUploadProductMaxBytes(parseCanonicalProductMax(value)),
  }
}

function parseCanonicalProductMax(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(
      `GFS writer rendered an invalid ${GFS_PRODUCT_MAX_WRITER_ENV} value: ${value || '<empty>'}`
    )
  }
  return Number(value)
}

async function renderedWriterProductMax(): Promise<string | undefined> {
  return parseRenderedGfsUploadProductMax(
    await kubectl(['-n', GFS_NAMESPACE, 'get', `deployment/${GFS_WRITER_DEPLOYMENT}`, '-o', 'json'])
  )
}

async function waitForRenderedWriterFlag(expected: boolean): Promise<void> {
  const expectedValue = String(expected)
  const deadline = Date.now() + 240_000
  let lastValue = ''
  while (Date.now() < deadline) {
    lastValue = await renderedWriterFlag()
    if (lastValue === expectedValue) return
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  throw new Error(
    `GFS Upload v2 runtime flag did not converge to ${expectedValue}; observed ${lastValue || '<empty>'}`
  )
}

async function waitForRenderedWriterProductMax(expected: number | undefined): Promise<void> {
  const expectedValue = expected === undefined ? '<absent>' : String(expected)
  const deadline = Date.now() + 240_000
  let lastValue: string | undefined
  while (Date.now() < deadline) {
    lastValue = await renderedWriterProductMax()
    if (lastValue === (expected === undefined ? undefined : expectedValue)) return
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  throw new Error(
    `GFS Upload v2 product maximum did not converge to ${expectedValue}; observed ${lastValue || '<absent>'}`
  )
}

export function validateGfsUploadProductMaxBytes(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES
  ) {
    throw new Error(
      `invalid GFS Upload v2 product maximum; expected an integer from 1 through ${GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES}`
    )
  }
  return value as number
}

async function waitForDeployment(deployment: string): Promise<void> {
  await kubectl([
    '-n',
    GFS_NAMESPACE,
    'rollout',
    'status',
    `deployment/${deployment}`,
    '--timeout=240s',
  ])
}

/**
 * Changes the HCC-owned source flag and waits for the generated writer to
 * converge. The caller must restore the original value in a finally block.
 */
export async function setGfsUploadV2Enabled(enabled: boolean): Promise<void> {
  await assertOwnedRuntimeContext()
  await kubectl([
    '-n',
    HCC_NAMESPACE,
    'set',
    'env',
    `deployment/${HCC_DEPLOYMENT}`,
    `${GFS_V2_HCC_ENV}=${String(enabled)}`,
  ])
  await kubectl([
    '-n',
    HCC_NAMESPACE,
    'rollout',
    'status',
    `deployment/${HCC_DEPLOYMENT}`,
    '--timeout=240s',
  ])
  await waitForRenderedWriterFlag(enabled)
  await waitForDeployment(GFS_WRITER_DEPLOYMENT)
  await waitForDeployment(GFS_READER_DEPLOYMENT)
}

export async function readGfsUploadV2Enabled(): Promise<boolean> {
  const value = await renderedWriterFlag()
  if (value !== 'true' && value !== 'false') {
    throw new Error(
      `GFS writer rendered an invalid ${GFS_V2_WRITER_ENV} value: ${value || '<empty>'}`
    )
  }
  return value === 'true'
}

/**
 * Changes the HCC-owned product policy and waits for the generated writer and
 * reader to converge. The caller must restore the original value in a finally
 * block. This changes policy only; the compiled protocol geometry is untouched.
 */
export function buildGfsUploadProductMaxEnvArgs(
  state: GfsUploadProductMaxState | number
): string[] {
  if (typeof state === 'number') {
    const validated = validateGfsUploadProductMaxBytes(state)
    return [
      `${GFS_PRODUCT_MAX_HCC_ENV}=${String(validated)}`,
      `${GFS_PRODUCT_MAX_HCC_ALIAS_ENV}=${String(validated)}`,
    ]
  }
  if (state.kind === 'absent') {
    return [`${GFS_PRODUCT_MAX_HCC_ENV}-`, `${GFS_PRODUCT_MAX_HCC_ALIAS_ENV}-`]
  }
  if (state.kind === 'explicit') {
    const validated = validateGfsUploadProductMaxBytes(state.value)
    return [
      `${GFS_PRODUCT_MAX_HCC_ENV}=${String(validated)}`,
      `${GFS_PRODUCT_MAX_HCC_ALIAS_ENV}=${String(validated)}`,
    ]
  }
  throw new Error('invalid GFS Upload v2 product maximum restoration state')
}

export async function setGfsUploadProductMaxBytes(
  state: GfsUploadProductMaxState | number
): Promise<void> {
  const envArgs = buildGfsUploadProductMaxEnvArgs(state)
  const expected =
    typeof state === 'number' ? state : state.kind === 'explicit' ? state.value : undefined
  await assertOwnedRuntimeContext()
  await kubectl(['-n', HCC_NAMESPACE, 'set', 'env', `deployment/${HCC_DEPLOYMENT}`, ...envArgs])
  await kubectl([
    '-n',
    HCC_NAMESPACE,
    'rollout',
    'status',
    `deployment/${HCC_DEPLOYMENT}`,
    '--timeout=240s',
  ])
  await waitForRenderedWriterProductMax(expected)
  await waitForDeployment(GFS_WRITER_DEPLOYMENT)
  await waitForDeployment(GFS_READER_DEPLOYMENT)
}

export async function readGfsUploadProductMaxBytes(): Promise<GfsUploadProductMaxState> {
  const value = await renderedWriterProductMax()
  if (value === undefined) return { kind: 'absent' }
  return {
    kind: 'explicit',
    value: validateGfsUploadProductMaxBytes(parseCanonicalProductMax(value)),
  }
}

export async function restartGfsWriter(): Promise<void> {
  await assertOwnedRuntimeContext()
  // Restart the real writer deployment while the upload is visibly active.
  // A rollout gives the relay a bounded termination path; deleting the pod
  // directly can leave an already-streaming PUT socket open until the full
  // five-minute part timeout, turning this journey into a transport-timeout
  // test instead of a restart/recovery test.
  await kubectl(['-n', GFS_NAMESPACE, 'rollout', 'restart', `deployment/${GFS_WRITER_DEPLOYMENT}`])
  await waitForDeployment(GFS_WRITER_DEPLOYMENT)
}

/** Revoke only the exact seeded user grant used by the Desktop E2E. */
export async function revokeGfsUserWriteGrant(resourceId: string, userId: string): Promise<void> {
  await assertOwnedRuntimeContext()
  runControlPostgresSql(`
    DELETE FROM gfs_grants
     WHERE drive = 'main'
       AND resource_id = ${sqlLiteral(resourceId)}::uuid
       AND subject_type = 'user'
       AND subject_id = ${sqlLiteral(userId)};
  `)
}

/**
 * Legacy fallback must not create an indexed Upload v2 session. Scope the
 * assertion to the exact seeded parent/name/owner tuple so unrelated active
 * sessions cannot make the negative journey flaky.
 */
export function countGfsCreateSessions(
  parentResourceId: string,
  resourceName: string,
  ownerSubject: string
): number {
  const value = firstDataLine(
    runControlPostgresSql(`
      SELECT COUNT(*)::int
        FROM gfs_upload_sessions
       WHERE drive = 'main'
         AND owner_subject = ${sqlLiteral(ownerSubject)}
         AND operation = 'create'
         AND parent_rid = ${sqlLiteral(parentResourceId)}
         AND resource_name = ${sqlLiteral(resourceName)};
    `)
  )
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`invalid GFS v2 session count: ${value || '<empty>'}`)
  }
  return count
}
