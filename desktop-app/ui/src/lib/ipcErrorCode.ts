import { stripIpcWrapper } from './gfsGrantErrors'

/**
 * The code a main-process refusal carries, when it is one of `codes`; otherwise null.
 *
 * Main refuses with `new Error('<code>')`, which reaches the renderer bare or as Electron wraps
 * it: `Error invoking remote method '<channel>': Error: <code>`. Once that wrapper is stripped,
 * the message must equal a code. A longer message that contains one is not that code.
 */
export function ipcErrorCode<T extends string>(error: unknown, codes: readonly T[]): T | null {
  const message = stripIpcWrapper(error instanceof Error ? error.message : String(error))
  return codes.find(code => code === message) ?? null
}
