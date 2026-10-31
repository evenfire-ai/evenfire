import type { Page } from '@playwright/test'

export declare const DESKTOP_DIAGNOSTIC_PATTERNS: readonly RegExp[]
export declare const CAPTURE_ANNOTATION: string
export function filterDesktopDiagnostics(lines: readonly string[]): string[]
export function createMainOutputBuffer(limit: number): {
  push(chunk: string): void
  flush(): void
  lines(): string[]
}
export function firstDiagnosticLine(lines: readonly string[]): string | undefined
export function formatDiagnosticsAttachment(matched: readonly string[]): string
export function attachOrAnnotate(
  attach: () => Promise<void>,
  annotate: (type: string, description: string) => void | Promise<void>,
  label?: string
): Promise<Error | null>

export declare const ARIA_REDACTION_MARKER: string
export function redactAriaSnapshot(yaml: string): { yaml: string; redacted: number }

export declare const INPUT_TAMPERED: string
export type UntamperedFields = Record<string, { expected: string; actual: string }>
export function assertUntamperedInputs(fields: UntamperedFields): number

export declare const LOGIN_REFUSED: string
export function loginRefusedMessage(
  toastText: string | null | undefined,
  diagnosticLines?: readonly string[]
): string

export declare const SIGN_IN_RESULT_TIMEOUT_MS: number
export declare const SIGN_IN_LAUNCH_BUDGET_MS: number
export declare const SIGN_IN_PACE_BUDGET_MS: number
export declare const C12_TEARDOWN_BUDGET_MS: number
export declare const C12_SIGN_IN_BUDGET_MS: number
export function c12TestBudgetMs(input: {
  capNoticeMaxMs: number
  turnTimeoutMs: number
  outcomeBudgetMs?: number
}): number

export declare const RETRY_LAYER: {
  readonly postRejected: string
  readonly noOutcome: string
  readonly claimed: string
  readonly noContinuation: string
  readonly noReply: string
}
export declare const RETRY_OUTCOME_BUDGET_MS: number
export declare const RETRY_OUTCOME_POLL_MS: number
export declare const RETRY_STAGE_POLL_MS: number
export function retryPostRejectedMessage(diagnosticLine: string | undefined): string

export type RetryCheckpoint = {
  status: string
  continuationTaskId?: string
  [key: string]: unknown
}
export type RetryModelStepOptions = {
  /** How the button is clicked; C4 passes a double click. */
  click?: (locator: import('@playwright/test').Locator) => Promise<void>
  readCheckpoint: () => Promise<RetryCheckpoint | undefined | null>
  readStages: () => Promise<string[]>
  firstContinuationStage: string
  diagnosticLines: () => readonly string[]
  outcomeBudgetMs?: number
  outcomePollMs?: number
  stageBudgetMs: number
  stagePollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}
export function awaitContinuationStage(options: {
  readStages: () => Promise<string[]>
  baselineLength: number
  stage: string
  budgetMs: number
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<string[]>
export function clickRetryModelStep(
  page: Page,
  options: RetryModelStepOptions
): Promise<{
  layer: string
  status: string
  continuationTaskId?: string
  stagesSinceClick: string[]
}>
