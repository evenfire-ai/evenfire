export type GfsCopyToast = (message: string, tone: 'success' | 'error') => void

export interface GfsCopyToastOptions {
  /** Error copy for surfaces that word the failure differently. */
  formatError?: (error: unknown) => string
}
