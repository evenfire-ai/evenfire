/**
 * MCP Server — StreamableHTTP on :port/mcp/v1.
 *
 * Follows the pattern from tests/e2e/fixtures/mock-mcp-server/src/index.ts
 * with session management and health endpoint.
 *
 * Source of truth: PHASE-4-MCP-SERVER-INTERFACE.md §5.3
 */
import * as k8s from '@kubernetes/client-node'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import http from 'node:http'
import { z } from 'zod/v3'
import { WorkflowRecipeProvider } from '../k8sClient'
import { registry } from '../metrics'
import { HttpMcpHostClient } from '../workflow/httpMcpHostClient'
import { JwtTokenFactory } from '../workflow/jwtTokenFactory'
import { K8sSecretReaderImpl } from '../workflow/k8sSecretReaderImpl'
import { ModelConfigHandler, type PluginSdkCredentialTarget } from '../workflow/modelConfigHandler'
import { createWorkflowEndpointHandlers, verifyIncomingToken } from '../workflow/restEndpoints'
import {
  verifyPluginSdkBrokerCallerToken,
  verifyPluginSdkCredentialTicket,
} from '../workflow/workflowAuth'
import {
  CallerIdentity,
  handleDeleteRecipe,
  handleDeployRecipe,
  handleGetRecipeStatus,
  handleListPolicies,
  handleListRecipes,
  handleRollbackRecipe,
  handleSearchRegistry,
  handleValidateRecipe,
} from './handlers'

const MAX_SESSIONS = 100
// Status reports can include full step output (research steps produce 50-200KB).
// Previous 64KB limit caused `req.destroy()` → coordinator received `socket hang up`
// instead of a proper 413 response, triggering false step retries.
const MAX_BODY_BYTES = 512 * 1024 // 512KB
const CONTROL_API_BASE_URL =
  process.env.CONTROL_API_BASE_URL || 'http://control-api.control-plane.svc.cluster.local:8090'

