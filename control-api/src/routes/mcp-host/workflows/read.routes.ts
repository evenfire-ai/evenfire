import { type Request, type Response, Router } from 'express'
import { config } from '../../../config.js'
import { asyncHandler } from '../../../http/asyncHandler.js'
import type { K8sGateway } from '../../../k8s.js'
import { rootLogger } from '../../../observability/logger.js'
import { K8sNotFoundError } from '../../../services/resourceService.js'
import {
  listEffectiveWorkflowTargets,
  resolveEffectiveWorkflowTriggerTarget,
} from '../../../services/workflows/effectiveWorkflowTargetsService.js'
import type { RuntimeWorkflowStatusDto } from '../../../services/workflows/types.js'
import { getConversationScopedWorkflowHealth } from '../../../services/workflows/workflowConversationRunReadService.js'
import {
  WORKFLOW_RECIPE_PLURAL,
  type WorkflowApprovalTarget,
  asRecord,
  ensureRecipeAuthorized,
  getAuthorizedRecipeResources,
  isMcpHostDirectlyAuthorizedForRecipe,
  isRecipeNamespaceAllowed,
  isSharedMcpHostControlCaller,
  mapRuntimeWorkflow,
} from '../../../services/workflows/workflowRecipeAccessService.js'
import {
  WorkflowArtifactHttpError,
  downloadWorkflowRunArtifact,
  listWorkflowRunArtifacts,
} from '../../../services/workflows/workflowRunArtifactService.js'
import {
  type ProviderScopedWorkflowRunRow,
  getLatestRun,
  getLatestWorkflowRunWithApprovalTarget,
  getProviderScopedWorkflowRun,
  getWorkflowHealth,
  mapDbRun,
} from '../../../services/workflows/workflowRunReadService.js'
import {
  requireMcpHostControlScope,
  requireMcpHostControlWorkflowCaller,
} from '../../workflows/shared/auth.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CONVERSATION_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/
// Teams uses opaque a: and 19: IDs; channel targets add @thread and ;messageid= suffixes.
const TEAMS_CONVERSATION_ID_RE = /^(?:a|19):[a-zA-Z0-9._:@;=+-]+$/
const TEAMS_CONVERSATION_ID_MAX_LENGTH = 512
const RECIPE_NAME_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/
const TARGET_LABEL_MAX_LENGTH = 120
const MAX_AGENT_WORKFLOW_ARTIFACT_BYTES = 256 * 1024
const MAX_AGENT_WORKFLOW_ARTIFACT_DOWNLOAD_BYTES = config.workflowArtifactDownloadMaxBytes
const logger = rootLogger.child({ module: 'mcp-host-workflow-read-routes' })

function filenameFromContentDisposition(
  contentDisposition: string | undefined,
  fallback: string
): string {
  const match = contentDisposition?.match(/filename="?([^";\r\n]+)"?/i)
  const raw = match?.[1] || fallback
  const cleaned = raw
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/[^a-zA-Z0-9._-]/g, '_')
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback
}

function parseApprovalTargetQuery(req: Request, res: Response): WorkflowApprovalTarget | null {
  const rawUserId = typeof req.query.targetUserId === 'string' ? req.query.targetUserId.trim() : ''
  const rawTeamId = typeof req.query.targetTeamId === 'string' ? req.query.targetTeamId.trim() : ''
  if (rawUserId && rawTeamId) {
    res.status(400).json({ error: 'targetUserId and targetTeamId are mutually exclusive' })
    return null
  }
  if (rawUserId && !UUID_RE.test(rawUserId)) {
    res.status(400).json({ error: 'Invalid targetUserId format, expected UUID' })
    return null
  }
  if (rawTeamId && !UUID_RE.test(rawTeamId)) {
    res.status(400).json({ error: 'Invalid targetTeamId format, expected UUID' })
    return null
  }
  return {
    ...(rawUserId ? { targetUserId: rawUserId } : {}),
    ...(rawTeamId ? { targetTeamId: rawTeamId } : {}),
  }
}

function hasApprovalTargetContext(approvalTarget: WorkflowApprovalTarget): boolean {
  return Boolean(approvalTarget.targetUserId || approvalTarget.targetTeamId)
}

