/**
 * HTTP server for receiving messages from channel-reader.
 *
 * Routing and authz are split into dedicated modules under src/server/.
 */
import express, { type NextFunction, type Request, type Response } from 'express'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'
import { register } from 'prom-client'
import { readOpenedArtifactBuffer, redactArtifactForDelivery } from './artifacts/artifactBytes'
import type { ArtifactSecretEntry } from './artifacts/artifactRedaction'
import type { RuntimeLifecycleGate } from './lifecycle/statelessHeartbeat'
import './mcp/statusHeartbeatMetrics'
import './observability/processMetrics'
import { requireScope } from './server/authMiddleware'
import { getRuntimeCallerContext, runtimeEdgeGuard } from './server/edgeRuntimeAuth'
import { getAllowedOrigins, json } from './server/httpUtils'
import {
  handleActivityRoute,
  handleActivityStreamRoute,
  handleApprovalRoute,
  handleCompactionRoute,
  handleContextBreakdownRoute,
  handleCronResultAckRoute,
  handleCronResultsRoute,
  handleMessageRoute,
  handleModelsListRoute,
  handleProgressStreamRoute,
  handleProviderMessageAuthorizationRoute,
  handleProviderWorkflowApprovalDecisionRoute,
  handleProviderWorkflowApprovalResolveRoute,
  handleProviderWorkflowResultRequestRoute,
  handleSessionMessagesRoute,
  handleSessionSearchRoute,
  handleSessionsListRoute,
  handleSetModelRoute,
  handleStatusRoute,
  handleTaskResultRoute,
  handleTelegramWorkflowApprovalVerificationRoute,
  handleWorkflowApprovalMediumEnrollmentRoute,
  handleWorkflowApprovalNotificationClaimRoute,
  handleWorkflowApprovalNotificationTerminalRoute,
  runtimeApiInfo,
} from './server/routes'
import type {
  ActivitySnapshotHandler,
  ActivityStreamHandler,
  ApprovalHandler,
  CancelHandler,
  CompactionHandler,
  ContextBreakdownHandler,
  CronResultAckHandler,
  CronResultsHandler,
  MessageHandler,
  ModelsListHandler,
  ProgressStreamHandler,
  ProviderMessageAuthorizationHandler,
  ProviderWorkflowApprovalDecisionHandler,
  ProviderWorkflowApprovalResolveHandler,
  ProviderWorkflowResultRequestHandler,
  SessionMessagesHandler,
  SessionSearchHandler,
  SessionsListHandler,
  SetModelHandler,
  StatusHandler,
  TaskResultHandler,
  TelegramWorkflowApprovalVerificationHandler,
  WorkflowApprovalMediumEnrollmentHandler,
  WorkflowApprovalNotificationClaimHandler,
  WorkflowApprovalNotificationTerminalHandler,
} from './server/types'
import {
  ArtifactPathError,
  type OpenedArtifactFile,
  openExistingArtifactFile,
  resolveExistingArtifactFile,
} from './workflow/artifactPaths'
import { getOutputDir } from './workflow/internalTools'
import { isInternalWorkflowArtifactName } from './workflow/mcpHostJwtState'
import { runtimeAuthHealthSnapshot } from './workflow/runtimeAuthHealth'
import { createWorkflowRouter } from './workflow/workflowRouter'
import { WorkflowService } from './workflow/workflowService'

