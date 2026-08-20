import express, { type Express, type Request, type Response } from 'express'
import { createServer, type Server } from 'node:http'
import { Registry, collectDefaultMetrics } from 'prom-client'
import { z } from 'zod'
import { verifyAdminPermit } from './auth/adminPermitVerifier.js'
import { verifyExecutionTicket } from './auth/executionTicketVerifier.js'
import { verifyPlatformJwt } from './auth/platformJwtVerifier.js'
import type { CodexLlmProxyConfig } from './config.js'
import { logger } from './logger.js'

const COMPLETION_KEYS = new Set([
  'executionTicket',
  'requestHash',
  'request',
  'deadlineMs',
])

const completionBodySchema = z
  .object({
    executionTicket: z.string().min(1),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    request: z.object({}).passthrough(),
    deadlineMs: z.number().int().positive().optional(),
  })
  .strict()

function bearer(req: Request): string {
  const raw = String(req.header('authorization') || '')
  return raw.replace(/^bearer\s+/i, '').trim()
}

function reject(res: Response, status: number, code: string): void {
  logger.warn({ event: 'codex_proxy_denied', code }, 'request denied')
  res.status(status).json({ error: code })
}

function boundedErrorHandler(err: unknown, _req: Request, res: Response, _next: () => void): void {
  const typed = err as { type?: string; status?: number }
  if (typed?.type === 'entity.too.large' || typed?.status === 413) {
    reject(res, 413, 'payload_too_large')
    return
  }
  if (err instanceof SyntaxError) {
    reject(res, 400, 'invalid_request')
    return
  }
  logger.error({ event: 'codex_proxy_error', err }, 'unhandled request error')
  reject(res, 500, 'internal_error')
}

export type ProxyServers = {
  runtime: Server
  admin: Server
  probe: Server
  runtimeApp: Express
  adminApp: Express
  probeApp: Express
  close: () => Promise<void>
}

export function createProxyApps(config: CodexLlmProxyConfig): ProxyServers {
  const metrics = new Registry()
  collectDefaultMetrics({ register: metrics })

  const runtimeApp = express()
  runtimeApp.use(express.json({ limit: config.maxBodyBytes }))
  runtimeApp.post('/internal/runtime/v1/codex/completions', (req, res) => {
    if (!req.is('application/json')) {
      reject(res, 415, 'unsupported_media_type')
      return
    }
    if (verifyAdminPermit(bearer(req), config)) {
      reject(res, 403, 'insufficient_scope')
      return
    }
    const platform = verifyPlatformJwt(bearer(req), config)
    if (!platform) {
      reject(res, 401, 'Unauthorized')
      return
    }
    const extra = Object.keys(req.body ?? {}).find(key => !COMPLETION_KEYS.has(key))
    if (extra) {
      reject(res, 400, 'unknown_field')
      return
    }
    const parsed = completionBodySchema.safeParse(req.body)
    if (!parsed.success) {
      reject(res, 400, 'invalid_request')
      return
    }
    if (parsed.data.deadlineMs !== undefined && parsed.data.deadlineMs > config.maxDeadlineMs) {
      reject(res, 400, 'invalid_request')
      return
    }
    const ticket = verifyExecutionTicket(parsed.data.executionTicket, config)
    if (!ticket) {
      reject(res, 403, 'ticket_invalid')
      return
    }
    if (!config.executionEnabled) {
      reject(res, 404, 'disabled')
      return
    }
    reject(res, 503, 'provider_unavailable')
  })
  runtimeApp.use((_req, res) => reject(res, 404, 'not_found'))
  runtimeApp.use(boundedErrorHandler)

  const adminApp = express()
  adminApp.use(express.json({ limit: config.maxBodyBytes }))
  const adminHandler = (req: Request, res: Response) => {
    if (!req.is('application/json')) {
      reject(res, 415, 'unsupported_media_type')
      return
    }
    if (verifyExecutionTicket(bearer(req), config)) {
      reject(res, 403, 'insufficient_scope')
      return
    }
    if (!verifyAdminPermit(bearer(req), config)) {
      reject(res, 401, 'Unauthorized')
      return
    }
    if (!config.executionEnabled) {
      reject(res, 404, 'disabled')
      return
    }
    reject(res, 503, 'provider_unavailable')
  }
  adminApp.post('/internal/admin/v1/codex/models', adminHandler)
  adminApp.post('/internal/admin/v1/codex/test', adminHandler)
  adminApp.use((_req, res) => reject(res, 404, 'not_found'))
  adminApp.use(boundedErrorHandler)

  const probeApp = express()
  probeApp.get('/healthz', (_req, res) => res.status(200).json({ ok: true }))
  probeApp.get('/readyz', (_req, res) => res.status(200).json({ ok: true }))
  probeApp.get('/metrics', async (_req, res) => {
    res.set('content-type', metrics.contentType)
    res.status(200).send(await metrics.metrics())
  })
  probeApp.use((_req, res) => reject(res, 404, 'not_found'))

  const runtime = createServer(runtimeApp)
  const admin = createServer(adminApp)
  const probe = createServer(probeApp)

  return {
    runtime,
    admin,
    probe,
    runtimeApp,
    adminApp,
    probeApp,
    close: async () => {
      await Promise.all([runtime, admin, probe].map(server => closeServer(server)))
    },
  }
}

export function startProxy(config: CodexLlmProxyConfig): ProxyServers {
  const servers = createProxyApps(config)
  servers.runtime.listen(config.runtimePort)
  servers.admin.listen(config.adminPort)
  servers.probe.listen(config.probePort)
  logger.info(
    {
      event: 'codex_proxy_listen',
      runtimePort: config.runtimePort,
      adminPort: config.adminPort,
      probePort: config.probePort,
    },
    'codex-llm-proxy listeners ready'
  )
  return servers
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve())
  })
}
