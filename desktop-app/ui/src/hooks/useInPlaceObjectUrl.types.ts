export type InPlaceObjectUrl = {
  /** The object URL loaded for the current source, or null while none is loaded. */
  url: string | null
  /** The blob behind `url`. */
  blob: Blob | null
  /** Create an object URL for `blob` loaded from `source` and make it current. */
  publish: (source: string, blob: Blob) => void
  /** Drop the loaded content; its URL is revoked once it leaves the screen. */
  discard: () => void
  /** Whether content from `source` is loaded (readable from async callbacks). */
  hasContentFor: (source: string | null) => boolean
}
