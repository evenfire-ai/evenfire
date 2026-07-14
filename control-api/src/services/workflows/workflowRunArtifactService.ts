import type { K8sGateway } from '../../k8s.js'
import { rootLogger } from '../../observability/logger.js'
import { signWrcDelegationToken } from '../../utils/auth/delegationToken.js'
import { K8sNotFoundError } from '../resourceService.js'
import { getRun } from '../workflowRunService.js'
import type { WorkflowRunRow } from '../workflowRunService.js'
import type { WorkflowRouteCaller, WorkflowRunArtifactDto } from './types.js'
import type { WorkflowApprovalTarget } from './workflowRecipeAccessService.js'
import {
  WORKFLOW_RECIPE_PLURAL,
  asRecord,
  ensureRecipeAuthorized,
  isRecipeNamespaceAllowed,
} from './workflowRecipeAccessService.js'
import { canCallerReadWorkflowRunWithApprovalTarget } from './workflowRunReadService.js'
import { buildWrcWorkflowArtifactsUrl } from './wrcClient.js'

const WRC_ARTIFACT_FETCH_TIMEOUT_MS = 30_000
const SAFE_ARTIFACT_NAME_RE = /^[A-Za-z0-9._-]+$/
const WORKFLOW_RUN_ID_LABEL = 'clerum.io/workflow-run-id'
const logger = rootLogger.child({ module: 'workflow-run-artifacts' })

export class WorkflowArtifactHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'WorkflowArtifactHttpError'
  }
}

export type WorkflowArtifactContext = {
  parentNamespace: string
  parentName: string
  run: WorkflowRunRow
  childRunId?: string
  childNamespace: string
  childName: string
  childRecipe: Record<string, unknown>
}

export type WorkflowArtifactDownloadResult = {
  status: number
  headers: Record<string, string>
  body: Buffer | Record<string, unknown>
}

export type WorkflowArtifactDeleteResult = {
  status: number
  body: Record<string, unknown>
}

export function isSafeWorkflowArtifactName(name: string): boolean {
  return SAFE_ARTIFACT_NAME_RE.test(name) && !name.includes('..')
}

function assertNever(value: never): never {
  throw new Error(`Unsupported workflow caller kind: ${JSON.stringify(value)}`)
}

function callerSubject(caller: WorkflowRouteCaller): string {
  switch (caller.kind) {
    case 'admin-ui':
      return `admin:${caller.userId}`
    case 'user-session':
      return `user:${caller.claims.userId}`
    case 'mcp-host-control':
      return `mcp-host:${caller.claims.sub}`
    default:
      return assertNever(caller)
  }
}

function callerUserId(caller: WorkflowRouteCaller): string {
  switch (caller.kind) {
    case 'admin-ui':
      return caller.userId
    case 'user-session':
      return caller.claims.userId
    case 'mcp-host-control':
      return caller.claims.sub
    default:
      return assertNever(caller)
  }
}

function extractErrorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err
}

function extractErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function readResponseBodyWithLimit(
  response: Response,
  maxBytes: number | undefined
): Promise<Buffer> {
  if (maxBytes === undefined) {
    return Buffer.from(await response.arrayBuffer())
  }

  const contentLength = response.headers.get('content-length')
  if (contentLength && /^\d+$/.test(contentLength)) {
    const expectedBytes = Number(contentLength)
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes > maxBytes) {
      throw new WorkflowArtifactHttpError(413, 'Artifact too large to download')
    }
  }

  if (!response.body) {
    const body = Buffer.from(await response.arrayBuffer())
    if (body.byteLength > maxBytes) {
      throw new WorkflowArtifactHttpError(413, 'Artifact too large to download')
    }
    return body
  }

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      totalBytes += chunk.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new WorkflowArtifactHttpError(413, 'Artifact too large to download')
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, totalBytes)
}

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.name === 'AbortError' || err.name === 'TimeoutError'
}

function isK8sNotFoundLike(err: unknown): boolean {
  if (err instanceof K8sNotFoundError) return true
  if (!err || typeof err !== 'object') return false
  const maybe = err as {
    name?: string
    statusCode?: number
    code?: number
    response?: { statusCode?: number; status?: number }
  }
  return (
    maybe.name === 'K8sNotFoundError' ||
    maybe.statusCode === 404 ||
    maybe.code === 404 ||
    maybe.response?.statusCode === 404 ||
    maybe.response?.status === 404
  )
}