function parseConversationIdQuery(req: Request, res: Response): string | null {
  const rawConversationId =
    typeof req.query.workflowConversationId === 'string'
      ? req.query.workflowConversationId.trim()
      : ''
  if (!rawConversationId) {
    res.status(400).json({ error: 'workflowConversationId is required' })
    return null
  }
  const isValidTeamsConversationId =
    rawConversationId.length <= TEAMS_CONVERSATION_ID_MAX_LENGTH &&
    TEAMS_CONVERSATION_ID_RE.test(rawConversationId)
  if (!CONVERSATION_ID_RE.test(rawConversationId) && !isValidTeamsConversationId) {
    res.status(400).json({ error: 'Invalid workflowConversationId format' })
    return null
  }
  return rawConversationId
}

function parseOptionalConversationIdQuery(req: Request, res: Response): string | null | undefined {
  const rawConversationId =
    typeof req.query.workflowConversationId === 'string'
      ? req.query.workflowConversationId.trim()
      : ''
  if (!rawConversationId) return undefined
  const isValidTeamsConversationId =
    rawConversationId.length <= TEAMS_CONVERSATION_ID_MAX_LENGTH &&
    TEAMS_CONVERSATION_ID_RE.test(rawConversationId)
  if (!CONVERSATION_ID_RE.test(rawConversationId) && !isValidTeamsConversationId) {
    res.status(400).json({ error: 'Invalid workflowConversationId format' })
    return null
  }
  return rawConversationId
}

function canIncludeRunSummary(
  caller: ReturnType<typeof requireMcpHostControlWorkflowCaller>,
  recipeNamespace: string,
  recipeName: string,
  approvalTarget: WorkflowApprovalTarget
): boolean {
  if (!caller) return false
  if (!hasApprovalTargetContext(approvalTarget)) return true
  return isMcpHostDirectlyAuthorizedForRecipe(caller, recipeNamespace, recipeName)
}

async function resolveReadableWorkflowRef(params: {
  caller: NonNullable<ReturnType<typeof requireMcpHostControlWorkflowCaller>>
  recipeNamespace: string
  recipeName: string
  approvalTarget: WorkflowApprovalTarget
}): Promise<{ recipeNamespace: string; recipeName: string } | null> {
  const { caller, recipeNamespace, recipeName, approvalTarget } = params
  if (await ensureRecipeAuthorized(caller, recipeNamespace, recipeName, approvalTarget)) {
    return { recipeNamespace, recipeName }
  }
  return null
}

function handleWorkflowArtifactError(res: Response, err: unknown): boolean {
  if (err instanceof WorkflowArtifactHttpError) {
    logger.warn({ status: err.status, message: err.message }, 'Workflow artifact route rejected')
    res.status(err.status).json({ error: err.message })
    return true
  }
  return false
}

function approvalTargetForProviderRun(run: ProviderScopedWorkflowRunRow): WorkflowApprovalTarget {
  if (run.approval_target_user_id) {
    return { targetUserId: run.approval_target_user_id }
  }
  return run.approval_target_team_id ? { targetTeamId: run.approval_target_team_id } : {}
}

function isJsonArtifact(artifactName: string, contentType: string): boolean {
  return /\bjson\b/i.test(contentType) || artifactName.toLowerCase().endsWith('.json')
}

function isTextArtifact(artifactName: string, contentType: string): boolean {
  const lowerName = artifactName.toLowerCase()
  return (
    /^text\//i.test(contentType) ||
    lowerName.endsWith('.md') ||
    lowerName.endsWith('.txt') ||
    lowerName.endsWith('.csv')
  )
}

function artifactContentResponse(params: {
  artifactName: string
  headers: Record<string, string>
  body: Buffer | Record<string, unknown>
}): Record<string, unknown> {
  const { artifactName, headers, body } = params
  const contentType = headers['content-type'] || ''
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8')
  if (buffer.byteLength > MAX_AGENT_WORKFLOW_ARTIFACT_BYTES) {
    return {
      artifactName,
      contentType,
      sizeBytes: buffer.byteLength,
      truncated: true,
      message: 'Artifact is too large to load into agent context. Use the download action.',
    }
  }

  if (isJsonArtifact(artifactName, contentType)) {
    try {
      return {
        artifactName,
        contentType,
        sizeBytes: buffer.byteLength,
        content: JSON.parse(buffer.toString('utf8')) as unknown,
      }
    } catch {
      return {
        artifactName,
        contentType,
        sizeBytes: buffer.byteLength,
        contentText: buffer.toString('utf8'),
      }
    }
  }

  if (isTextArtifact(artifactName, contentType)) {
    return {
      artifactName,
      contentType,
      sizeBytes: buffer.byteLength,
      contentText: buffer.toString('utf8'),
    }
  }

  return {
    artifactName,
    contentType,
    sizeBytes: buffer.byteLength,
    message: 'Artifact type is not loaded into agent context. Use the download action.',
  }
}

