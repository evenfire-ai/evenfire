/**
 * MCP Delegation — Intent Decomposition Pipeline (Phase 6).
 *
 * Handles the MCP Intent and Access-Policy Intent:
 * - MCP Intent: Workloads with `transport` → McpServer CRDs
 * - Access-Policy Intent: Context CRD patching to add servers to allowlist
 *
 * Transport-aware managed flag:
 * - HTTP workloads (sse/streamableHttp): managed: false — WRC owns runtime
 * - stdio workloads: managed: true — HCC owns Deployment (stdio-bridge sidecar)
 */
import * as k8s from '@kubernetes/client-node'
import {
  NETWORK_READY_ANNOTATION,
  NETWORK_READY_GENERATION_ANNOTATION,
  PRE_DEPLOY_ANNOTATION,
} from '@clerum/network-policy-core'
import {
  EVENFIRE_REGISTRY_PULL_SECRET_NAME,
  isPlatformRegistryImage,
} from '@clerum/workflow-runtime-core'
import { loadConfig } from '../config'
import { WorkflowRecipeCRD, WorkloadDef } from '../types'
import { CRD_GROUP, CRD_VERSION } from './crdConstants'
import { getErrorCode } from './k8sErrors'
import {
  ownerRef,
  resolveWorkloadResourceName,
  resolveWorkloadRuntimeResourceName,
  workloadLabels,
} from './resourceBuilder'
import type { SecretAccess } from './resourceBuilder'
import { specHashUnchanged, stampSpecHash } from './specHash'
import { effectiveWorkflowContextRef, privateWorkflowContextName } from './workflowContext'

// ─── Constants ───────────────────────────────────────────────────────
const MCPSERVER_PLURAL = 'mcpservers'
const CONTEXT_PLURAL = 'contexts'
const EXTERNAL_EGRESS_READY_CONDITION = 'ExternalEgressReady'
const RETRYABLE_EXTERNAL_EGRESS_REASONS = new Set([
  'ExternalEgressReconcileFailed',
  'InventoryListFailed',
  'CleanupFailed',
  'ExternalEgressProofFailed',
  'ExternalEgressUntrustedState',
  'StatusWriteFailed',
])
const MCPSERVER_REPLACE_CONFLICT_RETRIES = 3
const CONTEXT_REPLACE_CONFLICT_RETRIES = 3

// ─── Dependencies ────────────────────────────────────────────────────

export interface DelegationDeps {
  customApi: k8s.CustomObjectsApi
  coreApi: k8s.CoreV1Api
}

type ManifestEgressBinding = {
  egressClass?: 'exact-host' | 'public-web'
  dns?: string
  port?: number
  protocol?: 'TCP' | 'UDP'
}

