import { describe, expect, it } from 'vitest'
import {
  type BindingDef,
  type ComputedValue,
  type HealthCheck,
  type OAuthClientDef,
  type OAuthProvider,
  type RecipeDependency,
  type ResourceDef,
  type SandboxUiSpec,
  type SecurityIsolationLevel,
  type WebhookDef,
  type WebhookSetupHandshakeStrategy,
  type WebhookVerificationScheme,
  type WorkflowRecipeCRD,
  type WorkflowRecipePolicySpec,
  type WorkflowRecipeStatus,
  type WorkloadDef,
  type WorkloadStatus,
  isOAuthProvider,
  isRecipePhase,
  isWebhookSetupHandshakeStrategy,
  isWebhookVerificationScheme,
  isWorkloadType,
} from './types'

describe('isWorkloadType', () => {
  it('should return true for valid workload types (Risk 1.1)', () => {
    expect(isWorkloadType('deployment')).toBe(true)
    expect(isWorkloadType('statefulset')).toBe(true)
    expect(isWorkloadType('cronjob')).toBe(true)
    expect(isWorkloadType('job')).toBe(true)
    expect(isWorkloadType('daemonset')).toBe(true)
  })

  it('should return false for invalid workload types (Risk 1.1)', () => {
    expect(isWorkloadType('invalid')).toBe(false)
    expect(isWorkloadType('')).toBe(false)
    expect(isWorkloadType('Deployment')).toBe(false)
  })
})

describe('isRecipePhase', () => {
  it('should return true for all 13 phases (Risk 1.1)', () => {
    const allPhases = [
      'candidate',
      'pending-approval',
      'approved',
      'pending',
      'pending-operator-input',
      'deploying',
      'testing',
      'active',
      'degraded',
      'rolling-back',
      'failed',
      'deprecated',
      'rollback-failed',
    ]
    for (const phase of allPhases) {
      expect(isRecipePhase(phase)).toBe(true)
    }
    expect(allPhases).toHaveLength(13)
  })
})

describe('WorkflowRecipeCRD interface (Risk 1.2)', () => {
  it('should match CRD YAML required fields', () => {
    const crd: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'test', namespace: 'mcp-server' },
      spec: {
        workloads: [
          {
            id: 'nginx',
            type: 'deployment',
            image: 'nginx:1.30.1-alpine',
          },
        ],
      },
    }
    expect(crd.spec.workloads!).toHaveLength(1)
    expect(crd.spec.workloads![0].type).toBe('deployment')
  })
})

describe('SandboxUiSpec', () => {
  it('accepts the minimal required shape', () => {
    const ui: SandboxUiSpec = {
      workloadRef: 'frontend',
      port: 8080,
    }
    expect(ui.workloadRef).toBe('frontend')
    expect(ui.port).toBe(8080)
  })

  it('accepts the full shape with egress declarations', () => {
    const ui: SandboxUiSpec = {
      workloadRef: 'frontend',
      port: 8080,
      title: 'My Dashboard',
      icon: 'data:image/svg+xml;base64,PHN2Zy8+',
      defaultPath: '/dashboard',
      egress: {
        internal: [{ workloadRef: 'postgres', port: 5432 }],
        external: [{ fqdn: 'api.stripe.com', port: 443, reason: 'Charge cards' }],
      },
    }
    expect(ui.egress?.internal?.[0].workloadRef).toBe('postgres')
    expect(ui.egress?.external?.[0].fqdn).toBe('api.stripe.com')
  })

  it('accepts multiple external egress entries declared by fqdn (resolved by WRC)', () => {
    const ui: SandboxUiSpec = {
      workloadRef: 'frontend',
      port: 8080,
      egress: {
        external: [
          { fqdn: 'api.stripe.com', port: 443, reason: 'Charge cards' },
          { fqdn: 'ingest.sentry.io', port: 443 },
        ],
      },
    }
    const fqdns = ui.egress?.external?.map(e => e.fqdn) ?? []
    expect(fqdns).toEqual(['api.stripe.com', 'ingest.sentry.io'])
  })

  it('attaches to WorkflowRecipeSpec.ui as an optional field', () => {
    const crd: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'r', namespace: 'sandbox-recipes' },
      spec: {
        workloads: [{ id: 'frontend', type: 'deployment', image: 'app:1' }],
        ui: { workloadRef: 'frontend', port: 8080 },
      },
    }
    expect(crd.spec.ui?.workloadRef).toBe('frontend')
  })
})

