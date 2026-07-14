import * as k8s from '@kubernetes/client-node'
import { createHash } from 'node:crypto'
import { type WebhookDef, type WebhookVerificationScheme, type WorkflowRecipeCRD } from '../types'
import { ownerRef } from './resourceBuilder'

// ─── Ownership boundary ────────────────────────────────────────────────────
//
// Every resource emitted by this builder — Deployment, Service, ConfigMaps,
// and the three NetworkPolicies below — is OWNED BY WRC. Concretely that
// means:
//   - Cluster ownerReference points at the WorkflowRecipe CRD (set via
//     `ownerRef(recipe)`), so K8s garbage-collects the gateway resources
//     when the recipe is deleted.
//   - `clerum.io/managed-by: workflow-recipes` is on every object and is the
//     authoritative selector for cleanup, list, and watch — including the
//     three webhook NetworkPolicies (proxy-ingress, gateway→handler egress,
//     handler ingress from gateway).
//   - Status conditions on the recipe (`WebhookHandlerInvalid`,
//     `WebhookSecretMissing`, `WebhookGatewayNotReady`, `WebhookDormant`)
//     are owned by the recipe reconciler and surface the gateway's health.
//
// This is a different ownership domain from HCC / Context Mapper
// (MCPAccessCtrl), which owns the Context / MCP NetworkPolicy surface for
// McpServer / mcp-host / rpc-proxy paths — including the `ctx-*-egress` etc.
// policies in mcp-host AND the `mcp-server` / `rpc-proxy` / `sandbox-recipes`
// infrastructure policies (deny-all, allow-dns-egress, allow-hcc-api-egress,
// allow-k8s-api-egress) HCC reconciles at startup. WRC publishes "MCP intent"
// (workloads with `transport`, Context refs) onto a recipe's CRD; HCC turns
// that intent into Context/MCP NetworkPolicy. WRC does NOT write any of those
// policies and must not delete or relabel them.
//
// If you add a new resource here, keep both invariants intact:
//   1. ownerReferences[0] = the recipe (not the gateway Deployment, not the
//      Service — every artefact directly owned by the recipe so a single
//      delete tears the surface down).
//   2. `clerum.io/managed-by: workflow-recipes` label so the HCC reconcilers
//      ignore it and our cleanup paths pick it up.

/**
 * Wire-format of /etc/webhook-gateway/config.json — keep in sync with
 * webhook-gateway/src/types.ts (GatewayConfig).
 */
export interface GatewayConfigJson {
  webhooks: Record<string, GatewayConfigEntryJson>
}

export interface GatewayConfigEntryJson {
  id: string
  methods: ReadonlyArray<'POST' | 'GET'>
  maxBodyBytes: number
  verification: GatewayVerificationJson
  setupHandshake?: GatewaySetupHandshakeJson
  replay?: { timestampHeader: string; toleranceSec: number }
  upstream: { host: string; port: number; path: string }
  /**
   * When true, the entry is deferred-credential dormant: a referenced
   * Secret/key is missing AND the webhook is `optional: true` in the
   * recipe spec. The gateway short-circuits inbound requests with 410
   * Gone + `X-Clerum-Webhook-State: dormant` and never touches the
   * verifier or upstream. Transitions to active automatically once the
   * Secret materializes (Secret watcher → reconcile → ConfigMap rebuild
   * → rolling restart).
   */
  dormant?: boolean
  /** Secret name the operator must create to activate a dormant entry. */
  dormantSecretName?: string
}

export interface GatewaySetupHandshakeJson {
  strategy: 'meta-hub-challenge' | 'slack-url-verification' | 'stripe-verify'
  secretPath?: string
}

export type GatewayVerificationJson =
  | {
      scheme: 'hmac-sha256-body' | 'hmac-sha256-timestamp-body'
      signatureHeader: string
      signaturePrefix?: string
      signatureEncoding: 'hex' | 'base64'
      secretPath: string
    }
  | {
      scheme: 'jwt-bearer-jwks'
      jwksUrl: string
      issuer: string
      audience: string
      jwksPath: string
    }
  | {
      scheme: 'static-bearer'
      secretPath: string
      // Optional custom header (lowercased here so the gateway can index
      // IncomingHttpHeaders directly). Defaults applied gateway-side; we
      // only forward when the author set the field.
      tokenHeader?: string
      // Author-supplied empty string is meaningful ("no prefix") so we
      // distinguish undefined (gateway uses default `Bearer `) from `''`
      // (gateway strips nothing, the whole header value is the token).
      tokenPrefix?: string
    }

