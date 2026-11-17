/**
 * Longer code stays a code block. A chat diagram of about 25 shapes needs some
 * 2,000 characters; the main process enforces its own copy of this limit.
 */
export const MERMAID_MAX_CODE_CHARS = 20_000

/** Mermaid's own default limit on connections in one flowchart. */
export const MERMAID_MAX_EDGES = 500

/** Layout widths the main process accepts; a message outside them is drawn at the nearest. */
export const MERMAID_MIN_WIDTH_PX = 100
export const MERMAID_MAX_WIDTH_PX = 4_000

/**
 * The largest drawing returned, as its data URL. A 20,000-character diagram
 * comes to about 3 MB at most; one of 25 shapes to 40 to 65 KB.
 */
export const MERMAID_MAX_IMAGE_URL_CHARS = 4 * 1024 * 1024

/** The longest side a drawing may have, in CSS pixels. */
export const MERMAID_MAX_IMAGE_SIDE_PX = 100_000

/** Drawn diagrams kept in memory, measured by the size of their images. */
export const MERMAID_CACHE_MAX_BYTES = 16 * 1024 * 1024

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
