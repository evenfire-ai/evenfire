import { Router } from 'express'
import type { Response } from 'express'
import { config } from '../../config.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { K8sGateway } from '../../k8s.js'
import type { UiAuthedRequest } from '../../middleware/controlUIAuth.js'

type PersonalizationFields = {
  identity: string
  soul: string
  agents: string
  user: string
}

type HostResource = {
  metadata?: {
    annotations?: Record<string, string>
    labels?: Record<string, string>
    name?: string
    namespace?: string
    resourceVersion?: string
  }
  spec?: { personalization?: Partial<PersonalizationFields> } & Record<string, unknown>
}

const ALLOWED_PUT_KEYS = new Set(['agents', 'identity', 'resourceVersion', 'soul', 'user'])

function fieldsFromHost(host: {
  spec?: { personalization?: Partial<PersonalizationFields> }
}): PersonalizationFields {
  const p = host.spec?.personalization ?? {}
  return {
    identity: p.identity ?? '',
    soul: p.soul ?? '',
    agents: p.agents ?? '',
    user: p.user ?? '',
  }
}

function isK8sNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  return (err as { code?: number }).code === 404
}

function isK8sConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  return (err as { code?: number }).code === 409
}

function auditLog(action: string, details: Record<string, unknown>): void {
  console.log(`[admin-audit] ${action}`, JSON.stringify(details))
}

export function createAdminPersonalizationRouter(gateway: K8sGateway): Router {
  const router = Router()

  // Auth is enforced by the parent /api/v1/admin middleware in app.ts.
  router.get(
    '/admin/hosts/:hostRef/personalization',
    asyncHandler(async (req: UiAuthedRequest, res: Response) => {
      const { hostRef } = req.params
      try {
        const host = (await gateway.getResource(
          'hosts',
          hostRef,
          config.hostsNamespace
        )) as HostResource
        const resourceVersion = host.metadata?.resourceVersion
        if (!resourceVersion) {
          res.status(500).json({ error: 'host resourceVersion is missing' })
          return
        }
        res.status(200).json({
          ...fieldsFromHost(host),
          resourceVersion,
        })
      } catch (err) {
        if (isK8sNotFound(err)) {
          res.status(404).json({ error: 'host not found' })
          return
        }
        throw err
      }
    })
  )

  const FIELD_MAX = 64 * 1024 // 64 KiB per field
  const TOTAL_MAX = 256 * 1024 // 256 KiB total — guards the post-merge result; reachable when existing fields are large

  router.put(
    '/admin/hosts/:hostRef/personalization',
    asyncHandler(async (req: UiAuthedRequest, res: Response) => {
      const { hostRef } = req.params
      const body = (req.body ?? {}) as Partial<PersonalizationFields> & { resourceVersion?: string }

      const unknownKeys = Object.keys(body).filter(key => !ALLOWED_PUT_KEYS.has(key))
      if (unknownKeys.length > 0) {
        res.status(400).json({ error: `unknown field(s): ${unknownKeys.join(', ')}` })
        return
      }

      if (!body.resourceVersion || typeof body.resourceVersion !== 'string') {
        res.status(400).json({ error: 'resourceVersion is required' })
        return
      }

      // Per-field size check (only on fields the caller actually provided)
      for (const key of ['identity', 'soul', 'agents', 'user'] as const) {
        const v = body[key]
        if (typeof v === 'string' && Buffer.byteLength(v, 'utf8') > FIELD_MAX) {
          res.status(413).json({ error: `${key} exceeds 64 KiB limit` })
          return
        }
      }

      // Read current host (for omitted-field preservation)
      let host: HostResource
      try {
        host = (await gateway.getResource('hosts', hostRef, config.hostsNamespace)) as HostResource
      } catch (err) {
        if (isK8sNotFound(err)) {
          res.status(404).json({ error: 'host not found' })
          return
        }
        throw err
      }

      const currentSpec = (host.spec ?? {}) as Record<string, unknown>
      const currentP = (currentSpec.personalization ?? {}) as Partial<PersonalizationFields> & {
        enabled?: boolean
      }
      const merged = {
        // Preserve current enabled value; default true on first write so a fresh
        // personalization save activates reconciliation. Admins who explicitly set
        // enabled=false via kubectl retain that state across UI saves.
        enabled: currentP.enabled ?? true,
        identity: typeof body.identity === 'string' ? body.identity : (currentP.identity ?? ''),
        soul: typeof body.soul === 'string' ? body.soul : (currentP.soul ?? ''),
        agents: typeof body.agents === 'string' ? body.agents : (currentP.agents ?? ''),
        user: typeof body.user === 'string' ? body.user : (currentP.user ?? ''),
      }

      const total =
        Buffer.byteLength(merged.identity, 'utf8') +
        Buffer.byteLength(merged.soul, 'utf8') +
        Buffer.byteLength(merged.agents, 'utf8') +
        Buffer.byteLength(merged.user, 'utf8')
      if (total > TOTAL_MAX) {
        res.status(413).json({ error: 'total personalization size exceeds 256 KiB' })
        return
      }

      const newSpec = { ...currentSpec, personalization: merged }
      const namespace = host.metadata?.namespace ?? config.hostsNamespace

      let result: { metadata?: { resourceVersion?: string } }
      try {
        result = await gateway.replaceHost({
          metadata: {
            annotations: host.metadata?.annotations,
            labels: host.metadata?.labels,
            name: hostRef,
            namespace,
            resourceVersion: body.resourceVersion,
          },
          spec: newSpec,
        })
      } catch (err) {
        if (isK8sConflict(err)) {
          res.status(409).json({ error: 'resourceVersion mismatch — reload to see latest' })
          return
        }
        if (isK8sNotFound(err)) {
          res.status(404).json({ error: 'host not found' })
          return
        }
        throw err
      }

      const providedFields = (['identity', 'soul', 'agents', 'user'] as const).filter(
        k => typeof body[k] === 'string'
      )
      auditLog('personalization_updated', {
        hostRef,
        namespace,
        fields: providedFields,
        userId: req.adminAuth?.sub ?? null,
        byteCount: total,
      })

      res.status(200).json({ resourceVersion: result.metadata?.resourceVersion ?? '' })
    })
  )

  return router
}
