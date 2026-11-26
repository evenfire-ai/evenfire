/**
 * What a log line may say about an error: its class, never its message. A message may carry a
 * link, a URL or a token (D18).
 */
export function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}