export type {
  HostActivityEvent,
  HostActivitySnapshotResponse,
  IncomingMessage,
  MessageResponse,
  ProviderMessageAuthorization,
  StatusResponse,
  ProviderWorkflowApprovalDecision,
  ProviderWorkflowApprovalResolve,
  ProviderWorkflowResultRequest,
  TelegramWorkflowApprovalVerification,
  WorkflowApprovalNotificationClaim,
  WorkflowApprovalNotificationDelivery,
  WorkflowApprovalMediumEnrollment,
  WorkflowApprovalNotificationMedium,
  WorkflowApprovalNotificationTerminal,
  RuntimeCallerContext,
  MessageHandler,
  StatusHandler,
  ActivitySnapshotHandler,
  ActivityStreamHandler,
  ApprovalHandler,
  ProviderMessageAuthorizationHandler,
  ProviderWorkflowApprovalDecisionHandler,
  ProviderWorkflowApprovalResolveHandler,
  TelegramWorkflowApprovalVerificationHandler,
  WorkflowApprovalNotificationClaimHandler,
  WorkflowApprovalNotificationTerminalHandler,
  TaskResultHandler,
  CronResultsHandler,
  CronResultAckHandler,
  ProgressStreamHandler,
  CancelHandler,
  CancelResult,
  SessionsListHandler,
  SessionMessagesHandler,
  ContextBreakdownHandler,
  SessionSearchHandler,
  SessionSearchRequest,
  SessionSearchResponse,
  SetModelResult,
} from './server/types'

export class RPCServer {
  private server: http.Server | null = null
  private app = express()
  private readonly port: number
  private messageHandler: MessageHandler | null = null
  private statusHandler: StatusHandler | null = null
  private approvalHandler: ApprovalHandler | null = null
  private providerWorkflowApprovalDecisionHandler: ProviderWorkflowApprovalDecisionHandler | null =
    null
  private providerWorkflowApprovalResolveHandler: ProviderWorkflowApprovalResolveHandler | null =
    null
  private providerWorkflowResultRequestHandler: ProviderWorkflowResultRequestHandler | null = null
  private providerMessageAuthorizationHandler: ProviderMessageAuthorizationHandler | null = null
  private workflowApprovalNotificationClaimHandler: WorkflowApprovalNotificationClaimHandler | null =
    null
  private workflowApprovalNotificationTerminalHandler: WorkflowApprovalNotificationTerminalHandler | null =
    null
  private workflowApprovalMediumEnrollmentHandler: WorkflowApprovalMediumEnrollmentHandler | null =
    null
  private telegramWorkflowApprovalVerificationHandler: TelegramWorkflowApprovalVerificationHandler | null =
    null
  private activitySnapshotHandler: ActivitySnapshotHandler | null = null
  private activityStreamHandler: ActivityStreamHandler | null = null
  private taskResultHandler: TaskResultHandler | null = null
  private cronResultsHandler: CronResultsHandler | null = null
  private cronResultAckHandler: CronResultAckHandler | null = null
  private progressStreamHandler: ProgressStreamHandler | null = null
  private cancelHandler: CancelHandler | null = null
  private sessionsListHandler: SessionsListHandler | null = null
  private sessionMessagesHandler: SessionMessagesHandler | null = null
  private contextBreakdownHandler: ContextBreakdownHandler | null = null
  private sessionSearchHandler: SessionSearchHandler | null = null
  private compactionHandler: CompactionHandler | null = null
  private modelsListHandler: ModelsListHandler | null = null
  private setModelHandler: SetModelHandler | null = null
  private workflowRouter: ReturnType<typeof createWorkflowRouter> | null = null
  private artifactSecretEntriesProvider: (() => ArtifactSecretEntry[]) | null = null
  private lifecycleGate: RuntimeLifecycleGate | null = null

  constructor(port: number = 8080) {
    this.port = port
    this.configureExpress()
  }

  private configureExpress(): void {
    this.app.use((req, res, next) => {
      const origin = req.headers.origin
      if (origin && getAllowedOrigins().has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        res.setHeader('Vary', 'Origin')
      }
      if (req.method === 'OPTIONS') {
        res.status(204).end()
        return
      }
      next()
    })

    // Image attachments are sent as base64 in /v1/runtime/messages.
    // 6mb comfortably covers the default 3mb binary limit plus JSON overhead.
    this.app.use(express.json({ limit: '6mb' }))
    this.registerRoutes()
  }