describe('WorkloadDef discriminated union (Risk 1.2)', () => {
  it('should cover all 5 workload types', () => {
    const workloads: WorkloadDef[] = [
      { id: 'a', type: 'deployment', image: 'img' },
      { id: 'b', type: 'statefulset', image: 'img' },
      { id: 'c', type: 'cronjob', image: 'img', schedule: '*/5 * * * *' },
      { id: 'd', type: 'job', image: 'img' },
      { id: 'e', type: 'daemonset', image: 'img' },
    ]
    const types = workloads.map(w => w.type)
    expect(types).toEqual(['deployment', 'statefulset', 'cronjob', 'job', 'daemonset'])
  })
})

describe('ResourceDef discriminated union (Risk 1.2)', () => {
  it('should cover pvc, secret, configmap', () => {
    const resources: ResourceDef[] = [
      { id: 'vol', type: 'pvc', size: '10Gi' },
      { id: 'creds', type: 'secret', generateKeys: ['password'] },
      { id: 'cfg', type: 'configmap', data: { key: 'value' } },
    ]
    const types = resources.map(r => r.type)
    expect(types).toEqual(['pvc', 'secret', 'configmap'])
  })
})

describe('WorkflowRecipeStatus (Risk 1.3)', () => {
  it('should have all required fields', () => {
    const status: WorkflowRecipeStatus = {
      phase: 'active',
      message: 'All workloads running',
      lastTransitionTime: new Date().toISOString(),
      workloads: [{ id: 'nginx', type: 'deployment', phase: 'active', ready: true }],
    }
    expect(status.phase).toBe('active')
    expect(status.lastTransitionTime).toBeDefined()
  })

  it('should track per-workload status (Risk 1.3)', () => {
    const ws: WorkloadStatus = {
      id: 'pg',
      type: 'statefulset',
      phase: 'deploying',
      ready: false,
    }
    expect(ws.id).toBe('pg')
    expect(ws.ready).toBe(false)
  })
})

describe('SecurityIsolationLevel (Risk 1.4)', () => {
  it('should have exactly 3 values', () => {
    const levels: SecurityIsolationLevel[] = ['minimal', 'standard', 'strict']
    expect(levels).toHaveLength(3)
  })
})

describe('BindingDef (Risk 1.4)', () => {
  it('should require from, to, port', () => {
    const binding: BindingDef = { from: 'app', to: 'db', port: 5432 }
    expect(binding.from).toBe('app')
    expect(binding.to).toBe('db')
    expect(binding.port).toBe(5432)
  })
})

describe('ComputedValue (Risk 1.5)', () => {
  it('should validate expression field', () => {
    const cv: ComputedValue = { name: 'db_url', expression: 'postgres://{{db:host}}:5432' }
    expect(cv.expression).toContain('{{db:host}}')
  })
})

describe('RecipeDependency (Risk 1.5)', () => {
  it('should validate name, namespace, cascadeRollback, maxWaitMinutes', () => {
    const dep: RecipeDependency = {
      name: 'postgres-base',
      namespace: 'mcp-server',
      cascadeRollback: true,
      maxWaitMinutes: 10,
    }
    expect(dep.name).toBe('postgres-base')
    expect(dep.namespace).toBe('mcp-server')
    expect(dep.cascadeRollback).toBe(true)
    expect(dep.maxWaitMinutes).toBe(10)
  })
})

describe('WorkflowRecipeSpec new fields (Risk 1.2)', () => {
  it('should include contextRef, inputContract, activeProfile (Risk 1.5c)', () => {
    const crd: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'test', namespace: 'mcp-server' },
      spec: {
        contextRef: 'production',
        inputContract: { type: 'object', properties: { replicas: { type: 'number', default: 1 } } },
        activeProfile: 'prod',
        workloads: [{ id: 'app', type: 'deployment', image: 'img' }],
      },
    }
    expect(crd.spec.contextRef).toBe('production')
    expect(crd.spec.inputContract).toBeDefined()
    expect(crd.spec.activeProfile).toBe('prod')
  })
})

