/** Tone of the inline notice; each maps to an existing `cu-banner--*` modifier. */
export type DiscoverySyncNoticeTone = 'warn' | 'info'

/** A sync outcome the operator must act on, kept on screen until dismissed. */
export type DiscoverySyncNotice = {
  tone: DiscoverySyncNoticeTone
  message: string
}

export type DiscoverySyncDescription = {
  /** The transient success toast. */
  toast: string
  notice: DiscoverySyncNotice | null
}