type ConditionLike = {
  type?: string
  status?: string
  reason?: string
  message?: string
  observedGeneration?: number
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableJson(item)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function mcpServerSpecMatches(existingSpec: unknown, desiredSpec: unknown): boolean {
  return stableJson(existingSpec ?? {}) === stableJson(desiredSpec ?? {})
}

function sanitizeEgressBindings(
  bindings?: WorkloadDef['egressBindings']
): ManifestEgressBinding[] | undefined {
  if (!bindings || bindings.length === 0) return undefined

  return bindings.map(binding =>
    binding.egressClass === 'public-web'
      ? { egressClass: 'public-web' }
      : {
          ...(binding.egressClass ? { egressClass: binding.egressClass } : {}),
          ...(binding.dns ? { dns: binding.dns } : {}),
          ...(binding.port !== undefined ? { port: binding.port } : {}),
          ...(binding.protocol ? { protocol: binding.protocol } : {}),
        }
  )
}

// ─── Pure Helpers ────────────────────────────────────────────────────

export function transportWorkloadHasExternalEgress(workload: WorkloadDef): boolean {
  return Boolean(workload.transport && (workload.egressBindings ?? []).length > 0)
}

export function externalEgressMcpServerNames(recipe: WorkflowRecipeCRD): string[] {
  return (recipe.spec.workloads ?? [])
    .filter(transportWorkloadHasExternalEgress)
    .map(workload => mcpServerName(recipe.metadata.name, workload.id, recipe))
}

function hasExplicitWorkflowContextRef(recipe: WorkflowRecipeCRD): boolean {
  return Boolean(recipe.spec.contextRef?.trim())
}

/**
 * Compute McpServer CRD name.
 *
 * For workflow recipes (with steps[]), uses UUID-based name from status.workloadInstances.
 * For regular recipes (no steps), uses the classic {recipeName}-{workloadId} pattern.
 * McpServer names always include the recipe prefix (unlike non-MCP workloads).
 */
export function mcpServerName(
  recipeName: string,
  workloadId: string,
  recipe?: WorkflowRecipeCRD
): string {
  if (recipe) {
    const isWorkflow = Array.isArray(recipe.spec.steps) && recipe.spec.steps.length > 0
    if (isWorkflow) {
      // Workflow recipes: use UUID-based name from status.workloadInstances
      return resolveWorkloadResourceName(recipe, workloadId)
    }
  }
  // Non-workflow recipes or no recipe context: classic {recipeName}-{workloadId}
  return `${recipeName}-${workloadId}`
}

/**
 * Issue #637 — may this name-referenced Secret be copied into the McpServer CRD?
 *
 * The McpServer CRD's `envSecret` / `imagePullSecrets` are materialized verbatim
 * by HCC, which does NOT re-validate Clerum ownership labels. So the WRC is the
 * sole trust boundary: a Secret may be projected ONLY when classifySecretAccess
 * marked it `accessible` (or `missing` — left to kubelet, parity with the
 * non-transport required-key path). `denied`/`error` MUST be stripped.
 *
 * `secretAccess === undefined` means the caller opted out of gating (legacy code
 * paths / unit fixtures that pre-date #637) → project as before, so existing
 * behavior is preserved and only ownership-classified callers gain the gate.
 */
function transportSecretProjectable(
  secretAccess: ReadonlyMap<string, SecretAccess> | undefined,
  name: string
): boolean {
  if (!secretAccess) return true
  const state = secretAccess.get(name)?.state
  return state === undefined || state === 'accessible' || state === 'missing'
}

/**
 * Issue #637 — is this transport workload ownership-denied for any of its
 * name-referenced Secrets (`envSecret` or any `imagePullSecret`)?
 *
 * A denied transport workload must not be delegated AT ALL: skipping
 * ensureMcpServer / ensureTransportService prevents HCC from ever materializing
 * the foreign credential. `error` (ownership unverifiable) is normally requeued
 * by the reconciler before delegation runs; treating it as denied here is
 * belt-and-suspenders. `secretAccess === undefined` ⇒ not denied (legacy paths).
 */
export function transportWorkloadSecretDenied(
  workload: WorkloadDef,
  secretAccess: ReadonlyMap<string, SecretAccess> | undefined
): boolean {
  if (!secretAccess) return false
  const refs: string[] = []
  if (workload.envSecret?.name) refs.push(workload.envSecret.name)
  for (const pull of workload.imagePullSecrets ?? []) refs.push(pull)
  return refs.some(name => {
    const state = secretAccess.get(name)?.state
    return state === 'denied' || state === 'error'
  })
}

/**
 * Build a McpServer CRD manifest for a transport workload.
 *
 * Returns null if the workload has no transport field (non-MCP workload).
 * HTTP transports → managed: false (WRC owns runtime, HCC exposes discovery/status).
 * stdio transports → managed: true (HCC owns Deployment with stdio-bridge sidecar).
 *
 * `secretAccess` (Issue #637): the classifySecretAccess verdict map. When passed,
 * a name-referenced Secret (`envSecret` / `imagePullSecrets`) is copied into the
 * CRD ONLY if its ownership state allows projection — `denied`/`error` are
 * stripped so HCC (which never re-checks ownership) cannot materialize a foreign
 * credential. Omitted (pure-builder/legacy callers) ⇒ project as before; the
 * authoritative gate is the orchestrator skip, this strip is defense in depth.
 */
export function buildMcpServerManifest(
  workload: WorkloadDef,
  recipe: WorkflowRecipeCRD,
  namespace: string,
  secretAccess?: ReadonlyMap<string, SecretAccess>
): Record<string, unknown> | null {
  if (!workload.transport) return null

  const name = mcpServerName(recipe.metadata.name, workload.id, recipe)
  const contextRef = effectiveWorkflowContextRef(recipe)
  const port = workload.port ?? 3000
  const isStdio = workload.transport.type === 'stdio'
  const path = workload.transport.path ?? '/mcp'
  const url = `http://${name}.${namespace}.svc.cluster.local:${port}${path}`

  // Resolve bindings that reference this workload
  const bindings = (recipe.spec.bindings ?? []).filter(
    b => b.from === workload.id || b.to === workload.id
  )

  const annotations: Record<string, string> = {}
  if (bindings.length > 0) {
    annotations['clerum.io/recipe-bindings'] = JSON.stringify(bindings)
  }

  // Egress bindings are per-workload (least-privilege: each workload only gets
  // the external egress it explicitly declares, not the entire recipe's).
  const egressBindings = sanitizeEgressBindings(workload.egressBindings)

  // Cross-namespace ownerRefs are invalid per K8s API (OwnerRefInvalidNamespace
  // since 1.24). When the McpServer lives in `mcp-server` but the recipe CRD
  // lives in `sandbox-recipes` (post canonical-namespace refactor), we must
  // strip the ownerRef. Cleanup falls back to label selector in
  // `cleanupDelegation` / finalization handler.
  const sameNsAsRecipe = namespace === recipe.metadata.namespace
  const mcpServerOwnerRefs = sameNsAsRecipe ? [ownerRef(recipe)] : undefined

  // Issue #637 — gate the name-referenced Secret projections by ownership.
  // HCC materializes these verbatim without re-checking ownership, so a denied
  // ref stripped here cannot reach the third-party pod's runtime env / registry.
  const envSecretProjectable =
    !!workload.envSecret && transportSecretProjectable(secretAccess, workload.envSecret.name)
  const projectableImagePullSecrets = (workload.imagePullSecrets ?? []).filter(secretName =>
    transportSecretProjectable(secretAccess, secretName)
  )
  // The PLATFORM pull credential is injected AFTER the ownership filter for any workload
  // whose image is hosted on our own registry (see resourceBuilder for the full rationale:
  // control-api provisions it, it is intentionally unlabeled to the #637 model, and making
  // it recipe-referencable would either deny it or expose it as an envSecret).
  if (
    isPlatformRegistryImage(workload.image, loadConfig().registryUrl) &&
    !projectableImagePullSecrets.includes(EVENFIRE_REGISTRY_PULL_SECRET_NAME)
  ) {
    projectableImagePullSecrets.push(EVENFIRE_REGISTRY_PULL_SECRET_NAME)
  }

  return {
    apiVersion: `${CRD_GROUP}/${CRD_VERSION}`,
    kind: 'McpServer',
    metadata: {
      name,
      namespace,
      ...(mcpServerOwnerRefs && { ownerReferences: mcpServerOwnerRefs }),
      labels: workloadLabels(recipe.metadata.name, workload.id, contextRef),
      ...(Object.keys(annotations).length > 0 && { annotations }),
    },
    spec: {
      // stdio servers use managed: true — HCC injects the stdio-bridge sidecar
      // and manages the Deployment. HTTP servers use managed: false — WRC manages.
      managed: isStdio,
      contextRef,
      description: `MCP server for ${workload.id} (recipe: ${recipe.metadata.name})`,
      image: workload.image,
      ...(workload.imagePullPolicy && { imagePullPolicy: workload.imagePullPolicy }),
      ...(workload.command && { command: workload.command }),
      ...(workload.args && { args: workload.args }),
      ...(workload.env && { env: workload.env }),
      ...(envSecretProjectable && { envSecret: workload.envSecret }),
      transport: {
        type: workload.transport.type,
        ...(isStdio ? { port } : { url, port }),
      },
      ...(egressBindings && { egressBindings }),
      // G1: Propagate per-workload security overrides to HCC
      ...(workload.security && {
        security: {
          ...(workload.security.runAsUser !== undefined && {
            runAsUser: workload.security.runAsUser,
          }),
          ...(workload.security.runAsGroup !== undefined && {
            runAsGroup: workload.security.runAsGroup,
          }),
          ...(workload.security.fsGroup !== undefined && { fsGroup: workload.security.fsGroup }),
          ...(workload.security.addCapabilities?.length && {
            addCapabilities: workload.security.addCapabilities,
          }),
        },
      }),
      // G6: Propagate imagePullSecrets to HCC (normalize string[] -> [{name: string}]
      // per K8s LocalObjectReference convention; CRD schema requires objects).
      // Codex P2 fix (PR #101): producer normalizes at the McpServer CRD write boundary.
      // Issue #637: only ownership-projectable pull secrets are forwarded.
      ...(projectableImagePullSecrets.length > 0 && {
        imagePullSecrets: projectableImagePullSecrets.map(secretName => ({ name: secretName })),
      }),
    },
  }
}

/**
 * Build a ClusterIP Service for a transport workload.
 *
 * The Service name matches mcpServerName() so that the McpServer CRD's
 * transport.url resolves via DNS. The selector targets the Deployment
 * pods (app: workload.id).
 *
 * Returns null if the workload has no transport or no port.
 */
export function buildTransportService(
  workload: WorkloadDef,
  recipe: WorkflowRecipeCRD,
  namespace: string
): k8s.V1Service | null {
  if (!workload.transport || !workload.port) return null

  const name = mcpServerName(recipe.metadata.name, workload.id, recipe)
  const contextRef = effectiveWorkflowContextRef(recipe)
  const isStdio = workload.transport!.type === 'stdio'

  // For stdio workloads, HCC creates the Deployment with label `app: mcpServerName`.
  // For HTTP workloads, WRC creates the Deployment with label `app: resolvedName`.
  // Both now use the same UUID-based resolved name.
  const selectorApp = isStdio ? name : resolveWorkloadRuntimeResourceName(recipe, workload)

  // Cross-namespace ownerRefs are invalid (see buildMcpServerManifest for the
  // same rationale). The Service lives in the MCP namespace alongside the
  // McpServer CRD; recipe CRD lives in `sandbox-recipes`.
  const sameNsAsRecipe = namespace === recipe.metadata.namespace
  const svcOwnerRefs = sameNsAsRecipe ? [ownerRef(recipe)] : undefined

  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name,
      namespace,
      ...(svcOwnerRefs && { ownerReferences: svcOwnerRefs }),
      labels: workloadLabels(recipe.metadata.name, workload.id, contextRef),
    },
    spec: {
      type: 'ClusterIP',
      selector: { app: selectorApp },
      ports: [{ port: workload.port, targetPort: workload.port, protocol: 'TCP', name: 'mcp' }],
    },
  }
}

