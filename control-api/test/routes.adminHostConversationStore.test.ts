import { beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createApp } from '../src/app.js'
import type { UiAuthedRequest } from '../src/middleware/controlUIAuth.js'
import { createAdminHostConversationStoreRouter } from '../src/routes/admin/hostConversationStore.js'
import {
  type ConversationStoreHostSnapshot,
  type ConversationStoreRequest,
  buildConversationStoreRequestPatch,
  parseConversationStoreRequest,
} from '../src/services/hostConversationStoreService.js'
import { MockGateway } from './mockGateway.js'

const SUBJECT = '10000000-0000-4000-8000-000000000001'
const REQUEST_ID = '10000000-0000-4000-8000-000000000002'
const NEXT_ID = '10000000-0000-4000-8000-000000000003'
const MAINTENANCE_ID = '10000000-0000-4000-8000-000000000004'
const STORE_ID = '10000000-0000-4000-8000-000000000005'
const BASE = {
  schemaVersion: 1,
  requestId: REQUEST_ID,
  hostUid: 'host-current',
  pvcUid: 'pvc-current',
  maintenanceId: MAINTENANCE_ID,
}
const PREPARE = {
  ...BASE,
  requestId: NEXT_ID,
  targetImage: 'ghcr.io/evenfire-ai/mcp-host:fixture',
  templateRevision: 'a'.repeat(64),
  sourceClass: 'sqlite-pvc',
  manifestHash: 'b'.repeat(64),
}
const ADOPT = {
  ...BASE,
  migrationId: '10000000-0000-4000-8000-000000000006',
  manifestHash: 'b'.repeat(64),
  candidateHash: 'c'.repeat(64),
}

class Gateway {
  host: ConversationStoreHostSnapshot = {
    metadata: { uid: BASE.hostUid, resourceVersion: '17' },
    status: { lifecycle: { state: 'active' }, conditions: [{ type: 'Ready', status: 'True' }] },
  }
  writes: Array<{
    name: string
    request: ConversationStoreRequest
    snapshot: ConversationStoreHostSnapshot
  }> = []
  writeFault?: unknown
  async getResource() {
    return structuredClone(this.host)
  }
  async patchHostConversationStoreRequest(
    name: string,
    submitted: ConversationStoreRequest,
    snapshot: ConversationStoreHostSnapshot
  ) {
    if (this.writeFault) throw this.writeFault
    this.writes.push({ name, request: submitted, snapshot })
  }
}
function maintenance(phase = 'fenced') {
  return { maintenanceId: MAINTENANCE_ID, hostUid: BASE.hostUid, pvcUid: BASE.pvcUid, phase }
}
function endpoint(operation = 'maintenance') {
  return `/api/v1/admin/hosts/chatllm/conversation-store/${operation}`
}

let gateway: Gateway
let app: express.Express
let principal: UiAuthedRequest['adminAuth']
beforeEach(() => {
  gateway = new Gateway()
  principal = { sub: SUBJECT, typ: 'user', role: 'admin', jti: 'test-session-id', exp: 9999999999 }
  app = express()
  app.use(express.json())
  // Only this test harness supplies a bound middleware principal. Production
  // uses the real current-administrator authentication in createApp.
  app.use((req, _res, next) => {
    ;(req as UiAuthedRequest).adminAuth = principal
    next()
  })
  app.use('/api/v1', createAdminHostConversationStoreRouter(gateway as never))
})