/** Defaults the WRC applies when CRD optionals are omitted. */
const DEFAULT_METHODS: ReadonlyArray<'POST' | 'GET'> = ['POST']
const DEFAULT_MAX_BODY_BYTES = 1_048_576
const DEFAULT_SIGNATURE_ENCODING: 'hex' | 'base64' = 'hex'

/**
 * Constants shared with the gateway image (`webhook-gateway/src/server.ts`)
 * and the deployment manifests. Kept in lockstep with §11.1 of the spec.
 */
export const GATEWAY_HTTP_PORT = 8090
export const GATEWAY_METRICS_PORT = 9090
export const GATEWAY_LABEL = 'clerum.io/webhook-gateway'
export const RECIPE_NAMESPACE_LABEL = 'clerum.io/recipe-namespace'
export const RECIPE_NAME_LABEL = 'clerum.io/recipe-name'
export const CONFIG_HASH_ANNOTATION = 'clerum.io/config-hash'

/**
 * Per-recipe resource names. The "wf-" prefix mirrors what the rest of
 * WRC already uses for workflow-owned resources and stays inside the
 * 63-char DNS-1123 limit for any reasonable recipe name.
 */
export function gatewayResourceName(recipeName: string): string {
  return `wf-${recipeName}-webhook-gateway`
}

export function gatewayConfigMapName(recipeName: string): string {
  return `wf-${recipeName}-webhook-gateway-config`
}

export function gatewayJwksConfigMapName(recipeName: string): string {
  return `wf-${recipeName}-webhook-gateway-jwks`
}

export function gatewayServiceName(recipeName: string): string {
  return gatewayResourceName(recipeName)
}

export function proxyIngressNetworkPolicyName(recipeName: string): string {
  return `allow-webhook-proxy-ingress-wf-${recipeName}`
}

export function handlerEgressNetworkPolicyName(recipeName: string): string {
  return `allow-gateway-egress-to-handler-wf-${recipeName}`
}

export function handlerIngressNetworkPolicyName(recipeName: string): string {
  return `allow-gateway-ingress-to-handler-wf-${recipeName}`
}

/** Inputs to the builder. The reconciler resolves these before calling. */
export interface BuildInput {
  recipe: WorkflowRecipeCRD
  /** Webhooks pre-validated for W1 / W2 by the reconciler. */
  webhooks: WebhookDef[]
  /**
   * Recipe-namespace where ALL gateway resources live. Always
   * `sandbox-recipes` in production; tests pass a different namespace.
   */
  targetNamespace: string
  /**
   * Per-webhook handler workload metadata, resolved by the reconciler
   * via `resolveWorkloadResourceName(...)`. Map keyed on `webhookId`.
   */
  handlers: Record<string, HandlerMeta>
  /** Image reference for the webhook-gateway container. */
  image: string
  /** Namespace label of the metrics scraper (for the ingress rule). */
  monitoringNamespace: string
  /** Namespace label of webhook-proxy (for the ingress rule). */
  webhookIngressNamespace: string
  /** Resource requests/limits for the gateway container. */
  resources?: k8s.V1ResourceRequirements
  /**
   * Webhook ids the reconciler determined are dormant — `optional: true`
   * in the spec AND at least one referenced Secret/key is missing at
   * reconcile time. The builder marks the matching config entries
   * dormant (gateway short-circuits 410) and marks Secret projections
   * as optional so the pod can start without the missing Secret.
   */
  dormantWebhookIds?: ReadonlySet<string>
}

export interface HandlerMeta {
  /** Resolved K8s pod name (matches `app=` selector on the handler). */
  podName: string
  /** Service port the handler listens on. */
  port: number
  /** Path the handler workload sees on the forwarded request. */
  path: string
}

export interface BuildOutput {
  deployment: k8s.V1Deployment
  service: k8s.V1Service
  configConfigMap: k8s.V1ConfigMap
  proxyIngressPolicy: k8s.V1NetworkPolicy
  handlerEgressPolicy: k8s.V1NetworkPolicy
  handlerIngressPolicy: k8s.V1NetworkPolicy
}

