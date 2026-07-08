import { describe, expect, it } from 'vitest'
import type { WebhookDef, WorkflowRecipeCRD } from '../types'
import {
  type BuildInput,
  CONFIG_HASH_ANNOTATION,
  GATEWAY_HTTP_PORT,
  GATEWAY_LABEL,
  GATEWAY_METRICS_PORT,
  buildWebhookGatewayResources,
  gatewayConfigMapName,
  gatewayResourceName,
  gatewayServiceName,
  handlerEgressNetworkPolicyName,
  proxyIngressNetworkPolicyName,
} from './webhookGatewayBuilder'

const baseRecipe = (): WorkflowRecipeCRD => ({
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'WorkflowRecipe',
  metadata: {
    name: 'fireflies-recipe',
    namespace: 'sandbox-recipes',
    uid: '11111111-1111-1111-1111-111111111111',
  },
  spec: {
    workloads: [{ id: 'handler', type: 'deployment', image: 'echo:1', port: 8080 }],
  },
})

const fireflies = (): WebhookDef => ({
  id: 'fireflies',
  workloadRef: 'handler',
  path: '/webhooks/fireflies',
  verification: {
    scheme: 'hmac-sha256-body',
    secretRef: { name: 'fireflies-creds', key: 'signing-secret' },
    signatureHeader: 'X-Hub-Signature-256',
    signaturePrefix: 'sha256=',
  },
})

const baseInput = (overrides: Partial<BuildInput> = {}): BuildInput => ({
  recipe: baseRecipe(),
  webhooks: [fireflies()],
  targetNamespace: 'sandbox-recipes',
  handlers: {
    fireflies: { podName: 'handler-pod', port: 8080, path: '/webhooks/fireflies' },
  },
  image: 'clerum/webhook-gateway:0.1.0',
  monitoringNamespace: 'monitoring',
  webhookIngressNamespace: 'webhook-ingress',
  ...overrides,
})

describe('buildWebhookGatewayResources (W1.1) — Deployment shape', () => {
  it('emits one Deployment with the expected name + labels + container', () => {
    const out = buildWebhookGatewayResources(baseInput())
    expect(out.deployment.metadata?.name).toBe(gatewayResourceName('fireflies-recipe'))
    expect(out.deployment.metadata?.namespace).toBe('sandbox-recipes')
    expect(out.deployment.metadata?.labels?.[GATEWAY_LABEL]).toBe('true')
    const container = out.deployment.spec?.template?.spec?.containers?.[0]
    expect(container?.image).toBe('clerum/webhook-gateway:0.1.0')
    const ports = container?.ports?.map(p => p.containerPort)
    expect(ports).toEqual([GATEWAY_HTTP_PORT, GATEWAY_METRICS_PORT])
    // Slowloris budgets injected via env so the gateway picks them up.
    const envByName = Object.fromEntries((container?.env ?? []).map(e => [e.name, e.value]))
    expect(envByName.GATEWAY_HEADER_TIMEOUT_MS).toBe('5000')
    expect(envByName.GATEWAY_BODY_IDLE_TIMEOUT_MS).toBe('10000')
    expect(envByName.GATEWAY_TOTAL_TIMEOUT_MS).toBe('30000')
    expect(envByName.GATEWAY_MAX_IN_FLIGHT).toBe('256')
    // Recipe identity threaded via Downward-API-style env.
    expect(envByName.GATEWAY_RECIPE_NAMESPACE).toBe('sandbox-recipes')
    expect(envByName.GATEWAY_RECIPE_NAME).toBe('fireflies-recipe')
  })

  it('runs read-only filesystem, drops all caps, runs as UID 1001', () => {
    const out = buildWebhookGatewayResources(baseInput())
    const sec = out.deployment.spec?.template?.spec?.containers?.[0].securityContext
    expect(sec?.runAsNonRoot).toBe(true)
    expect(sec?.runAsUser).toBe(1001)
    expect(sec?.allowPrivilegeEscalation).toBe(false)
    expect(sec?.readOnlyRootFilesystem).toBe(true)
    expect(sec?.capabilities?.drop).toEqual(['ALL'])
    expect(sec?.seccompProfile?.type).toBe('RuntimeDefault')
    expect(out.deployment.spec?.template?.spec?.automountServiceAccountToken).toBe(false)
  })

  it('mounts config ConfigMap and projected secrets', () => {
    const out = buildWebhookGatewayResources(baseInput())
    const volumes = out.deployment.spec?.template?.spec?.volumes ?? []
    const configVol = volumes.find(v => v.name === 'config')
    expect(configVol?.configMap?.name).toBe(gatewayConfigMapName('fireflies-recipe'))
    const secretsVol = volumes.find(v => v.name === 'secrets')
    expect(secretsVol?.projected?.sources?.length).toBe(1)
    const projection = secretsVol?.projected?.sources?.[0].secret
    expect(projection?.name).toBe('fireflies-creds')
    expect(projection?.items?.[0]).toEqual({
      key: 'signing-secret',
      path: 'fireflies/signing-secret',
    })
  })

  it('omits secret projection for jwt-bearer-jwks webhooks', () => {
    const jwtWebhook: WebhookDef = {
      id: 'gemini',
      workloadRef: 'handler',
      path: '/webhooks/gemini',
      verification: {
        scheme: 'jwt-bearer-jwks',
        jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
        issuer: 'https://accounts.google.com',
        audience: 'https://my-app/wh/gemini',
      },
    }
    const out = buildWebhookGatewayResources(
      baseInput({
        webhooks: [jwtWebhook],
        handlers: {
          gemini: { podName: 'handler-pod', port: 8080, path: '/webhooks/gemini' },
        },
      })
    )
    const secretsVol = out.deployment.spec?.template?.spec?.volumes?.find(v => v.name === 'secrets')
    expect(secretsVol?.projected?.sources).toEqual([])
  })

  it('stamps a config-hash annotation that changes when config changes', () => {
    const a = buildWebhookGatewayResources(baseInput())
    const annotationsA =
      a.deployment.spec?.template?.metadata?.annotations?.[CONFIG_HASH_ANNOTATION]
    expect(annotationsA).toMatch(/^[0-9a-f]{64}$/)

    // Same input → same hash (idempotent reconcile).
    const aRepeat = buildWebhookGatewayResources(baseInput())
    expect(aRepeat.deployment.spec?.template?.metadata?.annotations?.[CONFIG_HASH_ANNOTATION]).toBe(
      annotationsA
    )

    // Different webhook id → different hash → triggers rolling restart.
    const altWebhook: WebhookDef = { ...fireflies(), id: 'fireflies-v2' }
    const b = buildWebhookGatewayResources(
      baseInput({
        webhooks: [altWebhook],
        handlers: { 'fireflies-v2': baseInput().handlers.fireflies },
      })
    )
    expect(b.deployment.spec?.template?.metadata?.annotations?.[CONFIG_HASH_ANNOTATION]).not.toBe(
      annotationsA
    )
  })
})

