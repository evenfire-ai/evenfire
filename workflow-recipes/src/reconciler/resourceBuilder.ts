import * as k8s from '@kubernetes/client-node'
import { createHash, randomBytes } from 'node:crypto'
import {
  EVENFIRE_REGISTRY_PULL_SECRET_NAME,
  isPlatformRegistryImage,
} from '@clerum/workflow-runtime-core'
import { loadConfig } from '../config'
import {
  ConfigMapResourceDef,
  CronJobDef,
  DaemonSetDef,
  DeploymentDef,
  JobDef,
  PvcResourceDef,
  SecretResourceDef,
  SecurityIsolationLevel,
  StatefulSetDef,
  WorkflowRecipeCRD,
  WorkloadDef,
} from '../types'
import { pluginWorkloadSdkTokenSecretKey } from '../workflow/pluginWorkloadSdkTokens'
import {
  buildPluginWorkloadSdkEndpoint,
  buildPluginWorkloadSdkTokenSecretName,
} from '../workflow/resourceNames'
import { OWNER_RECIPE_LABEL_KEY } from './secretOwnership'
import { buildWithOverrides } from './securityContext'
import { workloadEffectiveContextRef } from './workflowContext'

const MANAGED_BY_LABEL = 'clerum.io/managed-by'
const RECIPE_LABEL = 'clerum.io/recipe'
const CONTEXT_LABEL = 'clerum.io/context'
const WORKLOAD_LABEL = 'clerum.io/workload'
const RESOURCE_LABEL = 'clerum.io/resource'
const MCPSERVER_LABEL = 'clerum.io/mcpserver'
const SANDBOX_UI_LABEL = 'clerum.io/sandbox-ui'
const RECIPE_NAMESPACE_LABEL = 'clerum.io/recipe-namespace'
const RECIPE_NAME_LABEL = 'clerum.io/recipe-name'
const OAUTH_BROKER_CLIENT_LABEL = 'clerum.io/oauth-broker-client'

/**
 * Standard labels applied to ALL resources created by the WRC.
 *
 * NetworkPolicy layer usage:
 * - `clerum.io/recipe` is used by L3 binding-scoped NetworkPolicies to isolate
 *   per-recipe sandbox pods (only recipe-A's pods can reach recipe-A's MCP servers).
 * - `clerum.io/context` is used by L2 context-scoped NetworkPolicies to scope
 *   agent ↔ MCP server communication per Context CRD.
 */
export function standardLabels(
  recipeName: string,
  id: string,
  contextRef?: string,
  appName?: string
): Record<string, string> {
  const labels: Record<string, string> = {
    app: appName ?? id,
    [MANAGED_BY_LABEL]: 'workflow-recipes',
    [RECIPE_LABEL]: recipeName,
  }
  if (contextRef) {
    labels[CONTEXT_LABEL] = contextRef
  }
  return labels
}

export function workloadLabels(
  recipeName: string,
  workloadId: string,
  contextRef?: string,
  appName?: string
): Record<string, string> {
  return {
    ...standardLabels(recipeName, workloadId, contextRef, appName),
    [WORKLOAD_LABEL]: workloadId,
  }
}

function resourceLabels(
  recipeName: string,
  resourceId: string,
  contextRef?: string
): Record<string, string> {
  return { ...standardLabels(recipeName, resourceId, contextRef), [RESOURCE_LABEL]: resourceId }
}

/**
 * Labels applied to the Pod template + Service of a workload referenced by
 * `spec.ui.workloadRef`. These mark the pod as the sandbox UI of a recipe and
 * carry the (namespace, name) pair so cross-namespace selectors can match it
 * unambiguously:
 *
 * - `clerum.io/sandbox-ui=true` is the boolean marker the per-recipe
 *   `ui-egress-<recipeName>` NetworkPolicy uses as its podSelector base.
 * - `clerum.io/recipe-namespace` + `clerum.io/recipe-name` together identify
 *   the owning recipe; rpc-proxy reads them off the resolved Service to bind
 *   a session to a specific recipe.
 *
 * Returns an empty object when the workload is not the UI workload, so callers
 * can spread unconditionally.
 */
function sandboxUiLabels(workload: WorkloadDef, recipe: WorkflowRecipeCRD): Record<string, string> {
  if (!recipe.spec.ui || workload.id !== recipe.spec.ui.workloadRef) return {}
  return {
    [SANDBOX_UI_LABEL]: 'true',
    [RECIPE_NAMESPACE_LABEL]: recipe.metadata.namespace ?? '',
    [RECIPE_NAME_LABEL]: recipe.metadata.name,
  }
}

/**
 * Resolve the K8s resource name for a workload — DETERMINISTIC.
 *
 * Resolution order:
 * 1. If `status.workloadInstances[workloadId]` exists → use persisted name
 *    (fast path, stable across reconciles).
 * 2. Non-workflow recipes without a persisted assignment → use workload ID
 *    directly (builder backward compatibility; the reconciler assigns scoped
 *    names before creating resources).
 * 3. Workflow recipes (first reconcile, no status yet) → derive an 8-hex-char
 *    suffix from the recipe identity and workloadId.
 *
 * The UID-based hash is:
 *   - DETERMINISTIC across reconciles: every call returns the same name for
 *     the same (recipe UID, workloadId) pair. This fixes the orphan-service
 *     bug where two reconciles racing on the same fresh recipe produced two
 *     different `${recipe}-${workload}-${random}` names (both ended up as
 *     Services with no Deployment; coordinator then failed
 *     "Failed to connect to MCP servers: <workload>").
 *   - UNIQUE per recipe instance: K8s assigns a new UID on every CRD create,
 *     so a recipe delete+recreate (same metadata.name) produces a fresh UID
 *     → fresh hash → no collision with the old incarnation's orphaned resources.
 *   - COLLISION-RESISTANT across recipes: different UIDs produce different
 *     hashes even for recipes sharing a workloadId.
 *
 * K8s names must be DNS-compatible (max 63 chars, lowercase alphanumeric
 * + hyphens). 8 hex chars fits, lowercase by construction.
 */
const RESOURCE_NAME_MAX_LEN = 63
const RESOURCE_NAME_HASH_LEN = 8
// spec.resources[] names are new (issue #571) — nothing is pinned to 8 hex yet, so
// they use a wider 12-hex (48-bit) suffix. At 10k recipes × 5 resources the
// birthday-collision probability drops from ~25% (32-bit) to ~0.0007% (48-bit),
// removing the at-scale name-collision DoS. Workload suffixes stay at 8 (already
// persisted in status.workloadInstances; widening would re-scope live workloads).
const RESOURCE_INSTANCE_HASH_LEN = 12
// StatefulSets create multiple derived names/labels that are not validated when
// the StatefulSet object itself is accepted. The tightest limit is the
// `controller-revision-hash` label value on Pods, which uses
// `<statefulset>-<hash>` and must remain a DNS-1123 label (<=63 bytes).
// Kubernetes currently appends a 10-char hash, so reserve 1 dash + 10 hash
// chars. This also covers the stable Pod name `<statefulset>-<ordinal>`.
const STATEFULSET_POD_ORDINAL_SUFFIX_RESERVE = 4
const STATEFULSET_CONTROLLER_REVISION_HASH_SUFFIX_RESERVE = 11
const STATEFULSET_NAME_MAX_LEN =
  RESOURCE_NAME_MAX_LEN -
  Math.max(
    STATEFULSET_POD_ORDINAL_SUFFIX_RESERVE,
    STATEFULSET_CONTROLLER_REVISION_HASH_SUFFIX_RESERVE
  )
// CronJob children reserve the same 11 chars K8s appends to Jobs,
// so parent names must fit 52 chars.
const CRONJOB_CHILD_JOB_NAME_SUFFIX_RESERVE = 11
const CRONJOB_NAME_MAX_LEN = RESOURCE_NAME_MAX_LEN - CRONJOB_CHILD_JOB_NAME_SUFFIX_RESERVE

/**
 * Compose a 63-byte-safe Deployment/Service name from the recipe's name,
 * a workload identifier, and a deterministic 8-char hash suffix. When the
 * concatenation would exceed the DNS-1123 label limit the recipe-name stem
 * is truncated (trailing `-` stripped so we never emit `foo--web-search-…`).
 *
 * This is the same pattern used by `buildMcpHostServiceName`
 * (workflow/resourceNames.ts) — keeping them in sync means any stem that
 * fits into one fits into the other.
 */
function composeResourceName(stem: string, workloadId: string, suffix: string): string {
  const reserved = 1 + workloadId.length + 1 + suffix.length // two separators + workloadId + suffix
  const maxStem = Math.max(1, RESOURCE_NAME_MAX_LEN - reserved)
  const trimmedStem = stem.length > maxStem ? stem.slice(0, maxStem).replace(/-+$/g, '') : stem
  // `trimmedStem` can end up empty if the input was all hyphens (pathological
  // — upstream CRD validation rejects such names, but we fail-safe here).
  // In that case fall through to the same `'workflow'` literal
  // `buildDbRunChildName` uses, so the emitted name is still a DNS-1123 label.
  const safeStem = trimmedStem || 'workflow'.slice(0, maxStem)
  const composedName = `${safeStem}-${workloadId}-${suffix}`
  return composedName.length <= RESOURCE_NAME_MAX_LEN
    ? composedName
    : clampResourceName(composedName, RESOURCE_NAME_MAX_LEN)
}

