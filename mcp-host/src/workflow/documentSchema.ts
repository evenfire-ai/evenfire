/**
 * Limits and argument descriptions the PDF and DOCX tool schemas share with
 * their generators, kept apart so the schemas load neither generator.
 */

/** Footer lines that fit once the bottom margin has grown to hold them. */
export const PDF_MAX_FOOTER_LINES = 6

/** Where images come from, for the schema: the name clerum__generate_chart reports. */
export const IMAGE_FILE_DESCRIPTION =
  "File name of a PNG or JPEG (GIF, WebP and SVG are converted) in the output folder, as returned by clerum__generate_chart, e.g. 'sales.png'."

export const DOCX_IMAGE_FILE_DESCRIPTION =
  "File name in the output folder, as returned by clerum__generate_chart (e.g. 'sales.png'). " +
  'PNG, JPEG, GIF, WebP or SVG.'
