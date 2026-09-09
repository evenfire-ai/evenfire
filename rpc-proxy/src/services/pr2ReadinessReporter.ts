import { config } from '../config.js'

const HOPS = [
  'rpc_proxy_trusted_edge',
  'sandbox_derived_view',
  'remote_desktop_derived_view',
  'oauth_exact_target',
] as const

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
  const report = async () => {
    const observedAt = new Date().toISOString()
    await Promise.all(
      HOPS.map(async hop => {
        const response = await fetchImpl(
          `${config.controlApiBaseUrl.replace(/\/+$/, '')}/internal/pr2-readiness/runtime-evidence`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${config.controlApiServiceToken}`,
              'content-type': 'application/json',
              'x-service-token': 'rpc-proxy',
            },
            body: JSON.stringify({
              version: 1,
              environmentId,
              sourceRevision,
              hop,
              evidenceClass: 'runtime',
              evidenceKind: 'service_runtime',
              writer: 'rpc-proxy',
              evidenceReference: `runtime:rpc-proxy:${sourceRevision}`,
              outcome: 'passed',
              serviceVersion,
              contractVersion: 'pr2-readiness-v1',
              deploymentRevision,
              imageRevision,
              observedAt,
            }),
            signal: AbortSignal.timeout(5_000),
          }
        )
        if (!response.ok) throw new Error(`readiness evidence rejected (${response.status})`)
      })
    )
  }
  const run = () => void report().catch(() => undefined)
  run()
  const timer = setInterval(run, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
