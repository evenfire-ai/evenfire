/**
 * #656 / #1093 — the shared contract of `clerum__document_read`.
 *
 * Three parties code against this file and nothing else:
 *   - `index.ts` (the Tool): attachment lookup and access, the turn's read
 *     ledger, output measurement, redaction, and the image attachments of the
 *     visual mode;
 *   - the worker (`worker.ts`, run by `workerRunner.ts`): parses and renders in
 *     an isolated child process with heap and resident-memory caps and a hard
 *     kill, using `pdf*.ts` for PDF and `xlsx*.ts` for XLSX;
 *   - the tests.
 *
 * Document text is untrusted content, never instructions, and never reaches a
 * log: no type here carries a field meant for logging.
 */

export const DOCUMENT_READ_TOOL_NAME = 'clerum__document_read'

export type DocumentFormat = 'pdf' | 'xlsx'
export type DocumentReadMode = 'text' | 'visual'

// ─── Tool input ─────────────────────────────────────────────

/**
 * The validated tool input. `pages` and `mode` apply to PDF only, `sheet` to
 * XLSX only; passing one to the other format is `invalid_range`.
 */
export interface DocumentReadParams {
  attachmentId: string
  /** Default `text`. */
  mode?: DocumentReadMode
  /** 1-based page list, e.g. `"1-3,5"`. Default: every page. */
  pages?: string
  /** Exact sheet name. Default: every sheet in workbook order. */
  sheet?: string
  /** The `continuation.cursor` of a previous result for the same attachment. */
  cursor?: string
}

// ─── Tool result (serialized to the model) ──────────────────

/**
 * Why a read stopped before the end of its selection. `page_budget` and
 * `turn_budget` come from the turn's read ledger; the others from the
 * per-call limits.
 */
export type DocumentReadLimit =
  | 'page_budget'
  | 'turn_budget'
  | 'max_pages'
  | 'max_extracted_chars'
  | 'max_rows'
  | 'max_cells'

export interface DocumentContinuation {
  /** Opaque to the model; see `encodeCursor`. */
  cursor: string
  limit: DocumentReadLimit
}

export interface PdfTextPage {
  page: number
  text: string
}

export interface PdfImageInfo {
  page: number
  width: number
  height: number
}

export type XlsxCellValue = string | number | boolean | null

export interface XlsxSheetResult {
  name: string
  /** 1-based worksheet row number of `rows[0]`. */
  startRow: number
  /**
   * Contiguous: `rows[i]` is worksheet row `startRow + i`, and an empty row
   * inside the returned range is `[]`. Cursors depend on this.
   */
  rows: XlsxCellValue[][]
  /** True when rows of this sheet remain after the last returned one. */
  truncated: boolean
}

export type DocumentReadReason =
  | 'no_text_layer'
  | 'document_encrypted'
  | 'document_parse_failed'
  | 'document_empty'
  | 'document_limits_exceeded'
  | 'invalid_range'
  | 'visual_not_supported'
  | 'host_memory_unavailable'

/** Which bound a `document_limits_exceeded` hit. */
export type DocumentLimitName =
  | 'source_bytes'
  | 'uncompressed_bytes'
  | 'page_count'
  | 'pixels'
  | 'image_bytes'
  | 'output_bytes'
  | 'time'
  | 'heap'

// Key order is part of the contract, as in `clerum__attachment_read`: status,
// format and paging fields first, content last, so a reader of the start of
// the serialized result still sees `continuation`.
export type DocumentReadResult =
  | {
      status: 'ok'
      attachmentId: string
      referenceId: string
      format: 'pdf'
      mode: 'text'
      pageCount: number
      continuation?: DocumentContinuation
      /**
       * Returned pages whose text layer holds fewer than
       * `minTextCharsPerPage` characters; only present when the current model
       * accepts images, capped at the current visual call/delivery capacity,
       * so the model can read them again with `mode: 'visual'`.
       */
      visualCandidates?: number[]
      pages: PdfTextPage[]
    }
  | {
      status: 'ok'
      attachmentId: string
      referenceId: string
      format: 'pdf'
      mode: 'visual'
      pageCount: number
      continuation?: DocumentContinuation
      /** The rendered pages; their PNGs travel as typed image attachments. */
      images: PdfImageInfo[]
    }
  | {
      status: 'ok'
      attachmentId: string
      referenceId: string
      format: 'xlsx'
      sheetNames: string[]
      continuation?: DocumentContinuation
      sheets: XlsxSheetResult[]
    }
  | {
      status: 'error'
      attachmentId: string
      referenceId?: string
      reason: DocumentReadReason
      limit?: DocumentLimitName
      message: string
    }
  | {
      /**
       * The turn's attachment read budget (shared with
       * `clerum__attachment_read`) cannot hold any part of the next page.
       * `resumeCursor` is the cursor the call was made with, if any.
       */
      status: 'read_budget_exhausted'
      attachmentId: string
      referenceId?: string
      resumeCursor?: string
      message: string
    }

