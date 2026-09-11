import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import type { BrowsingJwtPayload, JwtVerifier } from '../auth/jwtVerifier'
import { err } from '../errors'
import { createFilesRouter } from '../routes/files'

const USER = '11111111-1111-4111-8111-111111111111'
let mountPath = ''

afterEach(async () => {
  if (mountPath) await rm(mountPath, { recursive: true, force: true })
  mountPath = ''
})

function v2Payload(): BrowsingJwtPayload {
  const now = Math.floor(Date.now() / 1000)
  return {
    sub: USER,
    iat: now,
    exp: now + 300,
    sharedFileSystem: 'mission',
    sharedFileSystemNamespace: 'mcp-host',
    scopes: ['files:write'],
    actionAuthority: {
      binding: {
        version: 2,
        userId: USER,
        sid: '22222222-2222-4222-8222-222222222222',
        sessionVersion: 1,
        delegationJti: '33333333-3333-4333-8333-333333333333',
        operationId: 'shared_filesystem.write',
        resource: {
          environmentId: 'development:local-cluster',
          type: 'shared_filesystem',
          canonicalId: 'shared_filesystem:mcp-host/mission',
          logicalId: 'mcp-host/mission',
          displayName: 'mission',
        },
        target: {
          sharedFileSystemNamespace: 'mcp-host',
          sharedFileSystemName: 'mission',
          relationshipInstanceId: 'rel1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          canonicalRelativePath: 'blocked',
          action: 'mkdir',
        },
        targetHash: 'ath1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        accessPathId: 'ap1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        authorizationRevision: 'ar1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        pathKind: 'direct',
        effectiveTeamId: null,
        behaviorBindingHash: 'abh1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      sourceIssuedAt: now,
      sourceExpiresAt: now + 300,
    },
  }
}

describe('workspace filesystem v2 route authority', () => {
  it('blocks filesystem mutation when the live checkpoint is unavailable', async () => {
    mountPath = await mkdtemp(join(tmpdir(), 'wfc-authority-route-'))
    const checkpoint = vi.fn(async () => {
      throw err('not_mounted', 'checkpoint unavailable')
    })
    const verifier = {
      verifyBearer: async () => v2Payload(),
    } as unknown as JwtVerifier
    const app = express()
    app.use(express.json())
    app.use(
      '/v1',
      createFilesRouter({
        mountPath,
        maxListEntries: 10,
        maxPathDepth: 10,
        maxUploadBytes: 1024,
        verifier,
        checkpointAuthority: checkpoint,
      })
    )

    const response = await request(app)
      .post('/v1/files/mkdir')
      .set('authorization', 'Bearer synthetic')
      .send({ path: 'blocked' })

    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({ ok: false, error: { code: 'not_mounted' } })
    expect(checkpoint).toHaveBeenCalledOnce()
    await expect(stat(join(mountPath, 'blocked'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
