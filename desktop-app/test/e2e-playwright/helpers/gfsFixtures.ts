/** Exact-subject GFS fixtures for the #775 regression and #797 Copy journey. */
import { request } from '@playwright/test'
import {
  type GfsCopyTreeFixture,
  cleanupGfsCopyTreeFixture,
  getGfsHostGrantsUnderTree,
  getGfsTreeAclShareCounts,
  getGfsTreeSnapshot,
  seedGfsCopyTreeFixture,
} from '../../../../tests/e2e/gfsCopyFixtures'
import {
  type GfsFileFixture,
  cleanupGfsFixture,
  countGfsLiveChildrenByName,
  getE2EUserId,
  getGfsChildResourceSummary,
  kubectlOut,
  runControlPostgresSql,
  seedGfsFileFixture,
  seedGfsGrant,
  sqlLiteral,
  uniqueGfsFixtureName,
} from '../../../../tests/e2e/gfsUiFixtures'
import { seedIssue797SourceShare } from './gfsAclShareFixtures'
import {
  type ManagedGfsAgent,
  discoverManagedGfsAgent,
  discoverManagedGfsAgents,
} from './gfsAgentDiscovery'

export {
  discoverManagedGfsAgent,
  discoverManagedGfsAgents,
  type ManagedGfsAgent,
} from './gfsAgentDiscovery'
export { getGfsTreeAclShareRows } from './gfsAclShareFixtures'

const GFS_NS = 'gfs'
const GFSC_POD_SELECTOR = 'app=gfs-controller'
const ISSUE_797_SHARE_RECIPIENT_EMAIL = 'test2@clerum.io'

/**
 * FAIL LOUD, NEVER SKIP: proves gfsc can actually authorize before any test
 * runs. A failure here is an infrastructure blocker to fix (re-run
 * deploy/scripts/provision-gfs-db.sh / make minikube-verify-gfs), not product
 * evidence.
 */
export function assertGfsInfraHealthy(): void {
  const dsnB64 = kubectlOut([
    '-n',
    GFS_NS,
    'get',
    'secret',
    'gfs-controller-db',
    '-o',
    'jsonpath={.data.connection-string}',
  ]).trim()
  if (dsnB64.length === 0) {
    throw new Error(
      'GFS infra guard: Secret gfs/gfs-controller-db has an empty connection-string — ' +
        'run CONTEXT=<kube-context> deploy/scripts/provision-gfs-db.sh before this suite'
    )
  }

  const podRows = kubectlOut([
    '-n',
    GFS_NS,
    'get',
    'pods',
    '-l',
    GFSC_POD_SELECTOR,
    '-o',
    // NOTE: \\n so kubectl receives the jsonpath token {"\n"}, not a literal
    // newline inside the expression (which it rejects as unterminated).
    'jsonpath={range .items[*]}{.metadata.name}{" "}{.status.conditions[?(@.type=="Ready")].status}{"\\n"}{end}',
  ])
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  if (podRows.length === 0) {
    throw new Error(
      `GFS infra guard: no gfsc pods matching ${GFSC_POD_SELECTOR} in namespace ${GFS_NS}`
    )
  }
  const notReady = podRows.filter(row => !row.endsWith(' True'))
  if (notReady.length > 0) {
    throw new Error(
      'GFS infra guard: gfsc pods NOT Ready (/readyz failing — permission store unreachable ' +
        `or credential invalid): ${notReady.join(', ')} — run make minikube-verify-gfs for details`
    )
  }
}

export interface AgentGfsFixtures {
  /** Exact HCC-managed host granted by this fixture. */
  agent: ManagedGfsAgent
  /** Visible to the user AND readable by the agent host (happy path). */
  granted: GfsFileFixture
  /** Visible to the user but NOT granted to the host (expects a 403 denial). */
  ungranted: GfsFileFixture
  /** Removes both fixtures; collects errors instead of swallowing them. */
  cleanup(): void
}

export interface AgentGfsCopyFixtures {
  agentA: ManagedGfsAgent
  agentB: ManagedGfsAgent
  tree: GfsCopyTreeFixture
  fileCopyName: string
  folderCopyName: string
  renamedFolderName: string
  deniedCopyName: string
  revokedCopyName: string
  destinationGrantId: string
  /** Source user-share whose exact row must survive Copy unchanged. */
  sourceShareId: string
  sourceShareSubjectId: string
  cleanup(): void
}

