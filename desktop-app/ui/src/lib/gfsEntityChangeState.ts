import { parseHttpStatus } from './gfsGrantErrors'

/**
 * Return only a transport-vetted status attached by the main-process GFS client.
 * Error prose can contain arbitrary upstream status numbers and is not an
 * authorization or deletion signal.
 */
export function authoritativeGfsStatus(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return parseHttpStatus(message) ?? undefined
}

/** Keep long-lived per-resource write affordances out of periodic content refreshes. */
export function shouldRevalidateGfsQuery(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === 'desktop-app' && queryKey[1] === 'gfs' && queryKey[3] !== 'affordances'
}
