/** Test-only image containers. Not part of the production contract surface. */

export declare const PNG_SIGNATURE: Buffer

export declare function pngChunk(type: string, data: Buffer): Buffer
export declare function pngHeader(width: number, height: number): Buffer
export declare function realPng(width: number, height: number, seed: number): Buffer
export declare function declaredHeaderPng(width: number, height: number): Buffer
export declare function declaredHeaderPngOfSize(targetBytes: number): Buffer
export declare function realPngOfSize(
  targetBytes: number,
  width: number,
  height: number,
  seed: number
): Buffer
export declare function padPngToSize(png: Buffer | string, targetBytes: number): Buffer
export declare function jpegOfSize(targetBytes: number, width?: number, height?: number): Buffer