// ─── K8s API Operations ──────────────────────────────────────────────

/** Create or update a ClusterIP Service. Idempotent (409 → read + replace preserving clusterIP). */
async function ensureTransportService(
  deps: DelegationDeps,
  svc: k8s.V1Service,
  namespace: string
): Promise<void> {
  const name = svc.metadata!.name!
  try {
    await deps.coreApi.createNamespacedService({ namespace, body: svc })
    console.log(`[MCP-Delegation] Created transport Service "${name}"`)
  } catch (error) {
    if (getErrorCode(error) === 409) {
      const existing = await deps.coreApi.readNamespacedService({ name, namespace })
      const updatedSvc: k8s.V1Service = {
        ...svc,
        metadata: { ...svc.metadata, resourceVersion: existing.metadata?.resourceVersion },
        spec: { ...svc.spec, clusterIP: existing.spec?.clusterIP },
      }
      await deps.coreApi.replaceNamespacedService({ name, namespace, body: updatedSvc })
      console.log(`[MCP-Delegation] Updated transport Service "${name}"`)
    } else {
      throw error
    }
  }
}

/** Create or update an McpServer CRD. Idempotent (409 → replace).
 *
 * Name collision guard (H-12): before creating, checks if an existing McpServer
 * is first-party (no `clerum.io/recipe` label). If so, throws to prevent silent
 * overwrite of admin-managed servers.
 */
