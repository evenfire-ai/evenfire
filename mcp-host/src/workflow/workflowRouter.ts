/**
 * Express router for mcp-host workflow mode endpoints.
 *
 * Endpoints:
 * - POST /api/v1/workflow/execute    (step execution)
 * - POST /api/v1/workflow/configure  (API key + SOUL delivery from WRC)
 * - GET  /api/v1/workflow/mode       (workflow mode status)
 * - GET  /api/v1/runtime/health      (readiness/health check)
 * - GET  /api/v1/runtime/live        (liveness check)
 *
 * All endpoints except /runtime/health require JWT with aud: mcp-host.
 *
 * Source of truth: STAGE-1-CRD-TWO-POD-FOUNDATION.md §4.7
 */
import { NextFunction, Request, Response, Router } from 'express'
import * as fs from 'fs'
import { importSPKI, jwtVerify } from 'jose'
import * as path from 'path'
import { config } from '../config'
import {
  ArtifactPathError,
  type OpenedArtifactFile,
  isSafeArtifactFilename,
  openExistingArtifactFile,
  resolveExistingArtifactFile,
} from './artifactPaths'
import { getOutputDir } from './internalTools'
import { ConfigureRequest, ExecuteStepRequest, PluginWorkloadSdkBootstrapRequest } from './types'
import { WorkflowService } from './workflowService'

// ─── V1 fix: JWT auth middleware for workflow endpoints ──────────────────
// Workflow tokens are signed by WRC (iss: clerum-wrc, aud: mcp-host) using
// the WRC private key. This is separate from the general mcp-host auth tokens
// (iss: control-api) — different signer, different trust boundary.

interface WorkflowTokenClaims {
  sub: 'wrc' | 'coordinator'
  recipeName: string
  recipeNamespace?: string
  runId?: string
  artifactName?: string
  scopes: string[]
}

// SEC-04 fix: cache the imported SPKI key to avoid per-request PEM parsing.
// Cache is keyed to PEM value so key rotation (Secret update + Pod restart) is handled.
let cachedPublicKey: Awaited<ReturnType<typeof importSPKI>> | null = null
let cachedPem = ''

async function verifyWorkflowToken(token: string): Promise<WorkflowTokenClaims> {
  const publicKeyPem = config.wrcPublicKey
  if (!publicKeyPem) throw new Error('WRC public key not configured')

  if (!cachedPublicKey || cachedPem !== publicKeyPem) {
    cachedPublicKey = await importSPKI(publicKeyPem, 'RS256')
    cachedPem = publicKeyPem
  }
  const { payload } = await jwtVerify(token, cachedPublicKey, {
    algorithms: ['RS256'],
    issuer: 'clerum-wrc',
    audience: 'mcp-host',
  })

  if (
    typeof payload.sub !== 'string' ||
    !Array.isArray(payload['scopes']) ||
    typeof payload['recipeName'] !== 'string'
  ) {
    throw new Error('Invalid workflow token claims')
  }

  return {
    sub: payload.sub as 'wrc' | 'coordinator',
    recipeName: payload['recipeName'] as string,
    recipeNamespace:
      typeof payload['recipeNamespace'] === 'string'
        ? (payload['recipeNamespace'] as string)
        : undefined,
    runId: typeof payload['runId'] === 'string' ? (payload['runId'] as string) : undefined,
    artifactName:
      typeof payload['artifactName'] === 'string' ? (payload['artifactName'] as string) : undefined,
    scopes: payload['scopes'] as string[],
  }
}

