import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { MockGateway } from './mockGateway.js'

const PROXY_TOKEN = 'dev-webhook-proxy-token'

function authedGet(app: ReturnType<typeof createApp>, path: string) {
  return request(app)
    .get(path)
    .set('authorization', `Bearer ${PROXY_TOKEN}`)
    .set('x-service-token', 'webhook-proxy')
}

function seedRecipe(gateway: MockGateway, name: string, webhooks: unknown[]): void {
  // Seed via createResource so the gateway records the canonical shape.
  void gateway.createResource(
    'workflowrecipes',
    {
      metadata: { name },
      spec: { webhooks },
    },
    'sandbox-recipes'
  )
}

describe('GET /api/v1/internal/webhook/registry/:recipeNs/:recipeName/:webhookId', () => {
  let app: ReturnType<typeof createApp>
  let gateway: MockGateway

  beforeEach(() => {
    gateway = new MockGateway('sandbox-recipes')
    app = createApp(gateway as never)
  })

  it('returns 401 without service auth', async () => {
    await request(app)
      .get('/api/v1/internal/webhook/registry/sandbox-recipes/r1/fireflies')
      .expect(401)
  })

  it('returns 401 when the service identity is wrong', async () => {
    await request(app)
      .get('/api/v1/internal/webhook/registry/sandbox-recipes/r1/fireflies')
      .set('authorization', `Bearer dev-rpc-proxy-token`)
      .set('x-service-token', 'rpc-proxy')
      .expect(401)
  })

  it('returns 400 when recipeNs is not sandbox-recipes', async () => {
    const res = await authedGet(app, '/api/v1/internal/webhook/registry/wrong-ns/r1/fireflies')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_recipe_namespace')
  })

  it('returns 400 when recipeName fails DNS-1123 (revalidation)', async () => {
    const res = await authedGet(
      app,
      '/api/v1/internal/webhook/registry/sandbox-recipes/UPPERCASE/fireflies'
    )
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_recipe_name')
  })

  it('returns 400 when webhookId fails the regex (revalidation against proxy bug)', async () => {
    const res = await authedGet(
      app,
      '/api/v1/internal/webhook/registry/sandbox-recipes/r1/has..dots'
    )
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_webhook_id')
  })

  it('returns 404 with reason=recipe_not_found when the CRD is absent', async () => {
    const res = await authedGet(
      app,
      '/api/v1/internal/webhook/registry/sandbox-recipes/missing/fireflies'
    )
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ exists: false, reason: 'recipe_not_found' })
  })

  it('returns 404 with reason=webhook_not_found when the recipe has no matching id', async () => {
    seedRecipe(gateway, 'r1', [
      {
        id: 'other',
        workloadRef: 'h',
        path: '/x',
        verification: {
          scheme: 'hmac-sha256-body',
          secretRef: { name: 's', key: 'k' },
          signatureHeader: 'x-sig',
        },
      },
    ])
    const res = await authedGet(
      app,
      '/api/v1/internal/webhook/registry/sandbox-recipes/r1/fireflies'
    )
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ exists: false, reason: 'webhook_not_found' })
  })

  it('returns 200 with policy fields and gateway routing for a valid lookup', async () => {
    seedRecipe(gateway, 'r1', [
      {
        id: 'fireflies',
        workloadRef: 'handler',
        path: '/webhooks/fireflies',
        methods: ['POST'],
        maxBodyBytes: 524288,
        verification: {
          scheme: 'hmac-sha256-body',
          secretRef: { name: 'fireflies-creds', key: 'signing-secret' },
          signatureHeader: 'x-hub-signature-256',
        },
      },
    ])
    const res = await authedGet(
      app,
      '/api/v1/internal/webhook/registry/sandbox-recipes/r1/fireflies'
    )
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      exists: true,
      methods: ['POST'],
      maxBodyBytes: 524288,
      gateway: {
        service: 'wf-r1-webhook-gateway',
        namespace: 'sandbox-recipes',
        port: 8090,
      },
    })
  })

  it('falls back to default methods + maxBodyBytes when the recipe omits them', async () => {
    seedRecipe(gateway, 'r1', [
      {
        id: 'fireflies',
        workloadRef: 'handler',
        path: '/webhooks/fireflies',
        verification: {
          scheme: 'hmac-sha256-body',
          secretRef: { name: 's', key: 'k' },
          signatureHeader: 'x-sig',
        },
      },
    ])
    const res = await authedGet(
      app,
      '/api/v1/internal/webhook/registry/sandbox-recipes/r1/fireflies'
    )
    expect(res.status).toBe(200)
    expect(res.body.methods).toEqual(['POST'])
    expect(res.body.maxBodyBytes).toBe(1_048_576)
  })

  it('includes allowedOrigins in the response when the recipe declares cors', async () => {
    seedRecipe(gateway, 'r1', [
      {
        id: 'widget',
        workloadRef: 'handler',
        path: '/x',
        verification: {
          scheme: 'static-bearer',
          secretRef: { name: 's', key: 'k' },
        },
        cors: {
          allowedOrigins: ['http://localhost:9000', 'https://customer.example'],
        },
      },
    ])
    const res = await authedGet(app, '/api/v1/internal/webhook/registry/sandbox-recipes/r1/widget')
    expect(res.status).toBe(200)
    expect(res.body.allowedOrigins).toEqual(['http://localhost:9000', 'https://customer.example'])
  })

  it('omits allowedOrigins from the response when the recipe has no cors block', async () => {
    seedRecipe(gateway, 'r1', [
      {
        id: 'fireflies',
        workloadRef: 'handler',
        path: '/x',
        verification: { scheme: 'static-bearer', secretRef: { name: 's', key: 'k' } },
      },
    ])
    const res = await authedGet(
      app,
      '/api/v1/internal/webhook/registry/sandbox-recipes/r1/fireflies'
    )
    expect(res.status).toBe(200)
    expect(res.body.allowedOrigins).toBeUndefined()
  })

  it('filters malformed cors.allowedOrigins entries (defense-in-depth)', async () => {
    seedRecipe(gateway, 'r1', [
      {
        id: 'widget',
        workloadRef: 'handler',
        path: '/x',
        verification: { scheme: 'static-bearer', secretRef: { name: 's', key: 'k' } },
        cors: {
          allowedOrigins: [
            'http://localhost:9000',
            'not-a-url',
            42,
            'https://customer.example/',
            'https://valid.example',
          ],
        },
      },
    ])
    const res = await authedGet(app, '/api/v1/internal/webhook/registry/sandbox-recipes/r1/widget')
    expect(res.status).toBe(200)
    expect(res.body.allowedOrigins).toEqual(['http://localhost:9000', 'https://valid.example'])
  })

  it('does NOT leak verification material in the response', async () => {
    seedRecipe(gateway, 'r1', [
      {
        id: 'fireflies',
        workloadRef: 'handler',
        path: '/webhooks/fireflies',
        verification: {
          scheme: 'hmac-sha256-body',
          secretRef: { name: 'fireflies-creds', key: 'signing-secret' },
          signatureHeader: 'x-hub-signature-256',
          signaturePrefix: 'sha256=',
        },
      },
    ])
    const res = await authedGet(
      app,
      '/api/v1/internal/webhook/registry/sandbox-recipes/r1/fireflies'
    )
    expect(res.status).toBe(200)
    // No verification block, no signing-secret hint, no scheme leak.
    expect(res.body.verification).toBeUndefined()
    const json = JSON.stringify(res.body)
    expect(json).not.toContain('signing-secret')
    expect(json).not.toContain('hmac-sha256-body')
  })
})