function scopedWorkloadNameSuffix(recipe: WorkflowRecipeCRD, workloadId: string): string {
  const identity = recipe.metadata.uid
    ? `uid:${recipe.metadata.uid}`
    : `ref:${recipe.metadata.namespace ?? ''}:${recipe.metadata.name}`
  return createHash('sha256')
    .update(`${identity}:${workloadId}`)
    .digest('hex')
    .slice(0, RESOURCE_NAME_HASH_LEN)
}

export function resolveScopedWorkloadResourceName(
  recipe: WorkflowRecipeCRD,
  workloadId: string
): string {
  return composeResourceName(
    recipe.metadata.name,
    workloadId,
    scopedWorkloadNameSuffix(recipe, workloadId)
  )
}

export function resolveScopedStatefulSetResourceName(
  recipe: WorkflowRecipeCRD,
  workloadId: string
): string {
  return clampResourceName(
    resolveScopedWorkloadResourceName(recipe, workloadId),
    STATEFULSET_NAME_MAX_LEN
  )
}

export function resolveScopedCronJobResourceName(
  recipe: WorkflowRecipeCRD,
  workloadId: string
): string {
  return clampResourceName(
    resolveScopedWorkloadResourceName(recipe, workloadId),
    CRONJOB_NAME_MAX_LEN
  )
}

export function resolveScopedWorkloadRuntimeResourceName(
  recipe: WorkflowRecipeCRD,
  workload: WorkloadDef
): string {
  switch (workload.type) {
    case 'statefulset':
      return resolveScopedStatefulSetResourceName(recipe, workload.id)
    case 'cronjob':
      return resolveScopedCronJobResourceName(recipe, workload.id)
    default:
      return resolveScopedWorkloadResourceName(recipe, workload.id)
  }
}

/**
 * Deterministic hash suffix for a `spec.resources[]` id (PVC/Secret/ConfigMap).
 *
 * Uses the SAME recipe-identity binding as `scopedWorkloadNameSuffix` but with a
 * `:resource:` domain separator so a workload and a resource that share a generic
 * id (e.g. both called `data`) in the same recipe never resolve to the same hash.
 */
function scopedResourceNameSuffix(recipe: WorkflowRecipeCRD, resourceId: string): string {
  const identity = recipe.metadata.uid
    ? `uid:${recipe.metadata.uid}`
    : `ref:${recipe.metadata.namespace ?? ''}:${recipe.metadata.name}`
  return createHash('sha256')
    .update(`${identity}:resource:${resourceId}`)
    .digest('hex')
    .slice(0, RESOURCE_INSTANCE_HASH_LEN)
}

/**
 * Recipe-scoped physical name for a `spec.resources[]` id, mirroring
 * `resolveScopedWorkloadResourceName`. PVC/Secret/ConfigMap names are plain
 * DNS-1123 labels (no StatefulSet controller-revision reserve), so the full
 * 63-byte budget applies.
 */
export function resolveScopedResourceName(recipe: WorkflowRecipeCRD, resourceId: string): string {
  return composeResourceName(
    recipe.metadata.name,
    resourceId,
    scopedResourceNameSuffix(recipe, resourceId)
  )
}

/**
 * Resolve the physical name for a `spec.resources[]` id, mirroring
 * `resolveWorkloadResourceName`:
 *   1. Pre-assigned name from `status.resourceInstances` (stable across reconciles,
 *      and the seam through which the reconciler can adopt a legacy raw name).
 *   2. Otherwise a freshly scoped name.
 *
 * Unlike workloads there is no "non-workflow → raw id" branch: new resources are
 * always scoped. Backward-compat adoption of an existing raw PVC/Secret/ConfigMap
 * is decided once, by the reconciler, and persisted into `status.resourceInstances`.
 */
export function resolveResourceName(recipe: WorkflowRecipeCRD, resourceId: string): string {
  const instances = recipe.status?.resourceInstances
  if (instances?.[resourceId]) return instances[resourceId]
  return resolveScopedResourceName(recipe, resourceId)
}

function appendResourceNameSuffix(baseName: string, suffix: string): string {
  const directName = `${baseName}-${suffix}`
  if (directName.length <= RESOURCE_NAME_MAX_LEN) return directName

  const hash = createHash('sha256')
    .update(directName)
    .digest('hex')
    .slice(0, RESOURCE_NAME_HASH_LEN)
  const reserved = 1 + suffix.length + 1 + hash.length
  const maxBase = Math.max(1, RESOURCE_NAME_MAX_LEN - reserved)
  const trimmedBase = baseName.slice(0, maxBase).replace(/-+$/g, '')
  const safeBase = trimmedBase || 'workflow'.slice(0, maxBase)
  return `${safeBase}-${suffix}-${hash}`
}

function clampResourceName(baseName: string, maxLen: number): string {
  if (baseName.length <= maxLen) return baseName

  const hash = createHash('sha256').update(baseName).digest('hex').slice(0, RESOURCE_NAME_HASH_LEN)
  const maxBase = Math.max(1, maxLen - 1 - hash.length)
  const trimmedBase = baseName.slice(0, maxBase).replace(/-+$/g, '')
  const safeBase = trimmedBase || 'workflow'.slice(0, maxBase)
  return `${safeBase}-${hash}`
}

export function resolveWorkloadResourceName(recipe: WorkflowRecipeCRD, workloadId: string): string {
  // 1. Pre-assigned name from status (fast path, stable across reconciles)
  const instances = recipe.status?.workloadInstances
  if (instances?.[workloadId]) return instances[workloadId]

  // 2. Non-workflow recipes: raw workload ID (backward compat)
  const isWorkflow = Array.isArray(recipe.spec.steps) && recipe.spec.steps.length > 0
  if (!isWorkflow) return workloadId

  // 3. First reconcile (no status yet): deterministic hash from (UID, workloadId).
  // Missing UID is not expected for a real CRD event; synthesized tests use
  // the namespace/name identity so this helper remains deterministic.
  // The child-recipe name is already clamped to 63 bytes by
  // `buildDbRunChildName`, so for typical parents the concatenation below
  // fits in 63 chars without truncation. Long parent+workload combinations
  // (or parents using the bare CRD name without going through the child
  // factory) trigger the stem truncation in `composeResourceName`.
  return resolveScopedWorkloadResourceName(recipe, workloadId)
}

export function resolveStatefulSetResourceName(
  recipe: WorkflowRecipeCRD,
  workloadId: string
): string {
  return clampResourceName(
    resolveWorkloadResourceName(recipe, workloadId),
    STATEFULSET_NAME_MAX_LEN
  )
}

export function resolveCronJobResourceName(recipe: WorkflowRecipeCRD, workloadId: string): string {
  return clampResourceName(resolveWorkloadResourceName(recipe, workloadId), CRONJOB_NAME_MAX_LEN)
}

export function resolveWorkloadRuntimeResourceName(
  recipe: WorkflowRecipeCRD,
  workload: WorkloadDef
): string {
  switch (workload.type) {
    case 'statefulset':
      return resolveStatefulSetResourceName(recipe, workload.id)
    case 'cronjob':
      return resolveCronJobResourceName(recipe, workload.id)
    default:
      return resolveWorkloadResourceName(recipe, workload.id)
  }
}

export function resolveWorkloadMcpServerLabel(
  recipe: WorkflowRecipeCRD,
  workload: WorkloadDef
): string {
  const isWorkflow = Array.isArray(recipe.spec.steps) && recipe.spec.steps.length > 0
  return isWorkflow
    ? resolveWorkloadResourceName(recipe, workload.id)
    : `${recipe.metadata.name}-${workload.id}`
}

export function resolveStatefulSetHeadlessServiceName(
  recipe: WorkflowRecipeCRD,
  workload: StatefulSetDef
): string {
  return (
    workload.serviceName ??
    appendResourceNameSuffix(resolveStatefulSetResourceName(recipe, workload.id), 'headless')
  )
}

/** OwnerReference for GC — points to the WorkflowRecipe CRD. */
export function ownerRef(recipe: WorkflowRecipeCRD): k8s.V1OwnerReference {
  return {
    apiVersion: recipe.apiVersion,
    kind: recipe.kind,
    name: recipe.metadata.name,
    uid: recipe.metadata.uid ?? '',
    controller: true,
    blockOwnerDeletion: true,
  }
}

/**
 * Access classification for a Kubernetes Secret referenced BY NAME from a recipe
 * workload (`envSecret` or `imagePullSecrets`). Built by the reconciler's
 * `readReferencedSecrets()` before construction and threaded through so the
 * builder can FAIL CLOSED on an ownership-denied Secret instead of projecting a
 * foreign credential (Issue #637).
 *
 * Making "denied" a first-class state — instead of collapsing it into an empty
 * key set indistinguishable from "missing" — is the core of the fix: a Secret
 * that exists but is owned by another recipe MUST NOT be projected, for required
 * OR optional mappings. Only `accessible` ever carries (and exposes) keys.
 */
