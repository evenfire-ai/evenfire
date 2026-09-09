export function startPr2ReadinessReporter(input: {
  baseUrl: string
  serviceToken: string
  fetchImpl?: typeof fetch
}): () => void {
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
    const response = await (input.fetchImpl ?? fetch)(
      `${input.baseUrl.replace(/\/+$/, '')}/api/v1/internal/pr2-readiness/runtime-evidence`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.serviceToken}`,
          'content-type': 'application/json',
          'x-service-token': 'gfs-controller',
        },
        body: JSON.stringify({
          version: 1,
          environmentId,
          sourceRevision,
          hop: 'gfs_controller_checkpoint',
          evidenceClass: 'runtime',
          evidenceKind: 'service_runtime',
          writer: 'gfs-controller',
          evidenceReference: `runtime:gfs-controller:${sourceRevision}`,
          outcome: 'passed',
          serviceVersion,
          contractVersion: 'pr2-readiness-v1',
          deploymentRevision,
          imageRevision,
          observedAt: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(5_000),
      }
    )
    if (!response.ok) throw new Error(`readiness evidence rejected (${response.status})`)
  }
  const run = () => void report().catch(() => undefined)
  run()
  const timer = setInterval(run, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
