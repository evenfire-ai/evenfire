// The limits the main process enforces too, from the module both sides share.
export {
  DIAGRAM_MAX_CODE_CHARS as MERMAID_MAX_CODE_CHARS,
  DIAGRAM_MAX_IMAGE_SIDE_PX as MERMAID_MAX_IMAGE_SIDE_PX,
  DIAGRAM_MAX_IMAGE_URL_CHARS as MERMAID_MAX_IMAGE_URL_CHARS,
  DIAGRAM_MAX_WIDTH_PX as MERMAID_MAX_WIDTH_PX,
  DIAGRAM_MIN_WIDTH_PX as MERMAID_MIN_WIDTH_PX,
} from '../../../src/diagramLimits'

/** Mermaid's own default limit on connections in one flowchart. */
export const MERMAID_MAX_EDGES = 500

/**
 * Drawn diagrams kept in memory, counted in characters of their code and
 * drawing. A drawing is ASCII, which takes a byte per character.
 */
export const MERMAID_CACHE_MAX_CHARS = 16 * 1024 * 1024

/** Wait before asking once more when the renderer, not the code, failed. */
export const MERMAID_RETRY_DELAY_MS = 1_000

/** Layout width for a diagram whose message has no width yet, such as a hidden chat. */
export const MERMAID_FALLBACK_WIDTH_PX = 640

/** A diagram starts drawing when it comes this close to the visible part of the chat. */
export const MERMAID_VIEWPORT_MARGIN = '600px 0px'

/**
 * Config keys that the diagram's own `%%{init}%%` or front matter cannot set:
 * Mermaid's secure defaults, plus the stylesheet, fonts, theme and sanitizer
 * settings, which could inject CSS, relax sanitizing or override the app theme.
 */
export const MERMAID_LOCKED_CONFIG_KEYS: readonly string[] = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'suppressErrorRendering',
  'maxEdges',
  'themeCSS',
  'fontFamily',
  'altFontFamily',
  'dompurifyConfig',
  'theme',
  'themeVariables',
  'darkMode',
  'arrowMarkerAbsolute',
]

/**
 * Tags removed from labels: Mermaid's default `style`, plus images, embeds,
 * form controls and SVG filters. Icons are plain SVG and stay.
 */
export const MERMAID_LABEL_FORBIDDEN_TAGS: readonly string[] = [
  'style',
  'img',
  'image',
  'picture',
  'video',
  'audio',
  'canvas',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'filter',
  'feBlend',
  'feColorMatrix',
  'feComponentTransfer',
  'feComposite',
  'feConvolveMatrix',
  'feDiffuseLighting',
  'feDisplacementMap',
  'feDropShadow',
  'feFlood',
  'feGaussianBlur',
  'feImage',
  'feMerge',
  'feMorphology',
  'feOffset',
  'feSpecularLighting',
  'feTile',
  'feTurbulence',
]

/** Names for the image's text alternative, by Mermaid's diagram type. */
export const MERMAID_DIAGRAM_TYPE_NAMES: Readonly<Record<string, string>> = {
  flowchart: 'Flowchart',
  'flowchart-v2': 'Flowchart',
  'flowchart-elk': 'Flowchart',
  sequence: 'Sequence diagram',
  class: 'Class diagram',
  classDiagram: 'Class diagram',
  state: 'State diagram',
  stateDiagram: 'State diagram',
  er: 'Entity relationship diagram',
  gantt: 'Gantt chart',
  pie: 'Pie chart',
  mindmap: 'Mind map',
  timeline: 'Timeline',
  quadrantChart: 'Quadrant chart',
  venn: 'Venn diagram',
  journey: 'User journey',
  gitGraph: 'Git graph',
  xychart: 'Chart',
  requirement: 'Requirement diagram',
  c4: 'C4 diagram',
  sankey: 'Sankey diagram',
  block: 'Block diagram',
  architecture: 'Architecture diagram',
  kanban: 'Kanban board',
  packet: 'Packet diagram',
  radar: 'Radar chart',
  treemap: 'Treemap',
}
