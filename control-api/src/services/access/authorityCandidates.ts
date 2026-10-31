import type { TeamRole } from '../../profileTypes.js'
import {
  type AccessPathBehavior,
  type AccessPathSeed,
  knownBehavior,
  unknownBehavior,
} from './accessPath.js'
import { type AccessCapability, normalizeAccessCapabilities } from './capabilityRegistry.js'
import type { OperationalBehaviorSources } from './operationalAccessProjection.js'

export type OperationalPathBinding = Readonly<{
  resourceType: 'host' | 'context' | 'mcp_server' | 'workflow_recipe' | 'shared_filesystem'
  logicalId: string
  providerUid: string
  providerResourceVersion: string
  behaviorSources?: OperationalBehaviorSources
  relationships: readonly Readonly<{
    instanceId: string
    behaviorAttributes: Readonly<Record<string, string | number | boolean>>
  }>[]
}>

export type AuthorityCandidate = AccessPathSeed &
  Readonly<{ operationalBindings: readonly OperationalPathBinding[] }>

function behavior(input: {
  userId: string
  kind: 'direct' | 'team'
  teamId?: string
  runtimeSensitive?: boolean
  filesystemScope?: string | null
  runtimeRef?: string | null
  providerModelRef?: string | null
  approvalRef?: string | null
  behaviorDimensions?: Partial<Omit<AccessPathBehavior, 'capabilities' | 'audit'>>
}): AccessPathBehavior {
  const runtimeSensitive = input.runtimeSensitive === true
  return Object.freeze({
    capabilities: Object.freeze([]),
    budget: runtimeSensitive ? unknownBehavior() : knownBehavior(null),
    credentialPolicy: runtimeSensitive ? unknownBehavior() : knownBehavior(null),
    approvalPolicy:
      input.approvalRef !== undefined
        ? knownBehavior(input.approvalRef)
        : runtimeSensitive
          ? unknownBehavior()
          : knownBehavior(null),
    filesystemScope:
      input.filesystemScope !== undefined
        ? knownBehavior(input.filesystemScope)
        : knownBehavior(null),
    runtime:
      input.runtimeRef !== undefined
        ? knownBehavior(input.runtimeRef)
        : runtimeSensitive
          ? unknownBehavior()
          : knownBehavior(null),
    providerModelPolicy:
      input.providerModelRef !== undefined
        ? knownBehavior(input.providerModelRef)
        : runtimeSensitive
          ? unknownBehavior()
          : knownBehavior(null),
    audit: knownBehavior(input.kind === 'team' ? `team:${input.teamId}` : `user:${input.userId}`),
    ...input.behaviorDimensions,
  })
}

export function authorityCandidate(input: {
  userId: string
  kind: 'direct' | 'team'
  grantId: string
  teamId?: string
  currentRole?: TeamRole
  capabilities: readonly AccessCapability[]
  runtimeSensitive?: boolean
  filesystemScope?: string | null
  runtimeRef?: string | null
  providerModelRef?: string | null
  approvalRef?: string | null
  behaviorDimensions?: Partial<Omit<AccessPathBehavior, 'capabilities' | 'audit'>>
  operationalBindings?: readonly OperationalPathBinding[]
}): AuthorityCandidate {
  return Object.freeze({
    kind: input.kind,
    grantId: input.grantId,
    ...(input.teamId ? { teamId: input.teamId } : {}),
    ...(input.currentRole ? { currentRole: input.currentRole } : {}),
    behavior: Object.freeze({
      ...behavior(input),
      capabilities: Object.freeze(normalizeAccessCapabilities(input.capabilities)),
    }),
    operationalBindings: Object.freeze([...(input.operationalBindings ?? [])]),
  })
}

export function authorityCandidateFromGrantRow(input: {
  row: Record<string, unknown>
  userId: string
  capabilities: readonly AccessCapability[]
  runtimeSensitive?: boolean
  operationalBindings?: readonly OperationalPathBinding[]
  filesystemScope?: string | null
  runtimeRef?: string | null
  providerModelRef?: string | null
  approvalRef?: string | null
  behaviorDimensions?: Partial<Omit<AccessPathBehavior, 'capabilities' | 'audit'>>
}): AuthorityCandidate | null {
  const kind = input.row.kind === 'direct' ? 'direct' : input.row.kind === 'team' ? 'team' : null
  const grantId = String(input.row.grant_id ?? '')
  if (!kind || !grantId) return null
  const teamId = kind === 'team' ? String(input.row.team_id ?? '') : undefined
  const currentRole = kind === 'team' ? (String(input.row.current_role) as TeamRole) : undefined
  if (kind === 'team' && (!teamId || !['admin', 'inviter', 'member'].includes(currentRole!))) {
    return null
  }
  return authorityCandidate({
    userId: input.userId,
    kind,
    grantId,
    ...(teamId ? { teamId } : {}),
    ...(currentRole ? { currentRole } : {}),
    capabilities: input.capabilities,
    runtimeSensitive: input.runtimeSensitive,
    operationalBindings: input.operationalBindings,
    filesystemScope: input.filesystemScope,
    runtimeRef: input.runtimeRef,
    providerModelRef: input.providerModelRef,
    approvalRef: input.approvalRef,
    behaviorDimensions: input.behaviorDimensions,
  })
}
