/** The 2D context methods that draw text. */
interface TextDrawing {
  fillText(text: string, x: number, y: number, maxWidth?: number): void
  strokeText(text: string, x: number, y: number, maxWidth?: number): void
}

/**
 * Records every string drawn on `ctx` from now on, so the attachment check
 * reads what a chart image shows (title, legend, ticks, value labels) as it is
 * drawn, numbers already formatted. Returns the live list.
 */
export function recordDrawnText(ctx: TextDrawing): string[] {
  const drawn: string[] = []
  for (const method of ['fillText', 'strokeText'] as const) {
    const draw = ctx[method].bind(ctx)
    ctx[method] = (text: string, x: number, y: number, maxWidth?: number) => {
      drawn.push(String(text))
      return maxWidth === undefined ? draw(text, x, y) : draw(text, x, y, maxWidth)
    }
  }
  return drawn
}

/**
 * The drawn strings once each. Each is checked on its own: run together, the
 * labels 340 and 560 would read "3405". A value that comes from the arguments
 * is checked whole there, however it is drawn.
 */
export function drawnTexts(drawn: string[]): string[] {
  return [...new Set(drawn)]
}
