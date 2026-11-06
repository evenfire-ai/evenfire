/**
 * ZIP budget constants shared by the renderer walk and the main-process
 * writer. Pure TS with no Electron import, so the renderer bundle can import
 * it without dragging the main process in.
 *
 * The main process enforces the SAME ceilings the renderer does. A renderer
 * limit alone is a suggestion: without a matching limit in the main process,
 * a sequence of individually valid appends bypasses the ceiling and grows the
 * temp file without bound (R3-M2).
 */

/**
 * The aggregate payload ceiling for one archive, in bytes. The renderer
 * refuses a folder over this at planning time; the main process refuses an
 * archive over this at append time.
 */
export const ZIP_MAX_TOTAL_BYTES = 512 * 1024 * 1024

/** The aggregate entry ceiling for one archive (files AND folders). */
export const ZIP_MAX_ENTRIES = 2000

/**
 * ZIP32 stores the entry count in a 16-bit field of the end-of-central-
 * directory record, so an archive can hold at most 65535 entries.
 */
export const ZIP32_MAX_ENTRIES = 0xffff

/**
 * ZIP32 stores sizes and offsets in 32-bit fields, so an archive can hold at
 * most 4 GiB − 1 bytes.
 */
export const ZIP32_MAX_BYTES = 0xffffffff

/**
 * A ZIP name field is a 16-bit BYTE count, so an entry's full encoded path
 * must stay strictly under this value.
 */
export const MAX_ZIP_ENTRY_NAME_BYTES = 65535