export type SecretAccess =
  | { state: 'accessible'; keys: ReadonlySet<string> } // shared or owner-match; keys actually present in the Secret
  | { state: 'denied' } // exists but ownership-refused (foreign owner / unlabeled / conflicting labels)
  | { state: 'missing' } // 404 — the Secret does not exist
  | { state: 'error' } // transient non-404 read failure; ownership unverified → never projected, reconciler requeues
export type SecretKeysByName = ReadonlyMap<string, SecretAccess>

// Path B — recipe background OAuth. WRC provisions a short-lived broker token
// per recipe into this Secret; workloads that declare `oauthClientRefs` present
// it to the control-api `/recipe-oauth/token` route. Spec §9.2.
//
// The token is mounted as a Secret VOLUME, not an env var: WRC rotates it on
// every reconcile (TTL ~600s), and only a mounted file propagates a Secret
// update into a running pod — an env-var `secretKeyRef` is resolved once at
// container start and would go stale after the first rotation. The workload
// re-reads the file (path in `RECIPE_OAUTH_BROKER_TOKEN_FILE`) on each call.
const OAUTH_BROKER_TOKEN_SECRET_KEY = 'broker-token'
const OAUTH_BROKER_TOKEN_VOLUME = 'clerum-oauth-broker-token'
const OAUTH_BROKER_TOKEN_MOUNT_DIR = '/var/run/clerum/oauth-broker'
const OAUTH_BROKER_TOKEN_PATH = `${OAUTH_BROKER_TOKEN_MOUNT_DIR}/${OAUTH_BROKER_TOKEN_SECRET_KEY}`
const OAUTH_BROKER_TOKEN_FILE_ENV = 'RECIPE_OAUTH_BROKER_TOKEN_FILE'

export function oauthBrokerTokenSecretName(recipeName: string): string {
  return `wf-${recipeName}-oauth-broker-token`
}

export function recipeHasBackgroundAccessClient(recipe: WorkflowRecipeCRD): boolean {
  return (recipe.spec.oauthClients ?? []).some(c => c.backgroundAccess === true)
}

/**
 * True when this workload opts into background OAuth: it declares
 * `oauthClientRefs` and at least one ref names a `backgroundAccess` client on
 * the recipe. Only such workloads get the broker token mounted + egress to
 * control-api. MCP transport and UI workloads are excluded — they reach
 * providers through their own paths.
 */
export function workloadUsesBackgroundOauth(
  workload: WorkloadDef,
  recipe: WorkflowRecipeCRD
): boolean {
  const refs = workload.oauthClientRefs ?? []
  if (refs.length === 0 || workload.transport) return false
  if (workload.id === recipe.spec.ui?.workloadRef) return false
  const backgroundIds = new Set(
    (recipe.spec.oauthClients ?? []).filter(c => c.backgroundAccess === true).map(c => c.id)
  )
  return refs.some(ref => backgroundIds.has(ref))
}

/**
 * Build the OAuth broker token Secret. Holds a single short-lived JWT under the
 * `broker-token` key; WRC re-issues it on its reconcile cadence. No
 * ownerReference — like other workflow Secrets, cleanup is explicit in the
 * reconciler's delete path.
 */
export function buildOAuthBrokerTokenSecret(
  recipeName: string,
  brokerToken: string,
  namespace: string
): k8s.V1Secret {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: oauthBrokerTokenSecretName(recipeName),
      namespace,
      labels: {
        [RECIPE_LABEL]: recipeName,
        [MANAGED_BY_LABEL]: 'wrc',
        'clerum.io/component': 'oauth-broker-token',
      },
    },
    type: 'Opaque',
    data: {
      [OAUTH_BROKER_TOKEN_SECRET_KEY]: Buffer.from(brokerToken).toString('base64'),
    },
  }
}

// control-api's in-cluster HTTP port. The broker route lives here; background
// workloads need egress to it. Matches CONTROL_API_BASE_URL's default.
const CONTROL_API_PORT = 8090

export function oauthBrokerEgressPolicyName(recipeName: string): string {
  return `wf-${recipeName}-oauth-broker-egress`
}

/**
 * Egress NetworkPolicy letting a recipe's background-OAuth workloads reach the
 * control-api broker route. sandbox-recipes is deny-all by default, so without
 * this the `/recipe-oauth/token` call is blocked. Selects only the opted-in
 * workloads (those with `oauthClientRefs`) — MCP/UI workloads are not granted
 * this egress. Returns null when no workload opted in. Path B, spec §9.2.
 */
export function buildOAuthBrokerEgressNetworkPolicy(
  recipe: WorkflowRecipeCRD,
  optedInWorkloadIds: string[],
  sandboxNamespace: string,
  controlPlaneNamespace: string
): k8s.V1NetworkPolicy | null {
  if (optedInWorkloadIds.length === 0) return null
  const recipeName = recipe.metadata.name
  const recipeNs = recipe.metadata.namespace ?? ''
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: oauthBrokerEgressPolicyName(recipeName),
      namespace: sandboxNamespace,
      labels: {
        [MANAGED_BY_LABEL]: 'workflow-recipes',
        [RECIPE_LABEL]: recipeName,
        [RECIPE_NAMESPACE_LABEL]: recipeNs,
        [RECIPE_NAME_LABEL]: recipeName,
        'clerum.io/component': 'oauth-broker-egress',
      },
    },
    spec: {
      podSelector: {
        matchLabels: { [RECIPE_LABEL]: recipeName },
        matchExpressions: [
          { key: WORKLOAD_LABEL, operator: 'In', values: [...optedInWorkloadIds].sort() },
        ],
      },
      policyTypes: ['Egress'],
      egress: [
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': controlPlaneNamespace },
              },
              podSelector: { matchLabels: { app: 'control-api' } },
            },
          ],
          ports: [{ port: CONTROL_API_PORT, protocol: 'TCP' }],
        },
      ],
    },
  }
}

/** Build K8s env vars from workload def (static env + secret-backed env). */
/**
 * Plugin Workload SDK env injection (plan §3.6): allowed plugin workloads
 * receive the SDK endpoint + recipe-scoped token. MCP transport workloads
 * (mcp-server namespace) and the sandbox UI workload (sandbox-ui namespace)
 * are excluded — the SDK port is only reachable from sandbox-recipes pods.
 */
export function buildPluginWorkloadSdkEnv(
  workload: WorkloadDef,
  recipe: WorkflowRecipeCRD,
  pluginWorkloadSdkEnabled: boolean
): k8s.V1EnvVar[] {
  if (!pluginWorkloadSdkEnabled) return []
  const sdk = recipe.spec.pluginWorkloadSdk
  if (!sdk) return []
  if (workload.transport) return []
  if (recipe.spec.ui?.workloadRef === workload.id) return []
  const allowedCallers = sdk.allowedCallers ?? []
  if (allowedCallers.length > 0 && !allowedCallers.includes(workload.id)) return []
  const recipeName = recipe.metadata.name
  return [
    {
      name: 'PLUGIN_WORKLOAD_SDK_ENDPOINT',
      value: buildPluginWorkloadSdkEndpoint(recipeName, recipe.metadata.namespace),
    },
    {
      name: 'PLUGIN_WORKLOAD_SDK_TOKEN',
      valueFrom: {
        secretKeyRef: {
          name: buildPluginWorkloadSdkTokenSecretName(recipeName),
          key: pluginWorkloadSdkTokenSecretKey(workload.id),
        },
      },
    },
  ]
}

function buildEnvVars(
  workload: WorkloadDef,
  secretKeys?: SecretKeysByName,
  injectBrokerToken?: boolean,
  extraEnv?: k8s.V1EnvVar[]
): k8s.V1EnvVar[] | undefined {
  const envVars: k8s.V1EnvVar[] = [...(extraEnv ?? [])]

  // 1. Static env vars (existing behavior)
  if (workload.env) {
    for (const e of workload.env) {
      envVars.push({
        name: e.name,
        ...(e.value !== undefined ? { value: e.value } : {}),
      })
    }
  }

  // 2. Secret-backed env vars (envSecret field).
  //
  // Issue #637 — fail closed on ownership: an `envSecret` whose Secret exists but
  // is owned by another recipe (`denied`), or whose ownership we could not verify
  // due to a transient read error (`error`), is NEVER projected — for required OR
  // optional mappings. The kubelet does not understand Clerum ownership labels, so
  // emitting a foreign `secretKeyRef` would inject another recipe's credential.
  // This is defense-in-depth: the reconciler gate (partitionEnvSecretsByOwnership)
  // should already have stopped the build, but the builder must never emit a
  // foreign ref even if it didn't. `missing`/absent-key keep the historical
  // "emit required, let kubelet surface CreateContainerConfigError" behavior so a
  // genuinely-absent key is a visible signal, not a silent drop.
  if (workload.envSecret) {
    const secretName = workload.envSecret.name
    const access = secretKeys?.get(secretName)
    if (access?.state !== 'denied' && access?.state !== 'error') {
      for (const mapping of workload.envSecret.keys) {
        const keyPresent = access?.state === 'accessible' && access.keys.has(mapping.secretKey)
        // Optional mappings are skipped when the key is absent at reconcile time;
        // required mappings are emitted (kubelet fails the pod if absent at start).
        if (mapping.optional && !keyPresent) {
          continue
        }
        envVars.push({
          name: mapping.envVar,
          valueFrom: {
            secretKeyRef: {
              name: secretName,
              key: mapping.secretKey,
            },
          },
        })
      }
    }
  }

  // 3. Recipe OAuth broker token path — points the workload at the mounted
  // token file (the token itself comes in via a Secret volume, not env, so
  // rotation propagates). The value is a static path, safe as a plain env var.
  if (injectBrokerToken) {
    envVars.push({ name: OAUTH_BROKER_TOKEN_FILE_ENV, value: OAUTH_BROKER_TOKEN_PATH })
  }

  return envVars.length > 0 ? envVars : undefined
}

