import {
  type ActionAuthorityCheckpointResponseV2,
  validateActionAuthorityCheckpointResponse,
} from '@clerum/action-context-contracts'
import { signInternalControlJwt } from '../utils/internalControlSigner'
import type { DbRunRow, WorkflowRunAuthorityBinding } from './dbRunProcessor'

const DEFAULT_CONTROL_API_BASE_URL = 'http://control-api.control-plane.svc.cluster.local:8090'
const CHECKPOINT_PATH = '/api/v1/internal/action-authority/checkpoint'
const REQUEST_TIMEOUT_MS = 10_000

function checkpointRequest(binding: WorkflowRunAuthorityBinding) {
  return {
    version: 2,
    principal: {
      sub: binding.userId,
      sid: binding.sid,
      sessionVersion: binding.sessionVersion,
    },
    delegationJti: binding.delegationJti,
    resource: binding.resource,
    operationId: binding.operationId,
    target: binding.target,
    targetHash: binding.targetHash,
    accessPathId: binding.accessPathId,
    authorizationRevision: binding.authorizationRevision,
    behaviorBindingHash: binding.behaviorBindingHash,
    domain: {
      service: 'workflow-recipes',
      resource: binding.resource,
      targetHash: binding.targetHash,
    },
  }
}

export type WorkflowRunAuthorityCheckpointer = (run: DbRunRow) => Promise<void>

export type WorkflowAuthorityCheckpointFailure =
  | 'denied'
  | 'not_found'
  | 'access_path_stale'
  | 'invalid_binding'
  | 'authority_unavailable'
  | 'invalid_response'
  | 'timeout'

export class WorkflowAuthorityCheckpointError extends Error {
  constructor(
    readonly failure: WorkflowAuthorityCheckpointFailure,
    readonly retryable: boolean
  ) {
    super(
      failure === 'authority_unavailable' || failure === 'timeout'
        ? 'workflow_authority_unavailable'
        : failure === 'invalid_response'
          ? 'workflow_authority_checkpoint_invalid_response'
          : 'workflow_authority_denied'
    )
    this.name = 'WorkflowAuthorityCheckpointError'
  }
}

export function createWorkflowRunAuthorityCheckpointer(
  options: {
    baseUrl?: string
    fetchImpl?: typeof fetch
  } = {}
): WorkflowRunAuthorityCheckpointer {
  const baseUrl = (
    options.baseUrl ??
    process.env.CONTROL_API_BASE_URL ??
    DEFAULT_CONTROL_API_BASE_URL
  ).replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? fetch

  return async run => {
    const binding = run.authority_binding
    if (!binding) return
    if (binding.operationId !== 'workflow.trigger') {
      throw new Error('workflow_authority_binding_operation_invalid')
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetchImpl(`${baseUrl}${CHECKPOINT_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${signInternalControlJwt()}`,
        },
        body: JSON.stringify(checkpointRequest(binding)),
        signal: controller.signal,
      })
      let result: ActionAuthorityCheckpointResponseV2
      try {
        result = validateActionAuthorityCheckpointResponse(await response.json())
      } catch {
        throw new WorkflowAuthorityCheckpointError('invalid_response', true)
      }
      const expectedStatus = {
        allowed: 200,
        denied: 403,
        not_found: 404,
        access_path_stale: 409,
        authority_unavailable: 503,
        invalid_binding: 400,
      }[result.status]
      if (response.status !== expectedStatus) {
        throw new WorkflowAuthorityCheckpointError('invalid_response', true)
      }
      if (result.status !== 'allowed') {
        throw new WorkflowAuthorityCheckpointError(
          result.status,
          result.status === 'authority_unavailable'
        )
      }
      const attribution = result.attribution
      if (
        result.authorizationRevision !== binding.authorizationRevision ||
        result.behaviorBindingHash !== binding.behaviorBindingHash ||
        attribution.userId !== binding.userId ||
        attribution.sid !== binding.sid ||
        attribution.sessionVersion !== binding.sessionVersion ||
        attribution.accessPathId !== binding.accessPathId ||
        attribution.pathKind !== binding.pathKind ||
        attribution.effectiveTeamId !== binding.effectiveTeamId ||
        result.destination !== null ||
        (result.validUntil !== null && Date.parse(result.validUntil) <= Date.now())
      ) {
        throw new WorkflowAuthorityCheckpointError('invalid_binding', false)
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new WorkflowAuthorityCheckpointError('timeout', true)
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
}