describe('buildWebhookGatewayResources (W1.1) — Service', () => {
  it('emits ClusterIP Service with http + metrics ports', () => {
    const out = buildWebhookGatewayResources(baseInput())
    expect(out.service.metadata?.name).toBe(gatewayServiceName('fireflies-recipe'))
    expect(out.service.spec?.type).toBe('ClusterIP')
    const portsByName = Object.fromEntries(
      (out.service.spec?.ports ?? []).map(p => [p.name, p.port])
    )
    expect(portsByName.http).toBe(GATEWAY_HTTP_PORT)
    expect(portsByName.metrics).toBe(GATEWAY_METRICS_PORT)
  })
})

describe('buildWebhookGatewayResources (W1.1) — ConfigMap', () => {
  it('serialises a Fireflies hmac-sha256-body entry into config.json', () => {
    const out = buildWebhookGatewayResources(baseInput())
    const data = out.configConfigMap.data?.['config.json']
    expect(typeof data).toBe('string')
    const parsed = JSON.parse(data!)
    const entry = parsed.webhooks.fireflies
    expect(entry.id).toBe('fireflies')
    expect(entry.methods).toEqual(['POST'])
    expect(entry.maxBodyBytes).toBe(1_048_576)
    expect(entry.verification).toEqual({
      scheme: 'hmac-sha256-body',
      signatureHeader: 'X-Hub-Signature-256',
      signaturePrefix: 'sha256=',
      signatureEncoding: 'hex',
      secretPath: '/run/secrets/fireflies/signing-secret',
    })
    expect(entry.upstream).toEqual({
      host: 'handler-pod',
      port: 8080,
      path: '/webhooks/fireflies',
    })
    expect(entry.replay).toBeUndefined()
  })

  it('includes replay block for hmac-sha256-timestamp-body', () => {
    const stripe: WebhookDef = {
      id: 'stripe',
      workloadRef: 'handler',
      path: '/webhooks/stripe',
      verification: {
        scheme: 'hmac-sha256-timestamp-body',
        secretRef: { name: 'stripe-creds', key: 'signing-secret' },
        signatureHeader: 'stripe-signature',
        signaturePrefix: 'v1=',
      },
      replay: { timestampHeader: 'stripe-timestamp', toleranceSec: 300 },
    }
    const out = buildWebhookGatewayResources(
      baseInput({
        webhooks: [stripe],
        handlers: { stripe: { podName: 'handler-pod', port: 8080, path: '/webhooks/stripe' } },
      })
    )
    const parsed = JSON.parse(out.configConfigMap.data!['config.json'])
    expect(parsed.webhooks.stripe.replay).toEqual({
      timestampHeader: 'stripe-timestamp',
      toleranceSec: 300,
    })
  })

  it('throws when an hmac scheme entry is missing signatureHeader', () => {
    const broken: WebhookDef = {
      id: 'fireflies',
      workloadRef: 'handler',
      path: '/x',
      verification: {
        scheme: 'hmac-sha256-body',
        secretRef: { name: 's', key: 'k' },
      },
    }
    expect(() =>
      buildWebhookGatewayResources(
        baseInput({
          webhooks: [broken],
          handlers: { fireflies: baseInput().handlers.fireflies },
        })
      )
    ).toThrow(/signatureHeader is required/)
  })
})