/** Build K8s volume mounts from workload def. */
function buildVolumeMounts(
  workload: WorkloadDef,
  injectBrokerToken?: boolean
): k8s.V1VolumeMount[] | undefined {
  const mounts: k8s.V1VolumeMount[] = (workload.volumeMounts ?? []).map(vm => ({
    name: vm.name,
    mountPath: vm.mountPath,
    subPath: vm.subPath,
    readOnly: vm.readOnly,
  }))
  if (injectBrokerToken) {
    mounts.push({
      name: OAUTH_BROKER_TOKEN_VOLUME,
      mountPath: OAUTH_BROKER_TOKEN_MOUNT_DIR,
      readOnly: true,
    })
  }
  return mounts.length > 0 ? mounts : undefined
}

/** Build K8s resource requirements. */
function buildResources(workload: WorkloadDef): k8s.V1ResourceRequirements | undefined {
  if (!workload.resources) return undefined
  const result: k8s.V1ResourceRequirements = {}
  if (workload.resources.requests) {
    result.requests = {}
    if (workload.resources.requests.cpu) result.requests['cpu'] = workload.resources.requests.cpu
    if (workload.resources.requests.memory)
      result.requests['memory'] = workload.resources.requests.memory
  }
  if (workload.resources.limits) {
    result.limits = {}
    if (workload.resources.limits.cpu) result.limits['cpu'] = workload.resources.limits.cpu
    if (workload.resources.limits.memory) result.limits['memory'] = workload.resources.limits.memory
  }
  return result
}

/** Map HealthCheck to K8s probe. */
function buildProbe(
  workload: WorkloadDef,
  initial: number,
  period: number
): k8s.V1Probe | undefined {
  const hc = workload.healthCheck
  if (!hc) return undefined
  const probe: k8s.V1Probe = {
    initialDelaySeconds: hc.initialDelaySeconds ?? initial,
    periodSeconds: hc.periodSeconds ?? period,
    timeoutSeconds: hc.timeoutSeconds,
    failureThreshold: hc.failureThreshold,
  }
  if (hc.type === 'http') {
    probe.httpGet = { path: hc.path ?? '/health', port: hc.port ?? workload.port ?? 8080 }
  } else if (hc.type === 'tcp') {
    probe.tcpSocket = { port: hc.port ?? workload.port ?? 8080 }
  } else if (hc.type === 'exec') {
    probe.exec = { command: hc.command }
  }
  return probe
}

/** Build container ports. */
function buildPorts(workload: WorkloadDef): k8s.V1ContainerPort[] | undefined {
  if (!workload.port) return undefined
  return [{ name: 'http', containerPort: workload.port, protocol: 'TCP' }]
}

/** Build common PodTemplateSpec container. */
function buildContainer(
  workload: WorkloadDef,
  isolationLevel: SecurityIsolationLevel,
  secretKeys?: SecretKeysByName,
  injectBrokerToken?: boolean,
  extraEnv?: k8s.V1EnvVar[]
): k8s.V1Container {
  const secCtx = buildWithOverrides(isolationLevel, workload.security)
  return {
    name: workload.id,
    image: workload.image,
    imagePullPolicy: 'IfNotPresent',
    command: workload.command,
    args: workload.args,
    ports: buildPorts(workload),
    env: buildEnvVars(workload, secretKeys, injectBrokerToken, extraEnv),
    volumeMounts: buildVolumeMounts(workload, injectBrokerToken),
    resources: buildResources(workload),
    securityContext: secCtx.container,
    livenessProbe: buildProbe(workload, 10, 15),
    readinessProbe: buildProbe(workload, 5, 10),
  }
}

function buildVolumeOwnershipInitContainer(workload: WorkloadDef): k8s.V1Container | undefined {
  if (!workload.security?.prepareVolumeOwnership) return undefined

  const writableMounts = (workload.volumeMounts ?? []).filter(vm => !vm.readOnly)
  if (writableMounts.length === 0) return undefined

  const uid = workload.security.runAsUser
  const gid = workload.security.runAsGroup ?? workload.security.fsGroup ?? uid
  if (!uid || !gid) return undefined

  return {
    name: 'prepare-volume-ownership',
    image: workload.image,
    imagePullPolicy: 'IfNotPresent',
    command: [
      'sh',
      '-c',
      [
        'set -eu',
        'for path do',
        '  chown -R "${TARGET_UID}:${TARGET_GID}" "$path"',
        '  chmod -R ug+rwX "$path"',
        'done',
      ].join('\n'),
      '--',
      ...writableMounts.map(vm => vm.mountPath),
    ],
    env: [
      { name: 'TARGET_UID', value: String(uid) },
      { name: 'TARGET_GID', value: String(gid) },
    ],
    volumeMounts: buildVolumeMounts({ ...workload, volumeMounts: writableMounts }),
    resources: {
      requests: { cpu: '10m', memory: '32Mi' },
      limits: { cpu: '100m', memory: '128Mi' },
    },
    securityContext: {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'], add: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'] },
      readOnlyRootFilesystem: true,
      runAsNonRoot: false,
      runAsUser: 0,
      runAsGroup: 0,
      seccompProfile: { type: 'RuntimeDefault' },
    },
  }
}

/** Build K8s volumes from workload volumeMounts + recipe PVC resources. */
function buildVolumes(
  workload: WorkloadDef,
  recipe: WorkflowRecipeCRD,
  injectBrokerToken?: boolean
): k8s.V1Volume[] | undefined {
  const pvcIds = new Set((recipe.spec.resources ?? []).filter(r => r.type === 'pvc').map(r => r.id))
  const volumes: k8s.V1Volume[] = (workload.volumeMounts ?? []).map(vm => {
    const vol: k8s.V1Volume = { name: vm.name }
    if (pvcIds.has(vm.name)) {
      // The pod volume keeps the authored (logical) name `vm.name`; the claim
      // must point at the recipe-scoped physical PVC (see issue #571).
      vol.persistentVolumeClaim = { claimName: resolveResourceName(recipe, vm.name) }
    } else {
      // Fallback: emptyDir for volumeMounts not backed by a PVC resource
      vol.emptyDir = {}
    }
    return vol
  })
  if (injectBrokerToken) {
    volumes.push({
      name: OAUTH_BROKER_TOKEN_VOLUME,
      secret: { secretName: oauthBrokerTokenSecretName(recipe.metadata.name) },
    })
  }
  return volumes.length > 0 ? volumes : undefined
}

/**
 * Build common PodTemplateSpec with support for imagePullSecrets.
 *
 * This function constructs the PodTemplateSpec for all workload types, including:
 * - Container configuration with security context
 * - Volume mounts from workload volumeMounts + recipe PVC resources
 * - Image pull secrets for private container registries
 *
 * **imagePullSecrets behavior**:
 * - If workload.imagePullSecrets is defined, creates imagePullSecrets array in pod spec
 * - Secrets must exist in the namespace where the pod is created
 * - For non-MCP workloads, secrets must be in SANDBOX_NAMESPACE
 * - For MCP workloads, secrets must be in mcp-server namespace
 *
 * **namespace-splitting consideration**:
 * - MCP workloads → mcp-server namespace
 * - Non-MCP workloads → sandbox-recipes namespace
 * - imagePullSecrets must exist in the target namespace
 */