describe('HealthCheck type discriminator (Risk 1.2)', () => {
  it('should support http, tcp, exec types (Risk 1.5d)', () => {
    const checks: HealthCheck[] = [
      { type: 'http', path: '/health', port: 8080 },
      { type: 'tcp', port: 5432 },
      { type: 'exec', command: ['pg_isready'] },
    ]
    expect(checks.map(c => c.type)).toEqual(['http', 'tcp', 'exec'])
    expect(checks[0].path).toBe('/health')
    expect(checks[2].command).toEqual(['pg_isready'])
  })
})

describe('isWebhookVerificationScheme (W1.1)', () => {
  it('accepts the four schemes from spec §7', () => {
    expect(isWebhookVerificationScheme('hmac-sha256-body')).toBe(true)
    expect(isWebhookVerificationScheme('hmac-sha256-timestamp-body')).toBe(true)
    expect(isWebhookVerificationScheme('jwt-bearer-jwks')).toBe(true)
    expect(isWebhookVerificationScheme('static-bearer')).toBe(true)
  })

  it('rejects misspellings, casing, and unknown schemes', () => {
    expect(isWebhookVerificationScheme('')).toBe(false)
    expect(isWebhookVerificationScheme('hmac')).toBe(false)
    expect(isWebhookVerificationScheme('HMAC-SHA256-BODY')).toBe(false)
    expect(isWebhookVerificationScheme('hmac-sha512-body')).toBe(false)
    expect(isWebhookVerificationScheme('jwt-bearer')).toBe(false)
  })

  it('covers every WebhookVerificationScheme branch (exhaustiveness)', () => {
    const all: WebhookVerificationScheme[] = [
      'hmac-sha256-body',
      'hmac-sha256-timestamp-body',
      'jwt-bearer-jwks',
      'static-bearer',
    ]
    for (const s of all) {
      expect(isWebhookVerificationScheme(s)).toBe(true)
    }
  })
})

describe('WebhookDef shape (W1.1)', () => {
  it('models a Fireflies-shaped hmac-sha256-body webhook', () => {
    const wh: WebhookDef = {
      id: 'fireflies',
      workloadRef: 'handler',
      path: '/webhooks/fireflies',
      verification: {
        scheme: 'hmac-sha256-body',
        secretRef: { name: 'fireflies-creds', key: 'signing-secret' },
        signatureHeader: 'x-hub-signature-256',
        signaturePrefix: 'sha256=',
      },
    }
    expect(wh.verification.scheme).toBe('hmac-sha256-body')
    expect(wh.verification.secretRef?.key).toBe('signing-secret')
    expect(wh.methods).toBeUndefined() // CRD default kicks in at admission
    expect(wh.maxBodyBytes).toBeUndefined()
  })

  it('models a Stripe-shaped hmac-sha256-timestamp-body webhook with replay', () => {
    const wh: WebhookDef = {
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
    expect(wh.replay?.toleranceSec).toBe(300)
  })

  it('models a jwt-bearer-jwks webhook (no secretRef)', () => {
    const wh: WebhookDef = {
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
    expect(wh.verification.secretRef).toBeUndefined()
    expect(wh.verification.jwksUrl).toContain('https://')
    expect(wh.verification.issuer).toBeDefined()
    expect(wh.verification.audience).toBeDefined()
  })

  it('models a static-bearer webhook', () => {
    const wh: WebhookDef = {
      id: 'legacy',
      workloadRef: 'handler',
      path: '/webhooks/legacy',
      verification: {
        scheme: 'static-bearer',
        secretRef: { name: 'legacy-creds', key: 'token' },
      },
    }
    expect(wh.verification.scheme).toBe('static-bearer')
  })

  it('accepts methods restricted to POST or POST,GET', () => {
    const post: WebhookDef = {
      id: 'a',
      workloadRef: 'h',
      path: '/a',
      methods: ['POST'],
      verification: { scheme: 'hmac-sha256-body', secretRef: { name: 's', key: 'k' } },
    }
    const both: WebhookDef = {
      id: 'b',
      workloadRef: 'h',
      path: '/b',
      methods: ['POST', 'GET'],
      verification: { scheme: 'hmac-sha256-body', secretRef: { name: 's', key: 'k' } },
    }
    expect(post.methods).toEqual(['POST'])
    expect(both.methods).toEqual(['POST', 'GET'])
  })

  it('attaches to WorkflowRecipeSpec.webhooks alongside workloads', () => {
    const crd: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'wh-recipe', namespace: 'sandbox-recipes' },
      spec: {
        workloads: [{ id: 'handler', type: 'deployment', image: 'echo:1' }],
        webhooks: [
          {
            id: 'fireflies',
            workloadRef: 'handler',
            path: '/webhooks/fireflies',
            verification: {
              scheme: 'hmac-sha256-body',
              secretRef: { name: 's', key: 'k' },
              signatureHeader: 'x-hub-signature-256',
            },
          },
        ],
      },
    }
    expect(crd.spec.webhooks).toHaveLength(1)
    expect(crd.spec.webhooks?.[0].workloadRef).toBe('handler')
  })
})