async function ensureMcpServer(
  deps: DelegationDeps,
  manifest: Record<string, unknown>,
  namespace: string
): Promise<void> {
  const meta = manifest.metadata as { name: string; labels?: Record<string, string> }
  const desiredRecipeLabel = meta.labels?.['clerum.io/recipe']
  if (!desiredRecipeLabel) {
    throw new Error(`McpServer "${meta.name}" manifest is missing clerum.io/recipe label.`)
  }

  // Stamp the desired-spec hash so every write (create + replace) carries it and the
  // next reconcile can detect a true no-op. We compare this hash — NOT existing.spec —
  // because the McpServer CRD server-defaults spec fields the manifest omits, which
  // would make a direct spec compare never match.
  stampSpecHash(manifest as { metadata?: { annotations?: Record<string, string> } })

  const readExisting = async () =>
    (await deps.customApi.getNamespacedCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      namespace,
      plural: MCPSERVER_PLURAL,
      name: meta.name,
    })) as {
      metadata?: {
        labels?: Record<string, string>
        annotations?: Record<string, string>
        resourceVersion?: string
      }
      spec?: unknown
    }

  // Returns true when a replace PUT was actually issued, false when the existing
  // object already matched (idempotent skip) — so callers can log honestly.
  const replaceFromExisting = async (
    initialExisting: Awaited<ReturnType<typeof readExisting>>
  ): Promise<boolean> => {
    let existing = initialExisting
    let lastConflict: unknown

    for (let attempt = 1; attempt <= MCPSERVER_REPLACE_CONFLICT_RETRIES; attempt += 1) {
      const isRecipeOwned = existing.metadata?.labels?.['clerum.io/recipe']
      if (!isRecipeOwned) {
        throw new Error(
          `McpServer "${meta.name}" already exists as a first-party server (no clerum.io/recipe label). ` +
            `Recipe workload must use a different ID to avoid name collision.`
        )
      }
      if (desiredRecipeLabel && isRecipeOwned !== desiredRecipeLabel) {
        throw new Error(
          `McpServer "${meta.name}" already exists for recipe "${isRecipeOwned}". ` +
            `Recipe "${desiredRecipeLabel}" must use a different workload ID to avoid name collision.`
        )
      }

      // Recipe-owned: safe to replace (idempotent update path).
      // Merge annotations: existing annotations are preserved as the base; WRC manifest
      // annotations override only the keys they specify. This prevents WRC updates from
      // erasing HCC-managed annotations during concurrent reconciles.
      // EXCEPTION (Issue #408): the pre-deploy network ack pair
      // (clerum.io/network-ready + clerum.io/network-ready-observed-generation) is dropped
      // from the carry-over here. This branch runs only when the DESIRED manifest's
      // spec-hash differs from the stored one (the idempotency gate below returns false and
      // skips the replace when they match), so a byte-identical desired object is never
      // rewritten by this path. Dropping the ack is idempotent: HCC re-acks after
      // re-applying NetworkPolicies for the current generation via its
      // (annotation !== 'true' || stamped-generation !== current) guard, so a stale ack
      // cannot satisfy the gate for the new generation.
      const rv = existing.metadata?.resourceVersion
      const existingAnnotations = existing.metadata?.annotations ?? {}
      const manifestAnnotations =
        ((manifest.metadata as Record<string, unknown>).annotations as
          | Record<string, string>
          | undefined) ?? {}

      // Idempotency gate: skip the replace when the existing recipe-owned object
      // already carries the spec-hash we are about to write. The hash is computed from
      // the DESIRED manifest (incl. its labels/annotations), so it is immune to the
      // server-defaulted spec fields that a direct spec compare would trip over. WRC
      // re-reconciles every McpServer each resync; an unconditional replace bumps
      // resourceVersion, which HCC watches → it recomputes context NetworkPolicies
      // every loop (a no-op write storm). Skipping unchanged writes stops that.
      if (
        specHashUnchanged(
          manifest as { metadata?: { annotations?: Record<string, string> } },
          existing
        )
      ) {
        return false
      }

      const carriedAnnotations: Record<string, string> = { ...existingAnnotations }
      // Only the network ack pair is dropped. Other HCC-relevant handshake keys
      // (notably clerum.io/pre-deploy) intentionally carry over from `existing`, even
      // on the delegate path that does not re-specify them — HCC's re-ack guard keys
      // off pre-deploy, so this is not the full set of handshake keys, just the ack.
      delete carriedAnnotations[NETWORK_READY_ANNOTATION]
      delete carriedAnnotations[NETWORK_READY_GENERATION_ANNOTATION]
      const mergedAnnotations = { ...carriedAnnotations, ...manifestAnnotations }
      const updatedManifest = {
        ...manifest,
        metadata: {
          ...(manifest.metadata as Record<string, unknown>),
          annotations: mergedAnnotations,
          ...(rv && { resourceVersion: rv }),
        },
      }

      try {
        await deps.customApi.replaceNamespacedCustomObject({
          group: CRD_GROUP,
          version: CRD_VERSION,
          namespace,
          plural: MCPSERVER_PLURAL,
          name: meta.name,
          body: updatedManifest,
        })
        return true
      } catch (error) {
        if (getErrorCode(error) !== 409) throw error
        lastConflict = error
        if (attempt === MCPSERVER_REPLACE_CONFLICT_RETRIES) break
        try {
          existing = await readExisting()
        } catch {
          // Transient read failure during a conflict retry: stop retrying and surface
          // the original 409 conflict below rather than masking it with the read error.
          break
        }
      }
    }

    try {
      const latest = await readExisting()
      const isRecipeOwned = latest.metadata?.labels?.['clerum.io/recipe']
      if (
        isRecipeOwned === desiredRecipeLabel &&
        mcpServerSpecMatches(latest.spec, manifest.spec)
      ) {
        console.warn(
          `[MCP-Delegation] McpServer "${meta.name}" kept existing recipe-owned object after ` +
            `${MCPSERVER_REPLACE_CONFLICT_RETRIES} replace conflict retries; existing spec already matches desired state.`
        )
        return false
      }
    } catch {
      // Preserve the original conflict error below when the final read cannot
      // prove that a recipe-owned object exists.
    }

    throw new Error(
      `McpServer "${meta.name}": failed to update after conflict retries: ${String(lastConflict)}`
    )
  }

  // Pre-check: guard against overwriting first-party (non-recipe-owned) McpServers.
  try {
    const existing = await readExisting()
    const replaced = await replaceFromExisting(existing)
    if (replaced) {
      console.log(`[MCP-Delegation] Updated McpServer "${meta.name}"`)
    } else {
      console.log(`[MCP-Delegation] McpServer "${meta.name}" unchanged; skipping update`)
    }
  } catch (error) {
    if (getErrorCode(error) === 404) {
      // Does not exist yet — safe to create
      try {
        await deps.customApi.createNamespacedCustomObject({
          group: CRD_GROUP,
          version: CRD_VERSION,
          namespace,
          plural: MCPSERVER_PLURAL,
          body: manifest,
        })
        console.log(`[MCP-Delegation] Created McpServer "${meta.name}"`)
      } catch (createError) {
        if (getErrorCode(createError) === 409) {
          const latest = await readExisting()
          const replaced = await replaceFromExisting(latest)
          if (replaced) {
            console.log(`[MCP-Delegation] Updated McpServer "${meta.name}" after create conflict`)
          } else {
            console.log(
              `[MCP-Delegation] McpServer "${meta.name}" unchanged after create conflict; skipping update`
            )
          }
        } else {
          throw createError
        }
      }
    } else if (error instanceof Error && error.message.includes('first-party server')) {
      throw error // Re-throw our name-collision guard error
    } else {
      throw error
    }
  }
}

/** Delete an McpServer CRD. 404 = already gone (idempotent). */
async function deleteMcpServer(
  deps: DelegationDeps,
  name: string,
  namespace: string
): Promise<void> {
  try {
    await deps.customApi.deleteNamespacedCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      namespace,
      plural: MCPSERVER_PLURAL,
      name,
    })
    console.log(`[MCP-Delegation] Deleted McpServer "${name}"`)
  } catch (error) {
    if (getErrorCode(error) === 404) {
      console.log(`[MCP-Delegation] McpServer "${name}" already gone`)
    } else {
      throw error
    }
  }
}

/**
 * Issue #637 — tear down a single transport workload's delegation (McpServer CRD
 * + transport Service) when its Secret ownership was REVOKED after it was already
 * delegated. The create-time gate (preDeploy/delegate skip) only stops NEW foreign
 * refs; an already-materialized McpServer CRD keeps feeding the foreign credential
 * to HCC until it is removed. Deleting the McpServer CRD makes HCC tear down any
 * managed (stdio) Deployment; the Service is removed explicitly. Idempotent
 * (404-tolerant). Stateful/PVC guards are the caller's responsibility.
 */
export async function deleteTransportDelegation(
  deps: DelegationDeps,
  recipe: WorkflowRecipeCRD,
  workload: WorkloadDef,
  namespace: string
): Promise<void> {
  if (!workload.transport) return
  const name = mcpServerName(recipe.metadata.name, workload.id, recipe)
  await deleteMcpServer(deps, name, namespace)
  try {
    await deps.coreApi.deleteNamespacedService({ name, namespace })
    console.log(`[MCP-Delegation] Deleted transport Service "${name}" (ownership revoked)`)
  } catch (error) {
    if (getErrorCode(error) !== 404) throw error
  }
}

/**
 * Create a per-recipe Context CRD (H-04 isolation fix).
 *
 * Instead of patching the shared Context allowlist, each workflow recipe gets
 * its own Context CRD named `wf-{recipeName}`. This prevents recipe MCP servers
 * from leaking into unrelated mcp-host instances using the shared Context.
 *
 * The Context has an ownerReference to the WorkflowRecipe so K8s GC handles
 * deletion automatically. Belt-and-suspenders explicit delete in cleanupDelegation.
 *
 * Returns the per-recipe context name.
 */
