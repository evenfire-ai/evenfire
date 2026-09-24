/**
 * Final pass over a pdfmake document: every piece of text is split into runs
 * whose face can draw them, right-to-left text is put into display order, and
 * whatever no face can draw is reported instead of vanishing.
 *
 * pdfmake names one family per run and pdfkit draws a missing glyph as a blank
 * box, so runs are split by face. pdfmake has no right-to-left layout, so lists
 * and tables whose text reads that way are mirrored here.
 */
import type { Content } from 'pdfmake/interfaces'
import { PDF_MONO_FAMILY, type PdfGlyphSource, asciiStandIn } from './fonts'
import {
  type BidiParagraph,
  hasRtl,
  isRtlScript,
  mirrored,
  resolveParagraph,
  visualOrder,
} from './pdfBidi'

type Props = Record<string, unknown>

/** What a node inherits from its ancestors, for choosing and measuring faces. */
export interface TypesetContext {
  /** Width available to the node's text, in points. */
  width: number
  font: string
  fontSize: number
  bold: boolean
  lineHeight: number
}

interface Glyph {
  text: string
  family: string
  props: Props
  cp: number
}

/** Dropped because they carry nothing to draw. Joiners are kept: Arabic shaping reads them. */
const INVISIBLE = /^[\u200B\u200E\u200F\u2060\uFE00-\uFE0F\uFEFF]$/u
const JOINER = /^[\u200C\u200D]$/u
const EMOJI = /^\p{Emoji_Presentation}$/u
const PLAIN = /^[\x20-\x7E\n]*$/

/** Share of the width a line fills before it is broken, leaving room for measuring error. */
export const LINE_FILL = 0.94

/**
 * Glyphs in a stretch with no break opportunity beyond which the typesetter
 * breaks it itself. pdfmake splits an over-wide word by measuring a prefix and
 * the rest of it for every line, and pdfkit caches each string it measures, so
 * a long token (a base64 blob, a minified JSON line) costs time and memory
 * quadratic in its length.
 */
const LONG_WORD = 64

/**
 * Characters pdfmake may break a line after: breaking spaces, ideographs and CJK
 * punctuation. No-break spaces (U+00A0, U+2007, U+202F, U+FEFF) are left out,
 * since pdfmake keeps the words they join on one line.
 */
const BREAKS_AFTER =
  /[\t\n\v\f\r \u1680\u2000-\u2006\u2008-\u200A\u2028\u2029\u205F\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF00-\uFFEF]/u

/** Combining marks, which stay on the line of the character they follow. */
const MARK = /^[\p{Mn}\p{Me}]$/u

/** Neither direction of its own: fontkit reads a run's direction from its first other character. */
const NEUTRAL_SCRIPT = /^[\p{Script=Common}\p{Script=Inherited}]/u

/** The scripts fontkit sets right to left. */
const RTL_SCRIPT =
  /^[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Cypriot}\p{Script=Kharoshthi}\p{Script=Phoenician}\p{Script=Nko}\p{Script=Lydian}\p{Script=Avestan}\p{Script=Imperial_Aramaic}\p{Script=Inscriptional_Pahlavi}\p{Script=Inscriptional_Parthian}\p{Script=Old_South_Arabian}\p{Script=Old_Turkic}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Meroitic_Cursive}\p{Script=Meroitic_Hieroglyphs}\p{Script=Manichaean}\p{Script=Mende_Kikakui}\p{Script=Nabataean}\p{Script=Old_North_Arabian}\p{Script=Palmyrene}\p{Script=Psalter_Pahlavi}]/u

/** The direction fontkit gives a run that starts with `ch`, if `ch` decides it. */
function scriptDirection(ch: string): 'L' | 'R' | undefined {
  if (NEUTRAL_SCRIPT.test(ch)) return undefined
  return RTL_SCRIPT.test(ch) ? 'R' : 'L'
}

/**
 * Bounds, in ems, on the line a run's face asks for. pdfkit sizes a line from
 * the face's ascent and descent: Courier's leave code lines touching, and
 * Noto Sans Arabic's space a paragraph as if it were double-spaced.
 */
const MIN_LINE_EM = 1.1
const MAX_LINE_EM_OVER_BODY = 1.2

/** A list's marker column, in ems of its type size, as pdfmake indents its items. */
const MARKER_EMS = 2

