/** KPI and people cards. */
import { type DrawContext, fitOrShorten, hex } from './pptxDraw'
import { type PptxKpi } from './pptxInput'
import { type Box, type PlanOf } from './pptxLayout'
import { type Slide, addText } from './pptxRuns'
import { TEXT_INSET_X, TEXT_INSET_Y, fitText, lineHeightIn, textWidth } from './pptxText'

/** One or two cards stretched across a wide slide leave their figures lost in the card. */
const MAX_CARD_WIDTH = 4.5

/** Label and value sizes shared by every card on a slide, so no figure looks more important. */
interface CardType {
  labelSize: number
  /** Room above the value, the same on every card so the values line up. */
  labelHeight: number
  valueSize: number
  /** The value sizes, largest first; a value that wraps may take a smaller one than valueSize. */
  valueSizes: number[]
}

const LABEL_SIZES = [11, 10, 9]
const LABEL_MAX_HEIGHT = 0.6

/** Width of the text in a card, inside its 0.2in padding. */
function cardTextWidth(cardW: number): number {
  return cardW - 0.4
}

function cardType(cards: PptxKpi[], cardW: number, columns: number, people: boolean): CardType {
  const w = cardTextWidth(cardW)
  const labels = people ? [] : cards.flatMap(c => (c.label ? [c.label] : []))
  const labelSize =
    LABEL_SIZES.find(size =>
      labels.every(l => fitText([l], { w, h: LABEL_MAX_HEIGHT }, [size], { bold: true }).fits)
    ) ?? LABEL_SIZES[LABEL_SIZES.length - 1]
  const labelHeight = Math.max(
    0,
    ...labels.map(l =>
      Math.min(
        fitText([l], { w, h: Infinity }, [labelSize], { bold: true }).height,
        LABEL_MAX_HEIGHT
      )
    )
  )
  const valueSizes = people
    ? columns >= 3
      ? [20, 18, 16, 14, 12]
      : [24, 20, 18, 16, 14, 12]
    : columns >= 3
      ? [24, 22, 20, 18, 16, 14, 12]
      : [32, 28, 24, 20, 18, 16, 14, 12]
  // The largest size at which every value that can fit one line does; a value
  // too long even at the smallest wraps at that size instead of shrinking the rest.
  const inner = w - TEXT_INSET_X
  const smallest = valueSizes[valueSizes.length - 1]
  const oneLine = cards.filter(c => textWidth(c.value, smallest, true) <= inner)
  const valueSize =
    (oneLine.length > 0 &&
      valueSizes.find(size => oneLine.every(c => textWidth(c.value, size, true) <= inner))) ||
    smallest
  return { labelSize, labelHeight, valueSize, valueSizes }
}

function drawCard(
  slide: Slide,
  card: PptxKpi,
  box: Box,
  type: CardType,
  people: boolean,
  ctx: DrawContext
): void {
  const p = ctx.palette
  slide.addShape(ctx.pptx.shapes?.ROUNDED_RECTANGLE ?? 'roundRect', {
    ...box,
    fill: { color: hex(p.surface) },
    line: { color: hex(p.border), width: 0.5 },
    rectRadius: 0.05,
  })
  const x = box.x + 0.2
  const w = cardTextWidth(box.w)
  const inner = w - TEXT_INSET_X
  let y = box.y + 0.15
  if (card.label && !people) {
    const label = fitOrShorten(
      card.label,
      { w, h: LABEL_MAX_HEIGHT },
      [type.labelSize],
      `${card.where}.label`,
      ctx.warnings,
      { bold: true }
    )
    addText(
      slide,
      label.text,
      { x, y, w, h: label.height },
      {
        fontSize: label.size,
        color: hex(p.muted),
        bold: true,
      }
    )
  }
  y += type.labelHeight
  let bottom = box.y + box.h - 0.1
  const glyph = card.deltaDirection === 'up' ? '▲ ' : card.deltaDirection === 'down' ? '▼ ' : '— '
  const delta = card.delta
    ? fitOrShorten(
        `${glyph}${card.delta}`,
        { w, h: 0.55 },
        [11, 10, 9],
        `${card.where}.delta`,
        ctx.warnings
      )
    : undefined
  if (delta) bottom -= delta.height
  const size = type.valueSize
  if (textWidth(card.value, size, true) <= inner) {
    const h = lineHeightIn(size, card.value) + TEXT_INSET_Y
    addText(
      slide,
      card.value,
      { x, y, w, h },
      {
        fontSize: size,
        bold: true,
        color: hex(p.primary),
        wrap: false,
      }
    )
    y += h
  } else {
    // A value that wraps keeps the size of the other cards' values when it fits
    // above the delta there, and takes a smaller one before it is shortened.
    const value = fitOrShorten(
      card.value,
      { w, h: bottom - y },
      type.valueSizes.filter(s => s <= size),
      `${card.where}.value`,
      ctx.warnings,
      { bold: true }
    )
    addText(
      slide,
      value.text,
      { x, y, w, h: value.height },
      { fontSize: value.size, bold: true, color: hex(p.primary) }
    )
    y += value.height
  }
  if (delta) {
    const color =
      card.deltaDirection === 'up'
        ? p.statusGreen
        : card.deltaDirection === 'down'
          ? p.statusRed
          : p.muted
    addText(
      slide,
      delta.text,
      { x, y: bottom, w, h: delta.height },
      { fontSize: delta.size, color: hex(color) }
    )
  }
  if (card.note) {
    const room = bottom - y
    if (room > TEXT_INSET_Y + 0.1) {
      const note = fitOrShorten(
        card.note,
        { w, h: room },
        people ? [14, 12, 11, 10] : [12, 11, 10, 9],
        card.notePath ?? `${card.where}.note`,
        ctx.warnings
      )
      addText(
        slide,
        note.text,
        { x, y, w, h: note.height },
        {
          fontSize: note.size,
          color: hex(people ? p.muted : p.text),
          valign: 'top',
        }
      )
    } else {
      ctx.warnings.push(
        `${card.notePath ?? card.where}: the card has no room left for this text, which was left out.`
      )
    }
  }
}

export function drawKpis(slide: Slide, planned: PlanOf<'kpis'>, ctx: DrawContext): void {
  const cards = planned.kpis
  const body = planned.body
  // One row up to four cards, then two rows with the longer one first:
  // five cards are three and two, not four and one.
  const rows = cards.length <= 4 ? 1 : 2
  const cols = Math.ceil(cards.length / rows)
  const gap = 0.2
  const people = planned.spec.kpiStyle === 'people'
  const cellW = Math.min((body.w - gap * (cols - 1)) / cols, MAX_CARD_WIDTH)
  const tallest = cards.some(c => c.note) && !people ? 3.2 : 2.0
  const cellH = Math.min((body.h - gap * (rows - 1)) / rows, tallest)
  const type = cardType(cards, cellW, cols, people)
  cards.forEach((card, i) => {
    const row = Math.floor(i / cols)
    const inRow = Math.min(cols, cards.length - row * cols)
    // Each row is centred, so a shorter last row sits under the middle of the first.
    const left = body.x + (body.w - (cellW * inRow + gap * (inRow - 1))) / 2
    const box = {
      x: left + (i % cols) * (cellW + gap),
      y: body.y + row * (cellH + gap),
      w: cellW,
      h: cellH,
    }
    drawCard(slide, card, box, type, people, ctx)
  })
}