function buildPodTemplate(
  workload: WorkloadDef,
  recipe: WorkflowRecipeCRD,
  isolationLevel: SecurityIsolationLevel,
  secretKeys?: SecretKeysByName,
  appName?: string,
  buildOptions?: WorkloadBuildOptions
): k8s.V1PodTemplateSpec {
  const resourceName = appName ?? resolveWorkloadRuntimeResourceName(recipe, workload)
  // Path B - mount the broker token only into workloads that explicitly opt in
  // via `oauthClientRefs` pointing at a `backgroundAccess` client. MCP and UI
  // workloads are excluded inside workloadUsesBackgroundOauth().
  const injectBrokerToken = workloadUsesBackgroundOauth(workload, recipe)
  const labels = {
    ...workloadLabels(
      recipe.metadata.name,
      workload.id,
      workloadEffectiveContextRef(recipe, Boolean(workload.transport)),
      resourceName
    ),
    ...sandboxUiLabels(workload, recipe),
  }
  // Add mcpserver label for MCP workloads so HCC NetworkPolicies can select these pods.
  // In the current schema, those workloads are the ones using transport-backed
  // MCP delegation.
  if (workload.transport) {
    labels[MCPSERVER_LABEL] = resolveWorkloadMcpServerLabel(recipe, workload)
  }
  if (injectBrokerToken) {
    labels[OAUTH_BROKER_CLIENT_LABEL] = 'true'
  }
  const secCtx = buildWithOverrides(isolationLevel, workload.security)

  // Build imagePullSecrets if specified — fail closed on ownership (Issue #637),
  // the same boundary as envSecret. A pull Secret the recipe does not own
  // (`denied`) or whose ownership we could not verify (`error`) is dropped; only
  // owned/shared (`accessible`) and genuinely-absent (`missing`, surfaced as
  // ImagePullBackOff) names are projected. When no access map is threaded
  // (secretKeys undefined) every name passes — preserving prior behavior.
  const allowedPullSecrets = (workload.imagePullSecrets ?? []).filter(name => {
    const st = secretKeys?.get(name)?.state
    return st !== 'denied' && st !== 'error'
  })
  // The PLATFORM pull credential is injected here, AFTER the ownership filter, for any
  // workload whose image is hosted on our own registry. It is deliberately not something
  // a recipe declares: control-api provisions it and labels it `managed-by=control-api`
  // only, which is *unlabeled* to the #637 model — so a recipe naming it would be denied,
  // and making it `shared` would let any recipe mount it as an envSecret and read the
  // credential. Injecting it means the recipe never references it, so it is never
  // classified, and there is no path for a recipe to reach its contents.
  const pullSecretNames = [...allowedPullSecrets]
  if (
    isPlatformRegistryImage(workload.image, loadConfig().registryUrl) &&
    !pullSecretNames.includes(EVENFIRE_REGISTRY_PULL_SECRET_NAME)
  ) {
    pullSecretNames.push(EVENFIRE_REGISTRY_PULL_SECRET_NAME)
  }
  const imagePullSecrets =
    pullSecretNames.length > 0 ? pullSecretNames.map(name => ({ name })) : undefined
  const ownershipInitContainer = buildVolumeOwnershipInitContainer(workload)

  const pluginSdkEnv = buildPluginWorkloadSdkEnv(
    workload,
    recipe,
    buildOptions?.pluginWorkloadSdkEnabled ?? false
  )

  return {
    metadata: { labels },
    spec: {
      initContainers: ownershipInitContainer ? [ownershipInitContainer] : undefined,
      containers: [
        buildContainer(workload, isolationLevel, secretKeys, injectBrokerToken, pluginSdkEnv),
      ],
      volumes: buildVolumes(workload, recipe, injectBrokerToken),
      securityContext: secCtx.podSecurityContext,
      // Hard-pinned false at every isolation level, not just `strict`. Recipe
      // workloads run recipe-author code and never call the K8s API — leaving
      // the default SA token mounted is a credential a compromised workload
      // could use to read other recipes' Secrets in the shared
      // `sandbox-recipes` namespace (e.g. wf-<recipe>-oauth-broker-token) the
      // moment any RoleBinding grants the namespace SA `get secrets`. Removing
      // the token is a control that holds regardless of RBAC drift.
      automountServiceAccountToken: false,
      // Three-tier PriorityClass scheme (stateless agents): recipe-created
      // non-transport workloads (Jobs, CronJobs, and sandbox-recipes
      // Deployments/StatefulSets/DaemonSets) run as preemptible batch
      // ('clerum-batch', value -10) so an interactive host wake
      // ('clerum-interactive-host', value 100) preferentially evicts them.
      // Transport workloads are serving pods in the mcp-server namespace and
      // stay unclassed (priority 0 = protected service tier).
      priorityClassName: workload.transport ? undefined : 'clerum-batch',
      imagePullSecrets,
    },
  }
}

// ─── Workload Builders ──────────────────────────────────────────────────

/** Cross-cutting build options threaded from the reconciler's config. */
export interface WorkloadBuildOptions {
  pluginWorkloadSdkEnabled?: boolean
}

export function buildDeployment(
  workload: DeploymentDef,
  recipe: WorkflowRecipeCRD,
  isolationLevel: SecurityIsolationLevel = 'standard',
  secretKeys?: SecretKeysByName,
  buildOptions?: WorkloadBuildOptions
): k8s.V1Deployment {
  const resourceName = resolveWorkloadResourceName(recipe, workload.id)
  const labels = {
    ...workloadLabels(
      recipe.metadata.name,
      workload.id,
      workloadEffectiveContextRef(recipe, Boolean(workload.transport)),
      resourceName
    ),
    ...sandboxUiLabels(workload, recipe),
  }
  if (workload.transport) {
    labels[MCPSERVER_LABEL] = resolveWorkloadMcpServerLabel(recipe, workload)
  }
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: resourceName,
      namespace: recipe.metadata.namespace,
      labels,
      ownerReferences: [ownerRef(recipe)],
    },
    spec: {
      replicas: workload.replicas ?? 1,
      selector: { matchLabels: { app: resourceName } },
      template: buildPodTemplate(
        workload,
        recipe,
        isolationLevel,
        secretKeys,
        undefined,
        buildOptions
      ),
    },
  }
}

/**
 * Build a StatefulSet resource with volumeClaimTemplates support.
 *
 * This function creates a StatefulSet and its associated headless Service.
 * The StatefulSet is deployed to the namespace determined by namespace-splitting rules.
 *
 * **volumeClaimTemplates behavior**:
 * - Creates one PVC per replica based on the template definition
 * - PVCs include WorkflowRecipe labels for queryability (clerum.io/workload, clerum.io/recipe, etc.)
 * - PVCs do NOT have ownerReferences (data retention on recipe deletion)
 * - PVCs persist in the namespace where the StatefulSet is created
 *
 * **Label inheritance**:
 * - volumeClaimTemplates.metadata.labels = { ...labels } from workload
 * - This ensures PVCs are queryable via standard label selectors
 * - Example: kubectl get pvc -l clerum.io/workload=<workload-id> -n <namespace>
 *
 * **namespace-splitting**:
 * - MCP workloads → mcp-server namespace
 * - Non-MCP workloads → SANDBOX_NAMESPACE (sandbox-recipes)
 * - Headless Service created in the same namespace as the StatefulSet
 *
 * @param workload - StatefulSet workload definition with optional volumeClaimTemplates
 * @param recipe - WorkflowRecipe CRD containing metadata and configuration
 * @param isolationLevel - Security isolation level (minimal | standard | strict)
 * @returns Object containing StatefulSet and headless Service resources
 */
export function buildStatefulSet(
  workload: StatefulSetDef,
  recipe: WorkflowRecipeCRD,
  isolationLevel: SecurityIsolationLevel = 'standard',
  secretKeys?: SecretKeysByName,
  buildOptions?: WorkloadBuildOptions
): { statefulSet: k8s.V1StatefulSet; headlessService: k8s.V1Service } {
  const resourceName = resolveStatefulSetResourceName(recipe, workload.id)
  const labels = workloadLabels(
    recipe.metadata.name,
    workload.id,
    workloadEffectiveContextRef(recipe, Boolean(workload.transport)),
    resourceName
  )
  if (workload.transport) {
    labels[MCPSERVER_LABEL] = resolveWorkloadMcpServerLabel(recipe, workload)
  }
  const svcName = resolveStatefulSetHeadlessServiceName(recipe, workload)

  // VCT names — Kubernetes auto-provisions these volumes from volumeClaimTemplates,
  // so they must NOT appear in pod spec.volumes (which would create emptyDir shadows).
  const vctNames = new Set((workload.volumeClaimTemplates ?? []).map(t => t.name))

  const template = buildPodTemplate(
    workload,
    recipe,
    isolationLevel,
    secretKeys,
    resourceName,
    buildOptions
  )

  // Filter out volumes that are backed by volumeClaimTemplates
  if (vctNames.size > 0 && template.spec?.volumes) {
    template.spec.volumes = template.spec.volumes.filter(v => !vctNames.has(v.name!))
    if (template.spec.volumes.length === 0) {
      template.spec.volumes = undefined
    }
  }

  const statefulSet: k8s.V1StatefulSet = {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: {
      name: resourceName,
      namespace: recipe.metadata.namespace,
      labels,
      ownerReferences: workload.ownerReferences === false ? [] : [ownerRef(recipe)],
    },
    spec: {
      serviceName: svcName,
      replicas: workload.replicas ?? 1,
      selector: { matchLabels: { app: resourceName } },
      template,
    },
  }

  // Add volumeClaimTemplates if defined
  if (workload.volumeClaimTemplates && workload.volumeClaimTemplates.length > 0) {
    statefulSet.spec!.volumeClaimTemplates = workload.volumeClaimTemplates.map(template => ({
      metadata: {
        name: template.name,
        labels: { ...labels }, // Include workload labels for PVC querying
        annotations: template.storageClass
          ? {
              'volume.beta.kubernetes.io/storage-class': template.storageClass,
            }
          : undefined,
      },
      spec: {
        accessModes: [template.accessMode],
        resources: {
          requests: {
            storage: template.size,
          },
        },
        storageClassName: template.storageClass,
      },
    }))
  }

  const headlessService: k8s.V1Service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: svcName,
      namespace: recipe.metadata.namespace,
      labels,
      ownerReferences: workload.ownerReferences === false ? [] : [ownerRef(recipe)],
    },
    spec: {
      clusterIP: 'None',
      ports: workload.port
        ? [{ port: workload.port, targetPort: workload.port, protocol: 'TCP', name: 'http' }]
        : [],
      selector: { app: resourceName },
    },
  }

  return { statefulSet, headlessService }
}