const SCRIPT_NAMES: Array<[RegExp, string]> = [
  [/\p{Script=Arabic}/u, 'Arabic'],
  [/\p{Script=Hebrew}/u, 'Hebrew'],
  [/\p{Script=Han}/u, 'Chinese'],
  [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, 'Japanese'],
  [/\p{Script=Hangul}/u, 'Korean'],
  [/\p{Script=Thai}/u, 'Thai'],
  [/\p{Script=Devanagari}/u, 'Devanagari'],
  [/\p{Script=Bengali}/u, 'Bengali'],
  [/\p{Script=Tamil}/u, 'Tamil'],
  [/\p{Script=Cyrillic}/u, 'Cyrillic'],
  [/\p{Script=Greek}/u, 'Greek'],
  [/\p{Extended_Pictographic}/u, 'emoji'],
]

function scriptName(ch: string): string | undefined {
  return SCRIPT_NAMES.find(([re]) => re.test(ch))?.[1]
}

function margins(node: Props): [number, number] {
  const m = node.margin
  if (typeof m === 'number') return [m, m]
  if (Array.isArray(m) && m.length === 2) return [Number(m[0]) || 0, Number(m[0]) || 0]
  if (Array.isArray(m) && m.length === 4) return [Number(m[0]) || 0, Number(m[2]) || 0]
  return [0, 0]
}

