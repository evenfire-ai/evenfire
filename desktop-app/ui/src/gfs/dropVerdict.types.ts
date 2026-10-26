/** Presentation tones (matrix §5.2): deny=error, no-op=info, unknown=warn. */
export type GfsDropFeedbackTone = 'error' | 'info' | 'warn'

/** Sanitized display names the reason sentences interpolate. */
export interface GfsDropReasonNames {
  source: string
  target: string
}

/** The drop-time presentation of a refused move (message + tone). */
export interface GfsDropRefusalPresentation {
  message: string
  tone: GfsDropFeedbackTone
}
