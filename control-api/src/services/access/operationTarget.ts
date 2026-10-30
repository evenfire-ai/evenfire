import type { TeamRole } from '../../profileTypes.js'
import type { AccessCapability } from './capabilityRegistry.js'
import type { CanonicalResourceIdentity } from './resourceIdentity.js'

export type ValidatedOperationTarget = Readonly<Record<string, string>> | null

export class OperationTargetValidationError extends Error {
  constructor(readonly code: 'missing' | 'invalid' | 'unsupported' | 'resource_mismatch') {
    super(`Operation target ${code}`)
    this.name = 'OperationTargetValidationError'
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TEAM_ROLES = new Set<TeamRole>(['admin', 'inviter', 'member'])
const READ_CAPABILITIES = new Set<AccessCapability>([
  'user.profile.read',
  'team.read',
  'host.read',
  'context.read',
  'mcp_server.read',
  'workflow.read',
  'gfs.read',
  'shared_filesystem.read',
  'sandbox_app.read',
  'chat.read',
  'task.read',
  'model.read',
  'session.read',
  'notification.read',
])

function flatStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationTargetValidationError('invalid')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0 || entries.length > 8) {
    throw new OperationTargetValidationError('invalid')
  }
  const result: Record<string, string> = {}
  for (const [key, item] of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(key) || typeof item !== 'string') {
      throw new OperationTargetValidationError('invalid')
    }
    const normalized = item.trim()
    if (!normalized || normalized.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
      throw new OperationTargetValidationError('invalid')
    }
    result[key] = normalized
  }
  return result
}

function exactKeys(
  value: Record<string, string>,
  required: readonly string[],
  optional: readonly string[] = []
) {
  const allowed = new Set([...required, ...optional])
  if (required.some(key => !(key in value)) || Object.keys(value).some(key => !allowed.has(key))) {
    throw new OperationTargetValidationError('invalid')
  }
}

function requireUuid(value: string | undefined): void {
  if (!value || !UUID_PATTERN.test(value)) throw new OperationTargetValidationError('invalid')
}

function requireRole(value: string | undefined): asserts value is TeamRole {
  if (!value || !TEAM_ROLES.has(value as TeamRole)) {
    throw new OperationTargetValidationError('invalid')
  }
}

function requireTargetTeam(resource: CanonicalResourceIdentity, teamId: string | undefined): void {
  requireUuid(teamId)
  if (resource.type !== 'team' || resource.logicalId !== teamId) {
    throw new OperationTargetValidationError('resource_mismatch')
  }
}

export function validateOperationTarget(input: {
  capability: AccessCapability
  resource: CanonicalResourceIdentity
  operationTarget?: unknown
}): ValidatedOperationTarget {
  if (READ_CAPABILITIES.has(input.capability)) {
    if (input.operationTarget !== undefined && input.operationTarget !== null) {
      throw new OperationTargetValidationError('unsupported')
    }
    return null
  }
  if (input.operationTarget === undefined || input.operationTarget === null) {
    throw new OperationTargetValidationError('missing')
  }
  const target = flatStringRecord(input.operationTarget)

  if (input.capability === 'team.manage') {
    exactKeys(target, ['teamId', 'action'])
    requireTargetTeam(input.resource, target.teamId)
    if (!['rename', 'delete'].includes(target.action)) {
      throw new OperationTargetValidationError('invalid')
    }
    return Object.freeze(target)
  }

  if (input.capability === 'team.member.read') {
    exactKeys(target, ['teamId'], ['userId'])
    requireTargetTeam(input.resource, target.teamId)
    if (target.userId) requireUuid(target.userId)
    return Object.freeze(target)
  }

  if (input.capability === 'team.member.invite') {
    exactKeys(target, ['teamId', 'action', 'role'], ['invitationId'])
    requireTargetTeam(input.resource, target.teamId)
    requireRole(target.role)
    if (!['create', 'resend', 'revoke'].includes(target.action)) {
      throw new OperationTargetValidationError('invalid')
    }
    if (target.action === 'create' && target.invitationId) {
      throw new OperationTargetValidationError('invalid')
    }
    if (target.action !== 'create') requireUuid(target.invitationId)
    return Object.freeze(target)
  }

  if (input.capability === 'team.member.manage') {
    exactKeys(target, ['teamId', 'action', 'userId', 'role'])
    requireTargetTeam(input.resource, target.teamId)
    requireUuid(target.userId)
    requireRole(target.role)
    if (!['set_role', 'remove'].includes(target.action)) {
      throw new OperationTargetValidationError('invalid')
    }
    return Object.freeze(target)
  }

  if (input.capability === 'workflow.approval.decide') {
    exactKeys(target, ['approvalId', 'decision'])
    requireUuid(target.approvalId)
    if (
      input.resource.type !== 'workflow_approval' ||
      input.resource.logicalId !== target.approvalId
    ) {
      throw new OperationTargetValidationError('resource_mismatch')
    }
    if (!['approve', 'deny'].includes(target.decision)) {
      throw new OperationTargetValidationError('invalid')
    }
    return Object.freeze(target)
  }

  // PR 2 owns the exact domain target schemas for runtime/file/app mutation capabilities.
  // Failing closed here prevents PR 1 from advertising a generic unbound action decision.
  throw new OperationTargetValidationError('unsupported')
}

export function stableOperationTarget(target: ValidatedOperationTarget): string {
  return JSON.stringify(
    target
      ? Object.fromEntries(
          Object.entries(target).sort(([left], [right]) => left.localeCompare(right))
        )
      : null
  )
}