function isObject(value: unknown): value is Props {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** In a mirrored table or list, text with no alignment of its own starts at the right. */
function startRight(cell: unknown): void {
  if (isObject(cell) && cell.alignment === undefined) cell.alignment = 'right'
}

/** "12 character(s) of Arabic, Hebrew text", counting every character in `chars`. */
function leftOut(chars: Map<string, number>): string {
  const total = [...chars.values()].reduce((a, b) => a + b, 0)
  const scripts = [...new Set([...chars.keys()].map(scriptName).filter(Boolean))]
  return `${total} character(s)${scripts.length ? ` of ${scripts.join(', ')} text` : ''}`
}

function samplesOf(chars: Map<string, number>): string {
  return [...chars.keys()]
    .slice(0, 5)
    .map(ch => `'${ch}' (U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`)
    .join(', ')
}

export class PdfTypesetter {
  /** Every family the typeset content names, for the printer's font table. */
  readonly families = new Set<string>()
  private readonly missing = new Map<string, number>()
  /** Characters of runs pdfkit could not lay out in their face, left out by settleShaping. */
  private readonly unshaped = new Map<string, number>()
  /** Every run set in a fallback face, by family, for settleShaping to check. */
  private readonly fallbackRuns = new Map<string, Props[]>()
  private readonly advances = new Map<string, number>()
  /** Base direction of each typeset text node that has one: 0 left to right, 1 right to left. */
  private readonly direction = new WeakMap<object, 0 | 1>()
  private bodyEm?: number

  constructor(
    private readonly glyphs: PdfGlyphSource,
    private readonly styles: Record<string, Props> = {}
  ) {}

  /** Typeset every text node in `content`, in place. */
  typeset(content: Content | Content[], ctx: TypesetContext): void {
    this.bodyEm ??= this.glyphs.metrics(ctx.font)?.lineHeight
    this.visit(content as unknown, ctx)
  }

  /**
   * Check that pdfkit can lay out every run set in a fallback face, and empty
   * the runs it cannot, so one sequence fontkit fails to shape leaves out those
   * characters with a note instead of failing the whole document. The runs of a
   * family are tried together, and split in halves only when that fails.
   */
  settleShaping(): void {
    for (const [family, runs] of this.fallbackRuns) {
      for (const run of this.unshapeable(family, runs)) {
        for (const ch of String(run.text)) {
          if (!/\s/.test(ch)) this.unshaped.set(ch, (this.unshaped.get(ch) ?? 0) + 1)
        }
        run.text = ''
      }
    }
    this.fallbackRuns.clear()
  }

  /** `runs`, the ones set in a fallback face recorded for settleShaping. */
  private kept(runs: Props[]): Props[] {
    for (const run of runs) {
      const family = run.font
      if (typeof family !== 'string' || !this.glyphs.isFallback(family)) continue
      const recorded = this.fallbackRuns.get(family)
      if (recorded) recorded.push(run)
      else this.fallbackRuns.set(family, [run])
    }
    return runs
  }

  private unshapeable(family: string, runs: Props[]): Props[] {
    if (
      this.glyphs.shapes(
        family,
        runs.map(r => String(r.text))
      )
    )
      return []
    if (runs.length === 1) return runs
    const half = runs.length >> 1
    return [
      ...this.unshapeable(family, runs.slice(0, half)),
      ...this.unshapeable(family, runs.slice(half)),
    ]
  }

  /** Text that was left out, as notes the agent can act on. */
  warnings(): string[] {
    const notes: string[] = []
    if (this.missing.size > 0) {
      notes.push(
        `${leftOut(this.missing)} have no glyph in the fonts available to the PDF renderer and ` +
          `were left out, for example ${samplesOf(this.missing)}. clerum__generate_docx keeps such text.`
      )
    }
    if (this.unshaped.size > 0) {
      notes.push(
        `${leftOut(this.unshaped)} are in a sequence the PDF renderer cannot lay out and were left ` +
          `out, for example ${samplesOf(this.unshaped)}. clerum__generate_docx keeps such text.`
      )
    }
    return notes
  }

  private visit(node: unknown, ctx: TypesetContext): unknown {
    if (typeof node === 'string') {
      const holder: Props = { text: node }
      this.textNode(holder, ctx)
      return holder
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) node[i] = this.visit(node[i], ctx)
      return node
    }
    if (!isObject(node)) return node
    const own = this.context(node, ctx)
    if ('text' in node) {
      this.textNode(node, own)
    } else if (Array.isArray(node.stack)) {
      this.visit(node.stack, own)
    } else if (Array.isArray(node.ul) || Array.isArray(node.ol)) {
      // Room for the bullet or number pdfmake draws before each item.
      const items = { ...own, width: own.width - own.fontSize * MARKER_EMS }
      const list = (node.ul ?? node.ol) as unknown[]
      this.visit(list, items)
      if (this.readsRtl(list.map(item => (Array.isArray(item) ? item[0] : item)))) {
        this.mirrorList(node, list, own)
      }
    } else if (isObject(node.table) && Array.isArray(node.table.body)) {
      const table = node.table
      const widths = Array.isArray(table.widths) ? table.widths : []
      const body = table.body as unknown[][]
      for (const row of body) {
        if (!Array.isArray(row)) continue
        for (let c = 0; c < row.length; c++) {
          const w = typeof widths[c] === 'number' ? (widths[c] as number) : own.width / row.length
          row[c] = this.visit(row[c], { ...own, width: w })
        }
        this.alignBaselines(row, own)
      }
      // Only data tables: code blocks and quotes are one-cell tables without a header.
      if (Number(table.headerRows) >= 1 && Array.isArray(body[0]) && this.readsRtl(body[0])) {
        for (const row of body) {
          if (!Array.isArray(row)) continue
          row.reverse()
          for (const cell of row) startRight(cell)
        }
        if (Array.isArray(table.widths)) table.widths.reverse()
      }
    } else if (Array.isArray(node.columns)) {
      const width = own.width / Math.max(1, node.columns.length)
      this.visit(node.columns, { ...own, width })
    }
    return node
  }

  /** Whether more of these typeset nodes read right to left than left to right. */
  private readsRtl(nodes: unknown[]): boolean {
    let balance = 0
    for (const node of nodes) {
      const dir = isObject(node) ? this.direction.get(node) : undefined
      if (dir !== undefined) balance += dir === 1 ? 1 : -1
    }
    return balance > 0
  }

  /**
   * pdfmake draws list markers only at the left, far from right-aligned text,
   * so a right-to-left list becomes a table with its markers on the right.
   */
  private mirrorList(node: Props, items: unknown[], ctx: TypesetContext): void {
    const ordered = Array.isArray(node.ol)
    const start = typeof node.start === 'number' ? node.start : 1
    const body = items.map((item, i) => {
      // Display order: in a right-to-left line "3." reads with the number first, at the right.
      const marker: Props = { text: ordered ? `.${start + i}` : '\u2022', alignment: 'right' }
      this.textNode(marker, ctx)
      const row = [Array.isArray(item) ? { stack: item } : item, marker]
      startRight(row[0])
      this.alignBaselines(row, ctx)
      return row
    })
    delete node.ul
    delete node.ol
    delete node.start
    node.table = { widths: ['*', ctx.fontSize * MARKER_EMS], body }
    node.layout = {
      hLineWidth: () => 0,
      vLineWidth: () => 0,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    }
  }

  /**
   * pdfmake sets each cell's first baseline by the tallest face on its line,
   * so an Arabic cell sits lower than a Latin one beside it. A top margin on
   * the others puts their first lines level.
   */
  private alignBaselines(cells: unknown[], ctx: TypesetContext): void {
    const ascents = cells.map(cell => this.firstLineAscent(cell, ctx))
    const top = Math.max(0, ...ascents.map(a => a ?? 0))
    cells.forEach((cell, i) => {
      const gap = top - (ascents[i] ?? top)
      if (gap < 0.5 || !isObject(cell)) return
      const m = cell.margin
      if (m === undefined) cell.margin = [0, gap, 0, 0]
      else if (Array.isArray(m) && m.length === 4)
        cell.margin = [m[0], Number(m[1]) + gap, m[2], m[3]]
    })
  }

  /** Points above the first baseline of a typeset node, from the faces on its first line. */
  private firstLineAscent(node: unknown, ctx: TypesetContext): number | undefined {
    if (Array.isArray(node)) return this.firstLineAscent(node[0], ctx)
    if (!isObject(node)) return undefined
    const own = this.context(node, ctx)
    if (Array.isArray(node.stack)) return this.firstLineAscent(node.stack[0], own)
    if (!Array.isArray(node.text)) return undefined
    let ascent = 0
    for (const run of node.text as Props[]) {
      const family = typeof run.font === 'string' ? run.font : own.font
      const size = typeof run.fontSize === 'number' ? run.fontSize : own.fontSize
      ascent = Math.max(ascent, (this.glyphs.metrics(family)?.ascent ?? 0) * size)
      if (String(run.text).includes('\n')) break
    }
    return ascent || undefined
  }

  private context(node: Props, ctx: TypesetContext): TypesetContext {
    const out = { ...ctx }
    const names = Array.isArray(node.style) ? node.style : node.style ? [node.style] : []
    for (const source of [...names.map(n => this.styles[String(n)] ?? {}), node]) {
      if (typeof source.font === 'string') out.font = source.font
      if (typeof source.fontSize === 'number') out.fontSize = source.fontSize
      if (typeof source.bold === 'boolean') out.bold = source.bold
      if (typeof source.lineHeight === 'number') out.lineHeight = source.lineHeight
    }
    const [left, right] = margins(node)
    out.width = Math.max(1, ctx.width - left - right)
    return out
  }

  /** The text of a node as pieces with the run properties each carries. */
  private pieces(
    text: unknown,
    inherited: Props,
    out: Array<{ text: string; props: Props }>
  ): void {
    if (typeof text === 'string' || typeof text === 'number') {
      out.push({ text: String(text), props: inherited })
    } else if (Array.isArray(text)) {
      for (const item of text) this.pieces(item, inherited, out)
    } else if (isObject(text)) {
      const { text: inner, ...props } = text
      this.pieces(inner, { ...inherited, ...props }, out)
    }
  }

  private glyphsOf(text: string, props: Props, ctx: TypesetContext, out: Glyph[]): void {
    const base = typeof props.font === 'string' ? props.font : ctx.font
    if (PLAIN.test(text)) {
      for (const ch of text) out.push({ text: ch, family: base, props, cp: ch.codePointAt(0)! })
      return
    }
    for (const ch of text) {
      const cp = ch.codePointAt(0)!
      if (INVISIBLE.test(ch)) continue
      if (JOINER.test(ch)) {
        const previous = out[out.length - 1]
        if (previous && isRtlScript(previous.cp))
          out.push({ text: ch, family: previous.family, props, cp })
        continue
      }
      if (ch === '\t') {
        out.push({ text: base === PDF_MONO_FAMILY ? '    ' : ' ', family: base, props, cp: 0x20 })
        continue
      }
      if (ch === '\n') {
        out.push({ text: ch, family: base, props, cp })
        continue
      }
      if (cp < 0x20) continue
      const standIn = asciiStandIn(ch)
      const family =
        EMOJI.test(ch) && standIn !== undefined ? undefined : this.glyphs.familyFor(cp, base)
      if (family) {
        out.push({ text: ch, family, props, cp })
      } else if (standIn !== undefined) {
        for (const c of standIn) out.push({ text: c, family: base, props, cp: c.codePointAt(0)! })
      } else {
        this.missing.set(ch, (this.missing.get(ch) ?? 0) + 1)
      }
    }
  }

  private textNode(node: Props, ctx: TypesetContext): void {
    const pieces: Array<{ text: string; props: Props }> = []
    this.pieces(node.text, {}, pieces)
    const glyphs: Glyph[] = []
    for (const piece of pieces) this.glyphsOf(piece.text, piece.props, ctx, glyphs)

    if (!pieces.some(p => hasRtl(p.text))) {
      const runs = this.kept(this.runs(this.breakLongWords(glyphs, ctx), ctx))
      node.text = runs.length > 0 ? runs : ''
      if (pieces.some(p => /\p{L}/u.test(p.text))) this.direction.set(node, 0)
      return
    }
    const lines: Glyph[][] = []
    let firstBase: 0 | 1 | undefined
    let start = 0
    for (let i = 0; i <= glyphs.length; i++) {
      if (i < glyphs.length && glyphs[i].text !== '\n') continue
      const paragraph = glyphs.slice(start, i)
      const bidi = resolveParagraph(paragraph.map(g => g.cp))
      if (firstBase === undefined && paragraph.length > 0) firstBase = bidi.base
      for (const [from, to] of this.breakLines(paragraph, ctx)) {
        lines.push(this.displayOrder(paragraph, bidi, from, to))
      }
      start = i + 1
    }
    const runs: Props[] = []
    lines.forEach((line, i) => {
      const lineRuns = this.runs(line, ctx)
      // The break rides on the line's last run: a run holding only '\n' is
      // laid out as an extra empty line.
      if (i < lines.length - 1) {
        const last = lineRuns[lineRuns.length - 1]
        if (last) last.text = `${String(last.text)}\n`
        else lineRuns.push({ text: '\n' })
      }
      runs.push(...lineRuns)
    })
    node.text = this.kept(runs)
    if (firstBase !== undefined) this.direction.set(node, firstBase)
    if (firstBase === 1 && node.alignment === undefined) node.alignment = 'right'
  }

  /**
   * `glyphs` with a line break in every stretch too long and too wide for one
   * line, wherever it fills the line. Only for text pdfmake lays out itself.
   */
  private breakLongWords(glyphs: Glyph[], ctx: TypesetContext): Glyph[] {
    const limit = ctx.width * LINE_FILL
    let out: Glyph[] | undefined
    let start = 0
    for (let i = 0; i <= glyphs.length; i++) {
      if (i < glyphs.length && !BREAKS_AFTER.test(glyphs[i].text)) continue
      if (i - start > LONG_WORD && this.width(glyphs.slice(start, i), ctx) > limit) {
        out ??= glyphs.slice(0, start)
        let width = 0
        for (let k = start; k < i; k++) {
          const g = glyphs[k]
          const advance = this.advance(g, ctx)
          if (width > 0 && width + advance > limit && !MARK.test(g.text)) {
            out.push({ ...glyphs[k - 1], text: '\n', cp: 0x0a })
            width = 0
          }
          out.push(g)
          width += advance
        }
      } else if (out) {
        for (let k = start; k < i; k++) out.push(glyphs[k])
      }
      if (out && i < glyphs.length) out.push(glyphs[i])
      start = i + 1
    }
    return out ?? glyphs
  }

  /**
   * Line ranges of one paragraph, broken at spaces to fit the context's width.
   * A word wider than the line is broken wherever it fills one.
   */
  private breakLines(glyphs: Glyph[], ctx: TypesetContext): Array<[number, number]> {
    const limit = ctx.width * LINE_FILL
    const lines: Array<[number, number]> = []
    let lineStart = 0
    let lineWidth = 0
    let i = 0
    while (i < glyphs.length) {
      let end = i
      while (end < glyphs.length && glyphs[end].text !== ' ') end++
      let wordWidth = this.width(glyphs.slice(i, end), ctx)
      if (wordWidth > limit) {
        if (lineWidth > 0) {
          lines.push([lineStart, i])
          lineStart = i
        }
        wordWidth = 0
        for (let k = i; k < end; k++) {
          const advance = this.advance(glyphs[k], ctx)
          if (wordWidth > 0 && wordWidth + advance > limit && !MARK.test(glyphs[k].text)) {
            lines.push([lineStart, k])
            lineStart = k
            wordWidth = 0
          }
          wordWidth += advance
        }
        lineWidth = 0
      } else if (lineWidth > 0 && lineWidth + wordWidth > limit) {
        lines.push([lineStart, i])
        lineStart = i
        lineWidth = 0
      }
      let next = end
      while (next < glyphs.length && glyphs[next].text === ' ') next++
      lineWidth += wordWidth + this.width(glyphs.slice(end, next), ctx)
      i = next
    }
    lines.push([lineStart, glyphs.length])
    return lines
  }

  private width(glyphs: Glyph[], ctx: TypesetContext): number {
    let total = 0
    for (const run of this.runs(glyphs, ctx)) {
      const size = typeof run.fontSize === 'number' ? run.fontSize : ctx.fontSize
      const bold = typeof run.bold === 'boolean' ? run.bold : ctx.bold
      const family = typeof run.font === 'string' ? run.font : ctx.font
      total += this.glyphs.measure(String(run.text), family, size, bold)
    }
    return total
  }

  /** Advance width of one glyph, measured once per face, size and weight. */
  private advance(g: Glyph, ctx: TypesetContext): number {
    const size = typeof g.props.fontSize === 'number' ? g.props.fontSize : ctx.fontSize
    const bold = typeof g.props.bold === 'boolean' ? g.props.bold : ctx.bold
    const key = `${g.family}\u0000${size}\u0000${bold}\u0000${g.text}`
    let advance = this.advances.get(key)
    if (advance === undefined) {
      advance = this.glyphs.measure(g.text, g.family, size, bold)
      this.advances.set(key, advance)
    }
    return advance
  }

  /** One line in display order, brackets mirrored where the text runs right to left. */
  private displayOrder(glyphs: Glyph[], bidi: BidiParagraph, from: number, to: number): Glyph[] {
    return visualOrder(bidi, from, to).map(at => ({
      ...glyphs[at],
      text: mirrored(glyphs[at].text, bidi.levels[at]),
    }))
  }

  /** The line height a run needs to keep its face within the line bounds, if it differs. */
  private lineHeightFor(family: string, props: Props, ctx: TypesetContext): number | undefined {
    const em = this.glyphs.metrics(family)?.lineHeight
    if (!em) return undefined
    const cap = Math.max(MIN_LINE_EM, (this.bodyEm ?? em) * MAX_LINE_EM_OVER_BODY)
    const target = Math.min(Math.max(em, MIN_LINE_EM), cap)
    if (target === em) return undefined
    const inherited = typeof props.lineHeight === 'number' ? props.lineHeight : ctx.lineHeight
    return (inherited * target) / em
  }

  /**
   * Adjacent glyphs sharing a face and properties, merged into pdfmake runs,
   * without mixing left-to-right and right-to-left letters in one run. A run
   * fontkit sets right to left is reversed by fontkit once shaped, so it is
   * handed over in reverse display order.
   */
  private runs(glyphs: Glyph[], ctx: TypesetContext): Props[] {
    const runs: Props[] = []
    let current:
      | { glyphs: Glyph[]; family: string; props: Props; direction?: 'L' | 'R' }
      | undefined
    const flush = (): void => {
      if (!current) return
      const reversed = current.direction === 'R' && this.glyphs.reversesRtl(current.family)
      const ordered = reversed ? [...current.glyphs].reverse() : current.glyphs
      const run: Props = { ...current.props, text: ordered.map(g => g.text).join('') }
      if (current.family !== ctx.font || current.props.font !== undefined) run.font = current.family
      const lineHeight = this.lineHeightFor(current.family, current.props, ctx)
      if (lineHeight !== undefined) run.lineHeight = lineHeight
      this.families.add(current.family)
      runs.push(run)
      current = undefined
    }
    for (const g of glyphs) {
      const direction = scriptDirection(g.text)
      if (
        current &&
        current.family === g.family &&
        current.props === g.props &&
        (!direction || !current.direction || direction === current.direction)
      ) {
        current.glyphs.push(g)
        current.direction ??= direction
      } else {
        flush()
        current = { glyphs: [g], family: g.family, props: g.props, direction }
      }
    }
    flush()
    return runs
  }
}