describe('isWebhookSetupHandshakeStrategy (W2.x setupHandshake)', () => {
  it('accepts the three strategies from spec §7.5', () => {
    expect(isWebhookSetupHandshakeStrategy('meta-hub-challenge')).toBe(true)
    expect(isWebhookSetupHandshakeStrategy('slack-url-verification')).toBe(true)
    expect(isWebhookSetupHandshakeStrategy('stripe-verify')).toBe(true)
  })

  it('rejects misspellings, casing, and unknown strategies', () => {
    expect(isWebhookSetupHandshakeStrategy('')).toBe(false)
    expect(isWebhookSetupHandshakeStrategy('meta')).toBe(false)
    expect(isWebhookSetupHandshakeStrategy('META-HUB-CHALLENGE')).toBe(false)
    expect(isWebhookSetupHandshakeStrategy('hub-challenge')).toBe(false)
    expect(isWebhookSetupHandshakeStrategy('slack')).toBe(false)
  })

  it('covers every WebhookSetupHandshakeStrategy branch (exhaustiveness)', () => {
    const all: WebhookSetupHandshakeStrategy[] = [
      'meta-hub-challenge',
      'slack-url-verification',
      'stripe-verify',
    ]
    for (const s of all) {
      expect(isWebhookSetupHandshakeStrategy(s)).toBe(true)
    }
  })
})

describe('WebhookDef with setupHandshake (W2.x)', () => {
  it('models a meta-hub-challenge webhook (GET in methods + setupHandshake.secretRef)', () => {
    const wh: WebhookDef = {
      id: 'whatsapp',
      workloadRef: 'handler',
      path: '/webhooks/whatsapp',
      methods: ['POST', 'GET'],
      verification: {
        scheme: 'hmac-sha256-body',
        secretRef: { name: 'meta-creds', key: 'app-secret' },
        signatureHeader: 'x-hub-signature-256',
        signaturePrefix: 'sha256=',
        setupHandshake: {
          strategy: 'meta-hub-challenge',
          secretRef: { name: 'meta-creds', key: 'hub-verify-token' },
        },
      },
    }
    expect(wh.verification.setupHandshake?.strategy).toBe('meta-hub-challenge')
    expect(wh.verification.setupHandshake?.secretRef?.key).toBe('hub-verify-token')
    expect(wh.methods).toContain('GET')
  })

  it('models a slack-url-verification webhook (no setupHandshake.secretRef; signed by main scheme)', () => {
    const wh: WebhookDef = {
      id: 'slack',
      workloadRef: 'handler',
      path: '/webhooks/slack',
      verification: {
        scheme: 'hmac-sha256-timestamp-body',
        secretRef: { name: 'slack-creds', key: 'signing-secret' },
        signatureHeader: 'x-slack-signature',
        signaturePrefix: 'v0=',
        setupHandshake: { strategy: 'slack-url-verification' },
      },
      replay: { timestampHeader: 'x-slack-request-timestamp', toleranceSec: 300 },
    }
    expect(wh.verification.setupHandshake?.strategy).toBe('slack-url-verification')
    expect(wh.verification.setupHandshake?.secretRef).toBeUndefined()
  })

  it('omits setupHandshake on plain hmac webhooks', () => {
    const wh: WebhookDef = {
      id: 'fireflies',
      workloadRef: 'handler',
      path: '/webhooks/fireflies',
      verification: {
        scheme: 'hmac-sha256-body',
        secretRef: { name: 'fireflies-creds', key: 'signing-secret' },
        signatureHeader: 'x-hub-signature-256',
      },
    }
    expect(wh.verification.setupHandshake).toBeUndefined()
  })
})