export function seedAgentGfsCopyFixtures(ownerEmail: string): AgentGfsCopyFixtures {
  const [agentA, agentB] = discoverManagedGfsAgents()
  const tree = seedGfsCopyTreeFixture(uniqueGfsFixtureName('e2e-gfs-copy-797'))
  try {
    const ownerUserId = getE2EUserId(ownerEmail)
    const sourceShareSubjectId = getE2EUserId(ISSUE_797_SHARE_RECIPIENT_EMAIL)
    for (const resourceId of [tree.sourceResourceId, tree.destinationResourceId]) {
      seedGfsGrant({
        resourceId,
        subjectType: 'user',
        subjectId: ownerUserId,
        permissions: ['read'],
        inherit: true,
        grantedBy: 'e2e:issue-797-owner',
      })
    }
    seedGfsGrant({
      resourceId: tree.sourceResourceId,
      subjectType: 'host',
      subjectId: agentA.subjectId,
      permissions: ['read'],
      inherit: true,
      grantedBy: 'e2e:issue-797-agent-a',
    })
    seedGfsGrant({
      resourceId: tree.sourceResourceId,
      subjectType: 'host',
      subjectId: agentB.subjectId,
      permissions: ['read'],
      inherit: false,
      grantedBy: 'e2e:issue-797-agent-b-root-only',
    })
    seedGfsGrant({
      resourceId: tree.destinationResourceId,
      subjectType: 'host',
      subjectId: agentB.subjectId,
      permissions: ['read', 'write'],
      inherit: true,
      grantedBy: 'e2e:issue-797-agent-b-destination',
    })
    const agentBSource = getGfsHostGrantsUnderTree(tree.sourceResourceId, agentB.subjectId)
    if (
      agentBSource.length !== 1 ||
      agentBSource[0]?.resourceId !== tree.sourceResourceId ||
      agentBSource[0].inherit ||
      agentBSource[0].permissions.join(',') !== 'read'
    ) {
      throw new Error('Agent B fixture must have root-only source read and no descendant grant')
    }
    const agentBDest = getGfsHostGrantsUnderTree(tree.destinationResourceId, agentB.subjectId)
    if (
      agentBDest.length !== 1 ||
      !agentBDest[0]?.inherit ||
      agentBDest[0].permissions.join(',') !== 'read,write'
    ) {
      throw new Error('Agent B fixture must have destination read/write')
    }
    const destinationGrantId = seedGfsGrant({
      resourceId: tree.destinationResourceId,
      subjectType: 'host',
      subjectId: agentA.subjectId,
      permissions: ['read', 'write'],
      inherit: true,
      grantedBy: 'e2e:issue-797-agent-a',
    })
    const sourceShareId = seedIssue797SourceShare(tree.sourceResourceId, sourceShareSubjectId)
    return {
      agentA,
      agentB,
      tree,
      fileCopyName: `${tree.sourceName}-file-copy.txt`,
      folderCopyName: `${tree.sourceName}-copy`,
      renamedFolderName: `${tree.sourceName}-renamed`,
      deniedCopyName: `${tree.sourceName}-agent-b-denied`,
      revokedCopyName: `${tree.sourceName}-revoked-denied`,
      destinationGrantId,
      sourceShareId,
      sourceShareSubjectId,
      cleanup: () => cleanupGfsCopyTreeFixture(tree),
    }
  } catch (error) {
    try {
      cleanupGfsCopyTreeFixture(tree)
    } catch (cleanupError) {
      throw new Error(
        `GFS Copy setup failed (${String(error)}) and cleanup failed (${String(cleanupError)})`
      )
    }
    throw error
  }
}

