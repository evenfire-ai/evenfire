const localBuckets = new Map<string, number>()

// Unsafe: wrong service route, untrusted hostRef key, local storage, and admission after work.
export async function artifactRead(_req: any, _res: any): Promise<void> {
  await resolveAuthorizedHostConnection()
  localBuckets.set(_req.params.hostRef, Date.now())
  return
}

function resolveAuthorizedHostConnection(): Promise<void> {
  return Promise.resolve()
}
