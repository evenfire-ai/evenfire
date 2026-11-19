/**
 * Limits on the chat's Mermaid diagrams, shared by the chat and the main
 * process. Pure TS with no Electron import, so the renderer bundle can import
 * it without dragging the main process in.
 *
 * The main process enforces the same limits the chat does. Raised on one side
 * only, a limit would turn diagrams the chat accepts into requests the main
 * process refuses.
 */

/**
 * Longer code stays a code block. A chat diagram of about 25 shapes needs some
 * 2,000 characters.
 */
export const DIAGRAM_MAX_CODE_CHARS = 20_000

/** Layout widths the main process accepts; a message outside them is drawn at the nearest. */
export const DIAGRAM_MIN_WIDTH_PX = 100
export const DIAGRAM_MAX_WIDTH_PX = 4_000

/**
 * The largest drawing returned, as its data URL. A 20,000-character diagram
 * comes to about 3 MB at most; one of 25 shapes to 40 to 65 KB.
 */
export const DIAGRAM_MAX_IMAGE_URL_CHARS = 4 * 1024 * 1024

/** The longest side a drawing may have, in CSS pixels. */
export const DIAGRAM_MAX_IMAGE_SIDE_PX = 100_000