function artifactDtoFromUnknown(value: unknown): WorkflowRunArtifactDto | null {
  const artifact = asRecord(value)
  if (!artifact) return null
  const name = typeof artifact.name === 'string' ? artifact.name.trim() : ''
  if (!name || !isSafeWorkflowArtifactName(name)) return null

  const format = typeof artifact.format === 'string' ? artifact.format.trim() : ''
  const rawSize = artifact.sizeBytes
  const sizeBytes = typeof rawSize === 'number' && Number.isSafeInteger(rawSize) ? rawSize : 0
  const createdAt =
    typeof artifact.createdAt === 'string' && artifact.createdAt.trim()
      ? artifact.createdAt
      : new Date(0).toISOString()

  return { name, format, sizeBytes: Math.max(0, sizeBytes), createdAt }
}

export function getWorkflowRunArtifactsFromRecipe(
  childRecipe: Record<string, unknown>
): WorkflowRunArtifactDto[] {
  const status = asRecord(childRecipe.status)
  const artifacts = status?.artifacts
  if (!Array.isArray(artifacts)) return []
  return artifacts
    .map(artifactDtoFromUnknown)
    .filter((artifact): artifact is WorkflowRunArtifactDto => artifact !== null)
}

function workflowRunIdFromChildRecipe(childRecipe: Record<string, unknown>): string | undefined {
  const metadata = asRecord(childRecipe.metadata)
  const labels = asRecord(metadata?.labels)
  const runId = labels?.[WORKFLOW_RUN_ID_LABEL]
  return typeof runId === 'string' && runId.trim() ? runId.trim() : undefined
}

export async function resolveWorkflowArtifactContext(params: {
  gateway: K8sGateway
  caller: WorkflowRouteCaller
  recipeNamespace: string
  recipeName: string
  runId: string
  approvalTarget?: WorkflowApprovalTarget
}): Promise<WorkflowArtifactContext> {
  const { gateway, caller, recipeNamespace, recipeName, runId, approvalTarget = {} } = params
  if (!isRecipeNamespaceAllowed(recipeNamespace)) {
    throw new WorkflowArtifactHttpError(404, `Recipe ${recipeNamespace}/${recipeName} not found`)
  }
  if (!(await ensureRecipeAuthorized(caller, recipeNamespace, recipeName, approvalTarget))) {
    logger.warn(
      {
        recipeNamespace,
        recipeName,
        callerKind: caller.kind,
        hasApprovalTarget: Boolean(approvalTarget?.targetUserId || approvalTarget?.targetTeamId),
      },
      'Workflow artifact access denied by recipe grant check'
    )
    throw new WorkflowArtifactHttpError(403, 'Not authorized to access artifacts for this recipe')
  }

  try {
    await gateway.getResource(WORKFLOW_RECIPE_PLURAL, recipeName, recipeNamespace)
  } catch (err) {
    if (isK8sNotFoundLike(err)) {
      throw new WorkflowArtifactHttpError(404, `Recipe ${recipeNamespace}/${recipeName} not found`)
    }
    throw err
  }

  const run = await getRun(runId)
  if (
    !run ||
    run.recipe_namespace !== recipeNamespace ||
    run.recipe_name !== recipeName ||
    !run.child_recipe_name ||
    !run.child_recipe_namespace
  ) {
    throw new WorkflowArtifactHttpError(
      404,
      `Run ${runId} not found for ${recipeNamespace}/${recipeName}`
    )
  }
  if (!(await canCallerReadWorkflowRunWithApprovalTarget(caller, run, approvalTarget))) {
    logger.warn(
      {
        runId,
        parentNamespace: recipeNamespace,
        parentName: recipeName,
        childNamespace: run.child_recipe_namespace,
        childName: run.child_recipe_name,
        approvalRequestId: run.approval_request_id,
        callerKind: caller.kind,
        hasApprovalTarget: Boolean(approvalTarget?.targetUserId || approvalTarget?.targetTeamId),
      },
      'Workflow artifact access denied by run ownership check'
    )
    throw new WorkflowArtifactHttpError(
      404,
      `Run ${runId} not found for ${recipeNamespace}/${recipeName}`
    )
  }
  if (!isRecipeNamespaceAllowed(run.child_recipe_namespace)) {
    logger.warn(
      {
        runId,
        parentNamespace: recipeNamespace,
        parentName: recipeName,
        childNamespace: run.child_recipe_namespace,
        childName: run.child_recipe_name,
      },
      'Workflow artifact child recipe namespace violated sandbox invariant'
    )
    throw new WorkflowArtifactHttpError(
      404,
      `Run ${runId} not found for ${recipeNamespace}/${recipeName}`
    )
  }

  let childRecipe: Record<string, unknown>
  try {
    const rawChildRecipe = await gateway.getResource(
      WORKFLOW_RECIPE_PLURAL,
      run.child_recipe_name,
      run.child_recipe_namespace
    )
    const childRecord = asRecord(rawChildRecipe)
    if (!childRecord) {
      logger.warn(
        {
          runId,
          parentNamespace: recipeNamespace,
          parentName: recipeName,
          childNamespace: run.child_recipe_namespace,
          childName: run.child_recipe_name,
        },
        'Workflow artifact child recipe response was malformed'
      )
      throw new WorkflowArtifactHttpError(502, 'Workflow run artifact metadata is malformed')
    }
    childRecipe = childRecord
  } catch (err) {
    if (err instanceof WorkflowArtifactHttpError) throw err
    if (isK8sNotFoundLike(err)) {
      logger.warn(
        {
          runId,
          parentNamespace: recipeNamespace,
          parentName: recipeName,
          childNamespace: run.child_recipe_namespace,
          childName: run.child_recipe_name,
        },
        'Workflow artifact child recipe was not found'
      )
      throw new WorkflowArtifactHttpError(410, 'Run artifact metadata has been pruned')
    }
    throw err
  }
  const childRunId = workflowRunIdFromChildRecipe(childRecipe)
  if (childRunId && childRunId !== run.run_id) {
    logger.warn(
      {
        runId,
        childRunId,
        parentNamespace: recipeNamespace,
        parentName: recipeName,
        childNamespace: run.child_recipe_namespace,
        childName: run.child_recipe_name,
      },
      'Workflow artifact child recipe run label did not match the requested run'
    )
    throw new WorkflowArtifactHttpError(
      404,
      `Run ${runId} not found for ${recipeNamespace}/${recipeName}`
    )
  }

  return {
    parentNamespace: recipeNamespace,
    parentName: recipeName,
    run,
    ...(childRunId ? { childRunId } : {}),
    childNamespace: run.child_recipe_namespace,
    childName: run.child_recipe_name,
    childRecipe,
  }
}