export function buildWebhookGatewayResources(input: BuildInput): BuildOutput {
  const { recipe, webhooks, targetNamespace } = input
  const recipeName = recipe.metadata.name
  const recipeNamespace = recipe.metadata.namespace
  const dormantIds = input.dormantWebhookIds ?? new Set<string>()

  const labels: Record<string, string> = {
    'clerum.io/managed-by': 'workflow-recipes',
    [RECIPE_NAMESPACE_LABEL]: recipeNamespace,
    [RECIPE_NAME_LABEL]: recipeName,
    [GATEWAY_LABEL]: 'true',
  }

  const configJson = buildConfigJson(webhooks, input.handlers, dormantIds)
  const configHash = sha256(JSON.stringify(configJson))

  const configConfigMap = buildConfigConfigMap(
    recipe,
    targetNamespace,
    labels,
    JSON.stringify(configJson, null, 2)
  )

  const deployment = buildDeployment(recipe, targetNamespace, labels, webhooks, input, configHash)
  const service = buildService(recipe, targetNamespace, labels)
  const proxyIngressPolicy = buildProxyIngressPolicy(recipe, targetNamespace, labels, input)
  const handlerEgressPolicy = buildHandlerEgressPolicy(
    recipe,
    targetNamespace,
    labels,
    input.handlers
  )
  const handlerIngressPolicy = buildHandlerIngressPolicy(
    recipe,
    targetNamespace,
    labels,
    input.handlers
  )

  return {
    deployment,
    service,
    configConfigMap,
    proxyIngressPolicy,
    handlerEgressPolicy,
    handlerIngressPolicy,
  }
}

// ─── Builders ───────────────────────────────────────────────────────────

function buildConfigJson(
  webhooks: WebhookDef[],
  handlers: Record<string, HandlerMeta>,
  dormantIds: ReadonlySet<string>
): GatewayConfigJson {
  const out: GatewayConfigJson = { webhooks: {} }
  for (const wh of webhooks) {
    const handler = handlers[wh.id]
    if (!handler) {
      throw new Error(`webhookGatewayBuilder: missing handler metadata for webhook ${wh.id}`)
    }
    out.webhooks[wh.id] = buildEntry(wh, handler, dormantIds.has(wh.id))
  }
  return out
}

function buildEntry(
  wh: WebhookDef,
  handler: HandlerMeta,
  dormant: boolean
): GatewayConfigEntryJson {
  const entry: GatewayConfigEntryJson = {
    id: wh.id,
    methods: wh.methods ?? DEFAULT_METHODS,
    maxBodyBytes: wh.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    verification: buildVerificationJson(wh),
    setupHandshake: buildSetupHandshakeJson(wh),
    replay: wh.replay ? { ...wh.replay } : undefined,
    upstream: {
      host: handler.podName,
      port: handler.port,
      path: handler.path,
    },
  }
  if (dormant) {
    entry.dormant = true
    if (wh.verification.secretRef?.name) {
      entry.dormantSecretName = wh.verification.secretRef.name
    }
  }
  return entry
}

function buildSetupHandshakeJson(wh: WebhookDef): GatewaySetupHandshakeJson | undefined {
  const sh = wh.verification.setupHandshake
  if (!sh) return undefined
  if (sh.strategy === 'meta-hub-challenge') {
    if (!sh.secretRef) {
      // CRD W14 already enforces this at admission; defense-in-depth.
      throw new Error(
        `webhookGatewayBuilder: ${wh.id} setupHandshake.strategy=meta-hub-challenge missing secretRef`
      )
    }
    return { strategy: sh.strategy, secretPath: secretPathFor(wh.id, sh.secretRef.key) }
  }
  return {
    strategy: sh.strategy,
    secretPath: sh.secretRef ? secretPathFor(wh.id, sh.secretRef.key) : undefined,
  }
}

