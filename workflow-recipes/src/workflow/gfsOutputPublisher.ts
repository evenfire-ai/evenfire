import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import type { WorkflowConfig } from '@clerum/workflow-runtime-core'

export interface GfsPublishTarget {
  drive: string
  target: string
}

export interface GfsPublishWorkflowSpec {
  gfs?: {
    publishTargets?: GfsPublishTarget[]
  }
}

export interface GfsOutputPublisherDeps {
  env?: NodeJS.ProcessEnv
  fetchFn?: typeof fetch
  readFileFn?: typeof readFile
  sleepFn?: (ms: number) => Promise<void>
  /** True once the run has been cancelled; read after each retry wait. */
  isCancelled?: () => boolean
}

/**
 * The run was cancelled while the publisher waited out a 429's Retry-After, so
 * the retry was not sent. The caller reports the run as cancelled, not failed.
 */
export class GfsPublishCancelledError extends Error {
  constructor() {
    super('GFS output publish stopped: the workflow run was cancelled')
    this.name = 'GfsPublishCancelledError'
  }
}

interface AgentRetry {
  fetchFn: typeof fetch
  sleepFn: (ms: number) => Promise<void>
  isCancelled: () => boolean
}

const DEFAULT_GFSC_READER_BASE_URL = 'http://gfsc.gfs.svc.cluster.local:8087'
const DEFAULT_GFSC_WRITER_BASE_URL = 'http://gfsc-writer.gfs.svc.cluster.local:8087'
const RESOURCE_ID_RE = /^[a-fA-F0-9][a-fA-F0-9-]{30,40}[a-fA-F0-9]$/
const HEADER_NAME = 'authorization'
const HEADER_SCHEME = 'Bearer'
// gfsc's per-replica agent limiter answers before the permission store and
// the executor run, so a write it denied had no effect and sending it again
// is safe. Upload-quota 429s carry other scopes and are not retried.
const RETRYABLE_SCOPES = new Set(['agent_reads', 'agent_writes'])
const MAX_RETRY_AFTER_SECONDS = 60

export async function publishWorkflowOutputsToGfs(
  spec: GfsPublishWorkflowSpec,
  config: Pick<WorkflowConfig, 'workflowName'>,
  outputs: Record<string, unknown>,
  deps: GfsOutputPublisherDeps = {}
): Promise<void> {
  const targets = (spec.gfs?.publishTargets ?? []).filter(target =>
    Boolean(target.drive?.trim() && target.target?.trim())
  )
  if (targets.length === 0) return

  const env = deps.env ?? process.env
  const fetchFn = deps.fetchFn ?? fetch
  const readFileFn = deps.readFileFn ?? readFile
  const sleepFn = deps.sleepFn ?? ((ms: number) => delay(ms))
  const retry: AgentRetry = { fetchFn, sleepFn, isCancelled: deps.isCancelled ?? (() => false) }
  const accessFile = env.GFS_ACCESS_FILE?.trim()
  if (!accessFile) {
    throw new Error('GFS_ACCESS_FILE is required when spec.gfs.publishTargets is configured')
  }
  const accessValue = (await readFileFn(accessFile, 'utf8')).trim()
  if (!accessValue) {
    throw new Error('GFS_ACCESS_FILE is empty')
  }

  const workflowRunId = env.CLERUM_WORKFLOW_RUN_ID?.trim() || null
  const name = outputFileName(config.workflowName, workflowRunId)
  const content = JSON.stringify(
    {
      workflowName: config.workflowName,
      workflowRunId,
      outputs,
    },
    null,
    2
  )

  for (const target of targets) {
    const parentId = await resolvePublishParent(target, accessValue, retry, env)
    const url = `${baseUrl(env.CLERUM_GFSC_WRITER_BASE_URL, DEFAULT_GFSC_WRITER_BASE_URL)}/v1/resources/${encodeURIComponent(parentId)}/children`
    const response = await fetchWithAgentRetry(
      url,
      {
        method: 'POST',
        headers: {
          [HEADER_NAME]: `${HEADER_SCHEME} ${accessValue}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name, kind: 'file', content }),
      },
      retry
    )
    if (!response.ok) {
      throw new Error(
        `GFS output publish failed: HTTP ${response.status} ${await responseText(response)}`
      )
    }
  }
}

async function resolvePublishParent(
  target: GfsPublishTarget,
  accessValue: string,
  retry: AgentRetry,
  env: NodeJS.ProcessEnv
): Promise<string> {
  const rawTarget = target.target.trim()
  if (RESOURCE_ID_RE.test(rawTarget)) return rawTarget
  if (!rawTarget.startsWith('gfs://')) {
    throw new Error(`unsupported GFS publish target: ${rawTarget}`)
  }

  const response = await fetchWithAgentRetry(
    `${baseUrl(env.CLERUM_GFSC_BASE_URL, DEFAULT_GFSC_READER_BASE_URL)}/v1/resolve?uri=${encodeURIComponent(rawTarget)}`,
    { headers: { [HEADER_NAME]: `${HEADER_SCHEME} ${accessValue}` } },
    retry
  )
  if (!response.ok) {
    throw new Error(
      `GFS output target resolve failed: HTTP ${response.status} ${await responseText(response)}`
    )
  }
  const payload = (await response.json()) as { data?: { resourceId?: string; rid?: string } }
  const resourceId = payload.data?.resourceId ?? payload.data?.rid
  if (!resourceId) throw new Error('GFS output target resolve returned no resourceId')
  return resourceId
}

/**
 * Sends the request, and once more after an agent-limiter 429 that states a
 * delay of at most MAX_RETRY_AFTER_SECONDS. A second denial is returned for the
 * caller to fail with its status. A cancel that arrives during the wait stops
 * the retry: the run is over, and the wait can last up to a minute.
 */
async function fetchWithAgentRetry(
  url: string,
  init: RequestInit,
  retry: AgentRetry
): Promise<Response> {
  const response = await retry.fetchFn(url, init)
  const retryAfterSeconds = agentRetryAfterSeconds(response)
  if (retryAfterSeconds === undefined) return response
  await response.body?.cancel()
  await retry.sleepFn(retryAfterSeconds * 1000)
  if (retry.isCancelled()) throw new GfsPublishCancelledError()
  return retry.fetchFn(url, init)
}

/** The Retry-After of a retryable agent-limiter 429, in seconds; undefined otherwise. */
function agentRetryAfterSeconds(response: Response): number | undefined {
  if (response.status !== 429) return undefined
  if (!RETRYABLE_SCOPES.has(response.headers.get('x-gfs-ratelimit-scope') ?? '')) return undefined
  const retryAfter = response.headers.get('retry-after') ?? ''
  if (!/^[1-9][0-9]?$/.test(retryAfter)) return undefined
  const seconds = Number(retryAfter)
  return seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : undefined
}

function outputFileName(workflowName: string, workflowRunId: string | null): string {
  const suffix = workflowRunId || workflowName || 'workflow'
  return `workflow-output-${suffix}.json`
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180)
}

function baseUrl(value: string | undefined, fallback: string): string {
  return (value?.trim() || fallback).replace(/\/+$/g, '')
}

async function responseText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300)
  } catch {
    return ''
  }
}
