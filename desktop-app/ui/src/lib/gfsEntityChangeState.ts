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
