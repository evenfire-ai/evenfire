// E2E_GUARDIAN_IPC_FLOW: this setup helper seeds the real GFS backend before
// the Desktop journey starts; it does not replace any browser transition.
import {
  type GfsDirectoryFixture,
  type GfsPermission,
  cleanupGfsFixture,
  getE2EUserId,
  seedGfsDirectoryFixture,
  seedGfsGrant,
  uniqueGfsFixtureName,
} from '../../../../tests/e2e/gfsUiFixtures'
import { type ManagedGfsAgent, discoverManagedGfsAgent } from './gfsAgentDiscovery'

export interface AgentGfsLargeFileFixtures {
  agent: ManagedGfsAgent
  granted: GfsDirectoryFixture
  cleanup(): void
}

interface GfsGrantInput {
  resourceId: string
  subjectType: 'user' | 'host'
  subjectId: string
  permissions: GfsPermission[]
  grantedBy: string
}

function grant(input: GfsGrantInput): void {
  seedGfsGrant({ ...input, inherit: true })
}

export function seedAgentGfsLargeFileFixtures(ownerEmail: string): AgentGfsLargeFileFixtures {
  const agent = discoverManagedGfsAgent()
  const ownerUserId = getE2EUserId(ownerEmail)
  const granted = seedGfsDirectoryFixture(uniqueGfsFixtureName('e2e-gfs-agent-large'))

  grant({
    resourceId: granted.resourceId,
    subjectType: 'user',
    subjectId: ownerUserId,
    permissions: ['read', 'write'],
    grantedBy: 'e2e:gfs-agent-large-file',
  })
  grant({
    resourceId: granted.resourceId,
    subjectType: 'host',
    subjectId: agent.subjectId,
    permissions: ['read'],
    grantedBy: 'e2e:gfs-agent-large-file',
  })

  return {
    agent,
    granted,
    cleanup: () => cleanupGfsFixture(granted.name),
  }
}
