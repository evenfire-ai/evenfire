/**
 * GFS fixtures for the agent-file-read E2E journey (issue #775).
 *
 * Seeds two isolated GFS files through the shared SQL fixtures:
 *  - `granted`:   visible to the Desktop user AND granted read to the agent
 *                 host `chatllm` — the happy path.
 *  - `ungranted`: visible to the Desktop user but NOT granted to the host —
 *                 the agent must receive a clean authorization denial (403),
 *                 never a permission-store outage (503 not_mounted).
 *
 * Also provides the fail-loud infra guard: when gfsc is unhealthy the suite
 * THROWS with the concrete pod/Secret state. It never skips and never mocks —
 * a broken permission store is an infrastructure blocker, not a reason to
 * fake a pass (repo rule: tests fail loud, especially minikube E2E).
 */
import {
  type GfsFileFixture,
  cleanupGfsFixture,
  getE2EUserId,
  kubectlOut,
  seedGfsFileFixture,
  seedGfsGrant,
  uniqueGfsFixtureName,
} from '../../../../tests/e2e/gfsUiFixtures'

/**
 * The Desktop agent journey runs through the concrete `chatllm` Host. GFS
 * grants are host-specific, so `chatllm-stateless` and every other first-party
 * Host remain independently denied unless they receive their own grant.
 */
export const FIRST_PARTY_HOST_SUBJECT_ID = '1st:mcp-host/chatllm'

const GFS_NS = 'gfs'
// Pod-template labels — pods do NOT inherit the deployment-level managed-by
// label (see gfsFactory commonLabels vs spec.selector).
const GFSC_POD_SELECTOR = 'app=gfs-controller'

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
  /** Visible to the user AND readable by the agent host (happy path). */
  granted: GfsFileFixture
  /** Visible to the user but NOT granted to the host (expects a 403 denial). */
  ungranted: GfsFileFixture
  /** Removes both fixtures; collects errors instead of swallowing them. */
  cleanup(): void
}

export function seedAgentGfsFixtures(ownerEmail: string): AgentGfsFixtures {
  const ownerUserId = getE2EUserId(ownerEmail)
  // Exception-safe seeding: if any later step throws, tear down whatever was
  // already created (rows + PVC blobs) before rethrowing — a partial seed must
  // not leak into the shared profile, and afterAll never runs on a failed
  // beforeAll.
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
      subjectId: FIRST_PARTY_HOST_SUBJECT_ID,
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
