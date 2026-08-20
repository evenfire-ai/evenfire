import type { SVGProps } from 'react'

export type GfsFileIconProps = {
  name: string
} & (
  | {
      /**
       * Provide `bytes` + `rid` to render an inline image thumbnail
       * (still shown as a 24×24 square, just painted with the actual
       * image bytes instead of the image glyph). Missing either field
       * falls back to the static image glyph.
       */
      bytes: number
      rid: string
    }
  | {
      bytes?: never
      rid?: never
    }
) &
  SVGProps<SVGSVGElement>
