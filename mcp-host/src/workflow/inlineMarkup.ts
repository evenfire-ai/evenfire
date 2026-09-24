/**
 * Inline markdown, and the bits of HTML models mix into it, read once for the
 * PDF and DOCX generators so both print the same text the same way.
 *
 * Every pattern here runs on text a model wrote, so none may backtrack across
 * the input: each stops at the next tag, bracket or marker of its own kind.
 */

// A tag's attributes. Each takes a value unless it is one of HTML's boolean
// attributes, so text such as "a<b and c>d" is not read as a <b> tag.
const ATTRIBUTES =
  '(?:\\s+(?:(?:allowfullscreen|async|checked|controls|default|defer|disabled|hidden|inert|' +
  'loop|multiple|muted|nowrap|open|readonly|required|reversed|selected)(?![-\\w:.=])|' +
  '[A-Za-z_:][-\\w:.]*\\s*=\\s*(?:"[^"<>]*"|\'[^\'<>]*\'|[^\\s"\'=<>`]+)))*\\s*'

/** Opening and closing tags named by the `names` alternatives, with their attributes. */
const tag = (names: string) => `</?(?:${names})${ATTRIBUTES}>`

const SCRIPT_OPEN = /<(script|style)\b[^<>]*>/gi
const LINE_BREAK = /<br\s*\/?>/gi
// A block or cell boundary ends a word even when no space surrounds the tags.
const BLOCK_EDGE = new RegExp(
  `(?:${tag(
    'article|blockquote|caption|dd|details|div|dt|figcaption|figure|footer|h[1-6]|header|li|ol|p|pre|section|summary|table|tr|ul'
  )}\\s*)+`,
  'gi'
)
const CELL_EDGE = new RegExp(`(?:${tag('t[dh]')}\\s*)+`, 'gi')
const BOLD_TAG = new RegExp(tag('b|strong'), 'gi')
const ITALIC_TAG = new RegExp(tag('i|em'), 'gi')
const CODE_TAG = new RegExp(tag('code|kbd|tt'), 'gi')
const STRIKE_TAG = new RegExp(tag('del|s|strike'), 'gi')
const LIST_TAG = new RegExp(`<(/?)(ul|ol|li)${ATTRIBUTES}>`, 'gi')
const IMG_TAG = /<img\b[^<>]*>/gi
const IMG_SRC = /\bsrc\s*=\s*(["'])([^"'<>]+)\1/i
/** A backslash before ASCII punctuation, which CommonMark prints as that character. */
const ESCAPE = /\\[!-/:-@[-`{-~]/
// The opening tag is taken whole and its href read apart, and the label stops at
// the next anchor tag, so neither an unclosed <a> nor a tag of many attributes
// is rescanned from every position.
const ANCHOR = /(<a\s[^<>]*>)((?:[^<]|<(?!\/?a[\s>]))*?)<\/a\s*>/gi
const HREF = /\shref\s*=\s*["']((?:https?:\/\/|mailto:)[^"'\s<>]+)["']/i

// Only real element names are removed, so a placeholder such as <namespace>
// in a command survives as text.
const HTML_TAG = new RegExp(
  '</?(?:' +
    [
      'a',
      'abbr',
      'article',
      'aside',
      'big',
      'blockquote',
      'caption',
      'center',
      'cite',
      'dd',
      'del',
      'details',
      'div',
      'dl',
      'dt',
      'figcaption',
      'figure',
      'font',
      'footer',
      'h[1-6]',
      'header',
      'hr',
      'img',
      'ins',
      'label',
      'li',
      'mark',
      'nav',
      'ol',
      'p',
      'pre',
      's',
      'script',
      'section',
      'small',
      'span',
      'strike',
      'style',
      'sub',
      'summary',
      'sup',
      'table',
      'tbody',
      'td',
      'tfoot',
      'th',
      'thead',
      'time',
      'tr',
      'u',
      'ul',
    ].join('|') +
    `)${ATTRIBUTES}/?>`,
  'gi'
)

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D',
  laquo: '\u00AB',
  raquo: '\u00BB',
  middot: '\u00B7',
  bull: '\u2022',
  times: '\u00D7',
  divide: '\u00F7',
  deg: '\u00B0',
  copy: '\u00A9',
  reg: '\u00AE',
  trade: '\u2122',
  euro: '\u20AC',
  pound: '\u00A3',
  yen: '\u00A5',
  cent: '\u00A2',
}

/** Code points XML 1.0 can carry; a numeric reference to anything else stays literal. */
function xmlAllowed(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  )
}

/** Character references decoded; an unknown or unrepresentable one stays as written. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (entity, name: string) => {
    if (name.startsWith('#')) {
      const cp =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1))
      return xmlAllowed(cp) ? String.fromCodePoint(cp) : entity
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? entity
  })
}

/** `text` without HTML comments, found in one pass; an unclosed one is left as written. */
function withoutComments(text: string): string {
  if (!text.includes('<!--')) return text
  let out = ''
  let at = 0
  for (let open = text.indexOf('<!--'); open >= 0; open = text.indexOf('<!--', at)) {
    const close = text.indexOf('-->', open + 4)
    if (close < 0) break
    out += text.slice(at, open)
    at = close + 3
  }
  return out + text.slice(at)
}

/** `text` without <script> and <style> elements, found in one pass. */
function withoutScripts(text: string): string {
  if (!/<(?:script|style)\b/i.test(text)) return text
  const lower = text.toLowerCase()
  let out = ''
  let at = 0
  SCRIPT_OPEN.lastIndex = 0
  for (let open = SCRIPT_OPEN.exec(text); open; open = SCRIPT_OPEN.exec(text)) {
    const close = lower.indexOf(`</${open[1].toLowerCase()}`, SCRIPT_OPEN.lastIndex)
    const end = close < 0 ? -1 : lower.indexOf('>', close)
    if (end < 0) break
    out += text.slice(at, open.index)
    at = end + 1
    SCRIPT_OPEN.lastIndex = at
  }
  return out + text.slice(at)
}

/**
 * Replace `pattern` with `separator` between words, and with nothing at either
 * end of `text`. A match that already spans a line break keeps the break.
 */
function separate(text: string, pattern: RegExp, separator: string): string {
  return text.replace(pattern, (match: string, offset: number) =>
    offset === 0 || offset + match.length === text.length
      ? ''
      : match.includes('\n')
        ? '\n'
        : separator
  )
}

/**
 * Each <li> given the marker its list shows, a bullet or its number, so a list
 * written in HTML keeps its items apart once the tags are gone.
 */
function withListMarkers(text: string): string {
  if (!/<li\b/i.test(text)) return text
  const lists: Array<{ ordered: boolean; count: number }> = []
  return text.replace(LIST_TAG, (tag: string, close: string, name: string) => {
    const kind = name.toLowerCase()
    if (kind !== 'li') {
      if (close) lists.pop()
      else lists.push({ ordered: kind === 'ol', count: 0 })
      return tag
    }
    if (close) return tag
    const list = lists[lists.length - 1]
    return `${tag}${list?.ordered ? `${++list.count}. ` : '\u2022 '}`
  })
}

/** An <img> tag as the markdown image it names, or nothing when it names no source. */
function imageMarkdown(tag: string): string {
  const src = IMG_SRC.exec(tag)?.[2].trim()
  return src ? `![](${src})` : ''
}

function htmlSegmentToMarkdown(text: string): string {
  const html = withListMarkers(withoutScripts(withoutComments(text))).replace(LINE_BREAK, '\n')
  return separate(separate(html, BLOCK_EDGE, '\n'), CELL_EDGE, ' ')
    .replace(IMG_TAG, imageMarkdown)
    .replace(ANCHOR, (whole: string, tag: string, label: string) => {
      const href = HREF.exec(tag)?.[1]
      return href ? `[${label}](${href})` : whole
    })
    .replace(BOLD_TAG, '**')
    .replace(ITALIC_TAG, '*')
    .replace(CODE_TAG, '`')
    .replace(STRIKE_TAG, '~~')
    .replace(HTML_TAG, '')
}

function htmlSegmentToPlainText(text: string): string {
  return decodeEntities(
    withoutScripts(withoutComments(text))
      .replace(LINE_BREAK, ' ')
      .replace(BLOCK_EDGE, ' ')
      .replace(CELL_EDGE, ' ')
      .replace(ANCHOR, (_whole: string, _tag: string, label: string) => label)
      .replace(BOLD_TAG, '')
      .replace(ITALIC_TAG, '')
      .replace(CODE_TAG, '')
      .replace(STRIKE_TAG, '')
      .replace(HTML_TAG, '')
  )
}

function mapOutsideCode(text: string, convert: (segment: string) => string): string {
  return text
    .split(/(`[^`\n]+`)/)
    .map((part, i) => (i % 2 === 1 ? part : convert(part)))
    .join('')
}

/**
 * Inline HTML as the markdown the span reader understands: <br> and block
 * edges become line breaks, <b>/<i>/<code>/<s>/<a>/<img> their markdown forms,
 * and other tags are dropped. Entities stay encoded until the spans are read,
 * so an encoded asterisk prints instead of starting emphasis. Code spans are
 * left as written.
 */
export function htmlToMarkdownInline(text: string): string {
  if (!text.includes('<')) return text
  return mapOutsideCode(text, htmlSegmentToMarkdown)
}

/** Inline HTML reduced to its text, for titles and other places that take no formatting. */
export function htmlToPlainText(text: string): string {
  const plain =
    text.includes('<') || text.includes('&') ? mapOutsideCode(text, htmlSegmentToPlainText) : text
  return plain.replace(/[ \t\r\n]+/g, ' ').trim()
}

/** Like htmlToPlainText, line by line: line breaks, <br> included, are kept. */
export function htmlToPlainLines(text: string): string {
  return text
    .replace(LINE_BREAK, '\n')
    .split('\n')
    .map(line => htmlToPlainText(line))
    .join('\n')
}

/** A heading's text without its optional closing run of hashes (`## Title ##`). */
export function withoutClosingHashes(text: string): string {
  const t = text.trimEnd()
  let end = t.length
  while (end > 0 && t[end - 1] === '#') end--
  if (end === t.length) return t
  if (end === 0) return ''
  return /\s/.test(t[end - 1]) ? t.slice(0, end).trimEnd() : t
}

/**
 * The paragraphs of a block quote, from its lines without their `>` marker. A
 * quoted line left empty ends a paragraph; the lines of one paragraph run on,
 * joined by a space. A quote with no text is one empty paragraph.
 */
export function quoteParagraphs(lines: string[]): string[] {
  const paragraphs: string[] = []
  let current: string[] = []
  for (const line of [...lines, '']) {
    if (line.trim()) {
      current.push(line)
    } else if (current.length > 0) {
      paragraphs.push(current.join(' '))
      current = []
    }
  }
  return paragraphs.length > 0 ? paragraphs : ['']
}

// No part may run into the next opening bracket or parenthesis: otherwise an
// unclosed image or link is rescanned to the end of the line from every
// opening, which takes minutes on a long line. As in CommonMark, a marker with
// a space on its inner side is not emphasis, so `5 * 3 * 2` keeps its
// asterisks, and no emphasis may span a marker of its own kind, which keeps
// every scan short.
const INLINE_TOKEN = new RegExp(
  [
    /!\[[^[\]\n]*\]\((?:[^()\n]|\([^()\n]*\))*\)/.source,
    /\[[^[\]\n]+\]\((?:https?:\/\/|mailto:)(?:[^\s()]|\([^\s()]*\))+\)/.source,
    /`[^`]+`/.source,
    ESCAPE.source,
    /(?<!\*)\*\*\*(?![\s*])[^*]*[^\s*\\]\*\*\*(?!\*)/.source,
    /\*\*(?![\s*])(?:[^*]|\*(?!\*))*?[^\s*\\]\*\*/.source,
    /(?<!\*)\*(?![\s*])[^*]*[^\s*\\]\*(?!\*)/.source,
    /~~(?![\s~])[^~\n]*[^\s~\\]~~/.source,
  ].join('|'),
  'g'
)

function unescapeMarkdown(text: string): string {
  return text.replace(new RegExp(ESCAPE.source, 'g'), escaped => escaped.slice(1))
}

/**
 * The file named between the parentheses of `![alt](...)`: `<my chart.png>`,
 * or `chart.png`, either with an optional title after it. The rest is read
 * whole, so a name with spaces written without angle brackets still names its file.
 */
export function imageTarget(inside: string): string {
  const t = inside.trim()
  const angle = /^<([^<>\n]*)>/.exec(t)
  const titled = /^(.*?)\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\))$/.exec(t)
  return decodeEntities(unescapeMarkdown(angle ? angle[1] : titled ? titled[1] : t))
}

/** One stretch of inline text and the formatting it carries. */
export interface InlineSpan {
  text: string
  bold?: boolean
  italics?: boolean
  strike?: boolean
  code?: boolean
  /** Target of a link; the span's text is its label. */
  link?: string
  /** An image written inside the text: the span's text is its alt text. */
  image?: string
}

type SpanStyle = Pick<InlineSpan, 'bold' | 'italics' | 'strike'>

/** Whether `span` can take on the text of `next`: both plain, formatted alike. */
function joins(span: InlineSpan, next: InlineSpan): boolean {
  return (
    span.link === undefined &&
    next.link === undefined &&
    span.image === undefined &&
    next.image === undefined &&
    !span.code &&
    !next.code &&
    !!span.bold === !!next.bold &&
    !!span.italics === !!next.italics &&
    !!span.strike === !!next.strike
  )
}

function appendSpans(source: string, style: SpanStyle, out: InlineSpan[]): void {
  const pattern = new RegExp(INLINE_TOKEN)
  let at = 0
  const plain = (text: string) => {
    if (text) out.push({ ...style, text: decodeEntities(text) })
  }
  for (let m = pattern.exec(source); m; m = pattern.exec(source)) {
    plain(source.slice(at, m.index))
    const token = m[0]
    if (token.startsWith('![')) {
      const split = token.indexOf('](')
      out.push({
        ...style,
        text: decodeEntities(unescapeMarkdown(token.slice(2, split))),
        image: imageTarget(token.slice(split + 2, -1)),
      })
    } else if (token.startsWith('[')) {
      const split = token.indexOf('](')
      out.push({
        ...style,
        text: decodeEntities(unescapeMarkdown(token.slice(1, split))),
        link: decodeEntities(token.slice(split + 2, -1)),
      })
    } else if (token.startsWith('`')) {
      out.push({ ...style, text: token.slice(1, -1), code: true })
    } else if (token.startsWith('\\')) {
      out.push({ ...style, text: token.slice(1) })
    } else if (token.startsWith('***')) {
      appendSpans(token.slice(3, -3), { ...style, bold: true, italics: true }, out)
    } else if (token.startsWith('**')) {
      appendSpans(token.slice(2, -2), { ...style, bold: true }, out)
    } else if (token.startsWith('~~')) {
      appendSpans(token.slice(2, -2), { ...style, strike: true }, out)
    } else {
      appendSpans(token.slice(1, -1), { ...style, italics: true }, out)
    }
    at = pattern.lastIndex
  }
  plain(source.slice(at))
}

/**
 * The spans of one block of markdown already through htmlToMarkdownInline:
 * **bold**, *italic*, ***both***, ~~strike~~, `code`, [links](https://...),
 * ![images](file.png) and backslash escapes.
 */
export function markdownSpans(markdown: string): InlineSpan[] {
  const spans: InlineSpan[] = []
  appendSpans(markdown, {}, spans)
  // An escape or an empty marker pair splits text that prints as one run.
  const joined: InlineSpan[] = []
  for (const span of spans) {
    const last = joined[joined.length - 1]
    if (last && joins(last, span)) last.text += span.text
    else joined.push(span)
  }
  return joined
}

/** The spans of one block of inline markdown that may carry HTML. */
export function inlineSpans(text: string): InlineSpan[] {
  return markdownSpans(htmlToMarkdownInline(text))
}