// Supported workflow scopes, all emitted exclusively by WRC (iss: clerum-wrc).
// The middleware itself is generic — any string is accepted — but this list
// documents the authoritative vocabulary and lets reviewers grep for callers.
//
//   configure       - POST /configure    (sub: wrc,         long-lived Secret)
//   execute         - POST /execute      (sub: coordinator, per-step token)
//   mode_read       - GET  /mode         (sub: *,           read-only)
//   health:read     - GET  /runtime/*    (sub: *,           read-only)
//   kill_switch:write - POST /kill-switch (sub: wrc)
//   status_read     - GET  /status       (sub: *)
//   artifact_read   - GET  /artifacts/:  (sub: wrc, 60s TTL)
//   artifact_delete - DELETE /artifacts  (sub: wrc,         60s TTL, cleanup)
function requireWorkflowAuth(requiredScope: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!config.enableAuth) {
      next()
      return
    }

    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing workflow auth token' })
      return
    }

    verifyWorkflowToken(header.slice(7))
      .then(claims => {
        if (!claims.scopes.includes(requiredScope)) {
          res.status(403).json({ error: `Missing scope: ${requiredScope}` })
          return
        }
        ;(req as Request & { workflowClaims: WorkflowTokenClaims }).workflowClaims = claims
        next()
      })
      .catch(() => {
        res.status(401).json({ error: 'Invalid workflow token' })
      })
  }
}

function workflowClaims(req: Request): WorkflowTokenClaims | undefined {
  return (req as Request & { workflowClaims?: WorkflowTokenClaims }).workflowClaims
}

function validateWorkflowBinding(
  req: Request,
  res: Response,
  options: { expectedSub?: WorkflowTokenClaims['sub'] } = {}
): WorkflowTokenClaims | null {
  if (!config.enableAuth) return workflowClaims(req) ?? ({} as WorkflowTokenClaims)

  const claims = workflowClaims(req)
  const expectedRecipe = process.env.CLERUM_WORKFLOW_RECIPE ?? ''
  const expectedNamespace = process.env.CLERUM_WORKFLOW_NAMESPACE ?? ''
  if (!claims) {
    res.status(401).json({ error: 'Missing workflow auth token' })
    return null
  }
  if (!expectedRecipe) {
    res.status(500).json({ error: 'Workflow recipe not configured' })
    return null
  }
  if (!expectedNamespace) {
    res.status(500).json({ error: 'Workflow namespace not configured' })
    return null
  }
  if (options.expectedSub && claims.sub !== options.expectedSub) {
    res.status(403).json({ error: `Endpoint requires sub: ${options.expectedSub}` })
    return null
  }
  if (claims.recipeName !== expectedRecipe) {
    res.status(403).json({ error: 'recipeName mismatch' })
    return null
  }
  if (claims.recipeNamespace !== expectedNamespace) {
    res.status(403).json({ error: 'recipeNamespace mismatch' })
    return null
  }
  return claims
}

const EXECUTE_HEARTBEAT_MS = 15_000
const WORKFLOW_CONTROL_RATE_LIMIT_WINDOW_MS = 60_000
const WORKFLOW_CONTROL_RATE_LIMIT_MAX = 60
const WORKFLOW_CONTROL_RATE_LIMIT_MAX_BUCKETS = 10_000
const workflowControlRateLimitBuckets = new Map<string, { windowStart: number; count: number }>()

/**
 * Bound WRC-only control operations (including SDK bootstrap) per recipe.
 * Authentication runs first, so the bucket key is server-verified JWT
 * identity rather than a request header or body field. The unauthenticated
 * key is retained only for the local auth-disabled mode and remains bounded.
 */
function workflowControlRateLimit(req: Request, res: Response, next: NextFunction): void {
  const claims = workflowClaims(req)
  const key = claims
    ? `workflow-control:${claims.recipeNamespace}/${claims.recipeName}:${claims.sub}`
    : 'workflow-control:unauthenticated'
  const now = Date.now()
  const existing = workflowControlRateLimitBuckets.get(key)
  const bucket =
    existing && now - existing.windowStart < WORKFLOW_CONTROL_RATE_LIMIT_WINDOW_MS
      ? existing
      : { windowStart: now, count: 0 }
  if (bucket.count >= WORKFLOW_CONTROL_RATE_LIMIT_MAX) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((bucket.windowStart + WORKFLOW_CONTROL_RATE_LIMIT_WINDOW_MS - now) / 1000)
    )
    res.setHeader('Retry-After', String(retryAfterSeconds))
    res.status(429).json({ error: 'Too Many Requests', retryAfterSeconds })
    return
  }
  bucket.count += 1
  workflowControlRateLimitBuckets.set(key, bucket)
  if (workflowControlRateLimitBuckets.size > WORKFLOW_CONTROL_RATE_LIMIT_MAX_BUCKETS) {
    const oldest = workflowControlRateLimitBuckets.keys().next().value
    if (typeof oldest === 'string') workflowControlRateLimitBuckets.delete(oldest)
  }
  next()
}

function writeSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function startExecuteStream(res: Response): ReturnType<typeof setInterval> {
  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
  res.write(': connected\n\n')

  const heartbeat = setInterval(() => {
    if (!res.destroyed) res.write(': keepalive\n\n')
  }, EXECUTE_HEARTBEAT_MS)
  heartbeat.unref?.()
  return heartbeat
}

// ─── Router ─────────────────────────────────────────────────────────────

export function createWorkflowRouter(service: WorkflowService): Router {
  const router = Router()

  // POST /execute — execute a single step (requires scope: execute, sub: coordinator)
  router.post('/execute', requireWorkflowAuth('execute'), async (req: Request, res: Response) => {
    if (!validateWorkflowBinding(req, res, { expectedSub: 'coordinator' })) return
    const body = req.body as ExecuteStepRequest

    if (!body.stepId || !body.instruction) {
      res.status(400).json({ error: 'stepId and instruction are required' })
      return
    }

    const controller = new AbortController()
    let finished = false
    res.on('close', () => {
      if (!finished && !controller.signal.aborted) controller.abort('client-disconnected')
    })
    const heartbeat = startExecuteStream(res)

    try {
      const result = await service.executeStep(
        body,
        event => {
          if (!res.destroyed) writeSse(res, 'progress', event)
        },
        { signal: controller.signal }
      )
      if (!res.destroyed) writeSse(res, 'result', result)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal execution error'
      if (!res.destroyed) writeSse(res, 'error', { message })
    } finally {
      finished = true
      clearInterval(heartbeat)
      if (!res.destroyed) res.end()
    }
  })

  // POST /configure — receive API key and SOUL from WRC (requires scope: configure, sub: wrc)
  router.post('/configure', requireWorkflowAuth('configure'), (req: Request, res: Response) => {
    if (!validateWorkflowBinding(req, res, { expectedSub: 'wrc' })) return
    const body = req.body as ConfigureRequest
    const result = service.configure(body)
    res.json(result)
  })

  // POST /plugin-workload-sdk/bootstrap — publish only the public
  // provider/model binding for a stepless SDK host. No API key is accepted or
  // resolved here; prompt credentials are brokered per attempt by WRC.
  router.post(
    '/plugin-workload-sdk/bootstrap',
    requireWorkflowAuth('configure'),
    workflowControlRateLimit,
    (req: Request, res: Response) => {
      if (!validateWorkflowBinding(req, res, { expectedSub: 'wrc' })) return
      const raw = req.body as PluginWorkloadSdkBootstrapRequest
      // Deliberately project the request to the identity-only contract. Any
      // apiKey/secret-shaped field supplied by a caller is ignored before the
      // service boundary and can never reach the SDK context holder.
      const body: PluginWorkloadSdkBootstrapRequest = {
        provider: raw?.provider,
        model: raw?.model,
      }
      const result = service.configurePluginWorkloadSdkBootstrap(body)
      res.status(result.configured ? 200 : 400).json(result)
    }
  )

  // GET /mode — workflow mode status (requires valid workflow token)
  router.get('/mode', requireWorkflowAuth('mode_read'), (req: Request, res: Response) => {
    if (!validateWorkflowBinding(req, res)) return
    res.json(service.getStatus())
  })

  // GET /artifacts/:filename — download artifact from /output (scope: artifact_read)
  //
  // Security model:
  //  1. requireWorkflowAuth validates JWT (iss, aud, scope).
  //  2. sub MUST be `wrc`; coordinators never read artifacts directly.
  //  3. recipeName/recipeNamespace claims MUST match this pod's workflow env
  //     — prevents a token signed for recipe-A from being replayed against
  //     recipe-B's mcp-host.
  //  4. artifactName MUST match the requested filename.
  //  5. Filename is sanitized against path traversal, null bytes, and slashes.
  //  6. Resolved path MUST remain inside the output directory (double-check
  //     in case of symlinks or edge-case filename encoding).
  //  7. Every successful download emits a structured audit log line so the
  //     control plane can attribute downloads to a specific admin/coordinator.
  router.get(
    '/artifacts/:filename',
    requireWorkflowAuth('artifact_read'),
    (req: Request, res: Response) => {
      const claims = validateWorkflowBinding(req, res, { expectedSub: 'wrc' })
      if (!claims) return
      const expectedRecipe = process.env.CLERUM_WORKFLOW_RECIPE ?? ''

      const filename = req.params.filename as string | undefined
      if (!isSafeArtifactFilename(filename)) {
        res.status(400).json({ error: 'Invalid filename' })
        return
      }
      if (!claims?.artifactName) {
        res.status(403).json({ error: 'Missing artifactName binding' })
        return
      }
      if (claims.artifactName !== filename) {
        res.status(403).json({ error: 'artifactName mismatch' })
        return
      }

      const outputDir = getOutputDir()
      let artifact: OpenedArtifactFile
      try {
        artifact = openExistingArtifactFile(outputDir, filename)
      } catch (err) {
        if (err instanceof ArtifactPathError) {
          res
            .status(err.status)
            .json({ error: err.status === 404 ? `Artifact "${filename}" not found` : err.message })
          return
        }
        res.status(500).json({ error: 'Failed to read artifact' })
        return
      }

      const ext = filename.split('.').pop()?.toLowerCase() ?? ''
      const contentTypes: Record<string, string> = {
        pdf: 'application/pdf',
        md: 'text/markdown',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }
      const contentType = contentTypes[ext] ?? 'application/octet-stream'

      const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_')
      res.setHeader('Content-Type', contentType)
      res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`)
      res.setHeader('Content-Length', String(artifact.stat.size))

      console.log(
        JSON.stringify({
          event: 'artifact_download',
          correlationId: req.headers['x-correlation-id'] ?? '-',
          sub: claims?.sub ?? '-',
          recipeName: claims?.recipeName ?? expectedRecipe,
          filename,
          sizeBytes: artifact.stat.size,
          contentType,
        })
      )

      const stream = fs.createReadStream(artifact.filePath, { fd: artifact.fd, autoClose: true })
      stream.on('error', err => {
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to read artifact' })
        } else {
          res.destroy()
        }
        console.error(
          JSON.stringify({
            event: 'artifact_read_error',
            filename,
            error: err.message,
          })
        )
      })
      stream.pipe(res)
    }
  )

  // DELETE /artifacts/:filename — delete a single artifact (scope: artifact_delete).
  //
  // Same security model as DELETE /artifacts (bulk) but targets a single file.
  // Defense in depth against malicious LLM/coordinator:
  //  1. Scope: artifact_delete (coordinator tokens never carry this)
  //  2. Sub: must be "wrc" (rejects coordinator even with scope)
  //  3. recipeName/recipeNamespace: must match this pod's workflow env
  //  4. Path traversal: filename sanitized, resolved path checked
  //  5. Physical: subPath mount prevents escape
  router.delete(
    '/artifacts/:filename',
    requireWorkflowAuth('artifact_delete'),
    (req: Request, res: Response) => {
      const claims = validateWorkflowBinding(req, res, { expectedSub: 'wrc' })
      if (!claims) return
      const expectedRecipe = process.env.CLERUM_WORKFLOW_RECIPE ?? ''

      const filename = req.params.filename as string | undefined
      if (!isSafeArtifactFilename(filename)) {
        res.status(400).json({ error: 'Invalid filename' })
        return
      }
      if (!claims?.artifactName) {
        res.status(403).json({ error: 'Missing artifactName binding' })
        return
      }
      if (claims.artifactName !== filename) {
        res.status(403).json({ error: 'artifactName mismatch' })
        return
      }

      const outputDir = getOutputDir()
      let filePath: string
      try {
        filePath = resolveExistingArtifactFile(outputDir, filename).filePath
      } catch (err) {
        if (err instanceof ArtifactPathError) {
          res
            .status(err.status)
            .json({ error: err.status === 404 ? `Artifact "${filename}" not found` : err.message })
          return
        }
        res.status(500).json({ error: 'Failed to delete artifact' })
        return
      }

      try {
        const stat = fs.lstatSync(filePath)
        if (!stat.isFile()) {
          res.status(404).json({ error: `Artifact "${filename}" not found` })
          return
        }
        fs.unlinkSync(filePath)
        console.log(
          JSON.stringify({
            event: 'artifact_file_deleted',
            correlationId: req.headers['x-correlation-id'] ?? '-',
            sub: claims?.sub ?? '-',
            recipeName: claims?.recipeName ?? expectedRecipe,
            filename,
          })
        )
        res.status(204).end()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(
          JSON.stringify({
            event: 'artifact_file_delete_failed',
            recipeName: claims?.recipeName ?? expectedRecipe,
            filename,
            error: message,
          })
        )
        res.status(500).json({ error: 'Failed to delete artifact' })
      }
    }
  )

  // DELETE /artifacts — WRC-only cleanup endpoint (scope: artifact_delete).
  //
  // Called by workflowReconciler.reconcileDelete() right before tearing down
  // the mcp-host pod, so the recipe's subPath on the shared PVC does not
  // accumulate orphan files. Defense in depth:
  //  1. Scope check: artifact_delete (only signWrcArtifactDeleteToken emits it).
  //  2. sub check: sub === "wrc" — coordinator tokens are rejected even if
  //     they somehow carry the scope. Cleanup is a control-plane operation.
  //  3. recipeName/recipeNamespace checks: must match pod workflow env — a
  //     leaked delete token can only delete its own recipe's data.
  //  4. Physical scoping: getOutputDir() is the subPath mount point. kubelet
  //     bind-mounts it, so `rm -rf` cannot escape the recipe's subdirectory
  //     even if an attacker somehow bypassed checks 1-3.
  router.delete(
    '/artifacts',
    requireWorkflowAuth('artifact_delete'),
    (req: Request, res: Response) => {
      const claims = validateWorkflowBinding(req, res, { expectedSub: 'wrc' })
      if (!claims) return
      const expectedRecipe = process.env.CLERUM_WORKFLOW_RECIPE ?? ''

      const dir = getOutputDir()
      try {
        // Clear directory contents without removing the mount point itself.
        // When /output is a kubelet bind mount (PVC subPath), rmSync on the
        // mount point fails with EBUSY. Deleting entries individually avoids this.
        const entries = fs.readdirSync(dir)
        for (const entry of entries) {
          const entryPath = path.join(dir, entry)
          const stat = fs.lstatSync(entryPath)
          if (stat.isSymbolicLink()) {
            fs.unlinkSync(entryPath)
            continue
          }
          fs.rmSync(entryPath, { recursive: true, force: true })
        }
        console.log(
          JSON.stringify({
            event: 'artifact_cleanup',
            correlationId: req.headers['x-correlation-id'] ?? '-',
            sub: claims?.sub ?? '-',
            recipeName: claims?.recipeName ?? expectedRecipe,
          })
        )
        res.status(204).end()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(
          JSON.stringify({
            event: 'artifact_cleanup_failed',
            correlationId: req.headers['x-correlation-id'] ?? '-',
            recipeName: claims?.recipeName ?? expectedRecipe,
            error: message,
          })
        )
        res.status(500).json({ error: 'Cleanup failed' })
      }
    }
  )

  return router
}

export function workflowHealthHandler(service: WorkflowService) {
  return (_req: Request, res: Response) => {
    const status = service.getStatus()
    if (status.ready) {
      res.json({ status: 'healthy', mode: 'workflow', ready: true })
    } else {
      res.status(503).json({
        status: 'not_ready',
        mode: 'workflow',
        ready: false,
        configured: status.configured,
      })
    }
  }
}
