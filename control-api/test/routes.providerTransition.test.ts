import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { ApiException } from '@kubernetes/client-node'
import request from 'supertest'
import type { K8sGateway } from '../src/k8s.js'
import { createAdminResourcesRouter } from '../src/routes/admin/resources.js'

// Same hand-crafted gateway double as routes.adminCommunicationChannelCredentials.test.ts:
// only the K8sGateway methods the CC write paths touch.
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

/** The jose-tg channel as the cluster holds it: Telegram only, with a credentials Secret. */
const TELEGRAM_SPEC = {
  hostRef: 'h1',
  telegram: [{ channelId: '-1001', chatType: 'group', userIds: ['123'] }],
  telegramSettings: { botHandle: '@jose_tg_bot' },
}

const SECRET_REF = { credentialsSecretRef: { name: 'cc-jose-tg-credentials' } }

function persistedChannel(spec: Record<string, unknown>): Record<string, unknown> {
  return {
    metadata: { name: 'jose-tg', namespace: 'channels', resourceVersion: 'rv-1' },
    spec,
  }
}

describe('admin communicationchannels — provider transition validation (#312)', () => {
  beforeEach(() => {
    Object.values(gatewayMock).forEach(fn => fn.mockReset())
    // Echo the written spec back, the way the API server does when the CRD is
    // current. Anything less trips the pruned-provider-setting 409 instead.
    gatewayMock.updateResource.mockImplementation(
      async (_plural: string, name: string, body: { spec: Record<string, unknown> }) => ({
        metadata: { name, namespace: 'channels', resourceVersion: 'rv-2' },
        spec: body.spec,
      })
    )
    gatewayMock.createResource.mockImplementation(
      async (
        _plural: string,
        body: { metadata: { name: string }; spec: Record<string, unknown> }
      ) => ({
        metadata: { name: body.metadata.name, namespace: 'channels' },
        spec: body.spec,
      })
    )
    gatewayMock.createSecret.mockResolvedValue({})
  })

  // ── BLOCKING ─────────────────────────────────────────────────────────────

  it('PUT enabling Slack on a Telegram channel whose Secret holds only telegram-bot-token → 400', async () => {
    // The #312 regression: an operator typed a Slack App Name into an existing
    // Telegram channel. The channel already had a credentialsSecretRef, so the
    // pre-existing "no envelope and no ref" guard never fired, and the channel
    // went on to answer every Slack request with slack_signing_secret_missing.
    gatewayMock.getResource.mockResolvedValue(persistedChannel({ ...TELEGRAM_SPEC, ...SECRET_REF }))
    gatewayMock.getSecret.mockResolvedValue({ data: { 'telegram-bot-token': 'dGc=' } })

    const res = await request(makeApp())
      .put('/admin/communicationchannels/jose-tg')
      .send({ spec: { ...TELEGRAM_SPEC, slackSettings: { botHandle: 'Jose Bot' } } })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/slack-bot-token|slack-signing-secret/)
    expect(gatewayMock.updateResource).not.toHaveBeenCalled()
  })

  it('POST declaring Slack with a credentialsSecretRef whose Secret lacks the Slack keys → 400', async () => {
    // A ref proves a Secret is named, not that it holds Slack credentials.
    gatewayMock.getSecret.mockResolvedValue({ data: { 'telegram-bot-token': 'dGc=' } })

    const res = await request(makeApp())
      .post('/admin/communicationchannels')
      .send({
        metadata: { name: 'jose-slack' },
        spec: {
          hostRef: 'h1',
          slackSettings: { botHandle: 'Jose Bot' },
          credentialsSecretRef: { name: 'shared-secret' },
        },
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/slack-bot-token|slack-signing-secret/)
    expect(gatewayMock.createResource).not.toHaveBeenCalled()
  })

  it('POST declaring email with a whitespace-only credential → 400 naming the key', async () => {
    // This guard reads the RAW envelope while the Secret is written from the
    // CLEANED values, which drop whitespace-only entries. Untrimmed, "   " is
    // truthy here, `missingCreateCredentialKey` has no email branch to catch it,
    // and the channel is created 201 advertising a provider whose Secret holds
    // only email-password: exactly the #312 state, through the API.
    const res = await request(makeApp())
      .post('/admin/communicationchannels')
      .send({
        metadata: { name: 'jose-email' },
        spec: { hostRef: 'h1', email: [{ emails: ['ops@example.com'] }] },
        credentials: { 'email-username': '   ', 'email-password': 'pw' },
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe(
      'credentials["email-username"] is required to enable the email provider on this CommunicationChannel'
    )
    expect(gatewayMock.createResource).not.toHaveBeenCalled()
    expect(gatewayMock.createSecret).not.toHaveBeenCalled()
  })

  it('POST declaring email with a numeric (non-string) credential value → 400 from validation, not a 500', async () => {
    // providerTransitionError runs before validateCommunicationChannelCredentials
    // and reads the raw, untrusted body. A bare `credentials?.[key]?.trim()` call
    // throws on a non-string value ("... .trim is not a function"), turning this
    // into an unhandled 500 instead of the ordinary validation 400.
    const res = await request(makeApp())
      .post('/admin/communicationchannels')
      .send({
        metadata: { name: 'jose-email' },
        spec: { hostRef: 'h1', email: [{ emails: ['ops@example.com'] }] },
        credentials: { 'email-username': 123, 'email-password': 'pw' },
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('credentials["email-username"] must be a string')
    expect(gatewayMock.createResource).not.toHaveBeenCalled()
    expect(gatewayMock.createSecret).not.toHaveBeenCalled()
  })

  // ── ALLOWING ─────────────────────────────────────────────────────────────
  // Without these, a validator that reads nothing at all still passes every
  // blocking case above.

  it('PUT enabling Slack where the referenced Secret ALREADY holds both Slack keys → 200', async () => {
    gatewayMock.getResource.mockResolvedValue(persistedChannel({ ...TELEGRAM_SPEC, ...SECRET_REF }))
    gatewayMock.getSecret.mockResolvedValue({
      data: {
        'telegram-bot-token': 'dGc=',
        'slack-bot-token': 'eG94Yi0x',
        'slack-signing-secret': 'c2ln',
      },
    })

    const res = await request(makeApp())
      .put('/admin/communicationchannels/jose-tg')
      .send({ spec: { ...TELEGRAM_SPEC, slackSettings: { botHandle: 'Jose Bot' } } })

    expect(res.status).toBe(200)
    // The request body carries no credentialsSecretRef (the UI never sends one),
    // so the keys can only have come from the preserved ref being read.
    expect(gatewayMock.getSecret).toHaveBeenCalledWith('cc-jose-tg-credentials', 'channels')
    expect(gatewayMock.updateResource).toHaveBeenCalled()
  })

  it('POST declaring Slack with both keys in the credentials envelope → 201', async () => {
    const res = await request(makeApp())
      .post('/admin/communicationchannels')
      .send({
        metadata: { name: 'jose-slack' },
        spec: { hostRef: 'h1', slackSettings: { botHandle: 'Jose Bot' } },
        credentials: { 'slack-bot-token': 'xoxb-1', 'slack-signing-secret': 'sig-1' },
      })

    expect(res.status).toBe(201)
    expect(gatewayMock.createResource).toHaveBeenCalled()
    // Envelope-supplied keys need no Secret read at all.
    expect(gatewayMock.getSecret).not.toHaveBeenCalled()
  })

  it('PUT editing a channel whose Secret LACKS the provider keys, with no NEW provider → 200', async () => {
    // present -> present. Validation is scoped to the transition, so a channel
    // already missing credentials in the cluster stays editable.
    const slackSpec = { hostRef: 'h1', slackSettings: { botHandle: 'Jose Bot' } }
    gatewayMock.getResource.mockResolvedValue(persistedChannel({ ...slackSpec, ...SECRET_REF }))
    gatewayMock.getSecret.mockResolvedValue({ data: {} })

    const res = await request(makeApp())
      .put('/admin/communicationchannels/jose-tg')
      .send({ spec: { ...slackSpec, access: { users: ['user-1'], teams: [] } } })

    expect(res.status).toBe(200)
    expect(gatewayMock.updateResource).toHaveBeenCalled()
  })

  it('PUT REMOVING a provider from a channel with an empty Secret → 200', async () => {
    gatewayMock.getResource.mockResolvedValue(
      persistedChannel({
        ...TELEGRAM_SPEC,
        slackSettings: { botHandle: 'Jose Bot' },
        ...SECRET_REF,
      })
    )
    gatewayMock.getSecret.mockResolvedValue({ data: {} })

    const res = await request(makeApp())
      .put('/admin/communicationchannels/jose-tg')
      .send({ spec: { ...TELEGRAM_SPEC } })

    expect(res.status).toBe(200)
    expect(gatewayMock.updateResource).toHaveBeenCalled()
  })

  // ── FAIL CLOSED ──────────────────────────────────────────────────────────

  it('PUT enabling Slack when the Secret read fails with 403 → 400, never a silent 200', async () => {
    // A real @kubernetes/client-node ApiException: it sets `.code`, not
    // `.statusCode`. A hand-rolled error shape would not exercise the
    // status extraction that decides rethrow-vs-"no keys".
    gatewayMock.getResource.mockResolvedValue(persistedChannel({ ...TELEGRAM_SPEC, ...SECRET_REF }))
    gatewayMock.getSecret.mockRejectedValue(
      new ApiException(
        403,
        'Forbidden',
        { message: 'secrets "cc-jose-tg-credentials" is forbidden' },
        {}
      )
    )

    const res = await request(makeApp())
      .put('/admin/communicationchannels/jose-tg')
      .send({ spec: { ...TELEGRAM_SPEC, slackSettings: { botHandle: 'Jose Bot' } } })

    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Cannot read the credentials Secret/)
    expect(gatewayMock.updateResource).not.toHaveBeenCalled()
  })

  it('PUT to a channel that does not exist does not answer with a credentials error', async () => {
    // The guard is scoped to an absent->present TRANSITION, and a channel that was
    // never there has no previous spec — so without the snapshot check every provider
    // in the body reads as newly added and the operator is told their credentials are
    // missing for a channel that does not exist. The snapshot is null only on 404, so
    // it is the honest signal to stand down and let the write answer.
    //
    // What the caller then sees is this codebase's generic k8s error surface, NOT a
    // 404: ApiException sets `.code` and the error handler forwards `.status`. That
    // collapse is pre-existing and applies to every route, so it is deliberately out
    // of scope here. This test pins the part that IS in scope — the operator is no
    // longer told to fix credentials on a channel that does not exist.
    gatewayMock.getResource.mockRejectedValue(
      new ApiException(404, 'Not Found', { message: 'communicationchannels "ghost" not found' }, {})
    )
    gatewayMock.updateResource.mockRejectedValue(
      new ApiException(404, 'Not Found', { message: 'communicationchannels "ghost" not found' }, {})
    )

    const res = await request(makeApp())
      .put('/admin/communicationchannels/ghost')
      .send({ spec: { hostRef: 'h1', slackSettings: { botHandle: 'Jose Bot' } } })

    expect(res.status).not.toBe(400)
    expect(res.body.error ?? '').not.toMatch(/slack-bot-token|slack-signing-secret/)
    // The write must be ATTEMPTED — that is what proves the guard stood down rather
    // than the route inferring an answer of its own.
    expect(gatewayMock.updateResource).toHaveBeenCalled()
  })
})
