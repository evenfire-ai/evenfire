export type FileClass =
  | 'text'
  | 'markdown'
  | 'html'
  | 'code'
  | 'svg'
  | 'jpeg'
  | 'png'
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'binary_unsupported'

export type FileClassFamily = 'text' | 'image' | 'document_binary' | 'binary_unsupported'

export type FileDetection = 'magic' | 'text_utf8' | 'declared'

/** The reader the Host uses for a class: UTF-8 text, a document reader, or none. */
export type FileReader = 'text' | 'pdf' | 'xlsx' | 'none'

export interface FileClassification {
  class: FileClass
  detectedMediaType: string
  detection: FileDetection
  textReadable: boolean
  reader: FileReader
  modelImageInput: 'candidate' | 'unsupported'
  /** The detected family differs from the one the declared media type or the extension implies. */
  mismatch: boolean
}

export declare const FILE_CLASSES: readonly FileClass[]
export declare const MEDIA_TYPE_BY_CLASS: Readonly<Record<FileClass, string>>

/**
 * Classify a file by its bytes. `bytes` is the whole file or a prefix of it;
 * `totalByteLength` is the size of the whole file.
 *
 * `detection: 'declared'` is returned only for a prefix shorter than 64 KiB
 * (including an empty one) that carries no signature and no evidence against
 * the declared media type or extension. Every other result is decided by the
 * bytes, and the declared type only breaks ties inside the text family.
 */
export declare function classifyBytes(input: {
  bytes: Uint8Array
  totalByteLength: number
  declaredMediaType?: string | null
  filename?: string | null
}): FileClassification

export declare function fileClassFamily(fileClass: FileClass): FileClassFamily
