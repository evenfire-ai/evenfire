import type { DiagramDrawRequest, DiagramDrawResult } from '../../../src/types'
import type { ThemeMode } from '../uiTypes'

/** What decides the drawing besides the code; the layout width only applies to its first draw. */
export type MermaidDiagramStyle = Readonly<{
  theme: ThemeMode
  fontFamily: string
}>

export type MermaidDiagramClientDeps = Readonly<{
  /** The main process's drawing bridge; a missing bridge may throw. */
  draw: (request: DiagramDrawRequest) => Promise<DiagramDrawResult>
  /** Memory for drawings, in characters of their code and result. */
  cacheMaxChars: number
  /** Wait before the one more request after a retryable failure. */
  retryDelayMs: number
}>

export type MermaidDiagramClient = Readonly<{
  /**
   * The drawing already made for this code and style, without asking for one.
   * Reading it keeps it in memory longer, as drawing it again does.
   */
  peek: (code: string, style: MermaidDiagramStyle) => DiagramDrawResult | null
  /** Draws the code, once per code and style, laid out for `width`. */
  draw: (code: string, style: MermaidDiagramStyle, width: number) => Promise<DiagramDrawResult>
}>