describe('administrator conversation-store operator requests', () => {
  it('the real application refuses unauthenticated access before any operator write', async () => {
    const actualApp = createApp(new MockGateway('mcp-host') as never)
    expect((await request(actualApp).post(endpoint()).send(BASE)).status).toBe(401)
  })
  it('refuses missing or non-administrator middleware identity', async () => {
    principal = undefined
    expect((await request(app).post(endpoint()).send(BASE)).status).toBe(401)
    principal = {
      sub: SUBJECT,
      typ: 'user',
      role: 'user',
      jti: 'test-session-id',
      exp: 9999999999,
    } as never
    expect((await request(app).post(endpoint()).send(BASE)).status).toBe(401)
    expect(gateway.writes).toEqual([])
  })
  it.each([
    { principal: { kind: 'control-admin', subject: 'forged' } },
    { authorized: true },
    { operation: 'adopt' },
  ])('rejects body authority and unknown fields: %j', async extra => {
    expect(
      (
        await request(app)
          .post(endpoint())
          .send({ ...BASE, ...extra })
      ).status
    ).toBe(400)
    expect(gateway.writes).toEqual([])
  })
  it('submits the bound principal with exact Host UID and resourceVersion preconditions', async () => {
    expect((await request(app).post(endpoint()).send(BASE)).status).toBe(202)
    expect(gateway.writes).toHaveLength(1)
    expect(gateway.writes[0].request.principal).toEqual({ kind: 'control-admin', subject: SUBJECT })
    const patch = buildConversationStoreRequestPatch(
      gateway.writes[0].snapshot,
      gateway.writes[0].request
    )
    expect(patch.slice(0, 2)).toEqual([
      { op: 'test', path: '/metadata/uid', value: BASE.hostUid },
      { op: 'test', path: '/metadata/resourceVersion', value: '17' },
    ])
    expect(patch.slice(2).map(op => op.path)).toEqual(['/status/conversationStore'])
    expect(gateway.host.status?.lifecycle).toEqual({ state: 'active' })
    expect(gateway.host.status?.conditions).toEqual([{ type: 'Ready', status: 'True' }])
  })
  it('refuses a recreated Host and absent identity evidence', async () => {
    gateway.host.metadata!.uid = 'host-recreated'
    expect((await request(app).post(endpoint()).send(BASE)).status).toBe(409)
    gateway.host.metadata = { uid: BASE.hostUid }
    expect((await request(app).post(endpoint()).send(BASE)).status).toBe(503)
    expect(gateway.writes).toEqual([])
  })
  it.each([409, 422])(
    'reports apiserver CAS rejection without retrying or claiming success: %s',
    async code => {
      gateway.writeFault = { code }
      const response = await request(app).post(endpoint()).send(BASE)
      expect(response.status).toBe(409)
      expect(response.body).toEqual({ error: 'host_state_changed' })
      expect(gateway.writes).toEqual([])
    }
  )
  it('does not overwrite an unacknowledged operator request', async () => {
    gateway.host.status!.conversationStore = {
      request: parseConversationStoreRequest(BASE, 'maintenance', SUBJECT, gateway.host),
    }
    const response = await request(app).post(endpoint('prepare')).send(PREPARE)
    expect(response.status).toBe(409)
    expect(response.body).toEqual({ error: 'operator_request_pending' })
    expect(gateway.writes).toEqual([])
  })
  it('accepts preparation after completed controller handling and fence, preserving controller fields', async () => {
    gateway.host.status!.conversationStore = {
      request: parseConversationStoreRequest(BASE, 'maintenance', SUBJECT, gateway.host),
      requestResult: {
        requestId: REQUEST_ID,
        hostUid: BASE.hostUid,
        pvcUid: BASE.pvcUid,
        state: 'completed',
        updatedAt: '2026-09-30T12:00:00Z',
      },
      maintenance: maintenance(),
      compatibility: { contractVersion: 1 },
    }
    expect((await request(app).post(endpoint('prepare')).send(PREPARE)).status).toBe(202)
    const submitted = gateway.writes[0]
    expect(
      buildConversationStoreRequestPatch(submitted.snapshot, submitted.request)
        .slice(2)
        .map(op => op.path)
    ).toEqual(['/status/conversationStore/request'])
    expect(
      (submitted.snapshot.status!.conversationStore as Record<string, unknown>).compatibility
    ).toEqual({ contractVersion: 1 })
  })
  it.each(['released', 'completed'])('refuses preparation while maintenance is %s', async phase => {
    gateway.host.status!.conversationStore = { maintenance: maintenance(phase) }
    expect((await request(app).post(endpoint('prepare')).send(PREPARE)).status).toBe(409)
    expect(gateway.writes).toEqual([])
  })
  it('allows an operator attestation during bound quiescing without granting a fence or receipt', async () => {
    gateway.host.status!.conversationStore = { maintenance: maintenance('quiescing') }
    expect((await request(app).post(endpoint('prepare')).send(PREPARE)).status).toBe(202)
    expect((gateway.host.status!.conversationStore as Record<string, unknown>).maintenance).toEqual(
      maintenance('quiescing')
    )
    expect(
      (gateway.host.status!.conversationStore as Record<string, unknown>).preparation
    ).toBeUndefined()
  })
  it('does not replace accepted preparation before actual controller completion', async () => {
    gateway.host.status!.conversationStore = {
      request: parseConversationStoreRequest(PREPARE, 'prepare', SUBJECT, gateway.host),
      requestResult: {
        requestId: NEXT_ID,
        hostUid: BASE.hostUid,
        pvcUid: BASE.pvcUid,
        state: 'accepted',
        updatedAt: '2026-09-30T12:00:00Z',
      },
      maintenance: maintenance(),
    }
    const response = await request(app).post(endpoint('adopt')).send(ADOPT)
    expect(response.status).toBe(409)
    expect(response.body).toEqual({ error: 'operator_request_pending' })
    expect(gateway.writes).toEqual([])
  })
  it('does not replace an accepted maintenance request before its atomic quiescing completion', async () => {
    gateway.host.status!.conversationStore = {
      request: parseConversationStoreRequest(BASE, 'maintenance', SUBJECT, gateway.host),
      requestResult: {
        requestId: REQUEST_ID,
        hostUid: BASE.hostUid,
        pvcUid: BASE.pvcUid,
        state: 'accepted',
        updatedAt: '2026-09-30T12:00:00Z',
      },
      maintenance: maintenance('quiescing'),
    }
    const response = await request(app).post(endpoint('prepare')).send(PREPARE)
    expect(response.status).toBe(409)
    expect(response.body).toEqual({ error: 'operator_request_pending' })
    expect(gateway.writes).toEqual([])
  })
  it('does not replace an accepted adoption while its durable completion is pending', async () => {
    gateway.host.status!.conversationStore = {
      request: parseConversationStoreRequest(ADOPT, 'adopt', SUBJECT, gateway.host),
      requestResult: {
        requestId: REQUEST_ID,
        hostUid: BASE.hostUid,
        pvcUid: BASE.pvcUid,
        state: 'accepted',
        updatedAt: '2026-09-30T12:00:00Z',
      },
      maintenance: maintenance(),
    }
    const response = await request(app).post(endpoint('prepare')).send(PREPARE)
    expect(response.status).toBe(409)
    expect(response.body).toEqual({ error: 'operator_request_pending' })
    expect(gateway.writes).toEqual([])
  })
  it('keeps duplicate requests idempotent and refuses changed pins or principal', async () => {
    gateway.host.status!.conversationStore = {
      request: parseConversationStoreRequest(ADOPT, 'adopt', SUBJECT, gateway.host),
      maintenance: maintenance(),
    }
    expect((await request(app).post(endpoint('adopt')).send(ADOPT)).status).toBe(200)
    expect(
      (
        await request(app)
          .post(endpoint('adopt'))
          .send({ ...ADOPT, candidateHash: 'd'.repeat(64) })
      ).status
    ).toBe(409)
    principal = { ...principal!, sub: 'another-operator' }
    expect((await request(app).post(endpoint('adopt')).send(ADOPT)).status).toBe(409)
    expect(gateway.writes).toEqual([])
  })
  it('allows first legacy adoption without inventing a current store identity', async () => {
    gateway.host.status!.conversationStore = { maintenance: maintenance() }
    expect((await request(app).post(endpoint('adopt')).send(ADOPT)).status).toBe(202)
    expect(gateway.writes[0].request.expectedStoreId).toBeUndefined()
    expect(gateway.writes[0].request.expectedCurrentCatalogHash).toBeUndefined()
  })
  it('requires both recovery pins when layout already names a store', async () => {
    gateway.host.status!.conversationStore = {
      maintenance: maintenance(),
      layout: { storeId: STORE_ID },
    }
    expect((await request(app).post(endpoint('adopt')).send(ADOPT)).status).toBe(400)
    expect(
      (
        await request(app)
          .post(endpoint('adopt'))
          .send({ ...ADOPT, expectedStoreId: STORE_ID })
      ).status
    ).toBe(400)
    expect(
      (
        await request(app)
          .post(endpoint('adopt'))
          .send({ ...ADOPT, expectedStoreId: STORE_ID, expectedCurrentCatalogHash: 'e'.repeat(64) })
      ).status
    ).toBe(202)
  })
  it('requires completed maintenance and current-store pins before release', async () => {
    const body = { ...BASE, expectedStoreId: STORE_ID, expectedCurrentCatalogHash: 'e'.repeat(64) }
    gateway.host.status!.conversationStore = {
      maintenance: maintenance('fenced'),
      layout: { storeId: STORE_ID },
    }
    expect((await request(app).post(endpoint('release')).send(body)).status).toBe(409)
    gateway.host.status!.conversationStore = {
      maintenance: maintenance('completed'),
      layout: { storeId: STORE_ID },
    }
    expect((await request(app).post(endpoint('release')).send(body)).status).toBe(202)
  })
  it('derives the floor contract from a fresh Host and refuses a client canonical hint', async () => {
    expect((await request(app).post(endpoint()).send(BASE)).status).toBe(202)
    expect(gateway.writes[0].request.storageContract).toBe('legacy-floor')
    expect(
      (
        await request(app)
          .post(endpoint())
          .send({ ...BASE, storageContract: 'canonical' })
      ).status
    ).toBe(409)
    expect(gateway.writes).toHaveLength(1)
  })
  it.each(['opt-in', 'layout-version', 'layout-identity', 'pending-outcome'])(
    'preserves the authoritative canonical contract from %s',
    async source => {
      if (source === 'opt-in')
        gateway.host.metadata!.annotations = { 'clerum.io/canonical-store': 'enabled' }
      if (source === 'layout-version')
        gateway.host.status!.conversationStore = { layout: { version: 1 } }
      if (source === 'layout-identity')
        gateway.host.status!.conversationStore = { layout: { storeId: STORE_ID } }
      if (source === 'pending-outcome')
        gateway.host.status!.conversationStore = {
          operationOutcome: { storageContract: 'canonical', storeId: STORE_ID },
        }
      expect(
        (
          await request(app)
            .post(endpoint())
            .send({ ...BASE, storageContract: 'legacy-floor' })
        ).status
      ).toBe(409)
      expect((await request(app).post(endpoint()).send(BASE)).status).toBe(202)
      expect(gateway.writes[0].request.storageContract).toBe('canonical')
    }
  )
  it('requires the floor migration identity and measured catalog for recovery without inventing a store ID', async () => {
    gateway.host.status!.conversationStore = {
      maintenance: maintenance(),
      compatibility: { storageContract: 'legacy-floor', migrationId: ADOPT.migrationId },
    }
    expect((await request(app).post(endpoint('adopt')).send(ADOPT)).status).toBe(400)
    expect(
      (
        await request(app)
          .post(endpoint('adopt'))
          .send({ ...ADOPT, expectedMigrationId: ADOPT.migrationId })
      ).status
    ).toBe(400)
    const valid = {
      ...ADOPT,
      expectedMigrationId: ADOPT.migrationId,
      expectedCurrentCatalogHash: 'e'.repeat(64),
    }
    expect((await request(app).post(endpoint('adopt')).send(valid)).status).toBe(202)
    expect(gateway.writes[0].request).toMatchObject({
      storageContract: 'legacy-floor',
      expectedMigrationId: ADOPT.migrationId,
    })
    expect(gateway.writes[0].request).not.toHaveProperty('expectedStoreId')
    expect(
      (
        await request(app)
          .post(endpoint('adopt'))
          .send({ ...valid, expectedMigrationId: NEXT_ID })
      ).status
    ).toBe(409)
  })
  it('requires a completed floor and the floor current pins before release', async () => {
    const valid = {
      ...BASE,
      expectedMigrationId: ADOPT.migrationId,
      expectedCurrentCatalogHash: 'e'.repeat(64),
    }
    gateway.host.status!.conversationStore = {
      maintenance: maintenance('fenced'),
      compatibility: { storageContract: 'legacy-floor', migrationId: ADOPT.migrationId },
    }
    expect((await request(app).post(endpoint('release')).send(valid)).status).toBe(409)
    gateway.host.status!.conversationStore = {
      maintenance: maintenance('completed'),
      compatibility: { storageContract: 'legacy-floor', migrationId: ADOPT.migrationId },
    }
    expect(
      (
        await request(app)
          .post(endpoint('release'))
          .send({ ...valid, expectedStoreId: STORE_ID })
      ).status
    ).toBe(400)
    expect((await request(app).post(endpoint('release')).send(valid)).status).toBe(202)
    expect(gateway.writes[0].request.storageContract).toBe('legacy-floor')
  })
  it('rejects old floor replay when opt-in changes the authoritative target', async () => {
    gateway.host.status!.conversationStore = {
      request: parseConversationStoreRequest(BASE, 'maintenance', SUBJECT, gateway.host),
    }
    gateway.host.metadata!.annotations = { 'clerum.io/canonical-store': 'enabled' }
    expect((await request(app).post(endpoint()).send(BASE)).status).toBe(409)
    expect(gateway.writes).toEqual([])
  })
  it.each([{ schemaVersion: 2 }, { requestId: '../escape' }, { manifestHash: 'not-a-hash' }])(
    'rejects malformed versions and pins: %j',
    async replacement => {
      expect(
        (
          await request(app)
            .post(endpoint())
            .send({ ...BASE, ...replacement })
        ).status
      ).toBe(400)
      expect(gateway.writes).toEqual([])
    }
  )
})
