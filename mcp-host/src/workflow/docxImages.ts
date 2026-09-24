import { AlignmentType, ImageRun, Paragraph } from 'docx'
import * as path from 'path'
import { type ImageSize, fitImageSize, loadEmbeddableImage } from './embeddedImages'

export interface DocxImagePlacement {
  /** Requested size in pixels; the image keeps its proportions and fits the box. */
  width?: number
  height?: number
  alignment?: unknown
  altText?: string
  spacing?: { before?: number; after?: number }
}

function alignmentOf(value: unknown) {
  if (value === 'center') return AlignmentType.CENTER
  if (value === 'right') return AlignmentType.RIGHT
  return AlignmentType.LEFT
}

/**
 * A paragraph holding the image `ref` names, fitted to `box`, or undefined when
 * it cannot be embedded; the reason is added to `warnings`, prefixed with the
 * argument `label` so the logo and an image of the same name can be told apart.
 * A path that leaves the output folder still fails the call, with an error
 * naming the argument and the fix.
 */
export function docxImageParagraph(
  ref: unknown,
  outputDir: string,
  box: ImageSize,
  placement: DocxImagePlacement,
  warnings: string[],
  label: string
): Paragraph | undefined {
  const notes: string[] = []
  let image: ReturnType<typeof loadEmbeddableImage>
  try {
    image = loadEmbeddableImage(ref, outputDir, notes, label)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!message.startsWith('path traversal blocked')) throw err
    throw new Error(
      `${label}: ${message}. Pass the file name in the output folder, such as the ` +
        "'sales.png' clerum__generate_chart returns, not a path.",
      { cause: err }
    )
  }
  warnings.push(...notes.map(note => (note.startsWith(label) ? note : `${label}: ${note}`)))
  if (!image) return undefined
  const size = fitImageSize(image, box, { width: placement.width, height: placement.height })
  return new Paragraph({
    alignment: alignmentOf(placement.alignment),
    spacing: placement.spacing,
    children: [
      new ImageRun({
        type: image.format === 'png' ? 'png' : 'jpg',
        data: image.data,
        transformation: size,
        altText: {
          name: path.basename(image.path),
          ...(placement.altText ? { description: placement.altText } : {}),
        },
      }),
    ],
  })
}
