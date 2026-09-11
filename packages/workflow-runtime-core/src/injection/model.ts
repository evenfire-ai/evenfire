import { PROVIDER_AUTH_MODE, isLlmProviderId, type LlmProviderId } from '@clerum/llm-providers'
import type { RuntimeTokenProvider } from '../runtime-token-provider/provider'
import { requireRuntimeToken } from '../runtime-token-provider/provider'
import { sendWithAuthRetryOn401 } from '../status-reporter/authRetry'
import { emitLog } from '../status-reporter/logger'

export interface ModelInjectionRequest {
  stepId: string
  provider: LlmProviderId
  model: string
}

async function postModelInjectionWithTimeout(
  url: string,
  tokenProvider: RuntimeTokenProvider,
  req: ModelInjectionRequest
): Promise<Response> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 10_000)
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await requireRuntimeToken(
          tokenProvider,
          'getWrcToken',
          'WRC_TOKEN_FILE'
        )}`,
      },
      body: JSON.stringify(req),
      signal: ac.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

export async function requestModelInjection(
  wrcUrl: string,
  workflowName: string,
  tokenProvider: RuntimeTokenProvider,
  req: ModelInjectionRequest
): Promise<void> {
  const url = `${wrcUrl}/api/v1/workflow/${encodeURIComponent(workflowName)}/injections/model`
  const resp = await sendWithAuthRetryOn401(
    () => postModelInjectionWithTimeout(url, tokenProvider, req),
    'model injection'
  )
  if (!resp.ok) {
    const msg = `Model injection failed: ${resp.status} ${resp.statusText}`
    emitLog('error', msg, { stepId: req.stepId })
    throw new Error(msg)
  }
  let payload: Record<string, unknown> = {}
  try {
    const parsed: unknown = await resp.json()
    if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>
  } catch {
    payload = {}
  }
  if (
    isLlmProviderId(req.provider) &&
    PROVIDER_AUTH_MODE[req.provider] === 'oauth-broker' &&
    payload.grantRedeemable !== true
  ) {
    const msg = 'Model injection refused: Codex grant is not redeemable'
    emitLog('error', msg, { stepId: req.stepId })
    throw new Error(msg)
  }
}