export async function ensureRecipeContext(
  deps: DelegationDeps,
  recipeOrName: WorkflowRecipeCRD | string,
  serverNames: string[],
  namespace: string,
  ownerReference: {
    apiVersion: string
    kind: string
    name: string
    uid: string
    controller?: boolean
    blockOwnerDeletion?: boolean
  },
  recipeNamespace?: string
): Promise<string> {
  const isRecipeObject = typeof recipeOrName !== 'string'
  const explicitContext = isRecipeObject && hasExplicitWorkflowContextRef(recipeOrName)
  const recipeName = typeof recipeOrName === 'string' ? recipeOrName : recipeOrName.metadata.name
  const contextName =
    typeof recipeOrName === 'string'
      ? privateWorkflowContextName(recipeName)
      : effectiveWorkflowContextRef(recipeOrName)
  // Cross-namespace ownerRefs are invalid (see buildMcpServerManifest for the
  // same rationale). Context lives in `mcp-server` alongside McpServer CRDs;
  // recipe lives in `sandbox-recipes` post canonical-namespace refactor.
  const sameNsAsRecipe = recipeNamespace === undefined || namespace === recipeNamespace
  const contextBody = {
    apiVersion: `${CRD_GROUP}/${CRD_VERSION}`,
    kind: 'Context',
    metadata: {
      name: contextName,
      namespace,
      ...(!explicitContext && sameNsAsRecipe && { ownerReferences: [ownerReference] }),
      labels: {
        'clerum.io/recipe': recipeName,
        'clerum.io/managed-by': 'wrc',
      },
    },
    spec: {
      contextId: contextName,
      mcpServers: serverNames,
    },
  }

  const replaceExistingContext = async (): Promise<void> => {
    for (let attempt = 1; attempt <= CONTEXT_REPLACE_CONFLICT_RETRIES; attempt += 1) {
      const existing = (await deps.customApi.getNamespacedCustomObject({
        group: CRD_GROUP,
        version: CRD_VERSION,
        namespace,
        plural: CONTEXT_PLURAL,
        name: contextName,
      })) as {
        metadata?: { resourceVersion?: string; labels?: Record<string, string> }
        spec?: { contextId?: string; mcpServers?: string[]; [key: string]: unknown }
      }
      const existingServers = Array.isArray(existing.spec?.mcpServers)
        ? existing.spec.mcpServers
        : []
      const mergedServers = explicitContext
        ? Array.from(new Set([...existingServers, ...serverNames]))
        : serverNames

      try {
        await deps.customApi.replaceNamespacedCustomObject({
          group: CRD_GROUP,
          version: CRD_VERSION,
          namespace,
          plural: CONTEXT_PLURAL,
          name: contextName,
          body: {
            ...contextBody,
            metadata: {
              ...contextBody.metadata,
              labels: {
                ...(existing.metadata?.labels ?? {}),
                ...contextBody.metadata.labels,
              },
              resourceVersion: existing.metadata?.resourceVersion,
            },
            spec: {
              ...(existing.spec ?? {}),
              contextId: existing.spec?.contextId || contextName,
              mcpServers: mergedServers,
            },
          },
        })
        return
      } catch (replaceError) {
        if (getErrorCode(replaceError) === 409) {
          if (attempt < CONTEXT_REPLACE_CONFLICT_RETRIES) {
            continue
          }
          throw new Error(`failed to update Context "${contextName}" after conflict retries`)
        }
        throw replaceError
      }
    }
  }

  try {
    await deps.customApi.createNamespacedCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      namespace,
      plural: CONTEXT_PLURAL,
      body: contextBody,
    })
    console.log(
      `[MCP-Delegation] Created per-recipe Context "${contextName}" with ${serverNames.length} server(s)`
    )
  } catch (error) {
    if (getErrorCode(error) === 409) {
      await replaceExistingContext()
      console.log(
        `[MCP-Delegation] Updated per-recipe Context "${contextName}" with ${serverNames.length} server(s)`
      )
    } else {
      throw error
    }
  }
  return contextName
}

// ─── Network Isolation Handshake (Option C) ──────────────────────────

/**
 * Annotation keys for the pre-deploy network isolation handshake.
 *
 * Flow:
 *   1. WRC creates McpServer CR with `clerum.io/pre-deploy: "true"`
 *   2. HCC sees McpServer CR → creates required NetworkPolicies
 *   3. For external-egress workloads, HCC writes ExternalEgressReady for the
 *      observed McpServer generation; for stdio workloads, HCC sets the legacy
 *      `clerum.io/network-ready: "true"` annotation.
 *   4. WRC observes the matching readiness signal → creates Deployment/StatefulSet
 *
 * This ensures pods never start before the relevant NetworkPolicies are applied,
 * without requiring ReadinessGates or cross-controller pod patching.
 * Communication stays 100% via CRDs.
 *
 * See: PHASE-9-PRE-PRODUCTION-HARDENING.md §GAP 14, Option C
 */
// Handshake annotation keys now live in @clerum/network-policy-core (single source of
// truth shared with HCC — a divergence is a compile error, not a silent 30s timeout).
// Re-exported here so existing WRC consumers keep importing them from this module.
// clerum.io/network-ready-observed-generation (Issue #408) is the generation HCC
// stamps when acking, so WRC can reject a stale ack from a prior generation.
export { PRE_DEPLOY_ANNOTATION, NETWORK_READY_ANNOTATION, NETWORK_READY_GENERATION_ANNOTATION }
const NETWORK_READY_POLL_INTERVAL_MS = 1_000
const NETWORK_READY_TIMEOUT_MS = 30_000

/**
 * Pre-deploy phase: Create McpServer CRDs with pre-deploy annotation
 * BEFORE creating workload resources. This signals HCC to apply
 * NetworkPolicies proactively.
 *
 * `secretAccess` (Issue #637) is REQUIRED: the classifySecretAccess verdict map
 * the reconciler already computed (per-workload namespace). A transport workload
 * referencing an ownership-denied Secret is SKIPPED here — no McpServer CRD, no
 * Service — so HCC never materializes the foreign credential. Making the param
 * required forces every caller to gate; there is no silent-bypass default.
 *
 * Returns array of McpServer names that were pre-deployed.
 */
