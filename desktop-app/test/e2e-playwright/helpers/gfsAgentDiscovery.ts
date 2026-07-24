/**
 * TEST-HARNESS discovery, not agent behavior: this module finds eligible
 * HCC-managed Host CRDs via kubectl so the suites can pick the two journey
 * agents (Agent A / Agent B). It has nothing to do with the agents' own
 * tool-based GFS file discovery (gfs_resolve/gfs_list), which the journeys
 * exercise through the real chat UI.
 */
import { kubectlOut } from '../../../../tests/e2e/gfsUiFixtures'

/** Historical fleet-wide identity, retained only as an explicit rejection guard. */
const LEGACY_FLEET_WIDE_SUBJECT_ID = '1st:mcp-host/standalone'

export interface ManagedGfsAgent {
  name: string
  namespace: string
  subjectId: string
}

interface CandidateError {
  namespace: string
  name: string
  message: string
}

function formatCandidateError(item: CandidateError): string {
  return `${item.namespace}/${item.name}: ${item.message}`
}

/**
 * Reads HCC safe metadata only: the Secret ANNOTATIONS below (expected subject,
 * host UID/generation) are non-sensitive drift metadata. No credential data is
 * requested, decoded, or printed — the go-template projects annotations only.
 */
function discoverManagedGfsAgentCandidates(): {
  candidates: ManagedGfsAgent[]
  candidateErrors: CandidateError[]
} {
  const expected = 'clerum.io/gfs-token-expected-subject'
  const uid = 'clerum.io/gfs-token-host-uid'
  const generation = 'clerum.io/gfs-token-host-generation'
  const template =
    `{{range .items}}{{with .metadata.annotations}}{{if index . "${expected}"}}` +
    `{{index . "${expected}"}}{{"\\t"}}` +
    `{{index . "${uid}"}}{{"\\t"}}` +
    `{{index . "${generation}"}}{{"\\n"}}{{end}}{{end}}{{end}}`
  const output = kubectlOut(['get', 'secrets', '-A', '-o', `go-template=${template}`])
  const bySubject = new Map<string, ManagedGfsAgent>()
  const candidateErrors: CandidateError[] = []
  for (const line of output
    .split('\n')
    .map(value => value.trim())
    .filter(Boolean)) {
    const [annotatedSubject, hostUid, hostGeneration] = line.split('\t')
    const match =
      /^host:1st:([a-z0-9](?:[-a-z0-9]*[a-z0-9])?)\/([a-z0-9](?:[-a-z0-9]*[a-z0-9])?)$/.exec(
        annotatedSubject ?? ''
      )
    if (!match || !hostUid || !/^\d+$/.test(hostGeneration ?? '')) continue
    const namespace = match[1]!
    const name = match[2]!
    const subjectId = `1st:${namespace}/${name}`
    if (name === 'standalone' || subjectId === LEGACY_FLEET_WIDE_SUBJECT_ID) continue
    let hostState = ''
    try {
      hostState = kubectlOut([
        '-n',
        namespace,
        'get',
        'hosts',
        name,
        '-o',
        'go-template={{.metadata.uid}}{{"\\t"}}{{.metadata.generation}}{{"\\t"}}{{if .metadata.deletionTimestamp}}deleting{{end}}{{"\\t"}}{{if eq .spec.enabled false}}disabled{{end}}',
      ]).trim()
    } catch (error) {
      // An infra error while validating a candidate must not be silently
      // reported as "agent does not exist"; it is surfaced with the final
      // topology failure so a broken kubectl path fails for the real reason.
      candidateErrors.push({
        namespace,
        name,
        message: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    const [activeUid, activeGeneration, deleting, disabled] = hostState.split('\t')
    if (activeUid !== hostUid || activeGeneration !== hostGeneration || deleting || disabled)
      continue
    bySubject.set(subjectId, { name, namespace, subjectId })
  }
  if (bySubject.size === 0 && candidateErrors.length > 0) {
    throw new Error(
      `GFS agent discovery could not validate any candidate host: ${candidateErrors
        .map(formatCandidateError)
        .join('; ')}`
    )
  }
  return {
    candidates: [...bySubject.values()].sort((a, b) => a.subjectId.localeCompare(b.subjectId)),
    candidateErrors,
  }
}

function chooseManagedGfsAgent(
  candidates: ManagedGfsAgent[],
  candidateErrors: CandidateError[],
  requested: string | undefined,
  excluded?: string
): ManagedGfsAgent | undefined {
  const eligible = candidates.filter(item => item.subjectId !== excluded)
  if (requested) {
    const matches = eligible.filter(item => item.name === requested)
    if (matches.length !== 1) {
      // If the requested agent was among the candidates whose kubectl
      // validation errored, "missing" would misreport an infra failure as a
      // topology failure — include the recorded error for that candidate.
      const requestedErrors = candidateErrors
        .filter(item => item.name === requested)
        .map(formatCandidateError)
      throw new Error(
        `HCC agent "${requested}" is missing or ambiguous` +
          (requestedErrors.length > 0
            ? ` (candidate validation errors: ${requestedErrors.join('; ')})`
            : '')
      )
    }
    return matches[0]
  }
  return eligible.find(item => eligible.filter(other => other.name === item.name).length === 1)
}

/**
 * Live pod identity (UID + startTime) for an HCC-managed agent. Used to prove
 * "same runtime" claims: revocation enforcement must not depend on a pod
 * restart, so the identity captured before a revoke must equal the identity
 * observed after the denied retry.
 */
export function getManagedAgentPodIdentity(agent: ManagedGfsAgent): string {
  const identity = kubectlOut([
    '-n',
    agent.namespace,
    'get',
    'pods',
    '-l',
    `app=${agent.name}`,
    '-o',
    'go-template={{range .items}}{{if not .metadata.deletionTimestamp}}{{.metadata.uid}}{{"\\t"}}{{.status.startTime}}{{"\\n"}}{{end}}{{end}}',
  ]).trim()
  if (!identity) {
    throw new Error(`no live pod found for HCC-managed agent ${agent.namespace}/${agent.name}`)
  }
  return identity
}

export function discoverManagedGfsAgent(): ManagedGfsAgent {
  const { candidates, candidateErrors } = discoverManagedGfsAgentCandidates()
  const agent = chooseManagedGfsAgent(candidates, candidateErrors, process.env.E2E_GFS_AGENT_A)
  if (!agent) throw new Error('GFS agent E2E requires one unambiguous HCC-managed agent name')
  return agent
}

export function discoverManagedGfsAgents(): [ManagedGfsAgent, ManagedGfsAgent] {
  const { candidates, candidateErrors } = discoverManagedGfsAgentCandidates()
  const agentA = chooseManagedGfsAgent(candidates, candidateErrors, process.env.E2E_GFS_AGENT_A)
  const agentB = chooseManagedGfsAgent(
    candidates,
    candidateErrors,
    process.env.E2E_GFS_AGENT_B,
    agentA?.subjectId
  )
  if (!agentA || !agentB || agentA.name === agentB.name) {
    throw new Error('Issue #797 requires two distinct, unambiguous HCC-managed agent names')
  }
  return [agentA, agentB]
}
