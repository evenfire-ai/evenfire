import { describe, expect, it } from 'vitest'
import { JwtVerifier } from '../../workspace-files-controller/src/auth/jwtVerifier.js'
import { config } from '../src/config.js'
import {
  WFC_BROWSING_READ_SCOPE,
  WFC_BROWSING_SCOPES,
  WFC_BROWSING_WRITE_SCOPE,
  signWfcBrowsingToken,
} from '../src/utils/auth/wfcBrowsingToken.js'

describe('wfc browsing scope wire contract', () => {
  // Cross-service contract with the workspace-files-controller (WFC_FILE_* in
  // workspace-files-controller/src/auth/jwtVerifier.ts). If either side drifts,
  // browsing tokens are rejected at runtime by the wfc scope checks. Keep both
  // lists in sync.
  it('pins the scope literals shared with the workspace-files-controller', () => {
    expect(WFC_BROWSING_READ_SCOPE).toBe('files:read')
    expect(WFC_BROWSING_WRITE_SCOPE).toBe('files:write')
    expect(WFC_BROWSING_SCOPES).toEqual(['files:read', 'files:write'])
  })

  it('accepts a shorter signed WFC child through the real verifier', async () => {
    const now = Math.floor(Date.now() / 1_000)
    const userId = '11111111-1111-4111-8111-111111111111'
    const actionAuthority = {
      binding: {
        version: 2 as const,
        userId,
        sid: '22222222-2222-4222-8222-222222222222',
        sessionVersion: 1,
        delegationJti: '33333333-3333-4333-8333-333333333333',
        operationId: 'shared_filesystem.read' as const,
        resource: {
          environmentId: 'development:local-cluster',
          type: 'shared_filesystem' as const,
          canonicalId: 'shared_filesystem:mcp-host/mission',
          logicalId: 'mcp-host/mission',
          displayName: 'mission',
        },
        target: {
          sharedFileSystemNamespace: 'mcp-host',
          sharedFileSystemName: 'mission',
          relationshipInstanceId: 'rel1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          canonicalRelativePath: 'docs/plan.md',
        },
        targetHash: 'ath2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        accessPathId: 'ap1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        authorizationRevision: 'ar1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        pathKind: 'direct' as const,
        effectiveTeamId: null,
        behaviorBindingHash: 'bh2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      sourceIssuedAt: now - 1,
      sourceExpiresAt: now + config.wfcTokenTtlSeconds * 2,
    }
    const issued = signWfcBrowsingToken({
      subject: userId,
      sharedFileSystem: 'mission',
      sharedFileSystemNamespace: 'mcp-host',
      actionAuthority,
    })
    const verified = await new JwtVerifier({
      publicKeyPem: config.rpcJwtPublicKey,
      issuer: config.rpcJwtIssuer,
      audience: config.wfcJwtAudience,
      expectedSharedFileSystem: 'mission',
      expectedSharedFileSystemNamespace: 'mcp-host',
    }).verifyBearer(`Bearer ${issued.token}`)

    expect(issued.expiresInSeconds).toBe(config.wfcTokenTtlSeconds)
    expect(verified.exp! - verified.iat!).toBe(issued.expiresInSeconds)
    expect(verified.actionAuthority?.sourceExpiresAt).toBeGreaterThan(verified.exp!)
  })

  it('clips WFC children to source life and rejects an expired source', async () => {
    const now = Math.floor(Date.now() / 1_000)
    const userId = '11111111-1111-4111-8111-111111111111'
    const actionAuthority = {
      binding: {
        version: 2 as const,
        userId,
        sid: '22222222-2222-4222-8222-222222222222',
        sessionVersion: 1,
        delegationJti: '33333333-3333-4333-8333-333333333333',
        operationId: 'shared_filesystem.read' as const,
        resource: {
          environmentId: 'development:local-cluster',
          type: 'shared_filesystem' as const,
          canonicalId: 'shared_filesystem:mcp-host/mission',
          logicalId: 'mcp-host/mission',
          displayName: 'mission',
        },
        target: {
          sharedFileSystemNamespace: 'mcp-host',
          sharedFileSystemName: 'mission',
          relationshipInstanceId: 'rel1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          canonicalRelativePath: 'docs/plan.md',
        },
        targetHash: 'ath2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        accessPathId: 'ap1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        authorizationRevision: 'ar1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        pathKind: 'direct' as const,
        effectiveTeamId: null,
        behaviorBindingHash: 'bh2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      sourceIssuedAt: now - 1,
      sourceExpiresAt: now + 60,
    }
    const issued = signWfcBrowsingToken({
      subject: userId,
      sharedFileSystem: 'mission',
      sharedFileSystemNamespace: 'mcp-host',
      actionAuthority,
    })
    const verified = await new JwtVerifier({
      publicKeyPem: config.rpcJwtPublicKey,
      issuer: config.rpcJwtIssuer,
      audience: config.wfcJwtAudience,
      expectedSharedFileSystem: 'mission',
      expectedSharedFileSystemNamespace: 'mcp-host',
    }).verifyBearer(`Bearer ${issued.token}`)

    expect(issued.expiresInSeconds).toBeLessThanOrEqual(60)
    expect(verified.exp).toBeLessThanOrEqual(actionAuthority.sourceExpiresAt)
    expect(() =>
      signWfcBrowsingToken({
        subject: userId,
        sharedFileSystem: 'mission',
        sharedFileSystemNamespace: 'mcp-host',
        actionAuthority: {
          ...actionAuthority,
          sourceIssuedAt: now - 60,
          sourceExpiresAt: now - 1,
        },
      })
    ).toThrow('action_authority_expired')
  })
})