export function createMcpHostWorkflowReadRoutes(gateway: K8sGateway): Router {
  const router = Router()

  router.post(
    '/workflows/effective-targets/resolve',
    asyncHandler(async (req: Request, res: Response) => {
      const caller = requireMcpHostControlWorkflowCaller(req, res)
      if (!caller) return
      if (!isSharedMcpHostControlCaller(caller)) {
        res.status(403).json({ error: 'mcp_host_caller_not_allowed' })
        return
      }

      const body = asRecord(req.body) ?? {}
      const purpose = typeof body.purpose === 'string' ? body.purpose.trim() : ''
      if (purpose !== 'list' && purpose !== 'trigger') {
        res.status(400).json({ error: 'purpose must be list or trigger' })
        return
      }
      if (
        !requireMcpHostControlScope(
          caller,
          res,
          purpose === 'list' ? 'workflow:list' : 'workflow:trigger'
        )
      ) {
        return
      }

      const userId = typeof body.userId === 'string' ? body.userId.trim() : ''
      if (!UUID_RE.test(userId)) {
        res.status(400).json({ error: 'Invalid userId format, expected UUID' })
        return
      }

      const recipeNamespace =
        typeof body.recipeNamespace === 'string' ? body.recipeNamespace.trim() : undefined
      if (recipeNamespace && !isRecipeNamespaceAllowed(recipeNamespace)) {
        res.status(400).json({ error: 'Invalid recipeNamespace' })
        return
      }

      const recipeName = typeof body.recipeName === 'string' ? body.recipeName.trim() : undefined
      if (recipeName && !RECIPE_NAME_RE.test(recipeName)) {
        res.status(400).json({ error: 'Invalid recipeName format' })
        return
      }
      if (purpose === 'trigger' && (!recipeNamespace || !recipeName)) {
        res.status(400).json({ error: 'recipeNamespace and recipeName are required for trigger' })
        return
      }

      const targetLabel = typeof body.targetLabel === 'string' ? body.targetLabel.trim() : undefined
      if (targetLabel && targetLabel.length > TARGET_LABEL_MAX_LENGTH) {
        res.status(400).json({ error: 'Invalid targetLabel format' })
        return
      }

      const params = {
        caller,
        gateway,
        userId,
        recipeNamespace,
        recipeName,
        targetLabel,
      }
      if (purpose === 'list') {
        res.json(await listEffectiveWorkflowTargets(params))
        return
      }

      res.json(await resolveEffectiveWorkflowTriggerTarget(params))
    })
  )

  router.get(
    '/workflows',
    asyncHandler(async (req: Request, res: Response) => {
      const caller = requireMcpHostControlWorkflowCaller(req, res)
      if (!caller) return
      if (!requireMcpHostControlScope(caller, res, 'workflow:list')) return
      const approvalTarget = parseApprovalTargetQuery(req, res)
      if (!approvalTarget) return

      const recipes = await getAuthorizedRecipeResources(caller, gateway, approvalTarget)
      const items = recipes.map(mapRuntimeWorkflow)
      res.json({ items, count: items.length })
    })
  )

  router.get(
    '/workflows/:ns/:name',
    asyncHandler(async (req: Request, res: Response) => {
      const caller = requireMcpHostControlWorkflowCaller(req, res)
      if (!caller) return
      if (!requireMcpHostControlScope(caller, res, 'workflow:read')) return
      const approvalTarget = parseApprovalTargetQuery(req, res)
      if (!approvalTarget) return

      const requested = { ns: req.params.ns, name: req.params.name }
      if (!isRecipeNamespaceAllowed(requested.ns)) {
        res.status(404).json({ error: `Recipe ${requested.ns}/${requested.name} not found` })
        return
      }
      const readableRef = await resolveReadableWorkflowRef({
        caller,
        recipeNamespace: requested.ns,
        recipeName: requested.name,
        approvalTarget,
      })
      if (!readableRef) {
        res.status(403).json({ error: 'Not authorized to view this recipe' })
        return
      }
      const { recipeNamespace: ns, recipeName: name } = readableRef

      const sharedApprovalTarget =
        isSharedMcpHostControlCaller(caller) && hasApprovalTargetContext(approvalTarget)
      const conversationId = sharedApprovalTarget
        ? parseOptionalConversationIdQuery(req, res)
        : undefined
      if (conversationId === null) return

      try {
        const resource = (await gateway.getResource(WORKFLOW_RECIPE_PLURAL, name, ns)) as Record<
          string,
          unknown
        >
        let latestRun = null
        if (canIncludeRunSummary(caller, ns, name, approvalTarget)) {
          latestRun = await getLatestRun(ns, name)
        } else if (sharedApprovalTarget && conversationId) {
          const scopedHealth = await getConversationScopedWorkflowHealth({
            caller,
            recipeNamespace: ns,
            recipeName: name,
            approvalTarget,
            conversationId,
          })
          latestRun = scopedHealth.lastRun ? mapDbRun(scopedHealth.lastRun) : null
        }
        const dto: RuntimeWorkflowStatusDto = {
          ...mapRuntimeWorkflow(resource),
          latestRun,
        }
        res.json(dto)
      } catch (err) {
        if (err instanceof K8sNotFoundError) {
          res.status(404).json({ error: `Recipe ${ns}/${name} not found` })
          return
        }
        throw err
      }
    })
  )

  router.get(
    '/workflows/:ns/:name/health',
    asyncHandler(async (req: Request, res: Response) => {
      const caller = requireMcpHostControlWorkflowCaller(req, res)
      if (!caller) return
      if (!requireMcpHostControlScope(caller, res, 'workflow:read')) return
      const approvalTarget = parseApprovalTargetQuery(req, res)
      if (!approvalTarget) return

      const requested = { ns: req.params.ns, name: req.params.name }
      if (!isRecipeNamespaceAllowed(requested.ns)) {
        res.status(404).json({ error: `Recipe ${requested.ns}/${requested.name} not found` })
        return
      }
      const readableRef = await resolveReadableWorkflowRef({
        caller,
        recipeNamespace: requested.ns,
        recipeName: requested.name,
        approvalTarget,
      })
      if (!readableRef) {
        res.status(403).json({ error: 'Not authorized to view this recipe health' })
        return
      }
      const { recipeNamespace: ns, recipeName: name } = readableRef

      const sharedApprovalTarget =
        isSharedMcpHostControlCaller(caller) && hasApprovalTargetContext(approvalTarget)
      const conversationId = sharedApprovalTarget
        ? parseOptionalConversationIdQuery(req, res)
        : undefined
      if (conversationId === null) return

      try {
        const resource = (await gateway.getResource(WORKFLOW_RECIPE_PLURAL, name, ns)) as Record<
          string,
          unknown
        >
        const status = asRecord(resource.status) ?? {}
        let runHealth: { activeRuns: number | null; lastRun: ReturnType<typeof mapDbRun> | null }
        if (canIncludeRunSummary(caller, ns, name, approvalTarget)) {
          runHealth = await getWorkflowHealth(ns, name)
        } else if (sharedApprovalTarget && conversationId) {
          const scopedHealth = await getConversationScopedWorkflowHealth({
            caller,
            recipeNamespace: ns,
            recipeName: name,
            approvalTarget,
            conversationId,
          })
          runHealth = {
            activeRuns: scopedHealth.activeRuns,
            lastRun: scopedHealth.lastRun ? mapDbRun(scopedHealth.lastRun) : null,
          }
        } else {
          runHealth = { activeRuns: null, lastRun: null }
        }
        res.json({
          recipe: `${ns}/${name}`,
          phase: status.phase ?? 'Unknown',
          workflowPhase: asRecord(status.workflowExecution)?.phase ?? null,
          activeRuns: runHealth.activeRuns,
          lastRun: runHealth.lastRun,
        })
      } catch (err) {
        if (err instanceof K8sNotFoundError) {
          res.status(404).json({ error: `Recipe ${ns}/${name} not found` })
          return
        }
        throw err
      }
    })
  )

  router.get(
    '/workflows/runs/:runId/artifacts',
    asyncHandler(async (req: Request, res: Response) => {
      const caller = requireMcpHostControlWorkflowCaller(req, res)
      if (!caller) return
      if (!requireMcpHostControlScope(caller, res, 'workflow:read')) return
      if (!UUID_RE.test(req.params.runId)) {
        res.status(400).json({ error: 'Invalid workflow run ID' })
        return
      }
      const requestedTarget = parseApprovalTargetQuery(req, res)
      if (!requestedTarget) return
      const conversationId = parseConversationIdQuery(req, res)
      if (!conversationId) return

      try {
        const run = await getProviderScopedWorkflowRun({
          caller,
          runId: req.params.runId,
          approvalTarget: requestedTarget,
          conversationId,
        })
        if (!run) {
          res.status(404).json({ error: `Workflow run ${req.params.runId} not found` })
          return
        }
        const artifacts = await listWorkflowRunArtifacts({
          gateway,
          caller,
          recipeNamespace: run.recipe_namespace,
          recipeName: run.recipe_name,
          runId: run.run_id,
          approvalTarget: approvalTargetForProviderRun(run),
        })
        res.status(200).json({
          workflowRunId: run.run_id,
          workflowName: run.recipe_name,
          artifacts,
        })
      } catch (err) {
        if (handleWorkflowArtifactError(res, err)) return
        throw err
      }
    })
  )

  router.get(
    '/workflows/runs/:runId/artifacts/:artifactName/download',
    asyncHandler(async (req: Request, res: Response) => {
      const caller = requireMcpHostControlWorkflowCaller(req, res)
      if (!caller) return
      if (!requireMcpHostControlScope(caller, res, 'workflow:read')) return
      if (!UUID_RE.test(req.params.runId)) {
        res.status(400).json({ error: 'Invalid workflow run ID' })
        return
      }
      const requestedTarget = parseApprovalTargetQuery(req, res)
      if (!requestedTarget) return
      const conversationId = parseConversationIdQuery(req, res)
      if (!conversationId) return

      try {
        const run = await getProviderScopedWorkflowRun({
          caller,
          runId: req.params.runId,
          approvalTarget: requestedTarget,
          conversationId,
        })
        if (!run) {
          res.status(404).json({ error: `Workflow run ${req.params.runId} not found` })
          return
        }
        const result = await downloadWorkflowRunArtifact({
          gateway,
          caller,
          recipeNamespace: run.recipe_namespace,
          recipeName: run.recipe_name,
          runId: run.run_id,
          artifactName: req.params.artifactName,
          approvalTarget: approvalTargetForProviderRun(run),
          maxBytes: MAX_AGENT_WORKFLOW_ARTIFACT_DOWNLOAD_BYTES,
        })
        if (result.status !== 200) {
          res.status(result.status).json(result.body)
          return
        }
        const body = Buffer.isBuffer(result.body)
          ? result.body
          : Buffer.from(JSON.stringify(result.body), 'utf8')
        const filename = filenameFromContentDisposition(
          result.headers['content-disposition'],
          req.params.artifactName
        )
        res
          .status(200)
          .set({
            'Content-Type': result.headers['content-type'] || 'application/octet-stream',
            'Content-Length': String(body.byteLength),
            'Content-Disposition': `attachment; filename="${filename}"`,
            'X-Clerum-Artifact-Name': req.params.artifactName,
            'X-Clerum-Artifact-Filename': filename,
          })
          .send(body)
      } catch (err) {
        if (handleWorkflowArtifactError(res, err)) return
        throw err
      }
    })
  )

  router.get(
    '/workflows/:ns/:name/runs/latest/artifacts',
    asyncHandler(async (req: Request, res: Response) => {
      const caller = requireMcpHostControlWorkflowCaller(req, res)
      if (!caller) return
      if (!requireMcpHostControlScope(caller, res, 'workflow:read')) return
      const approvalTarget = parseApprovalTargetQuery(req, res)
      if (!approvalTarget) return
      const conversationId = parseConversationIdQuery(req, res)
      if (!conversationId) return

      try {
        const run = await getLatestWorkflowRunWithApprovalTarget({
          caller,
          recipeNamespace: req.params.ns,
          recipeName: req.params.name,
          approvalTarget,
          conversationId,
        })
        if (!run) {
          res.status(404).json({ error: `Run not found for ${req.params.ns}/${req.params.name}` })
          return
        }
        const artifacts = await listWorkflowRunArtifacts({
          gateway,
          caller,
          recipeNamespace: run.recipe_namespace,
          recipeName: run.recipe_name,
          runId: run.run_id,
          approvalTarget,
        })
        res.status(200).json({ workflowName: run.recipe_name, artifacts })
      } catch (err) {
        if (handleWorkflowArtifactError(res, err)) return
        throw err
      }
    })
  )

  router.get(
    '/workflows/:ns/:name/runs/latest/artifacts/:artifactName/download',
    asyncHandler(async (req: Request, res: Response) => {
      const caller = requireMcpHostControlWorkflowCaller(req, res)
      if (!caller) return
      if (!requireMcpHostControlScope(caller, res, 'workflow:read')) return
      const approvalTarget = parseApprovalTargetQuery(req, res)
      if (!approvalTarget) return
      const conversationId = parseConversationIdQuery(req, res)
      if (!conversationId) return

      try {
        const run = await getLatestWorkflowRunWithApprovalTarget({
          caller,
          recipeNamespace: req.params.ns,
          recipeName: req.params.name,
          approvalTarget,
          conversationId,
        })
        if (!run) {
          res.status(404).json({ error: `Run not found for ${req.params.ns}/${req.params.name}` })
          return
        }
        const result = await downloadWorkflowRunArtifact({
          gateway,
          caller,
          recipeNamespace: run.recipe_namespace,
          recipeName: run.recipe_name,
          runId: run.run_id,
          artifactName: req.params.artifactName,
          approvalTarget,
          maxBytes: MAX_AGENT_WORKFLOW_ARTIFACT_DOWNLOAD_BYTES,
        })
        if (result.status !== 200) {
          res.status(result.status).json(result.body)
          return
        }
        const body = Buffer.isBuffer(result.body)
          ? result.body
          : Buffer.from(JSON.stringify(result.body), 'utf8')
        const filename = filenameFromContentDisposition(
          result.headers['content-disposition'],
          req.params.artifactName
        )
        res
          .status(200)
          .set({
            'Content-Type': result.headers['content-type'] || 'application/octet-stream',
            'Content-Length': String(body.byteLength),
            'Content-Disposition': `attachment; filename="${filename}"`,
            'X-Clerum-Artifact-Name': req.params.artifactName,
            'X-Clerum-Artifact-Filename': filename,
          })
          .send(body)
      } catch (err) {
        if (handleWorkflowArtifactError(res, err)) return
        throw err
      }
    })
  )

  router.get(
    '/workflows/:ns/:name/runs/latest/artifacts/:artifactName/content',
    asyncHandler(async (req: Request, res: Response) => {
      const caller = requireMcpHostControlWorkflowCaller(req, res)
      if (!caller) return
      if (!requireMcpHostControlScope(caller, res, 'workflow:read')) return
      const approvalTarget = parseApprovalTargetQuery(req, res)
      if (!approvalTarget) return
      const conversationId = parseConversationIdQuery(req, res)
      if (!conversationId) return

      try {
        const run = await getLatestWorkflowRunWithApprovalTarget({
          caller,
          recipeNamespace: req.params.ns,
          recipeName: req.params.name,
          approvalTarget,
          conversationId,
        })
        if (!run) {
          res.status(404).json({ error: `Run not found for ${req.params.ns}/${req.params.name}` })
          return
        }
        const result = await downloadWorkflowRunArtifact({
          gateway,
          caller,
          recipeNamespace: run.recipe_namespace,
          recipeName: run.recipe_name,
          runId: run.run_id,
          artifactName: req.params.artifactName,
          approvalTarget,
          maxBytes: MAX_AGENT_WORKFLOW_ARTIFACT_DOWNLOAD_BYTES,
        })
        if (result.status !== 200) {
          res.status(result.status).json(result.body)
          return
        }
        res.status(200).json(
          artifactContentResponse({
            artifactName: req.params.artifactName,
            headers: result.headers,
            body: result.body,
          })
        )
      } catch (err) {
        if (handleWorkflowArtifactError(res, err)) return
        throw err
      }
    })
  )

  return router
}