export async function revokeGfsGrantViaControlApi(grantId: string): Promise<void> {
  const rawBase = process.env.E2E_CONTROL_API_URL || process.env.CONTROL_API_BASE_URL
  if (!rawBase) throw new Error('audited GFS revoke requires an explicit Control API URL')
  const base = new URL(rawBase)
  if (!['127.0.0.1', 'localhost'].includes(base.hostname)) {
    throw new Error(`refusing issue #797 fixture revoke against ${base.origin}`)
  }
  // The desktop suite has no storageState producer, so the admin session is
  // created here through the real cookie login the Control UI uses. The
  // local-only default password is safe behind the localhost guard above and
  // matches the repo-wide E2E admin credential priority.
  const api = await request.newContext({ baseURL: base.origin })
  try {
    const username = process.env.TEST_ADMIN_USERNAME || 'admin'
    const password =
      process.env.E2E_ADMIN_PASSWORD ||
      process.env.ADMIN_PASSWORD ||
      process.env.ADMIN_PASS ||
      process.env.TEST_ADMIN_PASSWORD ||
      'admin123!'
    const login = await api.post('/api/v1/admin/auth/login', {
      data: { username, password },
    })
    if (!login.ok()) {
      throw new Error(
        `audited GFS revoke admin login failed with HTTP ${login.status()}: ${await login.text()}`
      )
    }
    // The admin session cookie is issued Secure; Playwright's cookie jar
    // rightly refuses to send Secure cookies over the http:// port-forward, so
    // API-only consumers send the captured value as an explicit Cookie header
    // (same pattern as the root suite's adminSessionCookieHeader helper).
    const sessionCookie = (await api.storageState()).cookies.find(
      cookie => cookie.name === 'control_ui_admin_session'
    )
    if (!sessionCookie?.value) {
      throw new Error('audited GFS revoke admin login did not set control_ui_admin_session')
    }
    const response = await api.delete(`/api/v1/gfs/grants/${encodeURIComponent(grantId)}`, {
      headers: {
        'X-Request-Id': `e2e-797-revoke-${Date.now()}`,
        cookie: `${sessionCookie.name}=${sessionCookie.value}`,
      },
    })
    if (!response.ok()) {
      throw new Error(
        `audited GFS revoke failed with HTTP ${response.status()}: ${await response.text()}`
      )
    }
  } finally {
    await api.dispose()
  }
}

export function gfsGrantRevokeAuditCount(agent: ManagedGfsAgent): number {
  const rows = runControlPostgresSql(`
    SELECT count(*)::text FROM gfs_audit
     WHERE subject = ${sqlLiteral(`host:${agent.subjectId}`)}
       AND op = 'grant.delete' AND outcome = 'allowed';
  `)
  return Number(rows.trim())
}

export {
  countGfsLiveChildrenByName,
  getGfsChildResourceSummary,
  getGfsTreeAclShareCounts,
  getGfsTreeSnapshot,
}

export function seedAgentGfsFixtures(ownerEmail: string): AgentGfsFixtures {
  const agent = discoverManagedGfsAgent()
  const ownerUserId = getE2EUserId(ownerEmail)
  const seeded: GfsFileFixture[] = []
  let granted: GfsFileFixture
  let ungranted: GfsFileFixture
  try {
    granted = seedGfsFileFixture(uniqueGfsFixtureName('e2e-gfs-agent-read'))
    seeded.push(granted)
    ungranted = seedGfsFileFixture(uniqueGfsFixtureName('e2e-gfs-agent-denied'))
    seeded.push(ungranted)

    for (const fixture of [granted, ungranted]) {
      // User grant on the FILE so it appears in the Desktop Files page list.
      seedGfsGrant({
        resourceId: fixture.fileResourceId,
        subjectType: 'user',
        subjectId: ownerUserId,
        permissions: ['read'],
        inherit: true,
        grantedBy: 'e2e:gfs-agent-file-read',
      })
    }
    // Host grant ONLY on the happy-path file — the other file must produce a
    // clean deny-by-default 403 for the agent.
    seedGfsGrant({
      resourceId: granted.fileResourceId,
      subjectType: 'host',
      subjectId: agent.subjectId,
      permissions: ['read'],
      inherit: true,
      grantedBy: 'e2e:gfs-agent-file-read',
    })
  } catch (err) {
    const teardownFailures: string[] = []
    for (const fixture of seeded) {
      try {
        cleanupGfsFixture(fixture.name)
      } catch (cleanupErr) {
        teardownFailures.push(
          `${fixture.name}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
        )
      }
    }
    if (teardownFailures.length > 0) {
      throw new Error(
        `GFS fixture seeding failed (${err instanceof Error ? err.message : String(err)}) AND teardown of partial state failed: ${teardownFailures.join('; ')}`
      )
    }
    throw err
  }

  return {
    agent,
    granted,
    ungranted,
    cleanup: () => {
      const failures: string[] = []
      for (const fixture of [granted, ungranted]) {
        try {
          cleanupGfsFixture(fixture.name)
        } catch (err) {
          failures.push(`${fixture.name}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (failures.length > 0) {
        throw new Error(`GFS fixture cleanup failed: ${failures.join('; ')}`)
      }
    },
  }
}
