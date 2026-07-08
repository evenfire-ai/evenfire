import { Router } from 'express'
import { config } from '../../config.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { enforceNamespace } from '../../http/namespaceAudit.js'
import { isValidDNSSubdomain } from '../../http/rfc1123.js'
import { K8sGateway } from '../../k8s.js'
import {
  OWNER_RECIPE_LABEL_KEY,
  SHARED_LABEL_KEY,
  type SecretOwnership,
  parseSecretOwnership,
} from '../../secretOwnership.js'
import { SecretUpsertRequest } from '../../types.js'
import { listHostSecrets } from './hostSecrets.js'

export function createAdminSecretsRouter(gateway: K8sGateway): Router {
  const router = Router()

  router.get(
    '/admin/secrets',
    enforceNamespace(config.secretsNamespace),
    asyncHandler(async (_req, res) => {
      res.status(200).json({ items: await listHostSecrets(gateway) })
    })
  )

  router.post(
    '/admin/secrets',
    enforceNamespace(config.secretsNamespace),
    asyncHandler(async (req, res) => {
      const body = {
        ...(req.body as SecretUpsertRequest),
        namespace: config.secretsNamespace,
      } as SecretUpsertRequest
      const created = await gateway.createSecret(body)
      res.status(201).json(created)
    })
  )

  router.put(
    '/admin/secrets',
    enforceNamespace(config.secretsNamespace),
    asyncHandler(async (req, res) => {
      const body = {
        ...(req.body as SecretUpsertRequest),
        namespace: config.secretsNamespace,
      } as SecretUpsertRequest
      const updated = await gateway.updateSecret(body)
      res.status(200).json(updated)
    })
  )

  router.delete(
    '/admin/secrets/:name',
    enforceNamespace(config.secretsNamespace),
    asyncHandler(async (req, res) => {
      const deleted = await gateway.deleteSecret(req.params.name, config.secretsNamespace)
      res.status(200).json(deleted)
    })
  )

  // ── MCP Server Secrets ──────────────────────────────────────────────────────
  // Create an Opaque K8s Secret in the mcp-server namespace.
  // Used by the Control UI when the operator provides secret values inline
  // in the Create MCP Server form.
  //
  // Body: { name: string, data: Record<string, string> }
  //   - name:      Kubernetes Secret name (RFC 1123)
  //   - data:      key-value pairs (plain text, stored via stringData)
  //
  // Namespace is set server-side to `config.mcpServersNamespace`.
  // Any caller-supplied namespace is silently ignored and logged as a security event.

  router.post(
    '/admin/mcp-secrets',
    enforceNamespace(config.mcpServersNamespace),
    asyncHandler(async (req, res) => {
      const { name, data } = req.body as {
        name?: string
        data?: Record<string, string>
      }

      // Validate required fields
      if (!name || typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ error: 'name is required' })
        return
      }
      if (!isValidDNSSubdomain(name.trim())) {
        res.status(400).json({
          error: 'Invalid secret name: must be lowercase alphanumeric and hyphens, max 253 chars',
        })
        return
      }
      if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
        res
          .status(400)
          .json({ error: 'data is required and must contain at least one key-value pair' })
        return
      }

      // Ensure all values are strings
      for (const [key, val] of Object.entries(data)) {
        if (typeof val !== 'string') {
          res.status(400).json({ error: `data["${key}"] must be a string` })
          return
        }
      }

      const targetNs = config.mcpServersNamespace
      const secretReq: SecretUpsertRequest = {
        name: name.trim(),
        namespace: targetNs,
        type: 'Opaque',
        stringData: data,
      }

      const created = await gateway.createSecret(secretReq)
      res.status(201).json({ name: name.trim(), namespace: targetNs, created: Boolean(created) })
    })
  )

  // Delete an MCP Server Secret. Used by the Control UI as a best-effort
  // rollback when CRD creation fails after the Secret was already created
  // (see PR-A / A2 — Secret-first + CRD-second transactional create).
  router.delete(
    '/admin/mcp-secrets/:name',
    enforceNamespace(config.mcpServersNamespace),
    asyncHandler(async (req, res) => {
      const deleted = await gateway.deleteSecret(req.params.name, config.mcpServersNamespace)
      res.status(200).json(deleted)
    })
  )

  // ── WorkflowRecipe Secrets ──────────────────────────────────────────────────
  // K8s Secrets in the `sandbox-recipes` namespace referenced by
  // WorkflowRecipe `workloads[].envSecret`. Tagged with the
  // `clerum.io/recipe-secret=true` label so list/filter excludes service-account
  // tokens, coordinator tokens, and other unrelated secrets in the namespace.
  //
  // Every recipe Secret also carries exactly ONE ownership label:
  //   - `clerum.io/shared=true` — any recipe may reference it via envSecret.
  //   - `clerum.io/owner-recipe=<recipe-name>` — only that recipe may reference
  //     it. WRC's reconciler refuses projection for any other recipe; the
  //     boundary holds even against malicious third-party recipe authors.

  const RECIPE_SECRET_LABEL_KEY = 'clerum.io/recipe-secret'
  const RECIPE_SECRET_LABEL_VALUE = 'true'
  const RECIPE_SECRET_NAMESPACES = new Set([
    config.sandboxNamespace,
    config.mcpServersNamespace,
    config.sandboxUiNamespace,
  ])
  // Issue #637 — the ownership READ predicate (OWNER_RECIPE_LABEL_KEY,
  // SHARED_LABEL_KEY, SecretOwnership, parseSecretOwnership) is imported from the
  // single source of truth (@clerum/workflow-runtime-core via ../../secretOwnership)
  // so the label WRITE path here cannot drift from the WRC read gate. The
  // write-side helpers below (ownershipLabels / parseOwnershipFromBody) are
  // control-api-specific and stay local.

  function ownershipLabels(ownership: SecretOwnership): Record<string, string> {
    switch (ownership.kind) {
      case 'shared':
        return { [SHARED_LABEL_KEY]: 'true' }
      case 'owner-recipe':
        return { [OWNER_RECIPE_LABEL_KEY]: ownership.recipeName }
      case 'unlabeled':
        return {}
    }
  }

  // Parse + validate the ownership descriptor a POST body carries.
  // Returns either the descriptor or a 400-shape error.
  function parseOwnershipFromBody(
    body: unknown
  ):
    | { ok: true; ownership: Exclude<SecretOwnership, { kind: 'unlabeled' }> }
    | { ok: false; error: string } {
    const o = (body as { ownership?: unknown }).ownership
    if (!o || typeof o !== 'object') {
      return {
        ok: false,
        error: 'ownership is required: { kind: "shared" } or { kind: "owner-recipe", recipeName }',
      }
    }
    const kind = (o as { kind?: unknown }).kind
    if (kind === 'shared') {
      return { ok: true, ownership: { kind: 'shared' } }
    }
    if (kind === 'owner-recipe') {
      const recipeName = (o as { recipeName?: unknown }).recipeName
      if (typeof recipeName !== 'string' || !recipeName.trim()) {
        return { ok: false, error: 'ownership.recipeName is required when kind="owner-recipe"' }
      }
      return { ok: true, ownership: { kind: 'owner-recipe', recipeName: recipeName.trim() } }
    }
    return { ok: false, error: 'ownership.kind must be "shared" or "owner-recipe"' }
  }

  function parseRecipeSecretTargetNamespace(
    body: unknown
  ): { ok: true; namespace: string } | { ok: false; error: string } {
    const raw = (body as { targetNamespace?: unknown }).targetNamespace
    const namespace =
      typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : config.sandboxNamespace
    if (!RECIPE_SECRET_NAMESPACES.has(namespace)) {
      return {
        ok: false,
        error: `targetNamespace must be one of: ${[...RECIPE_SECRET_NAMESPACES].join(', ')}`,
      }
    }
    return { ok: true, namespace }
  }

  async function listRecipeSecretsForNamespace(namespace: string): Promise<{
    namespace: string
    items: unknown[]
  }> {
    try {
      return { namespace, items: await gateway.listSecrets(namespace) }
    } catch (err) {
      if (namespace === config.sandboxNamespace) throw err

      const statusCode =
        typeof (err as { statusCode?: unknown }).statusCode === 'number'
          ? (err as { statusCode: number }).statusCode
          : typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : undefined
      console.warn(
        JSON.stringify({
          event: 'recipe-secret-namespace-list-degraded',
          namespace,
          statusCode,
        })
      )
      return { namespace, items: [] }
    }
  }

  async function recipeExists(recipeName: string): Promise<boolean> {
    try {
      const items = (await gateway.listResource(
        'workflowrecipes',
        config.sandboxNamespace
      )) as Array<{ metadata?: { name?: string } }>
      return items.some(r => r.metadata?.name === recipeName)
    } catch {
      // List failure: don't block Secret creation on a transient apiserver
      // hiccup — the WRC reconciler is the second line of defense (it rejects
      // owner-recipe Secrets that don't match the requesting recipe).
      return true
    }
  }

  async function isRecipeSecret(
    name: string,
    namespace = config.sandboxNamespace
  ): Promise<boolean> {
    const existing = await gateway.getSecret(name, namespace).catch(() => null)
    if (!existing) return false
    const labels = ((existing as { metadata?: { labels?: Record<string, string> } }).metadata
      ?.labels || {}) as Record<string, string>
    return labels[RECIPE_SECRET_LABEL_KEY] === RECIPE_SECRET_LABEL_VALUE
  }

  router.get(
    '/admin/recipe-secrets',
    enforceNamespace(config.sandboxNamespace),
    asyncHandler(async (_req, res) => {
      const namespaceItems = await Promise.all(
        [...RECIPE_SECRET_NAMESPACES].map(namespace => listRecipeSecretsForNamespace(namespace))
      )
      const rows = namespaceItems.flatMap(({ namespace, items }) =>
        items
          .filter(item => {
            const labels = ((item as { metadata?: { labels?: Record<string, string> } }).metadata
              ?.labels || {}) as Record<string, string>
            return String(labels[RECIPE_SECRET_LABEL_KEY] || '') === RECIPE_SECRET_LABEL_VALUE
          })
          .map(item => {
            const metadata = (
              item as { metadata?: { name?: string; labels?: Record<string, string> } }
            ).metadata
            const name = String(metadata?.name || '').trim()
            const keys = Array.isArray((item as { keys?: string[] }).keys)
              ? (item as { keys: string[] }).keys
              : []
            const ownership = parseSecretOwnership(metadata?.labels || {})
            return { name, namespace, keys, ownership }
          })
          .filter(row => row.name.length > 0)
      )
      res.status(200).json({ items: rows })
    })
  )

  router.post(
    '/admin/recipe-secrets',
    enforceNamespace(config.sandboxNamespace),
    asyncHandler(async (req, res) => {
      const { name, data } = req.body as {
        name?: string
        data?: Record<string, string>
      }

      if (!name || typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ error: 'name is required' })
        return
      }
      if (!isValidDNSSubdomain(name.trim())) {
        res.status(400).json({
          error: 'Invalid secret name: must be lowercase alphanumeric and hyphens, max 253 chars',
        })
        return
      }
      if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
        res
          .status(400)
          .json({ error: 'data is required and must contain at least one key-value pair' })
        return
      }
      for (const [key, val] of Object.entries(data)) {
        if (typeof val !== 'string') {
          res.status(400).json({ error: `data["${key}"] must be a string` })
          return
        }
      }

      const ownershipParse = parseOwnershipFromBody(req.body)
      if (!ownershipParse.ok) {
        res.status(400).json({ error: ownershipParse.error })
        return
      }
      const ownership = ownershipParse.ownership
      if (ownership.kind === 'owner-recipe' && !(await recipeExists(ownership.recipeName))) {
        res.status(400).json({
          error: `ownership.recipeName "${ownership.recipeName}" does not match any WorkflowRecipe in namespace "${config.sandboxNamespace}"`,
        })
        return
      }
      const namespaceParse = parseRecipeSecretTargetNamespace(req.body)
      if (!namespaceParse.ok) {
        res.status(400).json({ error: namespaceParse.error })
        return
      }
      const targetNamespace = namespaceParse.namespace

      const secretReq: SecretUpsertRequest = {
        name: name.trim(),
        namespace: targetNamespace,
        type: 'Opaque',
        labels: {
          [RECIPE_SECRET_LABEL_KEY]: RECIPE_SECRET_LABEL_VALUE,
          ...ownershipLabels(ownership),
        },
        stringData: data,
      }

      const created = await gateway.createSecret(secretReq)
      res.status(201).json({
        name: name.trim(),
        namespace: targetNamespace,
        ownership,
        created: Boolean(created),
      })
    })
  )

  router.put(
    '/admin/recipe-secrets',
    enforceNamespace(config.sandboxNamespace),
    asyncHandler(async (req, res) => {
      const { name, data, removeKeys } = req.body as {
        name?: string
        data?: Record<string, string>
        removeKeys?: string[]
      }

      if (!name || typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ error: 'name is required' })
        return
      }
      const dataEntries = data && typeof data === 'object' ? Object.entries(data) : []
      const removeList = Array.isArray(removeKeys)
        ? removeKeys.filter(k => typeof k === 'string' && k.length > 0)
        : []
      if (dataEntries.length === 0 && removeList.length === 0) {
        res.status(400).json({ error: 'data or removeKeys is required' })
        return
      }
      for (const [key, val] of dataEntries) {
        if (typeof val !== 'string') {
          res.status(400).json({ error: `data["${key}"] must be a string` })
          return
        }
      }
      const namespaceParse = parseRecipeSecretTargetNamespace(req.body)
      if (!namespaceParse.ok) {
        res.status(400).json({ error: namespaceParse.error })
        return
      }
      const targetNamespace = namespaceParse.namespace

      // Guardrail: refuse to mutate a workflow Secret that isn't a recipe
      // secret. Without this, the name alone could target coordinator tokens or
      // mcp-host/runtime auth Secrets that share an allowed namespace.
      const existing = (await gateway
        .getSecret(name.trim(), targetNamespace)
        .catch(() => null)) as {
        metadata?: { labels?: Record<string, string> }
        data?: Record<string, string>
      } | null
      const existingLabels = (existing && existing.metadata?.labels) || {}
      if (existingLabels[RECIPE_SECRET_LABEL_KEY] !== RECIPE_SECRET_LABEL_VALUE) {
        res.status(404).json({ error: 'Recipe secret not found' })
        return
      }

      // Merge semantics: overlay incoming keys onto existing data; drop keys
      // listed in removeKeys. Lets callers update one value without resending
      // every other key (and without us ever returning the existing values).
      const existingData = (existing && existing.data) || {}
      const mergedData: Record<string, string> = { ...existingData }
      for (const [k, v] of dataEntries) {
        mergedData[k] = Buffer.from(v, 'utf8').toString('base64')
      }
      for (const k of removeList) {
        delete mergedData[k]
      }

      if (Object.keys(mergedData).length === 0) {
        res.status(400).json({ error: 'secret must retain at least one key' })
        return
      }

      const preservedOwnership = parseSecretOwnership(existingLabels)
      const secretReq: SecretUpsertRequest = {
        name: name.trim(),
        namespace: targetNamespace,
        type: 'Opaque',
        labels: {
          [RECIPE_SECRET_LABEL_KEY]: RECIPE_SECRET_LABEL_VALUE,
          ...ownershipLabels(preservedOwnership),
        },
        data: mergedData,
      }

      const updated = await gateway.updateSecret(secretReq)
      res.status(200).json(updated)
    })
  )

  router.delete(
    '/admin/recipe-secrets/:name',
    enforceNamespace(config.sandboxNamespace),
    asyncHandler(async (req, res) => {
      const name = req.params.name
      const namespaceParse = parseRecipeSecretTargetNamespace(req.query)
      if (!namespaceParse.ok) {
        res.status(400).json({ error: namespaceParse.error })
        return
      }
      const targetNamespace = namespaceParse.namespace
      if (!(await isRecipeSecret(name, targetNamespace))) {
        res.status(404).json({ error: 'Recipe secret not found' })
        return
      }
      const deleted = await gateway.deleteSecret(name, targetNamespace)
      res.status(200).json(deleted)
    })
  )

  return router
}
