import {
  ACTION_AUTHORITY_CHECKPOINT_PATH,
  type ActionAuthorityCheckpointRequestV2,
  type ActionAuthorityCheckpointResponseV2,
  type AuthorityBindingV2,
  validateActionAuthorityCheckpointResponse,
} from '@clerum/action-context-contracts'
import { type McpHostRuntimeAuth, refreshWithRecovery } from '../workflow/userApprovalRequester'

const CHECKPOINT_TIMEOUT_MS = 5_000

export class McpHostActionAuthorityCheckpointError extends Error {
  constructor(readonly code: 'authority_unavailable') {
    super(code)
    this.name = 'McpHostActionAuthorityCheckpointError'
  }
}

export function mcpHostActionAuthorityCheckpointRequest(
  binding: AuthorityBindingV2
): ActionAuthorityCheckpointRequestV2 {
  return Object.freeze({
    version: 2,
    principal: Object.freeze({
      sub: binding.userId,
      sid: binding.sid,
      sessionVersion: binding.sessionVersion,
    }),
    delegationJti: binding.delegationJti,
    resource: binding.resource,
    operationId: binding.operationId,
    target: binding.target,
    targetHash: binding.targetHash,
    accessPathId: binding.accessPathId,
    authorizationRevision: binding.authorizationRevision,
    behaviorBindingHash: binding.behaviorBindingHash,
    domain: Object.freeze({
      service: 'mcp-host',
      resource: binding.resource,
      targetHash: binding.targetHash,
    }),
  })
}

async function postCheckpoint(
  binding: AuthorityBindingV2,
  auth: McpHostRuntimeAuth,
  fetchImpl: typeof fetch
): Promise<Response> {
  return fetchImpl(`${auth.baseUrl.replace(/\/+$/, '')}${ACTION_AUTHORITY_CHECKPOINT_PATH}`, {
    method: 'POST',
    signal: AbortSignal.timeout(CHECKPOINT_TIMEOUT_MS),
    headers: {
      authorization: `Bearer ${auth.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(mcpHostActionAuthorityCheckpointRequest(binding)),
  })
}

export async function checkpointMcpHostActionAuthority(
  binding: AuthorityBindingV2,
  auth: McpHostRuntimeAuth,
  fetchImpl: typeof fetch = fetch
): Promise<ActionAuthorityCheckpointResponseV2> {
  let response: Response
  try {
    response = await postCheckpoint(binding, auth, fetchImpl)
    if (response.status === 401) {
      await refreshWithRecovery(auth)
      response = await postCheckpoint(binding, auth, fetchImpl)
    }
  } catch {
    throw new McpHostActionAuthorityCheckpointError('authority_unavailable')
  }

  let parsed: ActionAuthorityCheckpointResponseV2
  try {
    parsed = validateActionAuthorityCheckpointResponse(await response.json())
  } catch {
    throw new McpHostActionAuthorityCheckpointError('authority_unavailable')
  }
  const expectedStatus = {
    allowed: 200,
    denied: 403,
    not_found: 404,
    access_path_stale: 409,
    authority_unavailable: 503,
    invalid_binding: 400,
  }[parsed.status]
  if (response.status !== expectedStatus) {
    throw new McpHostActionAuthorityCheckpointError('authority_unavailable')
  }
  return parsed
}
