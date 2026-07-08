import type { RuntimeTokenProvider } from '../runtime-token-provider/provider'
import { requireRuntimeToken } from '../runtime-token-provider/provider'
import { sendWithAuthRetryOn401 } from '../status-reporter/authRetry'
import { emitLog } from '../status-reporter/logger'

export interface ModelInjectionRequest {
  stepId: string
  provider: 'openai' | 'claude' | 'zai' | 'bailian'
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
}
