/**
 * Colors a caller sends with a chart, read the same by the PNG renderer and
 * the dashboard: one that is not a CSS color is left out for the palette's,
 * with a warning, rather than drawn black.
 */

/** CSS color keywords, which canvas and Chart.js both read. */
const NAMED_COLORS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue ' +
    'blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk ' +
    'crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki ' +
    'darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue ' +
    'dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite ' +
    'gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen ' +
    'lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen ' +
    'magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen ' +
    'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream ' +
    'mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
    'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum ' +
    'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen ' +
    'steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow ' +
    'yellowgreen transparent'
  ).split(' ')
)

/** Longer than any CSS color a chart needs, e.g. "hsl(210deg 50% 40% / 0.8)". */
const MAX_COLOR_LENGTH = 64

export function isCssColor(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > MAX_COLOR_LENGTH) return false
  const v = value.trim().toLowerCase()
  return (
    /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(v) ||
    /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\((?:[\d\s.,%/+-]|deg|g?rad|turn|none)*\)$/.test(v) ||
    NAMED_COLORS.has(v)
  )
}

/** Color warnings written out per chart; the rest are counted in one line. */
const COLOR_WARNINGS_SHOWN = 3

type ColorList = Array<string | undefined>

/**
 * `ds` without the colors that are not CSS colors: a single one is dropped,
 * and an entry of a per-value list is left empty, for the palette to fill.
 * Each rejected value's path and text go to `bad`.
 */
export function withoutInvalidColors<
  T extends { backgroundColor?: string | ColorList; borderColor?: string | ColorList },
>(ds: T, index: number, where: string, bad: Array<{ at: string; value: unknown }>): T {
  const out = { ...ds }
  for (const key of ['backgroundColor', 'borderColor'] as const) {
    const value = ds[key]
    if (value === undefined) continue
    const at = `${where}.datasets[${index}].${key}`
    if (!Array.isArray(value)) {
      if (!isCssColor(value)) {
        bad.push({ at, value })
        delete out[key]
      }
      continue
    }
    out[key] = value.map((v, j) => {
      if (isCssColor(v)) return v
      if (v !== undefined) bad.push({ at: `${at}[${j}]`, value: v })
      return undefined
    }) as T[typeof key]
  }
  return out
}

export function colorWarnings(bad: Array<{ at: string; value: unknown }>, where: string): string[] {
  const shown = bad.slice(0, COLOR_WARNINGS_SHOWN).map(({ at, value }) => {
    const text = JSON.stringify(
      typeof value === 'string' && value.length > 40 ? `${value.slice(0, 40)}…` : value
    )
    return (
      `${at} ${text} is not a CSS color, so the palette color was used. ` +
      'Pass hex such as "#2563eb", rgb(), hsl() or a color name.'
    )
  })
  const more = bad.length - shown.length
  if (more > 0) {
    shown.push(`${where}: ${more} more colors are not CSS colors and were replaced the same way.`)
  }
  return shown
}