function buildVerificationJson(wh: WebhookDef): GatewayVerificationJson {
  const v = wh.verification
  switch (v.scheme) {
    case 'hmac-sha256-body':
    case 'hmac-sha256-timestamp-body': {
      // W7 already enforces secretRef presence at admission, but we
      // double-check to give a clear runtime error if upstream code drift
      // somehow violates it.
      if (!v.secretRef) {
        throw new Error(`webhookGatewayBuilder: ${wh.id} ${v.scheme} missing secretRef`)
      }
      return {
        scheme: v.scheme,
        signatureHeader: v.signatureHeader ?? defaultSignatureHeader(v.scheme),
        signaturePrefix: v.signaturePrefix,
        signatureEncoding: v.signatureEncoding ?? DEFAULT_SIGNATURE_ENCODING,
        secretPath: secretPathFor(wh.id, v.secretRef.key),
      }
    }
    case 'jwt-bearer-jwks':
      return {
        scheme: 'jwt-bearer-jwks',
        jwksUrl: v.jwksUrl ?? '',
        issuer: v.issuer ?? '',
        audience: v.audience ?? '',
        jwksPath: jwksPathFor(wh.id),
      }
    case 'static-bearer': {
      if (!v.secretRef) {
        throw new Error(`webhookGatewayBuilder: ${wh.id} static-bearer missing secretRef`)
      }
      const tokenHeader =
        typeof v.tokenHeader === 'string' && v.tokenHeader.length > 0
          ? v.tokenHeader.toLowerCase()
          : undefined
      // Preserve explicit empty string — that's the Telegram-style "no
      // prefix" case. typeof check separates `''` from `undefined`.
      const tokenPrefix = typeof v.tokenPrefix === 'string' ? v.tokenPrefix : undefined
      return {
        scheme: 'static-bearer',
        secretPath: secretPathFor(wh.id, v.secretRef.key),
        ...(tokenHeader !== undefined ? { tokenHeader } : {}),
        ...(tokenPrefix !== undefined ? { tokenPrefix } : {}),
      }
    }
  }
}

function defaultSignatureHeader(_scheme: WebhookVerificationScheme): string {
  // No safe per-scheme default — most providers vary. The CRD validates
  // signatureHeader format (W10) but we make it required at build time
  // by surfacing this as an authoring error if the recipe omits it.
  throw new Error(
    'webhookGatewayBuilder: signatureHeader is required for hmac-* schemes (set verification.signatureHeader)'
  )
}

function secretPathFor(webhookId: string, secretKey: string): string {
  return `/run/secrets/${webhookId}/${secretKey}`
}

function jwksPathFor(webhookId: string): string {
  return `/etc/webhook-gateway/jwks/${webhookId}.json`
}

function buildConfigConfigMap(
  recipe: WorkflowRecipeCRD,
  targetNamespace: string,
  labels: Record<string, string>,
  configJsonStr: string
): k8s.V1ConfigMap {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: gatewayConfigMapName(recipe.metadata.name),
      namespace: targetNamespace,
      labels,
      ownerReferences: [ownerRef(recipe)],
    },
    data: { 'config.json': configJsonStr },
  }
}

function buildDeployment(
  recipe: WorkflowRecipeCRD,
  targetNamespace: string,
  labels: Record<string, string>,
  webhooks: WebhookDef[],
  input: BuildInput,
  configHash: string
): k8s.V1Deployment {
  const name = gatewayResourceName(recipe.metadata.name)
  const dormantIds = input.dormantWebhookIds ?? new Set<string>()
  const projectedSources = buildSecretProjection(webhooks, dormantIds)

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name,
      namespace: targetNamespace,
      labels,
      ownerReferences: [ownerRef(recipe)],
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: {
          labels: { ...labels, app: name },
          annotations: { [CONFIG_HASH_ANNOTATION]: configHash },
        },
        spec: {
          automountServiceAccountToken: false,
          containers: [
            {
              name: 'gateway',
              image: input.image,
              ports: [
                { name: 'http', containerPort: GATEWAY_HTTP_PORT },
                { name: 'metrics', containerPort: GATEWAY_METRICS_PORT },
              ],
              env: [
                { name: 'GATEWAY_RECIPE_NAMESPACE', value: recipe.metadata.namespace },
                { name: 'GATEWAY_RECIPE_NAME', value: recipe.metadata.name },
                { name: 'GATEWAY_CONFIG_PATH', value: '/etc/webhook-gateway/config.json' },
                { name: 'GATEWAY_HEADER_TIMEOUT_MS', value: '5000' },
                { name: 'GATEWAY_BODY_IDLE_TIMEOUT_MS', value: '10000' },
                { name: 'GATEWAY_TOTAL_TIMEOUT_MS', value: '30000' },
                { name: 'GATEWAY_MAX_IN_FLIGHT', value: '256' },
              ],
              readinessProbe: { httpGet: { path: '/healthz', port: 'http' } },
              livenessProbe: { httpGet: { path: '/healthz', port: 'http' } },
              resources: input.resources ?? {
                requests: { cpu: '50m', memory: '64Mi' },
                limits: { cpu: '250m', memory: '128Mi' },
              },
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 1001,
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
                seccompProfile: { type: 'RuntimeDefault' },
              },
              volumeMounts: [
                {
                  name: 'config',
                  mountPath: '/etc/webhook-gateway',
                  readOnly: true,
                },
                {
                  name: 'secrets',
                  mountPath: '/run/secrets',
                  readOnly: true,
                },
              ],
            },
          ],
          volumes: [
            {
              name: 'config',
              configMap: { name: gatewayConfigMapName(recipe.metadata.name) },
            },
            {
              name: 'secrets',
              projected: { sources: projectedSources },
            },
          ],
        },
      },
    },
  }
}