// ─── Limits ─────────────────────────────────────────────────

export interface DocumentReadLimits {
  /**
   * Source file bytes. The default is the ceiling of the inline attachment
   * cap (`CLERUM_ATTACHMENT_FILE_MAX_BYTES`, at most 11 MiB); chat admission
   * already rejects larger files, and this bound holds for any other producer.
   */
  maxSourceBytes: number
  /** Maximum declared uncompressed bytes of any ZIP entry and of their sum. */
  maxUncompressedBytes: number
  /** Pages a document may have at all. */
  maxPageCount: number
  /** Pages one text call returns. */
  maxTextPagesPerCall: number
  /** Characters one text call extracts, before the ledger fit. */
  maxExtractedChars: number
  /** A page below this many non-whitespace characters is a visual candidate. */
  minTextCharsPerPage: number
  /** Pages one visual call renders. */
  maxVisualPagesPerCall: number
  /** Longest rendered side, before the model's own `maxDimension`. */
  maxRenderDimension: number
  /** Pixels shared by every page of one visual call. */
  maxRenderPixelsPerCall: number
  /** Embedded bitmap decode ceiling, independent of rendered output pixels. */
  maxEmbeddedImagePixels: number
  /** Encoded PNG bytes of one rendered page. */
  maxImageBytes: number
  /** Rows one XLSX call returns, across sheets. */
  maxRowsPerCall: number
  /** Cells one XLSX call returns, across sheets. */
  maxCellsPerCall: number
  /** Characters of one cell value; longer values are cut and end with `…`. */
  maxCellChars: number
  /** Serialized outcome bytes, checked inside the child before IPC. */
  maxOutputBytes: number
  /** Wall time of one child job; on expiry the parent kills it. */
  timeoutMs: number
  /** Configured child heap in MiB, narrowed by measured Linux cgroup headroom. */
  maxHeapMb: number
  /** Configured child RSS in MiB; child and cgroup use a 25 ms sample fence. */
  maxResidentMb: number
}

export const DEFAULT_DOCUMENT_READ_LIMITS: Readonly<DocumentReadLimits> = Object.freeze({
  maxSourceBytes: 11_534_336,
  maxUncompressedBytes: 134_217_728,
  maxPageCount: 2_000,
  maxTextPagesPerCall: 50,
  maxExtractedChars: 400_000,
  minTextCharsPerPage: 16,
  maxVisualPagesPerCall: 4,
  maxRenderDimension: 2_048,
  maxRenderPixelsPerCall: 8_000_000,
  maxEmbeddedImagePixels: 40_000_000,
  maxImageBytes: 5_242_880,
  maxRowsPerCall: 5_000,
  maxCellsPerCall: 100_000,
  maxCellChars: 2_000,
  maxOutputBytes: 33_554_432,
  timeoutMs: 30_000,
  maxHeapMb: 512,
  maxResidentMb: 768,
})

// ─── Cursors ────────────────────────────────────────────────

/** Where a PDF text read resumes: page, then UTF-16 offset into its text. */
export interface PdfTextPosition {
  page: number
  charOffset: number
}

/** Where an XLSX read resumes: workbook sheet index, then worksheet row. */
export interface XlsxPosition {
  sheetIndex: number
  row: number
}

export type DocumentPosition =
  | ({ format: 'pdf' } & PdfTextPosition)
  | ({ format: 'xlsx' } & XlsxPosition)

// ─── Worker protocol ────────────────────────────────────────

/**
 * `pages` is the raw `pages` input, or null for every page. The worker
 * resolves it with `resolvePageSelection` once it knows the page count; an
 * unresolvable selection is `invalid_range`.
 */
export interface PdfTextJob {
  kind: 'pdf_text'
  bytes: Uint8Array
  pages: string | null
  start: PdfTextPosition
  limits: DocumentReadLimits
}