export async function revalidatePluginSdkCredentialTicket(input: {
  runtimeToken: string
  credentialTicket: string
  invocationId: string
  targetRef: string
  /** Consume the control-plane jti after the Secret read, not during preflight. */
  redeem?: boolean
  fetchImpl?: typeof fetch
  controlApiBaseUrl?: string
}): Promise<boolean> {
  const fetchImpl = input.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(
      `${(input.controlApiBaseUrl ?? CONTROL_API_BASE_URL).replace(/\/+$/, '')}/api/v1/mcp-host/plugin-workload-sdk/credential-ticket/introspect`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${input.runtimeToken}`,
        },
        body: JSON.stringify({
          credentialTicket: input.credentialTicket,
          invocationId: input.invocationId,
          targetRef: input.targetRef,
          ...(input.redeem ? { redeem: true } : {}),
        }),
      }
    )
    if (!response.ok) return false
    const body = (await response.json().catch(() => null)) as { active?: unknown } | null
    return body?.active === true
  } catch {
    return false
  }
}

type ParseResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; reason: 'too_large' | 'invalid_json' | 'stream_error' }

function parseJsonBody(req: http.IncomingMessage): Promise<ParseResult> {
  return new Promise(resolve => {
    let data = ''
    let size = 0
    let settled = false
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        settled = true
        resolve({ ok: false, reason: 'too_large' })
        req.destroy()
        return
      }
      data += chunk.toString()
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      try {
        resolve({ ok: true, body: JSON.parse(data) })
      } catch {
        resolve({ ok: false, reason: 'invalid_json' })
      }
    })
    req.on('error', () => {
      if (!settled) {
        settled = true
        resolve({ ok: false, reason: 'stream_error' })
      }
    })
  })
}

export class ClerumMcpServer {
  private httpServer: http.Server | null = null
  private sessions: Map<string, StreamableHTTPServerTransport> = new Map()
  /** One-shot broker redemption cache; tickets are short-lived (60s). */
  private readonly consumedPluginSdkTicketJtis = new Map<string, number>()
  private provider: WorkflowRecipeProvider
  private port: number
  private customApi: k8s.CustomObjectsApi
  private namespace: string
  private sandboxNamespace: string
  private workflowHandlers: ReturnType<typeof createWorkflowEndpointHandlers> | null = null
  private modelConfigHandler: ModelConfigHandler | null
  private tokenFactory: JwtTokenFactory | null

  constructor(
    provider: WorkflowRecipeProvider,
    port: number,
    customApi: k8s.CustomObjectsApi,
    namespace: string,
    kc?: k8s.KubeConfig,
    sandboxNamespace = 'sandbox-recipes',
    tokenFactory?: JwtTokenFactory
  ) {
    this.provider = provider
    this.port = port
    this.customApi = customApi
    this.namespace = namespace
    this.sandboxNamespace = sandboxNamespace
    this.tokenFactory = tokenFactory ?? null

    // Wire ModelConfigHandler DI — K8sSecretReader + McpHostClient
    const coreApi = kc ? kc.makeApiClient(k8s.CoreV1Api) : null
    const k8sReader = coreApi ? new K8sSecretReaderImpl(coreApi) : null
    const mcpHostClient = new HttpMcpHostClient()
    // Handler requires K8sSecretReader; if unavailable (dev mode), configureModel returns 501
    this.modelConfigHandler = k8sReader ? new ModelConfigHandler(k8sReader, mcpHostClient) : null
  }

  private consumePluginSdkTicket(jti: string): boolean {
    const now = Date.now()
    for (const [entry, expiresAt] of this.consumedPluginSdkTicketJtis) {
      if (expiresAt <= now) this.consumedPluginSdkTicketJtis.delete(entry)
    }
    const existing = this.consumedPluginSdkTicketJtis.get(jti)
    if (existing !== undefined && existing > now) return false
    // Keep the cache bounded even if a compromised host floods distinct
    // signed tickets within their TTL.
    if (this.consumedPluginSdkTicketJtis.size >= 10_000) {
      const oldest = this.consumedPluginSdkTicketJtis.keys().next().value
      if (typeof oldest === 'string') this.consumedPluginSdkTicketJtis.delete(oldest)
    }
    this.consumedPluginSdkTicketJtis.set(jti, now + 60_000)
    return true
  }

  private createMcpServer(): McpServer {
    const server = new McpServer({
      name: 'workflow-recipes',
      version: '0.1.0',
    })

    const provider = this.provider

    // Identity headers are extracted from the HTTP request before
    // the MCP transport processes it. For unit-testable handlers,
    // we pass a default identity here — real header validation
    // happens at the HTTP layer in production (Phase 5+).
    const defaultIdentity: CallerIdentity = { agentId: 'unknown', contextRef: 'unknown' }

    server.tool(
      'deploy_recipe',
      'Deploy a WorkflowRecipe (optional version for registry)',
      {
        recipe_name: z.string().describe('Name of the WorkflowRecipe to deploy'),
        namespace: z.string().optional().describe('Target namespace'),
        version: z.string().optional().describe('Specific version from registry'),
      },
      async ({
        recipe_name,
        namespace,
        version,
      }: {
        recipe_name: string
        namespace?: string
        version?: string
      }) => {
        return handleDeployRecipe(
          { recipe_name, namespace, version },
          provider,
          defaultIdentity,
          this.namespace
        )
      }
    )

    server.tool(
      'list_recipes',
      'List all WorkflowRecipes with optional status filter',
      {
        status_filter: z.string().optional().describe('Filter by recipe phase'),
      },
      async ({ status_filter }: { status_filter?: string }) => {
        return handleListRecipes({ status_filter }, provider)
      }
    )

    server.tool(
      'get_recipe_status',
      'Get detailed status of a WorkflowRecipe',
      {
        name: z.string().describe('Name of the WorkflowRecipe'),
      },
      async ({ name }: { name: string }) => {
        return handleGetRecipeStatus({ name }, provider)
      }
    )

    server.tool(
      'rollback_recipe',
      'Trigger rollback on a WorkflowRecipe',
      {
        name: z.string().describe('Name of the WorkflowRecipe to rollback'),
        version: z.number().optional().describe('Target version to rollback to'),
      },
      async ({ name, version }: { name: string; version?: number }) => {
        return handleRollbackRecipe({ name, version }, provider)
      }
    )

    server.tool(
      'delete_recipe',
      'Delete a WorkflowRecipe and its managed resources',
      {
        name: z.string().describe('Name of the WorkflowRecipe to delete'),
      },
      async ({ name }: { name: string }) => {
        return handleDeleteRecipe({ name }, provider)
      }
    )

    server.tool(
      'validate_recipe',
      'Validate WorkflowRecipe YAML without deploying',
      {
        recipe_yaml: z.string().describe('WorkflowRecipe JSON string to validate'),
      },
      async ({ recipe_yaml }: { recipe_yaml: string }) => {
        return handleValidateRecipe({ recipe_yaml })
      }
    )

    server.tool(
      'search_registry',
      'Search the WorkflowRecipe registry',
      {
        query: z.string().optional().describe('Search query'),
        category: z.string().optional().describe('Filter by category'),
      },
      async ({ query, category }: { query?: string; category?: string }) => {
        return handleSearchRegistry({ query, category })
      }
    )

    const customApi = this.customApi
    const namespace = this.namespace

    server.tool('list_policies', 'List active WorkflowRecipePolicies', {}, async () => {
      return handleListPolicies(customApi, namespace)
    })

    return server
  }

  private async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const url = req.url ?? ''
    const sessions = this.sessions

    // Health endpoint
    if (url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }

    // Prometheus metrics
    if (url === '/metrics' && req.method === 'GET') {
      const metrics = await registry.metrics()
      res.writeHead(200, { 'Content-Type': registry.contentType })
      res.end(metrics)
      return
    }

    // MCP endpoint
    if (url === '/mcp/v1') {
      if (req.method === 'POST') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined

        if (sessionId && sessions.has(sessionId)) {
          const transport = sessions.get(sessionId)!
          await transport.handleRequest(req, res)
        } else {
          // Reject if session limit reached — prevents unbounded memory growth
          if (sessions.size >= MAX_SESSIONS) {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Too many active sessions', limit: MAX_SESSIONS }))
            return
          }

          // Create a NEW McpServer per session — the SDK requires one
          // connect() per McpServer lifetime (#MCP-SDK constraint).
          const sessionMcp = this.createMcpServer()
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
          await sessionMcp.connect(transport)
          await transport.handleRequest(req, res)

          const newSessionId = (transport as unknown as { sessionId?: string }).sessionId
          if (newSessionId) {
            sessions.set(newSessionId, transport)

            transport.onclose = () => {
              sessions.delete(newSessionId)
              sessionMcp.close().catch(() => {
                /* best-effort cleanup */
              })
              console.log(`[MCP-Server] Session ${newSessionId} closed (${sessions.size} active)`)
            }

            console.log(`[MCP-Server] New session ${newSessionId} (${sessions.size} active)`)
          }
        }
        return
      }

      if (req.method === 'DELETE') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined
        if (sessionId && sessions.has(sessionId)) {
          const transport = sessions.get(sessionId)!
          await transport.handleRequest(req, res)
          sessions.delete(sessionId)
        } else {
          res.writeHead(404)
          res.end()
        }
        return
      }
    }

    // ─── Workflow REST API (/api/v1/workflow/:name/...) ──────────────
    const workflowMatch = url.match(/^\/api\/v1\/workflow\/([^/]+)(\/.*)?$/)
    if (workflowMatch) {
      const recipeName = decodeURIComponent(workflowMatch[1])
      const subPath = workflowMatch[2] ?? ''

      // SEC: validate recipeName matches K8s RFC 1123 DNS label format before any API call.
      // Prevents Host header injection and path traversal via crafted recipe names.
      if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(recipeName)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid recipe name format' }))
        return
      }

      // Plugin Workload SDK credential broker. This route deliberately uses a
      // different audience from the workflow REST API: an mcp-host runtime JWT
      // authenticates the caller and a second short-lived signed ticket binds
      // the exact target that control-api already authorized.
      // lgtm[js/user-controlled-bypass]
      // The request path only selects the handler. Before any Secret read, the
      // handler verifies the JWT issuer/audience/scope, binds the token claims
      // to the server-owned namespace and recipe, and then validates the
      // signed invocation/target ticket against the current control-api policy.
      if (req.method === 'POST' && subPath === '/plugin-workload-sdk/credentials') {
        const authHeader = req.headers.authorization
        const runtimeToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : ''
        let callerClaims
        try {
          callerClaims = await verifyPluginSdkBrokerCallerToken(runtimeToken)
        } catch {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Unauthorized' }))
          return
        }
        if (
          callerClaims.recipeName !== recipeName ||
          callerClaims.recipeNamespace !== this.sandboxNamespace ||
          !callerClaims.workflowControlScopes.includes('plugin-workload-sdk')
        ) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Credential broker scope denied' }))
          return
        }

        const parseResult = await parseJsonBody(req)
        if (!parseResult.ok) {
          res.writeHead(parseResult.reason === 'too_large' ? 413 : 400, {
            'Content-Type': 'application/json',
          })
          res.end(JSON.stringify({ error: 'Invalid credential broker request' }))
          return
        }
        const body = parseResult.body
        const target = body.target as PluginSdkCredentialTarget | undefined
        if (
          body.recipeNamespace !== this.sandboxNamespace ||
          typeof body.invocationId !== 'string' ||
          !target ||
          typeof target.targetRef !== 'string' ||
          typeof target.provider !== 'string' ||
          typeof target.model !== 'string' ||
          typeof target.credentialSlot !== 'string' ||
          typeof body.credentialTicket !== 'string'
        ) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid credential broker request' }))
          return
        }

        let ticket
        try {
          ticket = await verifyPluginSdkCredentialTicket(body.credentialTicket)
        } catch {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Credential ticket denied' }))
          return
        }
        const ticketMatches =
          ticket.recipeName === recipeName &&
          ticket.recipeNamespace === this.sandboxNamespace &&
          ticket.invocationId === body.invocationId &&
          ticket.targetRef === target.targetRef &&
          ticket.provider === target.provider &&
          ticket.model === target.model &&
          ticket.credentialSlot === target.credentialSlot
        if (!ticketMatches) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Credential ticket denied' }))
          return
        }
        // The request body is only an equality check. Once the signed ticket
        // is verified, use its claims as the sole identity passed to the
        // Secret resolver and to all subsequent policy revalidation calls.
        const boundInvocationId = ticket.invocationId
        const boundTarget: PluginSdkCredentialTarget = {
          targetRef: ticket.targetRef,
          provider: ticket.provider,
          model: ticket.model,
          credentialSlot: ticket.credentialSlot,
        }
        // TOCTOU gate: ticket signature proves what was authorized, while this
        // control-api read proves that the invocation and policy revision/hash
        // are still current immediately before the Secret lookup.
        const ticketStillActive = await revalidatePluginSdkCredentialTicket({
          runtimeToken,
          credentialTicket: body.credentialTicket,
          invocationId: boundInvocationId,
          targetRef: boundTarget.targetRef,
        })
        if (!ticketStillActive) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Credential ticket denied' }))
          return
        }
        if (!this.modelConfigHandler) {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Credential broker unavailable' }))
          return
        }
        const result = await this.modelConfigHandler.resolvePluginSdkCredential(boundTarget)
        // Re-check after the Secret read as well as before it.  Control API
        // and the WRC Secret store are separate systems, so a single remote
        // check cannot be atomic with the read; the post-read gate ensures a
        // revocation observed during resolution never returns credentials.
        if (result.status === 200) {
          const ticketStillActiveAfterResolve = await revalidatePluginSdkCredentialTicket({
            runtimeToken,
            credentialTicket: body.credentialTicket,
            invocationId: boundInvocationId,
            targetRef: boundTarget.targetRef,
            redeem: true,
          })
          if (!ticketStillActiveAfterResolve) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Credential ticket denied' }))
            return
          }
          if (!this.consumePluginSdkTicket(ticket.jti)) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Credential ticket denied' }))
            return
          }
        }
        res.writeHead(result.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result.body))
        return
      }

      // JWT authentication — dual-issuer aware (clerum-wrc OR control-api)
      const authHeader = req.headers.authorization
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : ''
      let claims
      try {
        claims = await verifyIncomingToken(token)
      } catch (authErr) {
        console.error(
          `[WRC-AUTH] Token verification failed for ${req.method} ${url}:`,
          authErr instanceof Error ? authErr.message : authErr
        )
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }

      if (!this.workflowHandlers) {
        this.workflowHandlers = createWorkflowEndpointHandlers(
          this.customApi,
          this.sandboxNamespace,
          this.tokenFactory ?? undefined,
          { traceReporter: this.provider.getTraceReporter() }
        )
      }
      const handlers = this.workflowHandlers

      // GET /api/v1/workflow/:name/artifacts/:filename — admin artifact download proxy
      const artifactMatch = subPath.match(/^\/artifacts\/([^/]+)$/)
      if (req.method === 'GET' && artifactMatch) {
        const filename = decodeURIComponent(artifactMatch[1])
        const result = await handlers.getArtifact(recipeName, filename, claims)
        if (result.status === 200 && Buffer.isBuffer(result.body)) {
          res.writeHead(200, result.headers ?? { 'Content-Type': 'application/octet-stream' })
          res.end(result.body)
        } else {
          res.writeHead(result.status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result.body))
        }
        return
      }

      // DELETE /api/v1/workflow/:name/artifacts/:filename — admin single file delete
      if (req.method === 'DELETE' && artifactMatch) {
        const filename = decodeURIComponent(artifactMatch[1])
        const result = await handlers.deleteArtifactFile(recipeName, filename, claims)
        res.writeHead(result.status, { 'Content-Type': 'application/json' })
        res.end(result.status === 204 ? '' : JSON.stringify(result.body))
        return
      }

      // DELETE /api/v1/workflow/:name/artifacts — admin bulk delete
      if (req.method === 'DELETE' && subPath === '/artifacts') {
        const result = await handlers.deleteArtifact(recipeName, claims)
        res.writeHead(result.status, { 'Content-Type': 'application/json' })
        res.end(result.status === 204 ? '' : JSON.stringify(result.body))
        return
      }

      // GET /api/v1/workflow/:name/status
      if (req.method === 'GET' && subPath === '/status') {
        const result = await handlers.getWorkflowStatus(recipeName, claims)
        res.writeHead(result.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result.body))
        return
      }

      // GET /api/v1/workflow/:name/health
      if (req.method === 'GET' && subPath === '/health') {
        const result = await handlers.getHealth(recipeName, claims)
        res.writeHead(result.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result.body))
        return
      }

      // GET /api/v1/workflow/:name/signals
      if (req.method === 'GET' && subPath === '/signals') {
        const result = await handlers.getSignals(recipeName, claims)
        res.writeHead(result.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result.body))
        return
      }

      // POST endpoints — parse body
      if (req.method === 'POST') {
        const parseResult = await parseJsonBody(req)
        if (!parseResult.ok) {
          const status = parseResult.reason === 'too_large' ? 413 : 400
          const error =
            parseResult.reason === 'too_large' ? 'Request body too large' : 'Invalid JSON body'
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error }))
          return
        }
        const body = parseResult.body

        // POST /api/v1/workflow/:name/status
        if (subPath === '/status') {
          const result = await handlers.postStepStatus(recipeName, claims, body as never)
          res.writeHead(result.status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result.body))
          return
        }

        // POST /api/v1/workflow/:name/configure-model
        if (subPath === '/configure-model') {
          // Token factory injected at construction signs a fresh WRC→mcp-host
          // configure token per call inside handlers.configureModel — no store.
          const result = await handlers.configureModel(
            recipeName,
            claims,
            body as never,
            this.modelConfigHandler ?? undefined
          )
          res.writeHead(result.status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result.body))
          return
        }

        // POST /api/v1/workflow/:name/injections/model
        if (subPath === '/injections/model') {
          const result = await handlers.requestModelInjection(
            recipeName,
            claims,
            body as never,
            this.modelConfigHandler ?? undefined
          )
          res.writeHead(result.status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result.body))
          return
        }
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  }

  async start(): Promise<void> {
    this.httpServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res).catch((error: unknown) => {
        console.error('[MCP-Server] Unhandled error in request handler:', error)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Internal server error' }))
        }
      })
    })

    return new Promise<void>(resolve => {
      this.httpServer!.listen(this.port, () => {
        console.log(`[MCP-Server] Listening on :${this.port}`)
        console.log(`[MCP-Server] MCP endpoint: POST /mcp/v1`)
        console.log(`[MCP-Server] Health endpoint: GET /health`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    for (const [id, transport] of this.sessions) {
      try {
        await transport.close()
      } catch {
        // Ignore close errors during shutdown
      }
      this.sessions.delete(id)
    }

    return new Promise<void>(resolve => {
      if (this.httpServer) {
        this.httpServer.close(() => {
          console.log('[MCP-Server] HTTP server closed')
          resolve()
        })
      } else {
        resolve()
      }
    })
  }

  getSessionCount(): number {
    return this.sessions.size
  }
}
