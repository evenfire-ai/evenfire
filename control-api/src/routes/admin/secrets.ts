import { Router } from 'express'
import { PROVIDER_CREDENTIAL_SLOTS } from '@clerum/llm-providers'
import { config } from '../../config.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import { enforceNamespace } from '../../http/namespaceAudit.js'
import { isValidDNSSubdomain } from '../../http/rfc1123.js'
import { K8sGateway, extractHttpStatus } from '../../k8s.js'
import {
  OWNER_RECIPE_LABEL_KEY,
  SHARED_LABEL_KEY,
  type SecretOwnership,
  parseSecretOwnership,
} from '../../secretOwnership.js'
import { invalidSecretDataKeyReason } from '../../services/secretKeys.js'
import { SecretUpsertRequest } from '../../types.js'
import { listHostSecrets } from './hostSecrets.js'
import { isLlmHostSecret } from './llmSecretIdentity.js'

// The bedrock credential-slot keys and the vertex service-account key, derived
// from the shared provider package (never hardcoded here) so the write-side
// gate cannot drift from the UI's client-side gate (spec R4.5.3).
const BEDROCK_CREDENTIAL_KEYS: readonly string[] = PROVIDER_CREDENTIAL_SLOTS.bedrock.map(
  slot => slot.dataKey
)
const VERTEX_SERVICE_ACCOUNT_KEY: string = PROVIDER_CREDENTIAL_SLOTS.vertex[0].dataKey

// The ownership label every WorkflowRecipe Secret carries. Declared at module
// scope so the recipe-secret routes below and the mcp-secret rotation guard
// read the SAME constant: a literal duplicated in either place would silently
// stop the guard from firing the day the other one changes.
const RECIPE_SECRET_LABEL_KEY = 'clerum.io/recipe-secret'
const RECIPE_SECRET_LABEL_VALUE = 'true'

// The plaintext data being written, merging base64 `data` and plaintext
// `stringData` (stringData wins, matching Kubernetes Secret semantics).
function effectiveSecretData(body: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  const data = (body as { data?: unknown }).data
  if (data && typeof data === 'object') {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (typeof value === 'string') {
        out[key] = Buffer.from(value, 'base64').toString('utf8')
      }
    }
  }
  const stringData = (body as { stringData?: unknown }).stringData
  if (stringData && typeof stringData === 'object') {
    for (const [key, value] of Object.entries(stringData as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
    }
  }
  return out
}

