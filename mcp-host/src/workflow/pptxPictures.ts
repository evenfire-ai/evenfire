/** Pictures placed in a box, keeping their proportions. */
import { fitImageSize } from './embeddedImages'
import { type PptxPicture } from './pptxInput'
import { type Box } from './pptxLayout'
import { type Slide } from './pptxRuns'

/**
 * A picture drawn to fill its space is shown at most this much larger than its
 * pixels at 96 dpi, or it blurs.
 */
const MAX_UPSCALE = 2
const PIXELS_PER_INCH = 96

/** Where a small picture is reported, and whether its field takes a width. */
interface PictureReport {
  where: string
  sized: boolean
  warnings: string[]
}

/**
 * Box for `image` inside `area`, at the image's own proportions. Without a
 * requested size it fills the area, up to MAX_UPSCALE times its own size.
 */
export function placePicture(
  picture: { image: PptxPicture['image']; width?: number; height?: number },
  area: Box,
  align: 'center' | 'top-left' = 'center',
  report?: PictureReport
): Box {
  // fitImageSize rounds to whole units; thousandths of an inch keep the ratio exact enough.
  const unit = 1000
  const { width, height, image } = picture
  let requested: { width?: number; height?: number } = {
    width: area.w * unit,
    height: area.h * unit,
  }
  if (width || height) {
    requested = { width: width && width * unit, height: height && height * unit }
  } else {
    // Sharpness depends on the pixels stored, not on the density the file declares.
    const { pixels } = image
    const most = {
      w: (pixels.width / PIXELS_PER_INCH) * MAX_UPSCALE,
      h: (pixels.height / PIXELS_PER_INCH) * MAX_UPSCALE,
    }
    if (most.w < area.w && most.h < area.h) {
      requested = { width: most.w * unit, height: most.h * unit }
      report?.warnings.push(
        `${report.where}: the image is ${pixels.width}×${pixels.height} pixels, so it is shown at ` +
          `${most.w.toFixed(1)}×${most.h.toFixed(1)} in rather than blurred to fill its space. ` +
          `Send a larger image${report.sized ? ', or set width to enlarge it anyway' : ''}.`
      )
    }
  }
  const size = fitImageSize(
    { width: image.width, height: image.height },
    { width: area.w * unit, height: area.h * unit },
    requested
  )
  const w = size.width / unit
  const h = size.height / unit
  return align === 'top-left'
    ? { x: area.x, y: area.y, w, h }
    : { x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h }
}

export function addPicture(
  slide: Slide,
  image: PptxPicture['image'],
  box: Box,
  altText = ''
): void {
  slide.addImage({
    data: `image/${image.format};base64,${image.data.toString('base64')}`,
    ...box,
    altText,
  })
}
