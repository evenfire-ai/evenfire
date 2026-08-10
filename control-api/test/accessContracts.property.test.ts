import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  accessPathsAreEquivalent,
  buildAccessPath,
  selectEquivalentAccessPath,
} from '../src/services/access/accessPath.js'
import { isCapability, requireKnownCapability } from '../src/services/access/capabilityRegistry.js'
import {
  canonicalResourceIdentity,
  sameResourceIdentity,
} from '../src/services/access/resourceIdentity.js'

describe('access contract properties', () => {
  it('keeps identity immutable and never merges same-name different-id resources', () => {
    for (let index = 0; index < 100; index += 1) {
      const displayName = `Shared label ${index % 3}`
      const left = canonicalResourceIdentity({
        environmentId: 'control-api:mcp-host',
        type: 'host',
        logicalId: `mcp-host/${randomUUID()}`,
        displayName,
      })
      const right = canonicalResourceIdentity({
        environmentId: 'control-api:mcp-host',
        type: 'host',
        logicalId: `mcp-host/${randomUUID()}`,
        displayName,
      })

      expect(sameResourceIdentity(left, left)).toBe(true)
      expect(sameResourceIdentity(left, right)).toBe(false)
    }
  })

  it('uses deterministic authenticated path handles and direct-first equivalent selection', () => {
    const resource = canonicalResourceIdentity({
      environmentId: 'control-api:mcp-host',
      type: 'host',
      logicalId: 'mcp-host/agent-a',
      displayName: 'Agent A',
    })
    const behavior = {
      capabilities: ['host.read'] as const,
      budgetRef: null,
      credentialPolicyRef: null,
      approvalPolicyRef: null,
      filesystemScopeRef: null,
      runtimeRef: null,
      providerModelPolicyRef: null,
      auditSubject: 'user:user-1',
    }
    const team = buildAccessPath({
      principalUserId: 'user-1',
      resource,
      kind: 'team',
      grantId: 'team_agents:team-1:agent-a',
      teamId: 'team-1',
      authorizationRevision: 'revision-1',
      behavior,
    })
    const direct = buildAccessPath({
      principalUserId: 'user-1',
      resource,
      kind: 'direct',
      grantId: 'user_agents:user-1:agent-a',
      authorizationRevision: 'revision-1',
      behavior,
    })

    expect(
      buildAccessPath({
        principalUserId: 'user-1',
        resource,
        kind: 'direct',
        grantId: 'user_agents:user-1:agent-a',
        authorizationRevision: 'revision-1',
        behavior,
      }).id
    ).toBe(direct.id)
    expect(team.id).not.toBe(direct.id)
    expect(accessPathsAreEquivalent(direct, team)).toBe(true)
    expect(selectEquivalentAccessPath([team, direct])).toEqual(direct)
    expect(direct.id).toMatch(/^ap1_[A-Za-z0-9_-]{43}$/)
  })

  it('fails unknown capabilities closed', () => {
    expect(isCapability('workflow.approval.decide')).toBe(true)
    expect(isCapability('host.activity.read_all')).toBe(true)
    expect(isCapability('unknown.superpower')).toBe(false)
    expect(() => requireKnownCapability('unknown.superpower')).toThrow('unknown capability')
  })
})