/** The render budget is already narrowed by the model's delivery limits. */
export interface PdfVisualJob {
  kind: 'pdf_visual'
  bytes: Uint8Array
  pages: string | null
  /** Null/absent starts the selection; a visual cursor always has offset zero. */
  start?: PdfTextPosition | null
  maxDimension: number
  /** Additional delivery bound applied to the actual number of rendered pages. */
  maxDimensionAboveImageCount?: { count: number; maxDimension: number }
  maxPixelsPerCall: number
  maxImageBytes: number
  /** Encoded PNG bytes before base64; split evenly across rendered pages. */
  maxTotalImageBytes: number
  limits: DocumentReadLimits
}

/**
 * `start` null means the beginning of the selection (row 1 of the named
 * sheet, or of the first sheet); the Tool cannot know a named sheet's index
 * before the workbook is opened. A cursor's position names its sheet by index.
 */
export interface XlsxJob {
  kind: 'xlsx'
  bytes: Uint8Array
  sheet: string | null
  start: XlsxPosition | null
  limits: DocumentReadLimits
}

export type DocumentJob = PdfTextJob | PdfVisualJob | XlsxJob

export type DocumentJobFailure = {
  ok: false
  reason: Exclude<DocumentReadReason, 'visual_not_supported'>
  limit?: DocumentLimitName
}

/**
 * A text outcome holds every page of the selection from `start` until a
 * per-call limit binds; `next` is set exactly when pages or characters of the
 * selection remain. The Tool may return fewer pages to fit the ledger.
 * `pages[i].lowText` marks pages below `minTextCharsPerPage`. A selection in
 * whose returned window has no text inspects the remaining selection until
 * text is found, including before a resume cursor. This inspection is bounded
 * by maxPageCount, child time and memory, not by the returned-page budget.
 * Only an entirely textless selection is `no_text_layer`.
 *
 * Each page carries its whole text and the emitted window `[from, to)`, so
 * the Tool computes redaction over the complete page before slicing: a
 * secret cut by a cursor or a character limit is still matched whole.
 */
export interface PdfTextPageOutcome {
  page: number
  text: string
  from: number
  to: number
  lowText: boolean
}

export type PdfTextOutcome =
  | {
      ok: true
      pageCount: number
      pages: PdfTextPageOutcome[]
      next?: PdfTextPosition
      stoppedBy?: 'max_pages' | 'max_extracted_chars'
    }
  | DocumentJobFailure

export type PdfVisualOutcome =
  | {
      ok: true
      pageCount: number
      images: Array<PdfImageInfo & { png: Uint8Array }>
      next?: PdfTextPosition
      stoppedBy?: 'max_pages'
    }
  | DocumentJobFailure

/**
 * Every cell is the computed value: formulas give their cached result or
 * `[formula] =<formula>` when no result is stored, dates
 * an ISO 8601 string, rich text and hyperlinks their plain text, error cells
 * their error string (`#DIV/0!`). Rows keep their worksheet width up to the
 * last non-empty cell. A workbook with no non-empty cell in the selection is
 * `document_empty`, never an empty success.
 */
export type XlsxOutcome =
  | {
      ok: true
      sheetNames: string[]
      sheets: XlsxSheetResult[]
      next?: XlsxPosition
      stoppedBy?: 'max_rows' | 'max_cells'
    }
  | DocumentJobFailure

export type DocumentJobOutcome<J extends DocumentJob> = J extends PdfTextJob
  ? PdfTextOutcome
  : J extends PdfVisualJob
    ? PdfVisualOutcome
    : XlsxOutcome

/**
 * Queues one job per Host process, then runs it in a fresh child. Linux
 * cgroup-v2 headroom narrows configured caps; insufficient admission headroom
 * resolves `{ ok:false, reason:'host_memory_unavailable' }` without spawning,
 * and child/container memory overruns resolve with limit:'heap'. An unreadable
 * or v1 cgroup rejects as a worker defect. macOS uses configured caps.
 * Resolves with the job's outcome; a timeout
 * resolves `{ ok:false, reason:'document_limits_exceeded', limit:'time' }`, a
 * an outcome above `maxOutputBytes`
 * `limit:'output_bytes'`, and any other child crash rejects as a defect.
 * An aborted signal rejects with its reason without spawning while queued,
 * or kills an active child. Implemented by `workerRunner.ts`.
 */
export type RunDocumentJob = <J extends DocumentJob>(
  job: J,
  signal?: AbortSignal
) => Promise<DocumentJobOutcome<J>>
