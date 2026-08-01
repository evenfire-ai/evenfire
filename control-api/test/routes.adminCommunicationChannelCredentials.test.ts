import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { K8sGateway } from '../src/k8s.js'
import { createAdminResourcesRouter } from '../src/routes/admin/resources.js'

// vi.fn() arrays mirror the pattern in routes.adminChannelSecrets.test.ts —
// minimal hand-crafted gateway double that exposes only the K8sGateway methods
// the CC-credentials cascade touches. K8sGateway has no `patchResource`; the
// in-place patch is implemented via `getResource` (read current spec) +
// `updateResource` (replace with merged spec).
const gatewayMock = {
  createResource: vi.fn(),
  deleteResource: vi.fn(),
  getResource: vi.fn(),
  updateResource: vi.fn(),
  createSecret: vi.fn(),
  mergeSecret: vi.fn(),
  removeSecretKey: vi.fn(),
  deleteSecret: vi.fn(),
  getSecret: vi.fn(),
}

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use(createAdminResourcesRouter(gatewayMock as unknown as K8sGateway))
  return app
}

describe('admin communicationchannels — credentials cascade', () => {
  beforeEach(() => {
    Object.values(gatewayMock).forEach(fn => fn.mockReset())
  })

  // ── B4: mandatory credentials for provider CommunicationChannels ─────────

  it('B4: POST provider CC (telegram) WITHOUT credentials envelope → 400', async () => {
    const res = await request(makeApp())
      .post('/admin/communicationchannels')
      .send({
        metadata: { name: 'bot' },
        spec: {
          hostRef: 'h1',
          telegram: [{ channelId: '1', chatType: 'private', userIds: ['123'] }],
          // No credentials envelope, no credentialsSecretRef
        },
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/credentials/)
  })

  it('B4: POST provider CC (telegram) WITH credentials envelope → 201 (creates Secret + CC)', async () => {
    gatewayMock.createSecret.mockResolvedValue({ name: 'cc-bot-credentials' })
    gatewayMock.createResource.mockResolvedValue({
      metadata: { name: 'bot', namespace: 'channels' },
      spec: {
        hostRef: 'h1',
        telegram: [{ channelId: '1', chatType: 'private', userIds: ['123'] }],
        credentialsSecretRef: { name: 'cc-bot-credentials' },
      },
    })

    const res = await request(makeApp())
      .post('/admin/communicationchannels')
      .send({
        metadata: { name: 'bot' },
        spec: {
          hostRef: 'h1',
          telegram: [{ channelId: '1', chatType: 'private', userIds: ['123'] }],
        },
        credentials: { 'telegram-bot-token': 'tg-abc' },
      })

    expect(res.status).toBe(201)
  })

  it('B4: POST provider CC (telegram) WITH credentialsSecretRef already in spec → ok (no 400)', async () => {
    // A user may pre-create the Secret and supply credentialsSecretRef directly.
    gatewayMock.createResource.mockResolvedValue({
      metadata: { name: 'bot', namespace: 'channels' },
      spec: { hostRef: 'h1', credentialsSecretRef: { name: 'my-existing-secret' } },
    })

    const res = await request(makeApp())
      .post('/admin/communicationchannels')
      .send({
        metadata: { name: 'bot' },
        spec: {
          hostRef: 'h1',
          telegram: [{ channelId: '1', chatType: 'private', userIds: ['123'] }],
          credentialsSecretRef: { name: 'my-existing-secret' },
        },
      })

    expect(res.status).toBe(201)
  })

  it('B4: POST CC with NO provider fields (hostRef only) → ok (no credentials required)', async () => {
    gatewayMock.createResource.mockResolvedValue({
      metadata: { name: 'bare', namespace: 'channels' },
      spec: { hostRef: 'h1' },
    })

    const res = await request(makeApp())
      .post('/admin/communicationchannels')
      .send({
        metadata: { name: 'bare' },
        spec: { hostRef: 'h1' },
      })

    expect(res.status).toBe(201)
  })

  it('B4: PUT re-injects credentialsSecretRef when existing cc-<name>-credentials Secret is found', async () => {
    // The PUT body does NOT include credentialsSecretRef.
    // The existing CC also has no credentialsSecretRef.
    // BUT the conventional cc-<name>-credentials Secret EXISTS.
    const e404 = Object.assign(new Error('not found'), { statusCode: 404 })
    gatewayMock.getResource.mockRejectedValue(e404) // existing CC 404 → no existing ref
    gatewayMock.getSecret.mockResolvedValue({ metadata: { name: 'cc-bot-credentials' } })
    gatewayMock.updateResource.mockResolvedValue({
      metadata: { name: 'bot', namespace: 'channels' },
      spec: { hostRef: 'h1', credentialsSecretRef: { name: 'cc-bot-credentials' } },
    })

    const res = await request(makeApp())
      .put('/admin/communicationchannels/bot')
      .send({
        spec: {
          hostRef: 'h1',
          telegram: [{ channelId: '1', chatType: 'private', userIds: ['123'] }],
          // No credentialsSecretRef in the incoming body
        },
      })

    expect(res.status).toBe(200)
    expect(gatewayMock.getResource).toHaveBeenCalledTimes(1)
    // The ref must have been re-injected by preserveCommunicationChannelCredentialsSecretRef
    expect(gatewayMock.updateResource).toHaveBeenCalledWith(
      'communicationchannels',
      'bot',
      expect.objectContaining({
        spec: expect.objectContaining({
          credentialsSecretRef: { name: 'cc-bot-credentials' },
        }),
      }),
      'channels'
    )
  })

  it('POST communicationchannels with credentials creates Secret + CC and injects credentialsSecretRef', async () => {
    gatewayMock.createSecret.mockResolvedValue({ name: 'cc-foo-credentials' })
    gatewayMock.createResource.mockResolvedValue({
      metadata: { name: 'foo', namespace: 'channels' },
      spec: {
        hostRef: 'h1',
        telegram: [{ channelId: '1', chatType: 'private', userIds: ['1'] }],
        credentialsSecretRef: { name: 'cc-foo-credentials' },
      },
    })

    const res = await request(makeApp())
      .post('/admin/communicationchannels')
      .send({
        metadata: { name: 'foo' },
        spec: {
          hostRef: 'h1',
          telegram: [{ channelId: '1', chatType: 'private', userIds: ['1'] }],
        },
        credentials: { 'telegram-bot-token': 'tg-token' },
      })

    expect(res.status).toBe(201)
    expect(gatewayMock.createSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'cc-foo-credentials',
        namespace: 'channels',
        stringData: { 'telegram-bot-token': 'tg-token' },
      })
    )
    expect(gatewayMock.createResource).toHaveBeenCalledWith(
      'communicationchannels',
      expect.objectContaining({
        spec: expect.objectContaining({
          credentialsSecretRef: { name: 'cc-foo-credentials' },
        }),
      }),
      'channels'
    )
    // `credentials` envelope must not be passed through to K8s.
    const createCall = gatewayMock.createResource.mock.calls[0]
    expect(createCall[1]).not.toHaveProperty('credentials')
  })

  it('POST: rolls back Secret if CC create fails', async () => {
    gatewayMock.createSecret.mockResolvedValue({ name: 'cc-foo-credentials' })
    gatewayMock.createResource.mockRejectedValue(new Error('CC create failed'))
    gatewayMock.deleteSecret.mockResolvedValue({})

    const res = await request(makeApp())
      .post('/admin/communicationchannels')
      .send({
        metadata: { name: 'foo' },
        spec: {
          hostRef: 'h1',
          telegram: [{ channelId: '1', chatType: 'private', userIds: ['1'] }],
        },
        credentials: { 'telegram-bot-token': 'tg-token' },
      })

    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(gatewayMock.deleteSecret).toHaveBeenCalledWith('cc-foo-credentials', 'channels')
  })

  it('PUT /admin/communication-channels/:name/credentials patches existing Secret', async () => {
    gatewayMock.getResource.mockResolvedValue({
      metadata: { name: 'foo', namespace: 'channels' },
      spec: { hostRef: 'h1', credentialsSecretRef: { name: 'cc-foo-credentials' } },
    })
    gatewayMock.mergeSecret.mockResolvedValue({})

    const res = await request(makeApp())
      .put('/admin/communication-channels/foo/credentials')
      .send({ 'telegram-bot-token': 'new-token' })

    expect(res.status).toBe(200)
    expect(gatewayMock.mergeSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'cc-foo-credentials',
        namespace: 'channels',
        stringData: { 'telegram-bot-token': 'new-token' },
      })
    )
    // Existing-ref branch must NOT recreate the Secret or rewrite the CC.
    expect(gatewayMock.createSecret).not.toHaveBeenCalled()
    expect(gatewayMock.updateResource).not.toHaveBeenCalled()
  })

  it('SECURITY: PUT credentials (rotated:true) response is names-only and leaks no secret VALUE', async () => {
    // Regression for a pre-existing confidentiality leak (blame 5d663a4): the
    // rotated:true branch used to respond `result: merged`, and `merged` is the
    // full k8s Secret returned by patchNamespacedSecret — its `.data` carries
    // the base64 VALUES of every stored key, INCLUDING keys the caller never
    // sent. Those values then travel in the HTTP response body into surfaces
    // that don't protect secrets (access logs, proxies, error trackers,
    // DevTools). The route must mirror the #223 policy (secrets.ts): names-only.
    //
    // Mutation guard: mock mergeSecret to return exactly such a populated Secret
    // and assert NO secret value appears at any depth. This test goes RED if the
    // handler ever echoes the Secret object again (e.g. `result: merged`).
    gatewayMock.getResource.mockResolvedValue({
      metadata: { name: 'foo', namespace: 'channels' },
      spec: { hostRef: 'h1', credentialsSecretRef: { name: 'cc-foo-credentials' } },
    })
    const NEW_TOKEN_PLAIN = 'tg-new-token'
    const SLACK_TOKEN_PLAIN = 'xoxb-super-secret'
    const EMAIL_PW_PLAIN = 'hunter2'
    const NEW_TOKEN_B64 = Buffer.from(NEW_TOKEN_PLAIN, 'utf8').toString('base64')
    const SLACK_TOKEN_B64 = Buffer.from(SLACK_TOKEN_PLAIN, 'utf8').toString('base64')
    const EMAIL_PW_B64 = Buffer.from(EMAIL_PW_PLAIN, 'utf8').toString('base64')
    gatewayMock.mergeSecret.mockResolvedValue({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'cc-foo-credentials', namespace: 'channels' },
      type: 'Opaque',
      data: {
        'telegram-bot-token': NEW_TOKEN_B64,
        // Keys the caller did NOT send — over-return must never bring these back.
        'slack-bot-token': SLACK_TOKEN_B64,
        'email-password': EMAIL_PW_B64,
      },
    })

    const res = await request(makeApp())
      .put('/admin/communication-channels/foo/credentials')
      .send({ 'telegram-bot-token': NEW_TOKEN_PLAIN })

    expect(res.status).toBe(200)
    // Names-only contract: metadata + the rotated key NAMES the caller sent.
    expect(res.body).toEqual({
      name: 'foo',
      secretName: 'cc-foo-credentials',
      namespace: 'channels',
      rotated: true,
      rotatedKeys: ['telegram-bot-token'],
    })
    expect(res.body).not.toHaveProperty('result')
    // Belt-and-suspenders: no secret value (base64 or plaintext) at ANY depth,
    // including the caller-sent token in either encoding.
    const serialized = JSON.stringify(res.body)
    for (const needle of [
      NEW_TOKEN_B64,
      NEW_TOKEN_PLAIN,
      SLACK_TOKEN_B64,
      EMAIL_PW_B64,
      SLACK_TOKEN_PLAIN,
      EMAIL_PW_PLAIN,
    ]) {
      expect(serialized).not.toContain(needle)
    }
  })

  it('PUT credentials on CC without credentialsSecretRef creates Secret + patches CC', async () => {
    gatewayMock.getResource.mockResolvedValue({
      metadata: { name: 'foo', namespace: 'channels' },
      spec: { hostRef: 'h1' },
    })
    gatewayMock.createSecret.mockResolvedValue({})
    gatewayMock.updateResource.mockResolvedValue({
      metadata: { name: 'foo', namespace: 'channels' },
      spec: { hostRef: 'h1', credentialsSecretRef: { name: 'cc-foo-credentials' } },
    })

    const res = await request(makeApp())
      .put('/admin/communication-channels/foo/credentials')
      .send({ 'telegram-bot-token': 'tok' })

    expect(res.status).toBe(200)
    // Names-only for the rotated:false branch too: return the written key NAMES,
    // never the raw CRD object.
    expect(res.body).toEqual({
      name: 'foo',
      secretName: 'cc-foo-credentials',
      namespace: 'channels',
      rotated: false,
      rotatedKeys: ['telegram-bot-token'],
    })
    expect(res.body).not.toHaveProperty('result')
    expect(gatewayMock.createSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'cc-foo-credentials',
        namespace: 'channels',
        stringData: { 'telegram-bot-token': 'tok' },
      })
    )
    expect(gatewayMock.updateResource).toHaveBeenCalledWith(
      'communicationchannels',
      'foo',
      expect.objectContaining({
        spec: expect.objectContaining({
          hostRef: 'h1',
          credentialsSecretRef: { name: 'cc-foo-credentials' },
        }),
      }),
      'channels'
    )
  })

  it('DELETE credential key removes only the requested Secret key', async () => {
    gatewayMock.getResource.mockResolvedValue({
      metadata: { name: 'foo', namespace: 'channels' },
      spec: { hostRef: 'h1', credentialsSecretRef: { name: 'cc-foo-credentials' } },
    })
    gatewayMock.removeSecretKey.mockResolvedValue({})

    const res = await request(makeApp()).delete(
      '/admin/communication-channels/foo/credentials/telegram-bot-token'
    )

    expect(res.status).toBe(200)
    expect(gatewayMock.removeSecretKey).toHaveBeenCalledWith({
      name: 'cc-foo-credentials',
      namespace: 'channels',
      key: 'telegram-bot-token',
    })
    expect(gatewayMock.mergeSecret).not.toHaveBeenCalled()
  })

  it('DELETE communicationchannels cascades the credentials Secret (CC deleted BEFORE Secret)', async () => {
    gatewayMock.getResource.mockResolvedValue({
      metadata: { name: 'foo', namespace: 'channels' },
      spec: { hostRef: 'h1', credentialsSecretRef: { name: 'cc-foo-credentials' } },
    })
    gatewayMock.deleteSecret.mockResolvedValue({})
    gatewayMock.deleteResource.mockResolvedValue({ deleted: true })

    const res = await request(makeApp()).delete('/admin/communicationchannels/foo')

    expect(res.status).toBe(200)
    expect(gatewayMock.deleteResource).toHaveBeenCalledWith(
      'communicationchannels',
      'foo',
      'channels'
    )
    expect(gatewayMock.deleteSecret).toHaveBeenCalledWith('cc-foo-credentials', 'channels')
    // Order matters: CC delete must precede Secret delete so HCC's
    // SecretInformer doesn't observe the Secret-gone event while the CC is
    // still in the cache (which would produce a transient empty-data hash
    // patch on the channel-reader Deployment).
    const deleteResourceOrder = gatewayMock.deleteResource.mock.invocationCallOrder[0]
    const deleteSecretOrder = gatewayMock.deleteSecret.mock.invocationCallOrder[0]
    expect(deleteResourceOrder).toBeLessThan(deleteSecretOrder)
  })

  it('DELETE: Secret 404 after CC delete is tolerated', async () => {
    gatewayMock.getResource.mockResolvedValue({
      metadata: { name: 'foo', namespace: 'channels' },
      spec: { hostRef: 'h1', credentialsSecretRef: { name: 'gone' } },
    })
    const e404 = Object.assign(new Error('not found'), { statusCode: 404 })
    gatewayMock.deleteSecret.mockRejectedValue(e404)
    gatewayMock.deleteResource.mockResolvedValue({ deleted: true })

    const res = await request(makeApp()).delete('/admin/communicationchannels/foo')

    expect(res.status).toBe(200)
    expect(gatewayMock.deleteResource).toHaveBeenCalledWith(
      'communicationchannels',
      'foo',
      'channels'
    )
  })

  it('DELETE: non-404 Secret error after CC delete is logged but does not fail the request', async () => {
    gatewayMock.getResource.mockResolvedValue({
      metadata: { name: 'foo', namespace: 'channels' },
      spec: { hostRef: 'h1', credentialsSecretRef: { name: 'cc-foo-credentials' } },
    })
    const e500 = Object.assign(new Error('boom'), { statusCode: 500 })
    gatewayMock.deleteSecret.mockRejectedValue(e500)
    gatewayMock.deleteResource.mockResolvedValue({ deleted: true })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await request(makeApp()).delete('/admin/communicationchannels/foo')

    // CC delete already succeeded; Secret-cleanup failure shouldn't crash
    // the request. Operator sees the warn in logs and can clean up manually.
    expect(res.status).toBe(200)
    expect(gatewayMock.deleteResource).toHaveBeenCalledWith(
      'communicationchannels',
      'foo',
      'channels'
    )
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