describe('buildWebhookGatewayResources (W1.1) — NetworkPolicies', () => {
  it('builds proxy-ingress policy with both webhook-proxy and Prometheus scrape rules', () => {
    const out = buildWebhookGatewayResources(baseInput())
    expect(out.proxyIngressPolicy.metadata?.name).toBe(
      proxyIngressNetworkPolicyName('fireflies-recipe')
    )
    expect(out.proxyIngressPolicy.spec?.policyTypes).toEqual(['Ingress'])
    const ingress = out.proxyIngressPolicy.spec?.ingress ?? []
    expect(ingress).toHaveLength(2)
    // First rule: webhook-proxy on :8090.
    expect(ingress[0].ports).toEqual([{ port: GATEWAY_HTTP_PORT, protocol: 'TCP' }])
    expect(
      ingress[0]._from?.[0].namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name']
    ).toBe('webhook-ingress')
    expect(ingress[0]._from?.[0].podSelector?.matchLabels?.app).toBe('webhook-proxy')
    // Second rule: Prometheus on :9090.
    expect(ingress[1].ports).toEqual([{ port: GATEWAY_METRICS_PORT, protocol: 'TCP' }])
    expect(
      ingress[1]._from?.[0].namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name']
    ).toBe('monitoring')
  })

  it('builds handler-egress policy with one rule per distinct (pod, port) pair', () => {
    const wh1: WebhookDef = {
      id: 'a',
      workloadRef: 'handler',
      path: '/a',
      verification: {
        scheme: 'hmac-sha256-body',
        secretRef: { name: 's', key: 'k' },
        signatureHeader: 'x-sig',
      },
    }
    const wh2: WebhookDef = { ...wh1, id: 'b', path: '/b' }
    const out = buildWebhookGatewayResources(
      baseInput({
        webhooks: [wh1, wh2],
        // Both webhooks share the same handler — egress rule must dedupe.
        handlers: {
          a: { podName: 'handler-pod', port: 8080, path: '/a' },
          b: { podName: 'handler-pod', port: 8080, path: '/b' },
        },
      })
    )
    expect(out.handlerEgressPolicy.metadata?.name).toBe(
      handlerEgressNetworkPolicyName('fireflies-recipe')
    )
    expect(out.handlerEgressPolicy.spec?.policyTypes).toEqual(['Egress'])
    const egress = out.handlerEgressPolicy.spec?.egress ?? []
    expect(egress).toHaveLength(1)
    expect(egress[0].to).toEqual([{ podSelector: { matchLabels: { app: 'handler-pod' } } }])
    expect(egress[0].ports).toEqual([{ port: 8080, protocol: 'TCP' }])
  })
})

describe('buildWebhookGatewayResources (W1.1) — owner refs', () => {
  it('owner-references all four resources back to the recipe', () => {
    const out = buildWebhookGatewayResources(baseInput())
    for (const r of [
      out.deployment,
      out.service,
      out.configConfigMap,
      out.proxyIngressPolicy,
      out.handlerEgressPolicy,
    ]) {
      expect(r.metadata?.ownerReferences?.[0].uid).toBe('11111111-1111-1111-1111-111111111111')
      expect(r.metadata?.ownerReferences?.[0].kind).toBe('WorkflowRecipe')
      expect(r.metadata?.ownerReferences?.[0].controller).toBe(true)
    }
  })
})