export async function preDeployMcpServers(
  deps: DelegationDeps,
  recipe: WorkflowRecipeCRD,
  namespace: string,
  secretAccess: ReadonlyMap<string, SecretAccess>
): Promise<string[]> {
  const transportWorkloads = (recipe.spec.workloads ?? [])
    .filter(w => !!w.transport)
    .filter(workload => {
      if (transportWorkloadSecretDenied(workload, secretAccess)) {
        console.error(
          `[MCP-Delegation] Issue #637: refusing to pre-deploy transport workload "${workload.id}" ` +
            `in recipe "${recipe.metadata.name}" — it references a Secret it does not own ` +
            `(denied/unverified). No McpServer CRD or Service will be created.`
        )
        return false
      }
      return true
    })

  // P-1: parallel pre-deploy — independent per workload, allSettled to surface all errors
  const results = await Promise.allSettled(
    transportWorkloads.map(async workload => {
      const manifest = buildMcpServerManifest(workload, recipe, namespace, secretAccess)
      if (!manifest) return null

      // Add pre-deploy annotation to signal HCC
      const meta = manifest.metadata as Record<string, unknown>
      meta.annotations = {
        ...((meta.annotations as Record<string, string>) ?? {}),
        [PRE_DEPLOY_ANNOTATION]: 'true',
      }

      // Also create the transport Service (needed for DNS resolution in McpServer URL)
      const svc = buildTransportService(workload, recipe, namespace)
      if (svc) {
        await ensureTransportService(deps, svc, namespace)
      }

      await ensureMcpServer(deps, manifest, namespace)
      return mcpServerName(recipe.metadata.name, workload.id, recipe)
    })
  )

  const preDeployed: string[] = []
  const errors: Array<{ workloadId: string; error: unknown }> = []
  for (const [i, r] of results.entries()) {
    if (r.status === 'fulfilled' && r.value) {
      preDeployed.push(r.value)
    } else if (r.status === 'rejected') {
      const workloadId = transportWorkloads[i].id
      console.warn(
        `[MCP-Delegation] Pre-deploy failed for workload "${workloadId}": ${String(r.reason)}`
      )
      errors.push({ workloadId, error: r.reason })
    }
  }
  if (errors.length > 0) {
    const ids = errors.map(e => e.workloadId).join(', ')
    throw new Error(
      `Pre-deploy failed for workload(s): ${ids}. Reconciler will retry to ensure all NetworkPolicies are applied before workloads start.`
    )
  }

  // Create (or update) the per-recipe Context CRD immediately after McpServers
  // are pre-deployed. This makes the allowlist visible to E2E tests and downstream
  // watchers in ~2-3s, well before waitForNetworkReady completes (~30s for stdio).
  // delegateTransportWorkloads (Step 9a) will call ensureRecipeContext again
  // idempotently after the network handshake completes.
  if (preDeployed.length > 0) {
    const recipeOwnerRef = {
      apiVersion: `${CRD_GROUP}/${CRD_VERSION}` as const,
      kind: 'WorkflowRecipe',
      name: recipe.metadata.name,
      uid: recipe.metadata.uid ?? '',
      controller: true,
      blockOwnerDeletion: true,
    }
    try {
      await ensureRecipeContext(
        deps,
        recipe,
        preDeployed,
        namespace,
        recipeOwnerRef,
        recipe.metadata.namespace
      )
    } catch (err) {
      throw new Error(
        `Pre-deploy Context allowlist failed for "${recipe.metadata.name}": ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  return preDeployed
}

/**
 * Wait for HCC to set `clerum.io/network-ready: "true"` on all
 * pre-deployed McpServer CRDs.
 *
 * Polls each McpServer CR until the annotation appears or timeout.
 * The ack is honored only when HCC's stamped
 * `clerum.io/network-ready-observed-generation` matches the current
 * `metadata.generation` (Issue #408) — a stale ack from a prior generation
 * does not satisfy the gate. A non-numeric generation is tolerated as fresh.
 * Returns true if all are ready, false if timeout.
 */
export async function waitForNetworkReady(
  deps: DelegationDeps,
  serverNames: string[],
  namespace: string,
  timeoutMs: number = NETWORK_READY_TIMEOUT_MS
): Promise<{ ready: boolean; pending: string[] }> {
  if (serverNames.length === 0) return { ready: true, pending: [] }

  const deadline = Date.now() + timeoutMs
  const pending = new Set(serverNames)

  while (pending.size > 0 && Date.now() < deadline) {
    const results = await Promise.all(
      [...pending].map(async name => {
        try {
          const mcpServer = (await deps.customApi.getNamespacedCustomObject({
            group: CRD_GROUP,
            version: CRD_VERSION,
            namespace,
            plural: MCPSERVER_PLURAL,
            name,
          })) as {
            metadata?: { generation?: number; annotations?: Record<string, string> }
          }
          // Issue #408: mirror waitForExternalEgressReady's freshness check. The flat
          // 'true' ack carries no generation, so trust it only when HCC's stamped
          // generation matches the current one. A non-numeric generation is tolerated
          // as fresh (same tolerance as the condition-based gate).
          const annotations = mcpServer.metadata?.annotations
          const currentGeneration = mcpServer.metadata?.generation
          const ackFresh =
            typeof currentGeneration !== 'number' ||
            annotations?.[NETWORK_READY_GENERATION_ANNOTATION] === String(currentGeneration)
          return {
            name,
            ready: annotations?.[NETWORK_READY_ANNOTATION] === 'true' && ackFresh,
          }
        } catch (error) {
          // 404 = McpServer deleted externally — treat as resolved
          return { name, ready: getErrorCode(error) === 404 }
        }
      })
    )

    for (const { name, ready } of results) {
      if (ready) {
        pending.delete(name)
        console.log(`[MCP-Delegation] Network ready for "${name}"`)
      }
    }

    if (pending.size > 0) {
      await new Promise(resolve => setTimeout(resolve, NETWORK_READY_POLL_INTERVAL_MS))
    }
  }

  if (pending.size > 0) {
    console.warn(
      `[MCP-Delegation] Network ready timeout (${timeoutMs}ms) for: ${[...pending].join(', ')}. ` +
        `This generic readiness check is not used to unblock workloads with external egress.`
    )
  }

  return { ready: pending.size === 0, pending: [...pending] }
}

function externalEgressCondition(mcpServer: {
  status?: { conditions?: ConditionLike[] }
}): ConditionLike | undefined {
  return mcpServer.status?.conditions?.find(
    condition => condition.type === EXTERNAL_EGRESS_READY_CONDITION
  )
}

/**
 * Wait for HCC to report ExternalEgressReady=True on child McpServer CRDs.
 *
 * This is the security readiness gate for WorkflowRecipe transport workloads
 * with egressBindings. The legacy network-ready annotation only proves that
 * generic L2/L3 policy reconciliation ran; it is not evidence that exact-host
 * external egress policies were resolved and applied.
 */
export async function waitForExternalEgressReady(
  deps: DelegationDeps,
  serverNames: string[],
  namespace: string,
  timeoutMs: number = NETWORK_READY_TIMEOUT_MS
): Promise<{
  ready: boolean
  pending: string[]
  failed: Array<{ name: string; message: string }>
}> {
  if (serverNames.length === 0) return { ready: true, pending: [], failed: [] }

  const deadline = Date.now() + timeoutMs
  const pending = new Set(serverNames)
  const failed = new Map<string, string>()

  while (pending.size > 0 && failed.size === 0 && Date.now() < deadline) {
    const results = await Promise.all(
      [...pending].map(async name => {
        try {
          const mcpServer = (await deps.customApi.getNamespacedCustomObject({
            group: CRD_GROUP,
            version: CRD_VERSION,
            namespace,
            plural: MCPSERVER_PLURAL,
            name,
          })) as { metadata?: { generation?: number }; status?: { conditions?: ConditionLike[] } }
          const condition = externalEgressCondition(mcpServer)
          const currentGeneration = mcpServer.metadata?.generation
          const isFresh =
            typeof currentGeneration !== 'number' ||
            condition?.observedGeneration === currentGeneration
          return {
            name,
            status: isFresh ? condition?.status : 'Unknown',
            reason: isFresh ? condition?.reason : undefined,
            message:
              isFresh && condition
                ? (condition.message ??
                  condition.reason ??
                  `${EXTERNAL_EGRESS_READY_CONDITION} is ${condition.status}`)
                : condition
                  ? `${EXTERNAL_EGRESS_READY_CONDITION} is stale for generation ${currentGeneration}`
                  : `${EXTERNAL_EGRESS_READY_CONDITION} is missing`,
          }
        } catch (error) {
          return {
            name,
            status: getErrorCode(error) === 404 ? 'False' : 'Unknown',
            reason: getErrorCode(error) === 404 ? 'McpServerDeleted' : 'InventoryReadFailed',
            message:
              getErrorCode(error) === 404
                ? 'McpServer was deleted before external egress became ready'
                : String(error),
          }
        }
      })
    )

    for (const result of results) {
      if (result.status === 'True') {
        pending.delete(result.name)
        console.log(`[MCP-Delegation] External egress ready for "${result.name}"`)
      } else if (result.status === 'False') {
        if (!result.reason || !RETRYABLE_EXTERNAL_EGRESS_REASONS.has(result.reason)) {
          failed.set(result.name, result.message ?? `${EXTERNAL_EGRESS_READY_CONDITION} is False`)
        }
      }
    }

    if (pending.size > 0 && failed.size === 0) {
      await new Promise(resolve => setTimeout(resolve, NETWORK_READY_POLL_INTERVAL_MS))
    }
  }

  const failedList = [...failed.entries()].map(([name, message]) => ({ name, message }))
  if (pending.size > 0 || failedList.length > 0) {
    console.warn(
      `[MCP-Delegation] External egress readiness not achieved for: ${[
        ...pending,
        ...failed.keys(),
      ].join(', ')}`
    )
  }

  return {
    ready: pending.size === 0 && failedList.length === 0,
    pending: [...pending],
    failed: failedList,
  }
}

// ─── Orchestrators ───────────────────────────────────────────────────

/**
 * Delegate all transport workloads in a recipe.
 *
 * For each workload with transport:
 *   1. Create transport Service (ClusterIP)
 *   2. Create McpServer CRD (managed: false for HTTP, managed: true for stdio)
 *
 * After all workloads are processed, creates a per-recipe Context CRD (H-04):
 *   3. Create/update Context `wf-{recipeName}` with all delegated server names
 *
 * This replaces the shared-context patch approach: each recipe gets isolated
 * visibility — its mcp-host only sees servers in `wf-{recipeName}`, not the
 * shared Context. The Context has ownerReferences so K8s GC handles deletion.
 *
 * NOTE: When using the pre-deploy handshake (Option C), McpServer CRDs
 * and Services are already created by preDeployMcpServers(). This function
 * then only needs to ensure idempotent updates to existing McpServer CRDs
 * and create/update the per-recipe Context.
 *
 * `secretAccess` (Issue #637) is REQUIRED: same verdict map preDeployMcpServers
 * used. A transport workload referencing an ownership-denied Secret is SKIPPED —
 * not delegated, never re-creating an McpServer CRD that carries the foreign
 * credential. (preDeploy already skipped it; this keeps the idempotent re-ensure
 * pass equally fail-closed.)
 *
 * Returns array of delegated McpServer names.
 */
export async function delegateTransportWorkloads(
  deps: DelegationDeps,
  recipe: WorkflowRecipeCRD,
  namespace: string,
  secretAccess: ReadonlyMap<string, SecretAccess>
): Promise<string[]> {
  const transportWorkloads = (recipe.spec.workloads ?? [])
    .filter(w => !!w.transport)
    .filter(workload => {
      if (transportWorkloadSecretDenied(workload, secretAccess)) {
        console.error(
          `[MCP-Delegation] Issue #637: refusing to delegate transport workload "${workload.id}" ` +
            `in recipe "${recipe.metadata.name}" — it references a Secret it does not own ` +
            `(denied/unverified). Its McpServer CRD will not be (re)created.`
        )
        return false
      }
      return true
    })

  // Parallel delegation — independent per workload, allSettled collects all errors
  const results = await Promise.allSettled(
    transportWorkloads.map(async workload => {
      const serverName = mcpServerName(recipe.metadata.name, workload.id, recipe)

      // 1. Create transport Service
      const svc = buildTransportService(workload, recipe, namespace)
      if (svc) {
        await ensureTransportService(deps, svc, namespace)
      }

      // 2. Create McpServer CRD
      const manifest = buildMcpServerManifest(workload, recipe, namespace, secretAccess)
      if (manifest) {
        await ensureMcpServer(deps, manifest, namespace)
      }

      return serverName
    })
  )

  const delegated: string[] = []
  const errors: Array<{ workloadId: string; error: unknown }> = []
  for (const [i, r] of results.entries()) {
    if (r.status === 'fulfilled') {
      delegated.push(r.value)
    } else {
      const workloadId = transportWorkloads[i].id
      console.error(`[MCP-Delegation] Failed to delegate workload "${workloadId}":`, r.reason)
      errors.push({ workloadId, error: r.reason })
    }
  }

  if (errors.length > 0) {
    const ids = errors.map(e => e.workloadId).join(', ')
    throw new Error(
      `Delegation failed for workload(s): ${ids}. ${delegated.length} workload(s) delegated successfully.`
    )
  }

  // 3. Create per-recipe Context CRD (H-04 isolation) — only if there are MCP servers.
  // Replaces the shared-context patch approach to prevent cross-recipe visibility leaks.
  if (delegated.length > 0) {
    const recipeOwnerRef = {
      apiVersion: `${CRD_GROUP}/${CRD_VERSION}` as const,
      kind: 'WorkflowRecipe',
      name: recipe.metadata.name,
      uid: recipe.metadata.uid ?? '',
      controller: true,
      blockOwnerDeletion: true,
    }
    await ensureRecipeContext(
      deps,
      recipe,
      delegated,
      namespace,
      recipeOwnerRef,
      recipe.metadata.namespace
    )
  }

  return delegated
}

