export declare const ADMISSION_PACE_MS: number
export declare const SOURCE_ATTEMPTS_PER_MINUTE: number
export declare const PACE_MARGIN_MS: number
export declare const SOURCE_WINDOW_MS: number
export declare const RETAINED_SOURCE_ATTEMPTS: number
export declare const LOGIN_LEDGER_FILE: string

export type LoginSurface = 'desktop' | 'control-ui'
export type LoginLedgerEntry = { at: number; surface: LoginSurface; inputChecks: number }

export function loginLedgerRootFromEnv(env?: Record<string, string | undefined>): string | null
export function loginLedgerPath(root: string): string
export function readLoginLedger(root: string | null): LoginLedgerEntry[]
export function waitMsForLoginPace(entries: readonly LoginLedgerEntry[], now?: number): number
export function waitForLoginPace(
  root: string | null,
  options?: { now?: () => number; sleep?: (ms: number) => Promise<void> }
): Promise<{ waitedMs: number; paced: boolean }>
export function recordPasswordLogin(
  root: string | null,
  record: { surface: LoginSurface; inputChecks: number; at?: number }
): LoginLedgerEntry | null