// Slot-aware validation for the LLM credential slots, mirroring the client-side
// `validateLlmSecretData` in control-ui (spec R4.5.3). Only enforced when the
// write payload targets an LLM host Secret — everything else passes through the
// generic contract untouched. Returns an error message or null.
export function validateLlmSecretSlots(body: unknown): string | null {
  // Scope: the slot-aware contract fires for an LLM host Secret identified by
  // EITHER the host-secret label (per-host Secrets minted by the wizard) OR a
  // name in LLM_SECRET_NAMES (the shared `chatllm-api-keys` Secret WRC uses).
  // A per-host-NAMED Secret can no longer bypass the bedrock/vertex gate, and a
  // generic Secret with a stray `aws-access-key-id` is still not our concern.
  const b = body as { name?: unknown; labels?: Record<string, string> | null }
  if (!isLlmHostSecret({ name: b.name, labels: b.labels })) return null
  const data = effectiveSecretData(body)
  const has = (key: string): boolean => typeof data[key] === 'string' && data[key].trim().length > 0

  // Bedrock: the access-key pair must be written together (no half state).
  const bedrockPresent = BEDROCK_CREDENTIAL_KEYS.filter(has)
  if (bedrockPresent.length > 0 && bedrockPresent.length < BEDROCK_CREDENTIAL_KEYS.length) {
    const missing = BEDROCK_CREDENTIAL_KEYS.filter(key => !has(key))
    return `Amazon Bedrock requires both credentials in a single write; missing: ${missing.join(', ')}.`
  }

  // Vertex: the service-account JSON must parse and carry client_email +
  // private_key before it is stored.
  if (has(VERTEX_SERVICE_ACCOUNT_KEY)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(data[VERTEX_SERVICE_ACCOUNT_KEY])
    } catch {
      return `${VERTEX_SERVICE_ACCOUNT_KEY} must be valid JSON.`
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return `${VERTEX_SERVICE_ACCOUNT_KEY} must be a service account JSON object.`
    }
    const record = parsed as Record<string, unknown>
    const missing = ['client_email', 'private_key'].filter(field => {
      const value = record[field]
      return typeof value !== 'string' || value.trim().length === 0
    })
    if (missing.length > 0) {
      return `${VERTEX_SERVICE_ACCOUNT_KEY} must contain ${missing.join(' and ')}.`
    }
  }

  return null
}

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
      const llmSlotError = validateLlmSecretSlots(req.body)
      if (llmSlotError) {
        res.status(400).json({ error: llmSlotError })
        return
      }
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
      // Opt-in merge semantics (spec R4 FIX 2b): with `merge: true` the update is
      // a server-side read-then-replace that OVERLAYS the sent keys onto the
      // existing Secret's keys (preserving keys the caller didn't send — e.g.
      // other providers' credentials on the shared LLM Secret). Without the flag
      // the default stays FULL-REPLACE so existing callers are unaffected.
      // `removeKeys` (merge-only) is the delete-a-slot half of partial edit:
      // an operator retiring a provider from the fallback chain drops that
      // provider's credential slot without resending — or wiping — the others.
      const merge = (req.body as { merge?: unknown }).merge === true
      const name = (req.body as { name?: unknown }).name

      if (merge) {
        if (typeof name !== 'string' || !name.trim()) {
          res.status(400).json({ error: 'name is required' })
          return
        }
        const existing = (await gateway
          .getSecret(name.trim(), config.secretsNamespace)
          .catch(() => null)) as {
          data?: Record<string, string>
          metadata?: { labels?: Record<string, string> }
        } | null
        if (!existing) {
          res.status(404).json({ error: 'Secret not found' })
          return
        }
        // Label authority for LLM-host identity is the EXISTING Secret, never the
        // caller's body — so a caller cannot flip validation on/off by (not)
        // echoing the label. Both the slot gate and the bedrock atomic-retirement
        // below key off this.
        const existingLabels = existing.metadata?.labels
        const llmHost = isLlmHostSecret({ name: name.trim(), labels: existingLabels })

        // Overlay incoming keys (base64-encoded) onto the existing base64 data.
        // Empty values are skipped: blanking is not deletion (removeKeys is the
        // deletion path), so a stray empty field can never wipe a stored value.
        //
        // NOTE: read-then-replace is used instead of `SecretService.mergeSecret`
        // (RFC 7396 merge-patch, race-free) because that needs the
        // `secrets: patch` RBAC verb, which is not granted on this namespace's
        // Role. If it ever is, prefer mergeSecret here — it removes the
        // read/replace race window.
        const mergedData: Record<string, string> = { ...(existing.data || {}) }
        for (const [k, v] of Object.entries(effectiveSecretData(req.body))) {
          if (v.trim().length === 0) continue
          mergedData[k] = Buffer.from(v, 'utf8').toString('base64')
        }

        // removeKeys: retire named data keys. Only the named keys are dropped;
        // every other key is left untouched (write-safe partial delete).
        const rawRemove = (req.body as { removeKeys?: unknown }).removeKeys
        const removeList = Array.isArray(rawRemove)
          ? rawRemove.filter((k): k is string => typeof k === 'string' && k.length > 0)
          : []
        for (const k of removeList) {
          delete mergedData[k]
        }

        // Atomic Bedrock retirement (contract): the access-key pair is atomic on
        // the way OUT as well as in. If a removal drops one half of the pair, the
        // lone sibling is dead weight that would otherwise trip the paired-slot
        // gate below — so we retire the WHOLE pair. This keeps the Secret in a
        // valid slot state and matches the "retire a provider's slot" intent; the
        // names-only response makes the extra removal visible to the operator.
        // NOTE: a single request that both re-adds one Bedrock key (via data) AND
        // lists its sibling in removeKeys is contradictory — retirement wins and
        // BOTH keys are dropped. Callers rotating the pair should send both keys
        // in `data` (and not in removeKeys).
        if (llmHost && removeList.some(k => BEDROCK_CREDENTIAL_KEYS.includes(k))) {
          for (const k of BEDROCK_CREDENTIAL_KEYS) delete mergedData[k]
        }

        // A partial edit must never leave an empty Secret behind (mirror the
        // recipe-secrets removeKeys guard). Deleting the Secret is DELETE's job.
        if (Object.keys(mergedData).length === 0) {
          res.status(400).json({ error: 'secret must retain at least one key' })
          return
        }

        // Validate slot-aware rules over the EFFECTIVE merged+pruned result, so a
        // bedrock pair completed across existing+sent keys passes, and an
        // incomplete pair after the merge still 400s. Pass the existing labels so
        // a per-host labeled Secret is validated even when the body omits them.
        const llmSlotError = validateLlmSecretSlots({
          name: name.trim(),
          data: mergedData,
          labels: existingLabels,
        })
        if (llmSlotError) {
          res.status(400).json({ error: llmSlotError })
          return
        }
        await gateway.updateSecret({
          name: name.trim(),
          namespace: config.secretsNamespace,
          type: (req.body as { type?: string }).type,
          data: mergedData,
        } as SecretUpsertRequest)
        // Never echo the k8s Secret object here: the merged Secret carries the
        // base64 VALUES of every stored key — including keys the caller did NOT
        // send (other providers' credentials). The R4 contract is names-only
        // everywhere, so the response returns only the resulting key names.
        res.status(200).json({
          name: name.trim(),
          namespace: config.secretsNamespace,
          keys: Object.keys(mergedData).sort((a, b) => a.localeCompare(b)),
        })
        return
      }

      // Full-replace path. secretService.updateSecret re-attaches the EXISTING
      // Secret's labels when the body omits them, so a label-less full-replace of
      // a per-host labeled LLM Secret would otherwise skip the slot gate yet still
      // be stored as an LLM host Secret (landing e.g. a half-Bedrock pair). Mirror
      // the merge path: derive LLM-host identity from the existing labels too.
      // This read is validation-only — the write body is unchanged, and NO data
      // is merged (full-replace stays a passthrough). `chatllm-api-keys` is
      // matched by name, so this only affects per-host labeled Secrets.
      const replaceName = (req.body as { name?: unknown }).name
      const existingReplaceLabels =
        typeof replaceName === 'string' && replaceName.trim()
          ? (
              (await gateway
                .getSecret(replaceName.trim(), config.secretsNamespace)
                .catch(() => null)) as { metadata?: { labels?: Record<string, string> } } | null
            )?.metadata?.labels
          : undefined
      const bodyLabels = (req.body as { labels?: Record<string, string> }).labels
      const llmSlotError = validateLlmSecretSlots({
        ...(req.body as Record<string, unknown>),
        labels: bodyLabels || existingReplaceLabels,
      })
      if (llmSlotError) {
        res.status(400).json({ error: llmSlotError })
        return
      }
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

      // Reject invalid Secret keys and non-string values up front so creating a
      // Secret with a key the apiserver refuses returns a clear 400 instead of
      // the opaque 500 (mirrors the rotation guard on the PUT route).
      for (const [key, val] of Object.entries(data)) {
        const keyError = invalidSecretDataKeyReason(key)
        if (keyError) {
          res.status(400).json({ error: keyError })
          return
        }
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

  // Rotate credentials on an EXISTING MCP Server Secret (issue #223).
  //
  // Body: { data: Record<string, string> } — only the keys the operator means
  // to rotate. Keys sent here are added or replaced; every other key on the
  // Secret survives untouched, because one connector Secret can hold several
  // credentials and rotating one must not wipe the rest. The merge is a
  // server-side RFC 7396 merge-patch (atomic, no read/replace race), which is
  // why this namespace's Role grants `secrets: patch`.
  //
  // Restarting the connector is NOT this route's job: HCC watches Secrets and
  // rolls the affected Deployments through the credentials-revision annotation.
  // `affectedConnectors` names the McpServers that reference this Secret, so
  // the UI can tell the operator exactly what is about to restart.
  //
  // The response is names-only. No secret value is ever echoed back — not in
  // plaintext, not in base64, and not as a hash of the values.
  //
  // Namespace is always `config.mcpServersNamespace`; any caller-supplied
  // namespace is ignored.
  router.put(
    '/admin/mcp-secrets/:name',
    enforceNamespace(config.mcpServersNamespace),
    asyncHandler(async (req, res) => {
      const name = (req.params.name || '').trim()
      const { data } = req.body as { data?: Record<string, string> }

      if (!name) {
        res.status(400).json({ error: 'name is required' })
        return
      }
      if (!isValidDNSSubdomain(name)) {
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
        const keyError = invalidSecretDataKeyReason(key)
        if (keyError) {
          res.status(400).json({ error: keyError })
          return
        }
        if (typeof val !== 'string') {
          res.status(400).json({ error: `data["${key}"] must be a string` })
          return
        }
        // A blank value is an operator slip, not a delete instruction: this
        // route writes the keys the operator chose to rotate, and retiring a
        // key is DELETE's job. Skipping it silently would report a rotation
        // that never happened.
        if (!val.trim()) {
          res.status(400).json({ error: `data["${key}"] must not be empty` })
          return
        }
      }

      const targetNs = config.mcpServersNamespace

      // Rotation targets a Secret that already exists — creating one is POST's
      // job. Read it first so a missing Secret is a 404 instead of a silent
      // upsert, and so the ownership guard below sees the stored labels.
      let existing: {
        metadata?: { labels?: Record<string, string> }
        data?: Record<string, string>
      }
      try {
        existing = (await gateway.getSecret(name, targetNs)) as typeof existing
      } catch (err) {
        if (extractHttpStatus(err) === 404) {
          res.status(404).json({ error: `Secret "${name}" not found in ${targetNs}` })
          return
        }
        // 403 (Role missing the verb), 5xx, timeouts: propagate. Dressing them
        // up as 404 would tell the operator "no such credential" when the truth
        // is that the API server refused the read.
        throw err
      }

      // `mcp-server` is a shared namespace: WorkflowRecipe Secrets live here too
      // (see RECIPE_SECRET_NAMESPACES below) behind their own ownership gate.
      // Without this guard, rotating through the connector route would be a way
      // around that gate.
      if (existing.metadata?.labels?.[RECIPE_SECRET_LABEL_KEY] === RECIPE_SECRET_LABEL_VALUE) {
        res.status(409).json({
          error: `Secret "${name}" is owned by a WorkflowRecipe; rotate it through /admin/recipe-secrets`,
        })
        return
      }

      await gateway.mergeSecret({ name, namespace: targetNs, stringData: data })

      const keys = [...new Set([...Object.keys(existing.data || {}), ...Object.keys(data)])].sort(
        (a, b) => a.localeCompare(b)
      )

      // The credential IS rotated at this point. Emit the audit record NOW,
      // before anything that could throw — a rotation that actually happened
      // must never go unlogged just because a later, secondary step failed.
      // Key NAMES are safe to log; values never are.
      console.log(
        JSON.stringify({
          event: 'mcp-secret-rotated',
          name,
          namespace: targetNs,
          rotatedKeys: Object.keys(data).sort((a, b) => a.localeCompare(b)),
        })
      )

      // affectedConnectors is a best-effort convenience for the UI ("who
      // restarts"), NOT part of the rotation's success. The Secret is already
      // written and HCC will roll the affected Deployments regardless. So a
      // failure to LIST connectors must not turn a successful rotation into a
      // 500 that would make the operator think the credential is unchanged (and
      // possibly re-rotate). Fail loud in the log, then return the rotation as
      // the success it is, with an empty list the UI renders as "unknown".
      let affectedConnectors: string[] = []
      try {
        affectedConnectors = (await gateway.listResource('mcpservers', targetNs))
          .filter(
            item =>
              (item as { spec?: { envSecret?: { name?: string } } }).spec?.envSecret?.name === name
          )
          .map(item => (item as { metadata?: { name?: string } }).metadata?.name)
          .filter((connector): connector is string => typeof connector === 'string')
          .sort((a, b) => a.localeCompare(b))
      } catch (err) {
        console.warn(
          JSON.stringify({
            event: 'mcp-secret-rotated-affected-connectors-unavailable',
            name,
            namespace: targetNs,
            error: err instanceof Error ? err.message : String(err),
          })
        )
      }

      res.status(200).json({ name, namespace: targetNs, keys, affectedConnectors })
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
        const keyError = invalidSecretDataKeyReason(key)
        if (keyError) {
          res.status(400).json({ error: keyError })
          return
        }
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
        const keyError = invalidSecretDataKeyReason(key)
        if (keyError) {
          res.status(400).json({ error: keyError })
          return
        }
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