describe('WorkflowRecipePolicySpec nested structure (Risk 1.2)', () => {
  it('should have governance, detection, publication, deployment, notification, deprecation (Risk 1.5e)', () => {
    const policy: WorkflowRecipePolicySpec = {
      governance: { requireApproval: true, maxWorkloadsPerRecipe: 10 },
      detection: { enabled: true, scanOnDeploy: true },
      publication: { registry: 'registry.example.com' },
      deployment: { autoPromoteAfterSeconds: 300, rollbackOnFailure: true },
      notification: { channels: ['slack-ops'], events: ['deploy', 'failed'] },
      deprecation: { gracePeriodDays: 30 },
    }
    expect(policy.governance?.requireApproval).toBe(true)
    expect(policy.detection?.enabled).toBe(true)
    expect(policy.publication?.registry).toBe('registry.example.com')
    expect(policy.deployment?.autoPromoteAfterSeconds).toBe(300)
    expect(policy.notification?.events).toContain('deploy')
    expect(policy.deprecation?.gracePeriodDays).toBe(30)
  })
})

describe('isOAuthProvider (O1.1)', () => {
  it('accepts the five known-shape providers', () => {
    expect(isOAuthProvider('salesforce')).toBe(true)
    expect(isOAuthProvider('slack')).toBe(true)
    expect(isOAuthProvider('notion')).toBe(true)
    expect(isOAuthProvider('microsoft-graph')).toBe(true)
    expect(isOAuthProvider('google')).toBe(true)
  })

  it('rejects misspellings, casing, and unknown providers', () => {
    expect(isOAuthProvider('')).toBe(false)
    expect(isOAuthProvider('Salesforce')).toBe(false)
    expect(isOAuthProvider('github')).toBe(false)
    expect(isOAuthProvider('google-workspace')).toBe(false)
    expect(isOAuthProvider('microsoft')).toBe(false)
  })

  it('covers every OAuthProvider branch (exhaustiveness)', () => {
    const all: OAuthProvider[] = ['salesforce', 'slack', 'notion', 'microsoft-graph', 'google']
    for (const p of all) {
      expect(isOAuthProvider(p)).toBe(true)
    }
  })
})

describe('OAuthClientDef shape (O1.1)', () => {
  it('models a Salesforce client with scopes', () => {
    const c: OAuthClientDef = {
      id: 'salesforce',
      provider: 'salesforce',
      clientIdRef: { name: 'salesforce-creds', key: 'client-id' },
      clientSecretRef: { name: 'salesforce-creds', key: 'client-secret' },
      scopes: ['api', 'refresh_token'],
    }
    expect(c.provider).toBe('salesforce')
    expect(c.clientIdRef.key).toBe('client-id')
    expect(c.scopes).toEqual(['api', 'refresh_token'])
  })

  it('allows omitting scopes (per-provider default applies in control-api)', () => {
    const c: OAuthClientDef = {
      id: 'slack',
      provider: 'slack',
      clientIdRef: { name: 'slack-creds', key: 'client-id' },
      clientSecretRef: { name: 'slack-creds', key: 'client-secret' },
    }
    expect(c.scopes).toBeUndefined()
  })

  it('attaches to WorkflowRecipeSpec.oauthClients alongside ui', () => {
    const crd: WorkflowRecipeCRD = {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'crm', namespace: 'sandbox-recipes' },
      spec: {
        workloads: [{ id: 'web', type: 'deployment', image: 'app:1' }],
        ui: { workloadRef: 'web', port: 8080 },
        oauthClients: [
          {
            id: 'salesforce',
            provider: 'salesforce',
            clientIdRef: { name: 's', key: 'i' },
            clientSecretRef: { name: 's', key: 's' },
          },
          {
            id: 'slack',
            provider: 'slack',
            clientIdRef: { name: 's2', key: 'i' },
            clientSecretRef: { name: 's2', key: 's' },
          },
        ],
      },
    }
    expect(crd.spec.oauthClients).toHaveLength(2)
    expect(crd.spec.oauthClients?.[0].provider).toBe('salesforce')
  })
})