export async function listWorkflowRunArtifacts(params: {
  gateway: K8sGateway
  caller: WorkflowRouteCaller
  recipeNamespace: string
  recipeName: string
  runId: string
  approvalTarget?: WorkflowApprovalTarget
}): Promise<WorkflowRunArtifactDto[]> {
  const context = await resolveWorkflowArtifactContext(params)
  return getWorkflowRunArtifactsFromRecipe(context.childRecipe)
}

async function proxyWorkflowArtifactRequest(params: {
  context: WorkflowArtifactContext
  caller: WorkflowRouteCaller
  method: 'GET' | 'DELETE'
  artifactName?: string
}): Promise<Response> {
  const { context, caller, method, artifactName } = params
  if (method === 'DELETE' && caller.kind !== 'admin-ui') {
    throw new WorkflowArtifactHttpError(403, 'Only admin callers may delete workflow artifacts')
  }
  const delegationToken = signWrcDelegationToken({
    adminUserId: callerUserId(caller),
    subject: callerSubject(caller),
    recipeName: context.childName,
    recipeNamespace: context.childNamespace,
    ...(context.childRunId ? { runId: context.childRunId } : {}),
    ...(artifactName ? { artifactName } : {}),
    scope:
      caller.kind === 'admin-ui'
        ? method === 'GET'
          ? 'admin:artifact_read'
          : 'admin:artifact_delete'
        : 'artifact_read',
  })
  const wrcUrl = buildWrcWorkflowArtifactsUrl(context.childName, artifactName)

  try {
    return await fetch(wrcUrl, {
      method,
      headers: { authorization: `Bearer ${delegationToken}` },
      signal: AbortSignal.timeout(WRC_ARTIFACT_FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    logger.error(
      {
        err: { name: extractErrorName(err), message: extractErrorMessage(err) },
        runId: context.run.run_id,
        parentNamespace: context.parentNamespace,
        parentName: context.parentName,
        childNamespace: context.childNamespace,
        childName: context.childName,
        artifactName,
      },
      method === 'GET' ? 'Workflow artifact fetch failed' : 'Workflow artifact delete failed'
    )
    throw new WorkflowArtifactHttpError(
      isTimeoutError(err) ? 504 : 502,
      isTimeoutError(err)
        ? 'Workflow artifact service timeout'
        : 'Workflow artifact service unreachable'
    )
  }
}

export async function downloadWorkflowRunArtifact(params: {
  gateway: K8sGateway
  caller: WorkflowRouteCaller
  recipeNamespace: string
  recipeName: string
  runId: string
  artifactName: string
  approvalTarget?: WorkflowApprovalTarget
  maxBytes?: number
}): Promise<WorkflowArtifactDownloadResult> {
  const { artifactName, caller, maxBytes } = params
  if (!artifactName || !isSafeWorkflowArtifactName(artifactName)) {
    throw new WorkflowArtifactHttpError(400, 'Invalid artifactName')
  }

  const context = await resolveWorkflowArtifactContext(params)
  const artifacts = getWorkflowRunArtifactsFromRecipe(context.childRecipe)
  if (!artifacts.some(artifact => artifact.name === artifactName)) {
    throw new WorkflowArtifactHttpError(
      404,
      `Artifact "${artifactName}" not found for run ${params.runId}`
    )
  }

  const upstream = await proxyWorkflowArtifactRequest({
    context,
    caller,
    method: 'GET',
    artifactName,
  })

  if (!upstream.ok) {
    let text = ''
    try {
      text = await upstream.text()
    } catch (err) {
      logger.warn(
        {
          err: { name: extractErrorName(err), message: extractErrorMessage(err) },
          status: upstream.status,
          runId: params.runId,
          childNamespace: context.childNamespace,
          childName: context.childName,
          artifactName,
        },
        'Failed to read workflow artifact upstream error body'
      )
    }
    logger.warn(
      {
        status: upstream.status,
        runId: params.runId,
        childNamespace: context.childNamespace,
        childName: context.childName,
        artifactName,
        bodyBytes: Buffer.byteLength(text, 'utf8'),
      },
      'Workflow artifact upstream returned non-OK response'
    )
    return {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
      body: { error: `Upstream returned ${upstream.status}` },
    }
  }

  const body = await readResponseBodyWithLimit(upstream, maxBytes)
  const upstreamDisposition = upstream.headers.get('content-disposition')
  const extractedName = upstreamDisposition?.match(/filename="?([^";\r\n]+)"?/)?.[1]
  const rawFilename =
    (extractedName ?? artifactName).replace(/\\/g, '/').split('/').pop() || artifactName
  const safeFilename = rawFilename.replace(/[^a-zA-Z0-9._-]/g, '_')

  return {
    status: 200,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'content-length': String(body.byteLength),
      'content-disposition': `attachment; filename="${safeFilename}"`,
    },
    body,
  }
}

export async function deleteWorkflowRunArtifact(params: {
  gateway: K8sGateway
  caller: WorkflowRouteCaller
  recipeNamespace: string
  recipeName: string
  runId: string
  artifactName: string
}): Promise<WorkflowArtifactDeleteResult> {
  const { artifactName, caller } = params
  if (!artifactName || !isSafeWorkflowArtifactName(artifactName)) {
    throw new WorkflowArtifactHttpError(400, 'Invalid artifactName')
  }

  const context = await resolveWorkflowArtifactContext(params)
  const artifacts = getWorkflowRunArtifactsFromRecipe(context.childRecipe)
  if (!artifacts.some(artifact => artifact.name === artifactName)) {
    throw new WorkflowArtifactHttpError(
      404,
      `Artifact "${artifactName}" not found for run ${params.runId}`
    )
  }

  const upstream = await proxyWorkflowArtifactRequest({
    context,
    caller,
    method: 'DELETE',
    artifactName,
  })

  if (!upstream.ok) {
    return {
      status: upstream.status,
      body: { error: `Upstream returned ${upstream.status}` },
    }
  }

  return { status: 204, body: {} }
}

export async function deleteWorkflowRunArtifacts(params: {
  gateway: K8sGateway
  caller: WorkflowRouteCaller
  recipeNamespace: string
  recipeName: string
  runId: string
}): Promise<WorkflowArtifactDeleteResult> {
  const context = await resolveWorkflowArtifactContext(params)
  const upstream = await proxyWorkflowArtifactRequest({
    context,
    caller: params.caller,
    method: 'DELETE',
  })

  if (!upstream.ok) {
    return {
      status: upstream.status,
      body: { error: `Upstream returned ${upstream.status}` },
    }
  }

  return { status: 204, body: {} }
}