  private registerRoutes(): void {
    this.app.get('/v1/runtime', (_req, res) => {
      json(res, 200, runtimeApiInfo())
    })

    // Liveness check — intentionally independent from runtime auth so a stale
    // credential family does not create kubelet restart loops.
    this.app.get('/v1/runtime/live', (_req, res) => {
      json(res, 200, { status: 'live' })
    })

    // Readiness/health check — no auth required (K8s probes don't send JWT).
    // Runtime auth degradation returns 503 readiness while liveness stays 200.
    this.app.get('/v1/runtime/health', (_req, res) => {
      const runtimeAuth = runtimeAuthHealthSnapshot()
      if (runtimeAuth.state === 'degraded') {
        json(res, 503, { status: 'degraded' })
        return
      }
      json(res, 200, { status: 'ok' })
    })

    this.app.get('/metrics', async (_req, res) => {
      res.setHeader('Content-Type', register.contentType)
      res.send(await register.metrics())
    })

    this.app.get('/v1/runtime/status', runtimeEdgeGuard(['rpc-proxy']), async (req, res) => {
      await handleStatusRoute(req, res, this.routeDeps())
    })
    this.app.get('/v1/runtime/activity', runtimeEdgeGuard(['rpc-proxy']), async (req, res) => {
      await handleActivityRoute(req, res, this.routeDeps())
    })
    this.app.get(
      '/v1/runtime/activity/stream',
      runtimeEdgeGuard(['rpc-proxy']),
      async (req, res) => {
        await handleActivityStreamRoute(req, res, this.routeDeps())
      }
    )

    this.app.post(
      '/v1/runtime/messages',
      runtimeEdgeGuard(['rpc-proxy', 'channel-reader', 'workflow-approval-request-reader']),
      async (req, res) => {
        // Stage 3 (stateless-agents) — reversible DRAINING fence. While the
        // host is draining/drained, new intake is rejected with the exact
        // code rpc-proxy keys on; the in-flight turn keeps running. The
        // fence lifts immediately on drain-cancel (no restart). Body stays
        // minimal on purpose: no activity details leak to callers.
        if (this.lifecycleGate?.isIntakeFenced()) {
          // H2 self-heal: record that new work arrived while fenced so the next
          // heartbeat surfaces pendingIntake=true and HCC/control-api can cancel
          // the drain deterministically. The 503 still goes back to rpc-proxy,
          // which holds and redrives the message once the fence lifts.
          this.lifecycleGate.noteFencedIntake()
          json(res, 503, { code: 'host_draining' })
          return
        }
        this.lifecycleGate?.noteIntakeActivity()
        await handleMessageRoute(req, res, this.routeDeps())
      }
    )

    this.app.post(
      '/v1/runtime/approvals/approve',
      runtimeEdgeGuard(['rpc-proxy', 'channel-reader']),
      async (req, res) => {
        await handleApprovalRoute(req, res, true, this.routeDeps())
      }
    )

    this.app.post(
      '/v1/runtime/approvals/deny',
      runtimeEdgeGuard(['rpc-proxy', 'channel-reader']),
      async (req, res) => {
        await handleApprovalRoute(req, res, false, this.routeDeps())
      }
    )

    this.app.post(
      '/v1/runtime/provider-messages/authorize',
      runtimeEdgeGuard(['channel-reader', 'workflow-approval-request-reader']),
      async (req, res) => {
        await handleProviderMessageAuthorizationRoute(req, res, this.routeDeps())
      }
    )

    this.app.post(
      '/v1/runtime/workflow-approvals/decide',
      runtimeEdgeGuard(['channel-reader', 'workflow-approval-request-reader']),
      async (req, res) => {
        await handleProviderWorkflowApprovalDecisionRoute(req, res, this.routeDeps())
      }
    )

    this.app.post(
      '/v1/runtime/workflow-approval-mediums/link-sessions/confirm',
      runtimeEdgeGuard(['channel-reader', 'workflow-approval-request-reader']),
      async (req, res) => {
        await handleWorkflowApprovalMediumEnrollmentRoute(req, res, this.routeDeps())
      }
    )

    this.app.post(
      '/v1/runtime/workflow-approvals/resolve',
      runtimeEdgeGuard(['channel-reader']),
      async (req, res) => {
        await handleProviderWorkflowApprovalResolveRoute(req, res, this.routeDeps())
      }
    )

    this.app.post(
      '/v1/runtime/workflow-results/latest',
      runtimeEdgeGuard(['channel-reader']),
      async (req, res) => {
        await handleProviderWorkflowResultRequestRoute(req, res, this.routeDeps())
      }
    )

    this.app.post(
      '/v1/runtime/workflow-approval-notifications/claim',
      runtimeEdgeGuard(['channel-reader']),
      async (req, res) => {
        await handleWorkflowApprovalNotificationClaimRoute(req, res, this.routeDeps())
      }
    )

    this.app.post(
      '/v1/runtime/workflow-approval-notifications/deliveries/:id/:action',
      runtimeEdgeGuard(['channel-reader']),
      async (req, res) => {
        const action = String(req.params.action || '')
        if (action !== 'ack' && action !== 'fail') {
          res.status(404).json({ error: 'Unsupported notification delivery action' })
          return
        }
        await handleWorkflowApprovalNotificationTerminalRoute(
          req,
          res,
          String(req.params.id || ''),
          action,
          this.routeDeps()
        )
      }
    )

    this.app.post(
      '/v1/runtime/workflow-approval-mediums/telegram/challenges/confirm-provider-event',
      runtimeEdgeGuard(['channel-reader']),
      async (req, res) => {
        await handleTelegramWorkflowApprovalVerificationRoute(req, res, this.routeDeps())
      }
    )

    this.app.get('/v1/runtime/sessions', runtimeEdgeGuard(['rpc-proxy']), async (req, res) => {
      await handleSessionsListRoute(req, res, this.routeDeps())
    })

    // T3.1 — registered BEFORE `/sessions/:agent/:chatId/messages` so that
    // `search` is not eaten by the parameterized route (`agent=search` would
    // otherwise match and 404 at the second segment lookup).
    this.app.get(
      '/v1/runtime/sessions/search',
      requireScope('host:session:read'),
      async (req, res) => {
        await handleSessionSearchRoute(req, res, this.routeDeps())
      }
    )

    this.app.get(
      '/v1/runtime/sessions/:agent/:chatId/messages',
      runtimeEdgeGuard(['rpc-proxy']),
      async (req, res) => {
        await handleSessionMessagesRoute(req, res, this.routeDeps())
      }
    )

    this.app.get(
      '/v1/runtime/sessions/:agent/:chatId/context-breakdown',
      runtimeEdgeGuard(['rpc-proxy']),
      async (req, res) => {
        await handleContextBreakdownRoute(req, res, this.routeDeps())
      }
    )

    this.app.get(
      '/v1/runtime/tasks/:taskId/result',
      runtimeEdgeGuard(['rpc-proxy', 'channel-reader', 'workflow-approval-request-reader']),
      async (req, res) => {
        await handleTaskResultRoute(req, res, req.params.taskId as string, this.routeDeps())
      }
    )

    this.app.post(
      '/v1/runtime/tasks/:taskId/cancel',
      runtimeEdgeGuard(['rpc-proxy']),
      async (req, res) => {
        const taskId = String(req.params.taskId || '').trim()
        if (!taskId) {
          res.status(400).json({ error: 'taskId is required' })
          return
        }

        if (!this.cancelHandler) {
          res.status(501).json({ error: 'Cancel handler not configured' })
          return
        }

        const caller = getRuntimeCallerContext(req)
        const requesterUserId = caller?.caller === 'rpc-proxy' ? caller.userId : undefined

        const result = await this.cancelHandler(taskId, requesterUserId)

        if (result === 'cancelled' || result === 'already_terminal') {
          res.status(204).end()
          return
        }

        // result === "not_found" OR ownership_mismatch — both collapse to 404
        // (don't leak task existence to unauthorized requesters)
        res.status(404).json({ error: 'Task not found' })
      }
    )

    // T1.1 — operator-triggered compaction. New scope
    // `host:compaction:invoke` keeps the surface tight; default-deny in the
    // JWT middleware means tokens without it get a 403.
    this.app.post(
      '/v1/runtime/compact',
      requireScope('host:compaction:invoke'),
      async (req, res) => {
        await handleCompactionRoute(req, res, this.routeDeps())
      }
    )

    // R2 — per-session model selector. Read (list allowlist + selection) and
    // write (set-model). Both behind the edge guard: rpc-proxy has already
    // enforced host:session:read / host:model:write scopes, and it injects the
    // verified edge user + hostRef the handlers scope the session lookup to.
    this.app.get('/v1/runtime/models', runtimeEdgeGuard(['rpc-proxy']), async (req, res) => {
      await handleModelsListRoute(req, res, this.routeDeps())
    })
    this.app.post('/v1/runtime/model', runtimeEdgeGuard(['rpc-proxy']), async (req, res) => {
      await handleSetModelRoute(req, res, this.routeDeps())
    })

    this.app.get('/v1/runtime/cron/results', runtimeEdgeGuard(['channel-reader']), (req, res) => {
      handleCronResultsRoute(req, res, this.routeDeps())
    })

    this.app.delete(
      '/v1/runtime/cron/results/:taskId',
      runtimeEdgeGuard(['channel-reader']),
      (req, res) => {
        handleCronResultAckRoute(req, res, req.params.taskId as string, this.routeDeps())
      }
    )

    this.app.get(
      '/v1/runtime/tasks/:taskId/progress/stream',
      runtimeEdgeGuard(['rpc-proxy', 'channel-reader', 'workflow-approval-request-reader']),
      async (req, res) => {
        await handleProgressStreamRoute(req, res, req.params.taskId as string, this.routeDeps())
      }
    )

    // ─── Runtime artifact endpoints (chat mode only) ─────────────────────
    const workflowMode = process.env.CLERUM_WORKFLOW_ENABLED === 'true'
    const rejectWorkflowRuntimeArtifacts = (
      _req: Request,
      res: Response,
      next: NextFunction
    ): void => {
      if (workflowMode) {
        json(res, 404, { error: 'Not found' })
        return
      }
      next()
    }

    this.app.get(
      '/v1/runtime/artifacts',
      rejectWorkflowRuntimeArtifacts,
      runtimeEdgeGuard(['rpc-proxy']),
      (_req, res) => {
        try {
          // Re-resolved per request: getOutputDir() depends on the Host CRD, which
          // hydrates async after boot — a captured value would freeze the path
          // (and point at the old /tmp emptyDir). D.2b.
          const artifactDir = getOutputDir()
          if (!fs.existsSync(artifactDir)) {
            json(res, 200, { artifacts: [] })
            return
          }
          const files = []
          for (const entry of fs.readdirSync(artifactDir, { withFileTypes: true })) {
            if (!entry.isFile() || isInternalWorkflowArtifactName(entry.name)) continue
            try {
              const artifact = resolveExistingArtifactFile(artifactDir, entry.name)
              const ext = path.extname(entry.name).replace('.', '').toLowerCase()
              files.push({
                name: entry.name,
                format: ext,
                sizeBytes: artifact.stat.size,
                createdAt: artifact.stat.mtime.toISOString(),
              })
            } catch (err) {
              if (err instanceof ArtifactPathError && err.status !== 500) continue
              throw err
            }
          }
          json(res, 200, { artifacts: files })
        } catch {
          json(res, 500, { error: 'Failed to list artifacts' })
        }
      }
    )

    this.app.get(
      '/v1/runtime/artifacts/:filename/download',
      rejectWorkflowRuntimeArtifacts,
      runtimeEdgeGuard(['rpc-proxy']),
      (req, res) => {
        const filename = req.params.filename as string
        if (isInternalWorkflowArtifactName(filename)) {
          json(res, 404, { error: 'Artifact not found' })
          return
        }
        const artifactDir = getOutputDir()
        let artifact: OpenedArtifactFile
        try {
          artifact = openExistingArtifactFile(artifactDir, filename)
        } catch (err) {
          if (err instanceof ArtifactPathError) {
            json(res, err.status, { error: err.message })
            return
          }
          json(res, 500, { error: 'Failed to read artifact' })
          return
        }
        const ext = path.extname(filename).toLowerCase()
        const contentTypes: Record<string, string> = {
          '.pdf': 'application/pdf',
          '.md': 'text/markdown',
          '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          '.png': 'image/png',
          '.html': 'text/html',
          '.txt': 'text/plain',
        }
        res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream')
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`
        )
        let fileBuffer: Buffer
        try {
          fileBuffer = readOpenedArtifactBuffer(artifact)
        } catch (err) {
          if (err instanceof ArtifactPathError) {
            json(res, err.status, { error: err.message })
            return
          }
          json(res, 500, { error: 'Failed to read artifact' })
          return
        } finally {
          try {
            fs.closeSync(artifact.fd)
          } catch {
            /* ignore close failure after the read outcome is known */
          }
        }
        const extName = ext.replace('.', '').toLowerCase()
        const { buffer: redactedBuffer, redactionState } = redactArtifactForDelivery(
          extName,
          fileBuffer,
          this.artifactSecretEntriesProvider?.() ?? []
        )
        res.setHeader('X-Clerum-Redaction', redactionState)
        res.setHeader('Content-Length', String(redactedBuffer.length))
        res.send(redactedBuffer)
      }
    )

    // The workflow service is attached after server construction in workflow mode.
    this.app.use('/api/v1/workflow', (req, res, next) => {
      if (!this.workflowRouter) {
        json(res, 503, { error: 'Not in workflow mode' })
        return
      }
      this.workflowRouter(req, res, next)
    })

    this.app.use((_req, res) => {
      json(res, 404, { error: 'Not found' })
    })
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  onStatus(handler: StatusHandler): void {
    this.statusHandler = handler
  }

  onApproval(handler: ApprovalHandler): void {
    this.approvalHandler = handler
  }

  onProviderWorkflowApprovalDecision(handler: ProviderWorkflowApprovalDecisionHandler): void {
    this.providerWorkflowApprovalDecisionHandler = handler
  }

  onProviderWorkflowApprovalResolve(handler: ProviderWorkflowApprovalResolveHandler): void {
    this.providerWorkflowApprovalResolveHandler = handler
  }

  onProviderWorkflowResultRequest(handler: ProviderWorkflowResultRequestHandler): void {
    this.providerWorkflowResultRequestHandler = handler
  }

  onProviderMessageAuthorization(handler: ProviderMessageAuthorizationHandler): void {
    this.providerMessageAuthorizationHandler = handler
  }

  onWorkflowApprovalNotificationClaim(handler: WorkflowApprovalNotificationClaimHandler): void {
    this.workflowApprovalNotificationClaimHandler = handler
  }

  onWorkflowApprovalNotificationTerminal(
    handler: WorkflowApprovalNotificationTerminalHandler
  ): void {
    this.workflowApprovalNotificationTerminalHandler = handler
  }

  onWorkflowApprovalMediumEnrollment(handler: WorkflowApprovalMediumEnrollmentHandler): void {
    this.workflowApprovalMediumEnrollmentHandler = handler
  }

  onTelegramWorkflowApprovalVerification(
    handler: TelegramWorkflowApprovalVerificationHandler
  ): void {
    this.telegramWorkflowApprovalVerificationHandler = handler
  }

  onActivitySnapshot(handler: ActivitySnapshotHandler): void {
    this.activitySnapshotHandler = handler
  }

  onActivityStream(handler: ActivityStreamHandler): void {
    this.activityStreamHandler = handler
  }

  onTaskResult(handler: TaskResultHandler): void {
    this.taskResultHandler = handler
  }

  onCronResults(handler: CronResultsHandler): void {
    this.cronResultsHandler = handler
  }

  onCronResultAck(handler: CronResultAckHandler): void {
    this.cronResultAckHandler = handler
  }

  onProgressStream(handler: ProgressStreamHandler): void {
    this.progressStreamHandler = handler
  }

  onCancel(handler: CancelHandler): void {
    this.cancelHandler = handler
  }

  onSessionsList(handler: SessionsListHandler): void {
    this.sessionsListHandler = handler
  }

  onSessionMessages(handler: SessionMessagesHandler): void {
    this.sessionMessagesHandler = handler
  }

  onContextBreakdown(handler: ContextBreakdownHandler): void {
    this.contextBreakdownHandler = handler
  }

  onSessionSearch(handler: SessionSearchHandler): void {
    this.sessionSearchHandler = handler
  }

  onCompaction(handler: CompactionHandler): void {
    this.compactionHandler = handler
  }

  onModelsList(handler: ModelsListHandler): void {
    this.modelsListHandler = handler
  }

  onSetModel(handler: SetModelHandler): void {
    this.setModelHandler = handler
  }

  /** Activate workflow mode — mounts /api/v1/workflow/* routes. */
  setWorkflowService(service: WorkflowService): void {
    this.workflowRouter = createWorkflowRouter(service)
  }

  setArtifactSecretEntriesProvider(provider: () => ArtifactSecretEntry[]): void {
    this.artifactSecretEntriesProvider = provider
  }

  /** Stage 3 (stateless-agents) — wire the DRAINING fence + activity tracker
   *  consulted by the POST /v1/runtime/messages route. */
  setLifecycleGate(gate: RuntimeLifecycleGate): void {
    this.lifecycleGate = gate
  }

  private routeDeps() {
    return {
      messageHandler: this.messageHandler,
      statusHandler: this.statusHandler,
      approvalHandler: this.approvalHandler,
      providerWorkflowApprovalDecisionHandler: this.providerWorkflowApprovalDecisionHandler,
      providerWorkflowApprovalResolveHandler: this.providerWorkflowApprovalResolveHandler,
      providerWorkflowResultRequestHandler: this.providerWorkflowResultRequestHandler,
      providerMessageAuthorizationHandler: this.providerMessageAuthorizationHandler,
      workflowApprovalNotificationClaimHandler: this.workflowApprovalNotificationClaimHandler,
      workflowApprovalNotificationTerminalHandler: this.workflowApprovalNotificationTerminalHandler,
      workflowApprovalMediumEnrollmentHandler: this.workflowApprovalMediumEnrollmentHandler,
      telegramWorkflowApprovalVerificationHandler: this.telegramWorkflowApprovalVerificationHandler,
      activitySnapshotHandler: this.activitySnapshotHandler,
      activityStreamHandler: this.activityStreamHandler,
      taskResultHandler: this.taskResultHandler,
      cronResultsHandler: this.cronResultsHandler,
      cronResultAckHandler: this.cronResultAckHandler,
      progressStreamHandler: this.progressStreamHandler ?? undefined,
      sessionsListHandler: this.sessionsListHandler,
      sessionMessagesHandler: this.sessionMessagesHandler,
      contextBreakdownHandler: this.contextBreakdownHandler,
      sessionSearchHandler: this.sessionSearchHandler,
      compactionHandler: this.compactionHandler,
      modelsListHandler: this.modelsListHandler,
      setModelHandler: this.setModelHandler,
    }
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port)

      this.server.on('error', err => {
        console.error('[Server] Error:', err)
        reject(err)
      })

      this.server.on('listening', () => {
        console.log(`[Server] RPC server listening on port ${this.port}`)
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    return new Promise(resolve => {
      if (!this.server) {
        resolve()
        return
      }
      this.server.close(() => {
        console.log('[Server] RPC server stopped')
        resolve()
      })
    })
  }
}
