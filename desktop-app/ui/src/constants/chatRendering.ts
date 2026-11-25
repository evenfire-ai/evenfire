// Formulas past any of these limits stay as code.
export const CHAT_MATH_MAX_SOURCE_CHARS = 1_500
export const CHAT_MATH_MAX_SOURCE_PER_MESSAGE = 20_000
export const CHAT_MATH_MAX_PER_MESSAGE = 100
export const CHAT_MATH_MAX_HTML_CHARS = 300_000
export const CHAT_MATH_MAX_HTML_PER_MESSAGE = 600_000
export const CHAT_MATH_MAX_DEPTH = 200
export const CHAT_MATH_MAX_CONTENT_DEPTH = 60

// KaTeX options.
export const CHAT_MATH_MAX_EXPAND = 1_000
export const CHAT_MATH_MAX_SIZE_EM = 20

export const CHAT_MATH_CACHE_MAX_SOURCE_CHARS = 40_000

// Code blocks past any of these limits stay without colors.
export const CHAT_CODE_HIGHLIGHT_MAX_CHARS = 20_000
export const CHAT_CODE_HIGHLIGHT_MAX_LINE_CHARS = 1_000
export const CHAT_CODE_HIGHLIGHT_MAX_SPACE_CHARS = 1_000
export const CHAT_CODE_HIGHLIGHT_MAX_EMBEDS = 20
export const CHAT_CODE_HIGHLIGHT_MAX_MESSAGE_CHARS = 30_000

export const CHAT_CODE_PLAIN_LANGUAGES = ['text', 'txt', 'plain', 'plaintext', 'mermaid', 'math']

export const CHAT_INLINE_HTML_MAX_DEPTH = 8
export const CHAT_INLINE_HTML_TAGS: ReadonlySet<string> = new Set([
  'del',
  'ins',
  'kbd',
  'mark',
  's',
  'sub',
  'sup',
  'u',
])

export const CHAT_DATA_IMAGE_SRC = /^data:image\/(?:png|gif|jpeg|webp);base64,[a-z0-9+/=\s]+$/i
export const CHAT_IMAGE_MAX_PIXELS = 50_000_000
export const CHAT_GFS_IMAGE_MAX_PER_MESSAGE = 8
export const CHAT_GFS_DOWNLOAD_CONCURRENCY = 3
export const CHAT_GFS_DOWNLOAD_TIMEOUT_MS = 60_000

export const CHAT_LINKED_FILE_PREVIEW_LIMIT = 3
export const CHAT_GENERATED_FILE_PREVIEW_LIMIT = 3
export const CHAT_GENERATED_FILE_PREVIEW_KINDS: ReadonlySet<string> = new Set(['image', 'markdown'])
export const CHAT_FILE_PREVIEW_IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const CHAT_FILE_PREVIEW_TEXT_MAX_BYTES = 2 * 1024 * 1024
export const CHAT_FILE_PREVIEW_VIEWPORT_MARGIN = '600px 0px'
export const CHAT_FILE_PREVIEW_FOLLOW_MS = 4_000

// Longer text files show their beginning.
export const CHAT_FILE_PREVIEW_TEXT_MAX_CHARS = 200_000
export const CHAT_FILE_PREVIEW_TEXT_MAX_LINES = 5_000
export const CHAT_FILE_PREVIEW_BLOCK_MAX_CHARS = 4_000

// Markdown and JSON files past any of these limits show as plain text.
export const CHAT_FILE_PREVIEW_MARKDOWN_MAX_CHARS = 100_000
export const CHAT_FILE_PREVIEW_MARKDOWN_MAX_ELEMENTS = 15_000
export const CHAT_FILE_PREVIEW_MARKDOWN_TIMEOUT_MS = 4_000
export const CHAT_FILE_PREVIEW_MAX_LAYOUT_COST = 15_000
export const CHAT_FILE_PREVIEW_MARKDOWN_CONCURRENCY = 2

// Tables are cut where they pass any of these limits.
export const CHAT_FILE_PREVIEW_TABLE_MAX_ROWS = 200
export const CHAT_FILE_PREVIEW_TABLE_MAX_COLUMNS = 30
export const CHAT_FILE_PREVIEW_TABLE_MAX_CELL_CHARS = 2_000
export const CHAT_FILE_PREVIEW_TABLE_MAX_CHARS = 200_000
export const CHAT_FILE_PREVIEW_TABLE_MAX_LAYOUT_COST = 8_000

// Cells of all the tables in one Markdown text.
export const CHAT_TABLE_MAX_CELLS = 50_000
