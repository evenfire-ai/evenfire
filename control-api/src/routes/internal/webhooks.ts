import { Router } from 'express'
import { config } from '../../config.js'
import { K8sGateway } from '../../k8s.js'
import {
  requireInternalService,
  requireInternalToken,
} from '../../middleware/internalServiceAuth.js'
import { K8sNotFoundError } from '../../services/resourceService.js'

/**
 * Registry lookup for the webhook-proxy public ingress.
 *
 * Wire shape (mirrors spec §10.2):
 *   GET /api/v1/internal/webhook/registry/:recipeNs/:recipeName/:webhookId
 *   Auth: webhook-proxy → control-api internal service token
 *
 * 200 OK:
 *   { exists: true, methods: ['POST'], maxBodyBytes: 1048576,
 *     gateway: { service: 'wf-<recipe>-webhook-gateway',
 *                namespace: 'sandbox-recipes',
 *                port: 8090 } }
 *
 * 404 Not Found:                — webhook id absent from recipe.spec.webhooks[]
 *   { exists: false, reason: 'webhook_not_found' }
 *
 * 404 Not Found:                — recipe absent
 *   { exists: false, reason: 'recipe_not_found' }
 *
 * 400 Bad Request:              — namespace/name/id failed shape revalidation
 *   { error: '...' }
 *
 * The endpoint is policy-only: it returns enforcement metadata
 * (methods, maxBodyBytes) and routing info (gateway service+namespace+port)
 * so the proxy can short-circuit before forwarding. It does NOT return any
 * verification material — secrets stay mounted on the per-recipe gateway pod.
 */

const RECIPE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const WEBHOOK_ID_RE = /^[a-z0-9-]{1,63}$/
const GATEWAY_HTTP_PORT = 8090
const DEFAULT_METHODS: readonly ('POST' | 'GET')[] = ['POST']
const DEFAULT_MAX_BODY_BYTES = 1_048_576
// Mirrors the CRD pattern on spec.webhooks[].cors.allowedOrigins[].items —
// defense-in-depth against a CRD whose schema was bypassed (e.g. kubectl
// apply --validate=false). Cap also clamps response size.
const ORIGIN_RE = /^https?:\/\/[a-zA-Z0-9][a-zA-Z0-9.-]*(:[0-9]+)?$/
const MAX_ALLOWED_ORIGINS = 32

interface WebhookEntryPolicy {
  id: string
  methods: ReadonlyArray<'POST' | 'GET'>
  maxBodyBytes: number
  allowedOrigins?: readonly string[]
}

function gatewayServiceName(recipeName: string): string {
  return `wf-${recipeName}-webhook-gateway`
}

export function createInternalWebhooksRouter(gateway: K8sGateway): Router {
  const router = Router()
  const sandboxNamespace = config.sandboxNamespace

  router.get(
    '/internal/webhook/registry/:recipeNs/:recipeName/:webhookId',
    requireInternalToken,
    requireInternalService('webhook-proxy'),
    async (req, res, next) => {
      try {
        const { recipeNs, recipeName, webhookId } = req.params

        // ─── Shape revalidation (defense-in-depth) ─────────────────────
        // webhook-proxy is supposed to validate these before calling us.
        // We re-check anyway: an attacker cannot cause us to read
        // arbitrary CRDs by smuggling malformed names through.
        if (recipeNs !== sandboxNamespace) {
          return res.status(400).json({ error: 'invalid_recipe_namespace' })
        }
        if (!RECIPE_NAME_RE.test(recipeName)) {
          return res.status(400).json({ error: 'invalid_recipe_name' })
        }
        if (!WEBHOOK_ID_RE.test(webhookId)) {
          return res.status(400).json({ error: 'invalid_webhook_id' })
        }

        // ─── Lookup ────────────────────────────────────────────────────
        let recipe: unknown
        try {
          recipe = await gateway.getResource('workflowrecipes', recipeName, recipeNs)
        } catch (err) {
          if (isNotFound(err)) {
            return res.status(404).json({ exists: false, reason: 'recipe_not_found' })
          }
          throw err
        }

        const entry = findWebhookEntry(recipe, webhookId)
        if (!entry) {
          return res.status(404).json({ exists: false, reason: 'webhook_not_found' })
        }

        return res.status(200).json({
          exists: true,
          methods: entry.methods,
          maxBodyBytes: entry.maxBodyBytes,
          ...(entry.allowedOrigins && entry.allowedOrigins.length > 0
            ? { allowedOrigins: entry.allowedOrigins }
            : {}),
          gateway: {
            service: gatewayServiceName(recipeName),
            namespace: recipeNs,
            port: GATEWAY_HTTP_PORT,
          },
        })
      } catch (error) {
        return next(error)
      }
    }
  )

  return router
}

function findWebhookEntry(recipe: unknown, webhookId: string): WebhookEntryPolicy | null {
  const spec = (recipe as { spec?: unknown })?.spec
  if (!spec || typeof spec !== 'object') return null
  const webhooks = (spec as { webhooks?: unknown }).webhooks
  if (!Array.isArray(webhooks)) return null
  for (const wh of webhooks) {
    if (!wh || typeof wh !== 'object') continue
    const id = (wh as { id?: unknown }).id
    if (id !== webhookId) continue
    const rawMethods = (wh as { methods?: unknown }).methods
    const methods =
      Array.isArray(rawMethods) && rawMethods.length > 0
        ? rawMethods.filter((m): m is 'POST' | 'GET' => m === 'POST' || m === 'GET')
        : [...DEFAULT_METHODS]
    const rawMax = (wh as { maxBodyBytes?: unknown }).maxBodyBytes
    const maxBodyBytes =
      typeof rawMax === 'number' && rawMax >= 1024 && rawMax <= 10_485_760
        ? rawMax
        : DEFAULT_MAX_BODY_BYTES
    const allowedOrigins = extractAllowedOrigins(wh)
    return {
      id: webhookId,
      methods,
      maxBodyBytes,
      ...(allowedOrigins ? { allowedOrigins } : {}),
    }
  }
  return null
}

function extractAllowedOrigins(wh: unknown): readonly string[] | undefined {
  const cors = (wh as { cors?: unknown }).cors
  if (!cors || typeof cors !== 'object') return undefined
  const raw = (cors as { allowedOrigins?: unknown }).allowedOrigins
  if (!Array.isArray(raw)) return undefined
  const cleaned = raw
    .filter((o): o is string => typeof o === 'string' && ORIGIN_RE.test(o))
    .slice(0, MAX_ALLOWED_ORIGINS)
  return cleaned.length > 0 ? cleaned : undefined
}

function isNotFound(err: unknown): boolean {
  if (err instanceof K8sNotFoundError) return true
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: unknown; statusCode?: unknown; httpStatus?: unknown }).code
  const statusCode = (err as { statusCode?: unknown }).statusCode
  const httpStatus = (err as { httpStatus?: unknown }).httpStatus
  return code === 404 || statusCode === 404 || httpStatus === 404
}