/**
 * Cleanup delegation for a deleted recipe.
 *
 * For each transport workload:
 *   1. Delete McpServer CRD (belt-and-suspenders, ownerRef GC also handles this)
 *   2. Delete transport Service (belt-and-suspenders)
 *
 * After all workloads: explicitly delete the per-recipe Context CRD `wf-{recipeName}`
 * as belt-and-suspenders alongside ownerRef GC (H-04).
 *
 * NOTE: unpatchContextAllowlist is no longer called here — the shared Context is no
 * longer patched by delegateTransportWorkloads. Per-recipe isolation (H-04) means
 * each recipe has its own Context CRD with an ownerReference.
 */
export async function cleanupDelegation(
  deps: DelegationDeps,
  recipe: WorkflowRecipeCRD,
  namespace: string
): Promise<void> {
  const transportWorkloads = (recipe.spec.workloads ?? []).filter(w => !!w.transport)
  const cleanupFailures: string[] = []

  // P-2: parallel cleanup — allSettled so all workloads are attempted even if one fails
  const workloadResults = await Promise.allSettled(
    transportWorkloads.map(async workload => {
      const serverName = mcpServerName(recipe.metadata.name, workload.id, recipe)

      // 1. Delete McpServer CRD (ownerRef GC also handles this)
      await deleteMcpServer(deps, serverName, namespace)

      // 2. Delete transport Service (belt-and-suspenders)
      try {
        await deps.coreApi.deleteNamespacedService({ name: serverName, namespace })
        console.log(`[MCP-Delegation] Deleted transport Service "${serverName}"`)
      } catch (error) {
        if (getErrorCode(error) === 404) {
          console.log(`[MCP-Delegation] Transport Service "${serverName}" already gone`)
        } else {
          throw error
        }
      }
    })
  )

  // Belt-and-suspenders: explicitly delete per-recipe Context CRD (H-04).
  // ownerRef GC handles this automatically, but explicit delete closes the timing window.
  const recipeContextName = effectiveWorkflowContextRef(recipe)
  if (hasExplicitWorkflowContextRef(recipe)) {
    const serverNames = new Set(
      transportWorkloads.map(w => mcpServerName(recipe.metadata.name, w.id, recipe))
    )
    let removed = false
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const existing = (await deps.customApi.getNamespacedCustomObject({
          group: CRD_GROUP,
          version: CRD_VERSION,
          namespace,
          plural: CONTEXT_PLURAL,
          name: recipeContextName,
        })) as {
          metadata?: { resourceVersion?: string }
          spec?: { contextId?: string; mcpServers?: string[] }
        }
        const remainingServers = (existing.spec?.mcpServers ?? []).filter(
          name => !serverNames.has(name)
        )
        try {
          await deps.customApi.replaceNamespacedCustomObject({
            group: CRD_GROUP,
            version: CRD_VERSION,
            namespace,
            plural: CONTEXT_PLURAL,
            name: recipeContextName,
            body: {
              ...existing,
              metadata: {
                ...(existing.metadata ?? {}),
                resourceVersion: existing.metadata?.resourceVersion,
              },
              spec: {
                ...(existing.spec ?? {}),
                contextId: existing.spec?.contextId || recipeContextName,
                mcpServers: remainingServers,
              },
            },
          })
          removed = true
          break
        } catch (error) {
          if (getErrorCode(error) === 409) {
            continue
          }
          throw error
        }
      }
      if (!removed) {
        throw new Error(`failed to update Context "${recipeContextName}" after conflict retries`)
      }
      console.log(`[MCP-Delegation] Removed recipe servers from Context "${recipeContextName}"`)
    } catch (error) {
      if (getErrorCode(error) === 404) {
        console.log(`[MCP-Delegation] Explicit Context "${recipeContextName}" already gone`)
      } else {
        cleanupFailures.push(
          `Context "${recipeContextName}": ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }
  } else {
    await deps.customApi
      .deleteNamespacedCustomObject({
        group: CRD_GROUP,
        version: CRD_VERSION,
        namespace,
        plural: CONTEXT_PLURAL,
        name: recipeContextName,
      })
      .then(() => console.log(`[MCP-Delegation] Deleted per-recipe Context "${recipeContextName}"`))
      .catch(error => {
        if (getErrorCode(error) === 404) {
          console.log(`[MCP-Delegation] Per-recipe Context "${recipeContextName}" already gone`)
        } else {
          cleanupFailures.push(
            `Context "${recipeContextName}": ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }
      })
  }

  // Belt-and-suspenders label-selector sweep. The by-name loop above only
  // deletes workloads that still appear in `recipe.spec.workloads`. If a
  // workload was renamed/removed between create and delete, its McpServer +
  // Service would leak. Post Phase-8 cross-namespace placement, native GC
  // cannot reap them (ownerRef stripped), so we explicitly sweep by label.
  // `workloadLabels` in resourceBuilder stamps every child with
  // `clerum.io/recipe=<recipeName>`.
  const recipeSelector = `clerum.io/recipe=${recipe.metadata.name}`
  const sweepResults = await Promise.allSettled([
    deps.customApi
      .deleteCollectionNamespacedCustomObject({
        group: CRD_GROUP,
        version: CRD_VERSION,
        namespace,
        plural: MCPSERVER_PLURAL,
        labelSelector: recipeSelector,
      })
      .catch(error => {
        if (getErrorCode(error) === 404) {
          return
        }
        throw new Error(
          `McpServer label sweep failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }),
    deps.coreApi
      .deleteCollectionNamespacedService({ namespace, labelSelector: recipeSelector })
      .catch(error => {
        if (getErrorCode(error) === 404) {
          return
        }
        throw new Error(
          `Service label sweep failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }),
  ])
  for (const result of sweepResults) {
    if (result.status === 'rejected') {
      cleanupFailures.push(
        result.reason instanceof Error ? result.reason.message : String(result.reason)
      )
    }
  }

  const errors = workloadResults
    .map((r, i) =>
      r.status === 'rejected' ? { workloadId: transportWorkloads[i].id, error: r.reason } : null
    )
    .filter((e): e is { workloadId: string; error: unknown } => e !== null)

  if (errors.length > 0) {
    const ids = errors.map(e => e.workloadId).join(', ')
    cleanupFailures.push(`Cleanup failed for workload(s): ${ids}`)
  }

  if (cleanupFailures.length > 0) {
    throw new Error(cleanupFailures.join('; '))
  }
}