export function buildCronJob(
  workload: CronJobDef,
  recipe: WorkflowRecipeCRD,
  isolationLevel: SecurityIsolationLevel = 'standard',
  secretKeys?: SecretKeysByName,
  buildOptions?: WorkloadBuildOptions
): k8s.V1CronJob {
  const resourceName = resolveCronJobResourceName(recipe, workload.id)
  const labels = workloadLabels(
    recipe.metadata.name,
    workload.id,
    workloadEffectiveContextRef(recipe, Boolean(workload.transport)),
    resourceName
  )
  if (workload.transport) {
    labels[MCPSERVER_LABEL] = resolveWorkloadMcpServerLabel(recipe, workload)
  }
  const template = buildPodTemplate(
    workload,
    recipe,
    isolationLevel,
    secretKeys,
    undefined,
    buildOptions
  )
  template.spec!.restartPolicy = 'OnFailure'
  return {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: {
      name: resourceName,
      namespace: recipe.metadata.namespace,
      labels,
      ownerReferences: [ownerRef(recipe)],
    },
    spec: {
      schedule: workload.schedule,
      timeZone: workload.timeZone,
      jobTemplate: {
        spec: {
          template,
        },
      },
    },
  }
}

export function buildJob(
  workload: JobDef,
  recipe: WorkflowRecipeCRD,
  isolationLevel: SecurityIsolationLevel = 'standard',
  secretKeys?: SecretKeysByName,
  buildOptions?: WorkloadBuildOptions
): k8s.V1Job {
  const resourceName = resolveWorkloadResourceName(recipe, workload.id)
  const labels = workloadLabels(
    recipe.metadata.name,
    workload.id,
    workloadEffectiveContextRef(recipe, Boolean(workload.transport)),
    resourceName
  )
  if (workload.transport) {
    labels[MCPSERVER_LABEL] = resolveWorkloadMcpServerLabel(recipe, workload)
  }
  const template = buildPodTemplate(
    workload,
    recipe,
    isolationLevel,
    secretKeys,
    undefined,
    buildOptions
  )
  template.spec!.restartPolicy = 'Never'
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: resourceName,
      namespace: recipe.metadata.namespace,
      labels,
      ownerReferences: [ownerRef(recipe)],
    },
    spec: {
      backoffLimit: workload.backoffLimit ?? 3,
      template,
    },
  }
}

export function buildDaemonSet(
  workload: DaemonSetDef,
  recipe: WorkflowRecipeCRD,
  isolationLevel: SecurityIsolationLevel = 'standard',
  secretKeys?: SecretKeysByName,
  buildOptions?: WorkloadBuildOptions
): k8s.V1DaemonSet {
  const resourceName = resolveWorkloadResourceName(recipe, workload.id)
  const labels = workloadLabels(
    recipe.metadata.name,
    workload.id,
    workloadEffectiveContextRef(recipe, Boolean(workload.transport)),
    resourceName
  )
  if (workload.transport) {
    labels[MCPSERVER_LABEL] = resolveWorkloadMcpServerLabel(recipe, workload)
  }
  return {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: {
      name: resourceName,
      namespace: recipe.metadata.namespace,
      labels,
      ownerReferences: [ownerRef(recipe)],
    },
    spec: {
      selector: { matchLabels: { app: resourceName } },
      template: buildPodTemplate(
        workload,
        recipe,
        isolationLevel,
        secretKeys,
        undefined,
        buildOptions
      ),
    },
  }
}

/**
 * Build a ClusterIP Service for a workload with a port.
 *
 * Transport workloads (MCP HTTP/stdio) get their Service from WRC's MCP
 * delegation path in `mcpDelegation.ts`. Omitted contextRef derives a private
 * wf-<recipeName> Context; WRC must not create a second plain workload Service.
 */
export function buildService(
  workload: WorkloadDef,
  recipe: WorkflowRecipeCRD
): k8s.V1Service | null {
  if (workload.transport) return null
  if (!workload.port) return null

  const resourceName = resolveWorkloadRuntimeResourceName(recipe, workload)
  const labels = {
    ...workloadLabels(recipe.metadata.name, workload.id, recipe.spec.contextRef, resourceName),
    ...sandboxUiLabels(workload, recipe),
  }
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: resourceName,
      namespace: recipe.metadata.namespace,
      labels,
      ownerReferences: [ownerRef(recipe)],
    },
    spec: {
      type: 'ClusterIP',
      ports: [{ port: workload.port, targetPort: workload.port, protocol: 'TCP', name: 'http' }],
      selector: { app: resourceName },
    },
  }
}

// ─── NetworkPolicy Builders ─────────────────────────────────────────────

const RFC1918_EXCEPT = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']

/**
 * IPv4 dotted-quad → unsigned 32-bit integer. Throws on malformed input
 * so a bad CIDR caught here fails fast instead of building an invalid
 * NetworkPolicy.
 */
function ipv4ToInt(ip: string): number {
  const parts = ip.split('.')
  if (parts.length !== 4) throw new Error(`invalid IPv4: ${ip}`)
  let n = 0
  for (const part of parts) {
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      throw new Error(`invalid IPv4 octet: ${ip}`)
    }
    n = (n << 8) + octet
  }
  return n >>> 0
}

function parseCidr(cidr: string): { ip: number; prefixLen: number } {
  const [ip, prefix] = cidr.split('/')
  if (!ip || prefix === undefined) throw new Error(`invalid CIDR: ${cidr}`)
  const prefixLen = Number(prefix)
  if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 32) {
    throw new Error(`invalid CIDR prefix: ${cidr}`)
  }
  return { ip: ipv4ToInt(ip), prefixLen }
}

/**
 * Returns true iff `child` is strictly contained within `parent` (i.e.
 * parent is a wider range than child AND the network bits agree under
 * parent's mask). K8s NetworkPolicy validation rejects `except` entries
 * that aren't strict subsets of the surrounding `cidr`, so this filters
 * the RFC1918 carve-out to entries the parent actually contains.
 */
function isStrictSubsetCidr(child: string, parent: string): boolean {
  const c = parseCidr(child)
  const p = parseCidr(parent)
  if (p.prefixLen >= c.prefixLen) return false
  const mask = p.prefixLen === 0 ? 0 : (0xffffffff << (32 - p.prefixLen)) >>> 0
  return (c.ip & mask) === (p.ip & mask)
}

/** RFC1918 except entries that are strict subsets of the given parent CIDR. */
function rfc1918ExceptForParent(parent: string): string[] {
  return RFC1918_EXCEPT.filter(e => isStrictSubsetCidr(e, parent))
}

/**
 * Build the per-recipe `ui-egress-<recipeName>` NetworkPolicy that gates a
 * sandbox UI's outbound traffic. The policy lives in `sandboxUiNamespace` and
 * selects the UI workload's pods by their three sandbox-ui labels.
 *
 * Egress rules are derived from `spec.ui.egress`:
 *   - `internal[]`  → namespaceSelector(`sandboxRecipesNamespace`) +
 *     podSelector(recipe + workload). The UI can only reach declared sibling
 *     workloads in `sandbox-recipes`. RFC1918-correct because the
 *     namespaceSelector binds traffic to one namespace.
 *   - `external[]`  → ipBlock(0.0.0.0/0) with RFC1918 in `except[]`. The
 *     RFC1918 carve-out is unconditional — even if a user supplies a CIDR
 *     overlapping RFC1918, it is removed from the egress (defence in depth
 *     against misconfiguration).
 *
 * Returns null when the recipe has no `ui:` block. DNS egress is supplied by
 * HCC's `allow-dns-egress-sandbox-ui` policy, which stacks additively.
 */
/**
 * One ipBlock entry the builder will write into the NetworkPolicy. The
 * reconciler's FQDN resolver (`fqdnResolver.ts`) produces these from the
 * recipe's `ui.egress.external[]` declarations: each fqdn expands to one
 * entry per resolved A record. The `source` feeds provenance annotations
 * on the generated NetworkPolicy.
 */
export interface ResolvedExternalEgressInput {
  cidr: string
  port: number
  reason?: string
  source: { kind: 'fqdn'; fqdn: string }
}