describe('buildWebhookGatewayResources (W2.1) — setupHandshake', () => {
  const metaWebhook = (): WebhookDef => ({
    id: 'whatsapp',
    workloadRef: 'handler',
    path: '/webhooks/whatsapp',
    methods: ['POST', 'GET'],
    verification: {
      scheme: 'hmac-sha256-body',
      secretRef: { name: 'meta-creds', key: 'app-secret' },
      signatureHeader: 'X-Hub-Signature-256',
      signaturePrefix: 'sha256=',
      setupHandshake: {
        strategy: 'meta-hub-challenge',
        secretRef: { name: 'meta-creds', key: 'hub-verify-token' },
      },
    },
  })

  const slackWebhook = (): WebhookDef => ({
    id: 'slack',
    workloadRef: 'handler',
    path: '/webhooks/slack',
    verification: {
      scheme: 'hmac-sha256-timestamp-body',
      secretRef: { name: 'slack-creds', key: 'signing-secret' },
      signatureHeader: 'X-Slack-Signature',
      signaturePrefix: 'v0=',
      setupHandshake: { strategy: 'slack-url-verification' },
    },
    replay: { timestampHeader: 'X-Slack-Request-Timestamp', toleranceSec: 300 },
  })

  it('projects meta-hub-challenge into the gateway ConfigMap with secretPath', () => {
    const out = buildWebhookGatewayResources(
      baseInput({
        webhooks: [metaWebhook()],
        handlers: {
          whatsapp: { podName: 'handler-pod', port: 8080, path: '/webhooks/whatsapp' },
        },
      })
    )
    const config = JSON.parse(out.configConfigMap.data?.['config.json'] ?? '{}')
    const entry = config.webhooks.whatsapp
    expect(entry.setupHandshake).toEqual({
      strategy: 'meta-hub-challenge',
      secretPath: '/run/secrets/whatsapp/hub-verify-token',
    })
    expect(entry.methods).toEqual(['POST', 'GET'])
  })

  it('projects slack-url-verification with no secretPath', () => {
    const out = buildWebhookGatewayResources(
      baseInput({
        webhooks: [slackWebhook()],
        handlers: {
          slack: { podName: 'handler-pod', port: 8080, path: '/webhooks/slack' },
        },
      })
    )
    const config = JSON.parse(out.configConfigMap.data?.['config.json'] ?? '{}')
    const entry = config.webhooks.slack
    expect(entry.setupHandshake).toEqual({ strategy: 'slack-url-verification' })
  })

  it('mounts the setupHandshake.secretRef alongside the verification.secretRef', () => {
    const out = buildWebhookGatewayResources(
      baseInput({
        webhooks: [metaWebhook()],
        handlers: {
          whatsapp: { podName: 'handler-pod', port: 8080, path: '/webhooks/whatsapp' },
        },
      })
    )
    const projected = out.deployment.spec?.template.spec?.volumes?.find(
      v => v.name === 'secrets'
    )?.projected
    const sources = projected?.sources ?? []
    // One source for the verify signing secret + one for the hub-verify token.
    expect(sources).toHaveLength(2)
    const allItems = sources.flatMap(s => s.secret?.items ?? [])
    const itemPaths = allItems.map(i => i.path).sort()
    expect(itemPaths).toEqual(['whatsapp/app-secret', 'whatsapp/hub-verify-token'])
  })

  it('omits setupHandshake from the JSON when the recipe does not declare one', () => {
    const out = buildWebhookGatewayResources(baseInput())
    const config = JSON.parse(out.configConfigMap.data?.['config.json'] ?? '{}')
    expect(config.webhooks.fireflies.setupHandshake).toBeUndefined()
  })

  it('throws if meta-hub-challenge is missing setupHandshake.secretRef (defense-in-depth W14)', () => {
    const wh: WebhookDef = {
      ...metaWebhook(),
      verification: {
        ...metaWebhook().verification,
        setupHandshake: { strategy: 'meta-hub-challenge' }, // no secretRef
      },
    }
    expect(() =>
      buildWebhookGatewayResources(
        baseInput({
          webhooks: [wh],
          handlers: { whatsapp: { podName: 'p', port: 8080, path: '/webhooks/whatsapp' } },
        })
      )
    ).toThrow(/meta-hub-challenge missing secretRef/)
  })
})