function buildSecretProjection(
  webhooks: WebhookDef[],
  dormantIds: ReadonlySet<string>
): k8s.V1VolumeProjection[] {
  const sources: k8s.V1VolumeProjection[] = []
  for (const wh of webhooks) {
    // Dormant webhooks may reference Secrets that don't exist yet. Marking
    // each projection optional lets the gateway pod start without them; the
    // gateway short-circuits 410 for dormant entries so the missing files
    // are never read. When the Secret is later created the watcher fires a
    // reconcile, the config flips to non-dormant, and a rolling restart
    // re-renders the projection without `optional: true`.
    const isDormant = dormantIds.has(wh.id)
    const verifyRef = wh.verification.secretRef
    if (verifyRef) {
      sources.push({
        secret: {
          name: verifyRef.name,
          items: [{ key: verifyRef.key, path: `${wh.id}/${verifyRef.key}` }],
          optional: isDormant || undefined,
        },
      })
    }
    const handshakeRef = wh.verification.setupHandshake?.secretRef
    if (handshakeRef) {
      sources.push({
        secret: {
          name: handshakeRef.name,
          items: [{ key: handshakeRef.key, path: `${wh.id}/${handshakeRef.key}` }],
          optional: isDormant || undefined,
        },
      })
    }
  }
  return sources
}

function buildService(
  recipe: WorkflowRecipeCRD,
  targetNamespace: string,
  labels: Record<string, string>
): k8s.V1Service {
  const name = gatewayServiceName(recipe.metadata.name)
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name,
      namespace: targetNamespace,
      labels,
      ownerReferences: [ownerRef(recipe)],
    },
    spec: {
      type: 'ClusterIP',
      selector: { app: name },
      ports: [
        { name: 'http', port: GATEWAY_HTTP_PORT, targetPort: 'http' as unknown as number },
        {
          name: 'metrics',
          port: GATEWAY_METRICS_PORT,
          targetPort: 'metrics' as unknown as number,
        },
      ],
    },
  }
}

/**
 * WRC-owned proxy-ingress NetworkPolicy. Permits the cluster-shared
 * webhook-proxy (in `webhookIngressNamespace`) and the metrics scraper
 * to reach this recipe's gateway pod. Distinct ownership domain from
 * HCC's Context/MCP policies — those gate mcp-host / rpc-proxy / McpServer
 * traffic and never touch the gateway selector.
 */
function buildProxyIngressPolicy(
  recipe: WorkflowRecipeCRD,
  targetNamespace: string,
  labels: Record<string, string>,
  input: BuildInput
): k8s.V1NetworkPolicy {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: proxyIngressNetworkPolicyName(recipe.metadata.name),
      namespace: targetNamespace,
      labels,
      ownerReferences: [ownerRef(recipe)],
    },
    spec: {
      podSelector: {
        matchLabels: {
          [GATEWAY_LABEL]: 'true',
          [RECIPE_NAMESPACE_LABEL]: recipe.metadata.namespace,
          [RECIPE_NAME_LABEL]: recipe.metadata.name,
        },
      },
      policyTypes: ['Ingress'],
      ingress: [
        {
          // Webhook traffic from webhook-proxy.
          _from: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': input.webhookIngressNamespace },
              },
              podSelector: { matchLabels: { app: 'webhook-proxy' } },
            },
          ],
          ports: [{ port: GATEWAY_HTTP_PORT, protocol: 'TCP' }],
        },
        {
          // Prometheus scrape on the metrics port.
          _from: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': input.monitoringNamespace },
              },
            },
          ],
          ports: [{ port: GATEWAY_METRICS_PORT, protocol: 'TCP' }],
        },
      ],
    },
  }
}

