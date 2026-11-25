import {
  MERMAID_DIAGRAM_TYPE_NAMES,
  MERMAID_LABEL_FORBIDDEN_TAGS,
  MERMAID_LOCKED_CONFIG_KEYS,
  MERMAID_MAX_CODE_CHARS,
  MERMAID_MAX_EDGES,
  MERMAID_MAX_IMAGE_SIDE_PX,
  MERMAID_MAX_IMAGE_URL_CHARS,
} from '@constants/mermaid'
import type { DiagramDrawRequest, DiagramDrawResult, DiagramImage } from '../../../src/types'
import type { DiagramDrawerDeps } from './drawDiagram.types'

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'
const MAX_REASON_CHARS = 160
const MAX_LABEL_CHARS = 300

/**
 * The value with every `url(...)` that does not point inside the drawing, as
 * `url(#arrowhead)` does, replaced by `none`; an unclosed one runs to the end,
 * as CSS reads it. One pass, since a value can be as long as the code.
 */
function withoutOutsideUrls(value: string): string {
  const opening = /url\(/gi
  let kept = ''
  let from = 0
  for (let match = opening.exec(value); match; match = opening.exec(value)) {
    const close = value.indexOf(')', match.index + 4)
    const end = close === -1 ? value.length : close + 1
    const target = value.slice(match.index + 4, end).trimStart()
    const inside = target.startsWith('#') || /^['"]#/.test(target)
    kept += value.slice(from, match.index) + (inside ? value.slice(match.index, end) : 'none')
    from = end
    opening.lastIndex = end
  }
  return kept + value.slice(from)
}

/**
 * The diagram as an image: the SVG is re-serialized as XML, the form an image
 * accepts, and sized from its viewBox. Shown through `<img>`, it runs no
 * script, loads nothing and its stylesheet cannot reach the app.
 */
export function svgToDiagramImage(markup: string, diagramType = ''): DiagramImage {
  const svg = new DOMParser().parseFromString(markup, 'text/html').querySelector('svg')
  if (!svg) throw new Error('Mermaid drew nothing for this code')
  const [, , width = 0, height = 0] = (svg.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (!(width > 0) || !(height > 0)) throw new Error('Mermaid drew a diagram with no size')
  const imageWidth = Math.ceil(width)
  const imageHeight = Math.ceil(height)
  svg.setAttribute('width', String(imageWidth))
  svg.setAttribute('height', String(imageHeight))
  svg.removeAttribute('style')
  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    // Labels are HTML with a literal `xmlns` attribute; the serializer declares
    // their namespace itself, and some serializers would write it twice.
    if (element.namespaceURI === XHTML_NAMESPACE) element.removeAttribute('xmlns')
    // Shown as an image, the drawing loads nothing. Dropping its links and
    // url() references is a second guard, not a full CSS sanitizer: @import,
    // escaped or image-set() URLs stay, and only the image keeps them inert.
    for (const { name, value } of Array.from(element.attributes)) {
      const linksOut = (name === 'href' || name === 'xlink:href') && !value.startsWith('#')
      if (linksOut) {
        element.removeAttribute(name)
        continue
      }
      const cleaned = withoutOutsideUrls(value)
      if (cleaned !== value) element.setAttribute(name, cleaned)
    }
  }
  for (const style of svg.querySelectorAll('style')) {
    style.textContent = withoutOutsideUrls(style.textContent ?? '')
  }
  const xml = new XMLSerializer().serializeToString(svg)
  return {
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`,
    width: imageWidth,
    height: imageHeight,
    label: imageLabel(svg, diagramType),
  }
}

/**
 * The text alternative: the diagram's own accessible title and description,
 * or its kind and the words in it, so a screen reader still gets the content.
 */
function imageLabel(svg: SVGSVGElement, diagramType: string): string {
  const own = [svg.querySelector(':scope > title'), svg.querySelector(':scope > desc')]
    .map(node => node?.textContent?.trim() ?? '')
    .filter(Boolean)
    .join('. ')
  if (own) return own.slice(0, MAX_LABEL_CHARS)
  const kind = MERMAID_DIAGRAM_TYPE_NAMES[diagramType] ?? 'Diagram'
  const words = new Set<string>()
  for (const node of svg.querySelectorAll('text, foreignObject')) {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (text) words.add(text)
  }
  const label = words.size ? `${kind}: ${Array.from(words).join(', ')}` : kind
  return label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label
}

/**
 * The text without its closing spaces, colons and dots. A loop, not a regular
 * expression: the text can be as long as the code.
 */
function withoutClosingPunctuation(text: string): string {
  let end = text.length
  while (end > 0 && /[\s:.]/.test(text.charAt(end - 1))) end -= 1
  return text.slice(0, end)
}

/** The first line of Mermaid's error, which names the problem and its line. */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const line = withoutClosingPunctuation(
    (message.split('\n').find(part => part.trim()) ?? '').trim()
  )
  if (!line) return 'Mermaid could not read the code'
  return line.length > MAX_REASON_CHARS ? `${line.slice(0, MAX_REASON_CHARS - 1)}…` : line
}

/**
 * Draws one diagram: Mermaid at its strict level with the config locked
 * against the diagram, laid out in this page and returned as an image. The
 * main process sends one diagram at a time.
 */
export function createDiagramDrawer(
  deps: DiagramDrawerDeps
): (request: DiagramDrawRequest) => Promise<DiagramDrawResult> {
  let renders = 0
  return async request => {
    if (request.code.length > MERMAID_MAX_CODE_CHARS) {
      return { ok: false, reason: 'The diagram is too long' }
    }
    const id = `diagram-${++renders}`
    const host = document.createElement('div')
    host.style.width = `${request.width}px`
    try {
      deps.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        secure: [...MERMAID_LOCKED_CONFIG_KEYS],
        dompurifyConfig: { FORBID_TAGS: [...MERMAID_LABEL_FORBIDDEN_TAGS] },
        theme: request.theme === 'light' ? 'default' : 'dark',
        fontFamily: request.fontFamily,
        maxTextSize: MERMAID_MAX_CODE_CHARS,
        maxEdges: MERMAID_MAX_EDGES,
        suppressErrorRendering: true,
      })
      document.body.appendChild(host)
      const { svg, diagramType } = await deps.mermaid.render(id, request.code, host)
      const image = svgToDiagramImage(svg, diagramType)
      // Checked here, so a drawing too large to show is never sent to the app.
      const tooLarge =
        image.src.length > MERMAID_MAX_IMAGE_URL_CHARS ||
        image.width > MERMAID_MAX_IMAGE_SIDE_PX ||
        image.height > MERMAID_MAX_IMAGE_SIDE_PX
      if (tooLarge) return { ok: false, reason: 'The drawing is too large' }
      if (!(await deps.decodes(image.src))) {
        return { ok: false, reason: 'The drawing is not a valid image' }
      }
      return { ok: true, image }
    } catch (error) {
      return { ok: false, reason: reasonOf(error) }
    } finally {
      host.remove()
      document.getElementById(id)?.remove()
      document.getElementById(`d${id}`)?.remove()
    }
  }
}