export function buildUiEgressNetworkPolicy(
  recipe: WorkflowRecipeCRD,
  sandboxUiNamespace: string,
  sandboxRecipesNamespace: string,
  resolvedExternal: ResolvedExternalEgressInput[]
): k8s.V1NetworkPolicy | null {
  const ui = recipe.spec.ui
  if (!ui) return null

  const recipeName = recipe.metadata.name
  const recipeNs = recipe.metadata.namespace ?? ''
  const internal = ui.egress?.internal ?? []
  const external = resolvedExternal

  const egress: k8s.V1NetworkPolicyEgressRule[] = []

  for (const rule of internal) {
    egress.push({
      to: [
        {
          namespaceSelector: {
            matchLabels: { 'kubernetes.io/metadata.name': sandboxRecipesNamespace },
          },
          podSelector: {
            matchLabels: {
              [RECIPE_LABEL]: recipeName,
              [WORKLOAD_LABEL]: rule.workloadRef,
            },
          },
        },
      ],
      ports: [{ port: rule.port, protocol: 'TCP' }],
    })
  }

  for (const rule of external) {
    // K8s NetworkPolicy requires every `except` to be a strict subset of
    // the surrounding `cidr`. When an external FQDN resolves to a public
    // /32 (e.g. api.anthropic.com → 54.x.y.z/32), no RFC1918 range is
    // contained — emitting them all unconditionally would 422 the policy.
    const except = rfc1918ExceptForParent(rule.cidr)
    egress.push({
      to: [{ ipBlock: { cidr: rule.cidr, ...(except.length > 0 ? { except } : {}) } }],
      ports: [{ port: rule.port, protocol: 'TCP' }],
    })
  }

  const annotations = buildEgressProvenanceAnnotations(external)

  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: `ui-egress-${recipeName}`,
      namespace: sandboxUiNamespace,
      labels: {
        [MANAGED_BY_LABEL]: 'workflow-recipes',
        [RECIPE_LABEL]: recipeName,
        [RECIPE_NAMESPACE_LABEL]: recipeNs,
        [RECIPE_NAME_LABEL]: recipeName,
      },
      ...(annotations ? { annotations } : {}),
    },
    spec: {
      podSelector: {
        matchLabels: {
          [SANDBOX_UI_LABEL]: 'true',
          [RECIPE_NAMESPACE_LABEL]: recipeNs,
          [RECIPE_NAME_LABEL]: recipeName,
        },
      },
      policyTypes: ['Egress'],
      egress,
    },
  }
}

/**
 * Name for the per-target UI ingress NetworkPolicy. Mirrors
 * `workloadIngressPolicyName` — `ui-ingress-<recipe>-<workload>`, truncated
 * to fit the DNS-1123 63-char limit.
 */
export function uiIngressPolicyName(recipeName: string, workloadId: string): string {
  return composePolicyName('ui-ingress', recipeName, workloadId)
}

/**
 * Build the symmetric ingress NetworkPolicy for one workload targeted by
 * `spec.ui.egress.internal[]`. `buildUiEgressNetworkPolicy` only opens the
 * egress side on the sandbox-ui pod; without this the target sits behind
 * `deny-all-<ns>` with no ingress allowance and UI→backend traffic is
 * dropped at the target's SYN.
 *
 * The policy lives in the target workload's namespace and selects the
 * target by `clerum.io/recipe` + `clerum.io/workload`; ingress is allowed
 * from the recipe's sandbox-ui pod (matched by the same three labels
 * `buildUiEgressNetworkPolicy` stamps on its podSelector) on the declared
 * ports. Returns null when the target receives no UI internal egress.
 */
export function buildUiIngressNetworkPolicy(
  recipe: WorkflowRecipeCRD,
  targetWorkloadId: string,
  ports: number[],
  targetNamespace: string,
  sandboxUiNamespace: string
): k8s.V1NetworkPolicy | null {
  if (ports.length === 0) return null

  const recipeName = recipe.metadata.name
  const recipeNs = recipe.metadata.namespace ?? ''

  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: uiIngressPolicyName(recipeName, targetWorkloadId),
      namespace: targetNamespace,
      labels: {
        [MANAGED_BY_LABEL]: 'workflow-recipes',
        [RECIPE_LABEL]: recipeName,
        [RECIPE_NAMESPACE_LABEL]: recipeNs,
        [RECIPE_NAME_LABEL]: recipeName,
        [WORKLOAD_LABEL]: targetWorkloadId,
      },
    },
    spec: {
      podSelector: {
        matchLabels: {
          [RECIPE_LABEL]: recipeName,
          [WORKLOAD_LABEL]: targetWorkloadId,
        },
      },
      policyTypes: ['Ingress'],
      ingress: [
        {
          _from: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': sandboxUiNamespace },
              },
              podSelector: {
                matchLabels: {
                  [SANDBOX_UI_LABEL]: 'true',
                  [RECIPE_NAMESPACE_LABEL]: recipeNs,
                  [RECIPE_NAME_LABEL]: recipeName,
                },
              },
            },
          ],
          ports: ports.map(port => ({ port, protocol: 'TCP' as const })),
        },
      ],
    },
  }
}

/**
 * Stamp the resolved external set onto the NetworkPolicy as annotations so
 * cluster reviewers and ops can see when WRC last resolved fqdns and which
 * fqdn produced which cidr.
 */
function buildEgressProvenanceAnnotations(
  resolved: ResolvedExternalEgressInput[]
): Record<string, string> | undefined {
  if (resolved.length === 0) return undefined
  const targets = resolved.map(r => `${r.source.fqdn}=${r.cidr}`).join(',')
  return {
    'clerum.io/egress-fqdn-resolved-at': new Date().toISOString(),
    'clerum.io/egress-fqdn-targets': targets,
  }
}

// ─── Per-workload `egressBindings[]` NetworkPolicies ────────────────────
//
// Authors declare `workloads[<id>].egressBindings[]` to let a workload reach
// either a sibling pod (cluster-local FQDN) or an external service (public
// FQDN). The reconciler translates each binding into NetworkPolicy rules:
//
//   - cluster-local `<svc>.<ns>.svc.cluster.local` → namespaceSelector(<ns>) +
//     podSelector(clerum.io/recipe=<thisRecipe>, clerum.io/workload=<svc>).
//     CROSS-RECIPE GUARD: the target must be a sibling workload in the same
//     recipe. Validation rejects FQDNs that don't match any workload id —
//     otherwise a malicious recipe could declare another recipe's service
//     name and auto-grant ingress on the target side.
//   - external FQDN → ipBlock from `resolvedExternal`; RFC1918 except[] is
//     trimmed by `rfc1918ExceptForParent` to keep K8s' strict-subset rule.
//
// Cluster-local siblings symmetrically receive an ingress rule (built by
// `buildWorkloadIngressNetworkPolicy`) so both directions are open. The
// reconciler aggregates per-target sources before calling the ingress
// builder, so one ingress policy per receiving workload — not per pair.

const CLUSTER_DNS_SUFFIX = '.svc.cluster.local'

/**
 * Parses `<service>.<namespace>.svc.cluster.local` into its pieces.
 * Returns null for any FQDN that does not match the cluster-local shape —
 * those are treated as external by the caller.
 *
 * Trailing dots are tolerated (DNS strict form).
 */
export function parseClusterLocalFqdn(dns: string): { service: string; namespace: string } | null {
  const normalized = dns.toLowerCase().replace(/\.$/, '')
  if (!normalized.endsWith(CLUSTER_DNS_SUFFIX)) return null
  const prefix = normalized.slice(0, -CLUSTER_DNS_SUFFIX.length)
  const parts = prefix.split('.')
  // Must be exactly `<service>.<namespace>` — no extra labels (subdomains
  // under svc.cluster.local aren't a thing we want to silently accept).
  if (parts.length !== 2) return null
  const [service, namespace] = parts
  if (!service || !namespace) return null
  return { service, namespace }
}

/**
 * Resolves a cluster-local `egressBindings[].dns` to the (sibling workload,
 * namespace) pair the egress targets — or returns a fail-closed error string
 * when the FQDN looks cluster-local but doesn't match any sibling workload
 * in this recipe.
 *
 * The cross-recipe guard: matching `<svc>` to a workload id in
 * `recipe.spec.workloads` is what prevents a recipe from declaring
 * `db.sandbox-recipes.svc.cluster.local` against ANOTHER recipe's `db` to
 * auto-grant itself ingress. We also require the parsed namespace to equal
 * the namespace the sibling workload reconciles into (sandbox-recipes for
 * non-MCP/non-UI siblings).
 */
export type ClusterLocalTarget = {
  kind: 'cluster-local'
  workloadId: string
  namespace: string
}
export type ClusterLocalMismatch = {
  kind: 'mismatch'
  reason: string
}
export function resolveClusterLocalBinding(
  dns: string,
  recipe: WorkflowRecipeCRD,
  expectedNamespace: string
): ClusterLocalTarget | ClusterLocalMismatch | null {
  const parsed = parseClusterLocalFqdn(dns)
  if (!parsed) return null
  const siblingIds = new Set((recipe.spec.workloads ?? []).map(w => w.id))
  if (!siblingIds.has(parsed.service)) {
    return {
      kind: 'mismatch',
      reason: `cluster-local dns "${dns}" does not match any workload id in this recipe (got "${parsed.service}"); cross-recipe references are not allowed`,
    }
  }
  if (parsed.namespace !== expectedNamespace) {
    return {
      kind: 'mismatch',
      reason: `cluster-local dns "${dns}" targets namespace "${parsed.namespace}" but workloads in this recipe live in "${expectedNamespace}"`,
    }
  }
  return { kind: 'cluster-local', workloadId: parsed.service, namespace: parsed.namespace }
}