/**
 * WRC-owned egress NetworkPolicy from the gateway pod to the recipe's own
 * handler workloads. This is a workflow-internal path — gateway and handler
 * are both in the recipe's namespace and both labeled
 * `clerum.io/managed-by: workflow-recipes`. HCC has no say here.
 */
function buildHandlerEgressPolicy(
  recipe: WorkflowRecipeCRD,
  targetNamespace: string,
  labels: Record<string, string>,
  handlers: Record<string, HandlerMeta>
): k8s.V1NetworkPolicy {
  // Distinct (port, podName) pairs across all webhooks. Two webhooks
  // pointing at the same handler workload only emit one egress rule.
  const handlerPodNames = new Set<string>()
  const handlerPorts = new Set<number>()
  for (const handler of Object.values(handlers)) {
    handlerPodNames.add(handler.podName)
    handlerPorts.add(handler.port)
  }
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: handlerEgressNetworkPolicyName(recipe.metadata.name),
      namespace: targetNamespace,
      labels,
      ownerReferences: [ownerRef(recipe)],
    },
    spec: {
      podSelector: {
        matchLabels: {
          [GATEWAY_LABEL]: 'true',
          [RECIPE_NAMESPACE_LABEL]: recipe.metadata.namespace,
          [RECIPE_NAME_LABEL]: recipe.metadata.name,
        },
      },
      policyTypes: ['Egress'],
      egress: [
        {
          to: [...handlerPodNames].map(podName => ({
            podSelector: { matchLabels: { app: podName } },
          })),
          ports: [...handlerPorts].map(port => ({ port, protocol: 'TCP' as const })),
        },
      ],
    },
  }
}

/**
 * WRC-owned symmetric ingress NetworkPolicy on the handler workloads. The
 * egress policy above only opens the gateway's *outbound* side; the handler
 * pods sit behind `deny-all-<ns>` (which HCC reconciles into the
 * `sandbox-recipes` namespace) with no ingress allowance, so gateway→handler
 * traffic is dropped at the handler's SYN. This policy selects the same
 * handler pods (by `app`) and allows ingress from the gateway pod on the
 * handler ports — mirroring `buildHandlerEgressPolicy` so both directions
 * open together.
 *
 * Note the boundary: HCC supplies the namespace baseline (deny-all + dns +
 * hcc-api + k8s-api egress); WRC layers this allow on top to permit the
 * recipe's own webhook path. Neither side modifies the other's policies.
 */
function buildHandlerIngressPolicy(
  recipe: WorkflowRecipeCRD,
  targetNamespace: string,
  labels: Record<string, string>,
  handlers: Record<string, HandlerMeta>
): k8s.V1NetworkPolicy {
  const handlerPodNames = new Set<string>()
  const handlerPorts = new Set<number>()
  for (const handler of Object.values(handlers)) {
    handlerPodNames.add(handler.podName)
    handlerPorts.add(handler.port)
  }
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: handlerIngressNetworkPolicyName(recipe.metadata.name),
      namespace: targetNamespace,
      labels,
      ownerReferences: [ownerRef(recipe)],
    },
    spec: {
      podSelector: {
        matchExpressions: [{ key: 'app', operator: 'In', values: [...handlerPodNames] }],
      },
      policyTypes: ['Ingress'],
      ingress: [
        {
          _from: [
            {
              podSelector: {
                matchLabels: {
                  [GATEWAY_LABEL]: 'true',
                  [RECIPE_NAMESPACE_LABEL]: recipe.metadata.namespace,
                  [RECIPE_NAME_LABEL]: recipe.metadata.name,
                },
              },
            },
          ],
          ports: [...handlerPorts].map(port => ({ port, protocol: 'TCP' as const })),
        },
      ],
    },
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}
