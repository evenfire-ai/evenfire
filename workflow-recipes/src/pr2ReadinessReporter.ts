import { createLogger } from './observability/logger'
import { signInternalControlJwt } from './utils/internalControlSigner'

const DEFAULT_CONTROL_API_BASE_URL = 'http://control-api.control-plane.svc.cluster.local:8090'
const log = createLogger('wrc', 'pr2-readiness-reporter')

export function startPr2ReadinessReporter(fetchImpl: typeof fetch = fetch): () => void {
  const sourceRevision = process.env.EVENFIRE_SOURCE_REVISION?.trim() ?? ''
  const environmentId = process.env.PR2_READINESS_ENVIRONMENT_ID?.trim() ?? ''
  const serviceVersion = process.env.EVENFIRE_SERVICE_VERSION?.trim() ?? ''
  const deploymentRevision = process.env.EVENFIRE_DEPLOYMENT_REVISION?.trim() ?? ''
  const imageRevision = process.env.EVENFIRE_IMAGE_REVISION?.trim() ?? ''
  const intervalMs = Number(process.env.PR2_READINESS_REPORT_INTERVAL_MS)
  if (
    !/^[0-9a-f]{40}$/.test(sourceRevision) ||
    !environmentId ||
    !serviceVersion ||
    !deploymentRevision ||
    imageRevision !== sourceRevision ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1_000
  )
    return () => undefined
  const baseUrl = (process.env.CONTROL_API_BASE_URL || DEFAULT_CONTROL_API_BASE_URL).replace(
    /\/+$/,
    ''
  )
  const report = async () => {
    const response = await fetchImpl(`${baseUrl}/api/v1/internal/pr2-readiness/runtime-evidence`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signInternalControlJwt()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        version: 1,
        environmentId,
        sourceRevision,
        hop: 'workflow_recipes_checkpoint',
        evidenceClass: 'runtime',
        evidenceKind: 'service_runtime',
        writer: 'workflow-recipes',
        evidenceReference: `runtime:workflow-recipes:${sourceRevision}`,
        outcome: 'passed',
        serviceVersion,
        contractVersion: 'pr2-readiness-v1',
        deploymentRevision,
        imageRevision,
        observedAt: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) throw new Error(`readiness evidence rejected (${response.status})`)
  }
  const run = () =>
    void report().catch(error => {
      log.warn('readiness evidence unavailable', {
        error: error instanceof Error ? error.message : 'unknown',
      })
    })
  run()
  const timer = setInterval(run, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