/**
 * Compose a policy name fitting K8s' 63-char DNS-1123 limit. The stem is
 * truncated when (stem + suffix) would overflow; trailing hyphens are
 * stripped so we never produce `foo--egress`.
 */
function composePolicyName(prefix: string, recipeName: string, workloadId: string): string {
  // prefix-<recipe>-<workload> shape. Suffix budget: prefix + 2 separators + workloadId.
  const reserved = prefix.length + 1 + 1 + workloadId.length
  const maxRecipe = Math.max(1, 63 - reserved)
  const stem =
    recipeName.length > maxRecipe ? recipeName.slice(0, maxRecipe).replace(/-+$/g, '') : recipeName
  return `${prefix}-${stem || 'recipe'}-${workloadId}`
}

export function workloadEgressPolicyName(recipeName: string, workloadId: string): string {
  return composePolicyName('wl-egress', recipeName, workloadId)
}

export function workloadIngressPolicyName(recipeName: string, workloadId: string): string {
  return composePolicyName('wl-ingress', recipeName, workloadId)
}

/**
 * Build the egress NetworkPolicy for one workload's `egressBindings[]`.
 *
 * Returns null when the workload has no bindings. The policy lives in the
 * workload's namespace and selects the workload's pods by
 * `clerum.io/recipe` + `clerum.io/workload` (already stamped by
 * `standardLabels`).
 *
 * `resolvedExternal` is the post-fqdn-resolution view of the external
 * subset of bindings — see `fqdnResolver.ts`. Cluster-local bindings are
 * computed here from the recipe spec directly; the caller is responsible
 * for validating cross-recipe siblings via `resolveClusterLocalBinding`.
 */
export function buildWorkloadEgressNetworkPolicy(
  workload: WorkloadDef,
  recipe: WorkflowRecipeCRD,
  workloadNamespace: string,
  resolvedExternal: ResolvedExternalEgressInput[]
): k8s.V1NetworkPolicy | null {
  const bindings = workload.egressBindings ?? []
  if (bindings.length === 0) return null

  const recipeName = recipe.metadata.name
  const recipeNs = recipe.metadata.namespace ?? ''
  const egress: k8s.V1NetworkPolicyEgressRule[] = []

  // Cluster-local rules: namespaceSelector + podSelector (recipe + workload).
  // Skip mismatches silently here — the reconciler's validation pass already
  // rejects them. We still defensively guard against orphan bindings.
  for (const b of bindings) {
    if (!b.dns) continue
    const resolved = resolveClusterLocalBinding(b.dns, recipe, workloadNamespace)
    if (!resolved || resolved.kind !== 'cluster-local') continue
    egress.push({
      to: [
        {
          namespaceSelector: {
            matchLabels: { 'kubernetes.io/metadata.name': resolved.namespace },
          },
          podSelector: {
            matchLabels: {
              [RECIPE_LABEL]: recipeName,
              [WORKLOAD_LABEL]: resolved.workloadId,
            },
          },
        },
      ],
      ports: [{ port: b.port, protocol: b.protocol ?? 'TCP' }],
    })
  }

  // External rules: ipBlock from resolved CIDRs. RFC1918 except is trimmed
  // to actual subsets to keep K8s' strict-subset validation happy.
  for (const rule of resolvedExternal) {
    const except = rfc1918ExceptForParent(rule.cidr)
    egress.push({
      to: [{ ipBlock: { cidr: rule.cidr, ...(except.length > 0 ? { except } : {}) } }],
      ports: [{ port: rule.port, protocol: 'TCP' }],
    })
  }

  if (egress.length === 0) return null

  const annotations = buildEgressProvenanceAnnotations(resolvedExternal)

  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: workloadEgressPolicyName(recipeName, workload.id),
      namespace: workloadNamespace,
      labels: {
        [MANAGED_BY_LABEL]: 'workflow-recipes',
        [RECIPE_LABEL]: recipeName,
        [RECIPE_NAMESPACE_LABEL]: recipeNs,
        [RECIPE_NAME_LABEL]: recipeName,
        [WORKLOAD_LABEL]: workload.id,
      },
      ...(annotations ? { annotations } : {}),
    },
    spec: {
      podSelector: {
        matchLabels: {
          [RECIPE_LABEL]: recipeName,
          [WORKLOAD_LABEL]: workload.id,
        },
      },
      policyTypes: ['Egress'],
      egress,
    },
  }
}

/**
 * Aggregated ingress source — one entry per (source workload, port) the
 * receiver should accept traffic from. The reconciler collects these by
 * walking all workloads' `egressBindings[]` and matching cluster-local
 * targets back to the receiving workload.
 */
export interface WorkloadIngressSource {
  fromWorkloadId: string
  fromNamespace: string
  port: number
  protocol: 'TCP' | 'UDP'
}

/**
 * Build the symmetric ingress NetworkPolicy for a workload that is the
 * target of one or more siblings' cluster-local egressBindings. Returns
 * null when the target receives no sibling traffic.
 */
export function buildWorkloadIngressNetworkPolicy(
  targetWorkload: WorkloadDef,
  recipe: WorkflowRecipeCRD,
  workloadNamespace: string,
  sources: WorkloadIngressSource[]
): k8s.V1NetworkPolicy | null {
  if (sources.length === 0) return null

  const recipeName = recipe.metadata.name
  const recipeNs = recipe.metadata.namespace ?? ''

  const ingress: k8s.V1NetworkPolicyIngressRule[] = sources.map(s => ({
    _from: [
      {
        namespaceSelector: {
          matchLabels: { 'kubernetes.io/metadata.name': s.fromNamespace },
        },
        podSelector: {
          matchLabels: {
            [RECIPE_LABEL]: recipeName,
            [WORKLOAD_LABEL]: s.fromWorkloadId,
          },
        },
      },
    ],
    ports: [{ port: s.port, protocol: s.protocol }],
  }))

  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: workloadIngressPolicyName(recipeName, targetWorkload.id),
      namespace: workloadNamespace,
      labels: {
        [MANAGED_BY_LABEL]: 'workflow-recipes',
        [RECIPE_LABEL]: recipeName,
        [RECIPE_NAMESPACE_LABEL]: recipeNs,
        [RECIPE_NAME_LABEL]: recipeName,
        [WORKLOAD_LABEL]: targetWorkload.id,
      },
    },
    spec: {
      podSelector: {
        matchLabels: {
          [RECIPE_LABEL]: recipeName,
          [WORKLOAD_LABEL]: targetWorkload.id,
        },
      },
      policyTypes: ['Ingress'],
      ingress,
    },
  }
}

// ─── Resource Builders ──────────────────────────────────────────────────

/** Risk 3.7: PVC does NOT set ownerReference — retained on recipe delete. */
export function buildPVC(
  resource: PvcResourceDef,
  recipe: WorkflowRecipeCRD
): k8s.V1PersistentVolumeClaim {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: resolveResourceName(recipe, resource.id),
      namespace: recipe.metadata.namespace,
      labels: resourceLabels(recipe.metadata.name, resource.id, recipe.spec.contextRef),
      // NO ownerReferences — PVCs must be retained on recipe deletion (Risk 3.7)
    },
    spec: {
      accessModes: [resource.accessMode ?? 'ReadWriteOnce'],
      storageClassName: resource.storageClass,
      resources: { requests: { storage: resource.size } },
    },
  }
}

export function buildSecret(resource: SecretResourceDef, recipe: WorkflowRecipeCRD): k8s.V1Secret {
  const data: Record<string, string> = {}

  // User-provided data (base64-encode)
  if (resource.data) {
    for (const [key, value] of Object.entries(resource.data)) {
      data[key] = Buffer.from(value).toString('base64')
    }
  }

  // Generate random values for specified keys
  if (resource.generateKeys) {
    for (const key of resource.generateKeys) {
      const randomValue = generateRandomString(32)
      data[key] = Buffer.from(randomValue).toString('base64')
    }
  }

  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: resolveResourceName(recipe, resource.id),
      namespace: recipe.metadata.namespace,
      labels: {
        ...resourceLabels(recipe.metadata.name, resource.id, recipe.spec.contextRef),
        [OWNER_RECIPE_LABEL_KEY]: recipe.metadata.name,
      },
      ownerReferences: [ownerRef(recipe)],
    },
    type: 'Opaque',
    data,
  }
}

export function buildConfigMap(
  resource: ConfigMapResourceDef,
  recipe: WorkflowRecipeCRD
): k8s.V1ConfigMap {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: resolveResourceName(recipe, resource.id),
      namespace: recipe.metadata.namespace,
      labels: resourceLabels(recipe.metadata.name, resource.id, recipe.spec.contextRef),
      ownerReferences: [ownerRef(recipe)],
    },
    data: resource.data,
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function generateRandomString(length: number): string {
  return randomBytes(length).toString('base64url').slice(0, length)
}
