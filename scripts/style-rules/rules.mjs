/**
 * Style enforcement rules for Clerum frontend apps.
 *
 * Each rule has:
 *   - id: stable identifier (used in error messages and ignore comments)
 *   - severity: 'error' (fails commit/CI) or 'warn' (lists, does not fail)
 *   - applies(file): predicate — does this rule apply to this file path?
 *   - check({ file, content, lines }): returns array of { line, message }
 *
 * Rules are intentionally kept narrow and project-scoped. Provider-neutral
 * shared and application guidance lives under `docs/agents/`; Desktop visual
 * patterns live in `desktop-app/ui/docs/STYLE_STANDARDIZATION.md`.
 */

const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/
const FONT_SIZE_RAW = /^[^/*]*\bfont-size\s*:\s*(?:0|\d*\.?\d+(?:px|rem|em))/
const STRING_HEX = /['"]\s*#[0-9a-fA-F]{3,8}\s*['"]/
const STYLE_PROP_OPEN = /\bstyle=\{\{/
const MOTIONLESS_HOVER_PROPS = new Set(['filter', 'transform'])

const DESKTOP_UI_PREFIX = 'desktop-app/ui/'
const WEB_APP_PREFIXES = ['control-ui/', 'profile-ui/']
const WEB_APP_SOURCE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx']
const WEB_APP_STYLE_EXTENSIONS = ['.css']
const WEB_APP_NON_PRODUCTION_SEGMENTS = [
  '/__tests__/',
  '/e2e/',
  '/fixtures/',
  '/mocks/',
  '/test/',
  '/tests/',
]
const WEB_LEGACY_TABLE_PATTERNS = [
  {
    pattern: /\bcu-expandable-table\b|\bcu-expandable-row__[^\s'"`}]*/,
    message: 'retired Control UI expandable-table class',
  },
  {
    pattern: /\bmembers-table(?:__[a-z0-9-]+)?\b/,
    message: 'retired Profile UI members-table class',
  },
  {
    pattern: /(?:\b|\/)EditableList(?:\b|\/)/,
    message: 'retired Profile UI EditableList component',
  },
  {
    pattern: /(?:\b|\/)LlmSecretsSubTabs(?:\b|\/)/,
    message: 'retired Control UI LlmSecretsSubTabs component',
  },
  {
    pattern: /(?:from\s+['"][^'"]*\/RowActions['"]|<RowActions(?:\s|\/|>))/,
    message: 'retired Control UI RowActions component',
  },
  {
    pattern: /(?:from\s+['"][^'"]*\/GrantsPanel['"]|<GrantsPanel(?:\s|\/|>))/,
    message: 'retired Control UI GrantsPanel component',
  },
  {
    pattern: /from\s+['"][^'"]*\/tableSort['"]/,
    message: 'retired app-local tableSort helper',
  },
]

// Files where defining hex color tokens is the whole point.
const TOKEN_FILES = ['desktop-app/ui/src/styles/tokens.css']

// Pre-refactor component CSS files. New rules MUST NOT be added; existing
// rules grandfathered. See STYLE_STANDARDIZATION.md §6.
const LEGACY_CSS_ALLOWLIST = [
  'desktop-app/ui/src/components/ChatListPanel.css',
  'desktop-app/ui/src/components/ProgressStepper.css',
  'desktop-app/ui/src/components/ArtifactsBadge.css',
]

// The only `.css` files allowed under desktop-app/ui/. Anything else triggers
// `da-no-new-component-css`.
const ALLOWED_DESKTOP_CSS = new Set([
  'desktop-app/ui/src/styles.css',
  'desktop-app/ui/src/styles/tokens.css',
  ...LEGACY_CSS_ALLOWLIST,
])

// Per-file inline-style escape hatches (line/file). Used for genuinely
// dynamic positioning where a CSS class can't carry runtime values.
// Each entry: file path -> array of substring matches that the line must
// contain to be treated as legitimate.
const INLINE_STYLE_DYNAMIC_HINTS = [
  // Anything containing `--da-grid-cols` is the documented exception.
  '--da-grid-cols',
  // Popup positioning at runtime coords:
  'fleetMenuPosition',
  'sessionMenuPosition',
  // Stacking layer computed from list index:
  'zIndex: visible.length',
  // Data-driven stacked-bar segment width (context-window breakdown):
  '--seg-width',
]

function isCssTarget(file) {
  return file.startsWith(DESKTOP_UI_PREFIX) && file.endsWith('.css')
}

function isTsxTarget(file) {
  if (!file.startsWith(DESKTOP_UI_PREFIX)) return false
  // Skip ambient type declarations — they don't render JSX and frequently
  // include code-shaped JSDoc examples that trigger false positives.
  if (file.endsWith('.d.ts')) return false
  return file.endsWith('.tsx') || file.endsWith('.ts')
}

function isWebProductionSource(file) {
  if (!WEB_APP_PREFIXES.some(prefix => file.startsWith(prefix))) return false
  if (!WEB_APP_SOURCE_EXTENSIONS.some(extension => file.endsWith(extension))) return false
  if (file.endsWith('.d.ts')) return false
  return !WEB_APP_NON_PRODUCTION_SEGMENTS.some(segment => file.includes(segment))
}

function isWebProductionStyle(file) {
  if (!WEB_APP_PREFIXES.some(prefix => file.startsWith(prefix))) return false
  if (!WEB_APP_STYLE_EXTENSIONS.some(extension => file.endsWith(extension))) return false
  return !WEB_APP_NON_PRODUCTION_SEGMENTS.some(segment => file.includes(segment))
}

function collectHoverMotionViolations(line, lineNumber) {
  const violations = []
  for (const declarationText of line.split(';')) {
    const declaration = declarationText.match(/(?:^|[\s{])([a-z-]+)\s*:\s*([^;{}]+)/)
    if (!declaration) continue
    const [, prop, rawValue] = declaration
    if (MOTIONLESS_HOVER_PROPS.has(prop) && rawValue.trim() !== 'none') {
      violations.push({
        line: lineNumber,
        message: `${prop} in :hover block — use background, border, text color, or shadow instead`,
      })
    }
  }
  return violations
}

export const rules = [
  {
    id: 'web-no-app-local-table',
    severity: 'error',
    description:
      'Control UI and Profile UI production views must use @clerum/frontend-components instead of raw app-local table markup.',
    applies(file) {
      return isWebProductionSource(file)
    },
    check({ lines }) {
      const violations = []
      lines.forEach((line, i) => {
        if (/<table(?:\s|>)/.test(line)) {
          violations.push({
            line: i + 1,
            message:
              'raw <table> creates a parallel table shell — compose @clerum/frontend-components DataTable primitives',
          })
        }
      })
      return violations
    },
  },
  {
    id: 'web-no-app-local-table-viewport',
    severity: 'error',
    description:
      'Control UI and Profile UI production views must render standardized table viewports through TableViewport.',
    applies(file) {
      return isWebProductionSource(file) || isWebProductionStyle(file)
    },
    check({ lines }) {
      const violations = []
      lines.forEach((line, i) => {
        if (/\beft-table-viewport(?:--[a-z0-9-]+)?\b/.test(line)) {
          violations.push({
            line: i + 1,
            message:
              'direct viewport-class authorship bypasses the shared boundary — use @clerum/frontend-components TableViewport',
          })
        }
      })
      return violations
    },
  },
  {
    id: 'web-no-retired-table-pattern',
    severity: 'error',
    description:
      'Retired Control/Profile table wrappers and inline-expansion families must not regain production consumers.',
    applies(file) {
      return isWebProductionSource(file)
    },
    check({ lines }) {
      const violations = []
      lines.forEach((line, i) => {
        for (const legacy of WEB_LEGACY_TABLE_PATTERNS) {
          if (legacy.pattern.test(line)) {
            violations.push({
              line: i + 1,
              message: `${legacy.message} — use @clerum/frontend-components`,
            })
          }
        }
      })
      return violations
    },
  },
  {
    id: 'da-no-hex-in-css',
    severity: 'error',
    description:
      'CSS color values must come from tokens. Define hex in tokens.css and consume via var(--token).',
    applies(file) {
      if (!isCssTarget(file)) return false
      if (TOKEN_FILES.includes(file)) return false
      if (LEGACY_CSS_ALLOWLIST.includes(file)) return false
      return true
    },
    check({ lines }) {
      const violations = []
      lines.forEach((line, i) => {
        // Skip comment-only lines (cheap heuristic).
        const trimmed = line.trim()
        if (trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('//')) {
          return
        }
        if (HEX_LITERAL.test(line)) {
          violations.push({
            line: i + 1,
            message: `hex literal in CSS — promote to tokens.css and use var(--token)`,
          })
        }
      })
      return violations
    },
  },
  {
    id: 'da-no-raw-font-size',
    severity: 'error',
    description:
      'font-size must come from the typography scale (var(--font-size-*)). The scale is defined once in tokens.css.',
    applies(file) {
      if (!isCssTarget(file)) return false
      if (TOKEN_FILES.includes(file)) return false
      // Legacy files are allowed to keep existing values, but new font-size
      // declarations are still discouraged. Treat as warn for legacy.
      return true
    },
    check({ file, lines }) {
      const violations = []
      const isLegacy = LEGACY_CSS_ALLOWLIST.includes(file)
      lines.forEach((line, i) => {
        if (FONT_SIZE_RAW.test(line)) {
          violations.push({
            line: i + 1,
            message: isLegacy
              ? `raw font-size in legacy file — migrate to var(--font-size-*) when touching this surface`
              : `raw font-size — use var(--font-size-{2xs|xs|sm|md|lg|xl|2xl|3xl|4xl})`,
            // Override severity for legacy files
            severityOverride: isLegacy ? 'warn' : undefined,
          })
        }
      })
      return violations
    },
  },
  {
    id: 'da-no-new-component-css',
    severity: 'error',
    description:
      'No new component-level .css files. All shared styles live in src/styles.css; tokens in src/styles/tokens.css.',
    applies(file) {
      return file.startsWith(DESKTOP_UI_PREFIX) && file.endsWith('.css')
    },
    check({ file }) {
      if (ALLOWED_DESKTOP_CSS.has(file)) return []
      return [
        {
          line: 1,
          message: `new component-level CSS file is not allowed. Add rules to src/styles.css. See desktop-app/ui/docs/STYLE_STANDARDIZATION.md §6.`,
        },
      ]
    },
  },
  {
    id: 'da-no-hover-motion',
    severity: 'error',
    description:
      'Desktop hover states must not move, scale, or filter controls. Use background, border, text color, or shadow token changes instead.',
    applies(file) {
      return isCssTarget(file)
    },
    check({ lines }) {
      const violations = []
      let selectorBuffer = ''
      let inHoverBlock = false
      let blockDepth = 0

      lines.forEach((line, i) => {
        const trimmed = line.trim()

        if (!inHoverBlock && blockDepth > 0) {
          blockDepth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
          if (blockDepth <= 0) {
            blockDepth = 0
            selectorBuffer = ''
          }
          return
        }

        if (!inHoverBlock) {
          if (!trimmed || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
            selectorBuffer = ''
            return
          }
          selectorBuffer = selectorBuffer ? `${selectorBuffer} ${trimmed}` : trimmed
          if (!trimmed.includes('{')) return
          inHoverBlock = selectorBuffer.includes(':hover')
          blockDepth =
            (selectorBuffer.match(/\{/g) || []).length - (selectorBuffer.match(/\}/g) || []).length
          if (inHoverBlock) {
            violations.push(...collectHoverMotionViolations(selectorBuffer, i + 1))
          }
          selectorBuffer = ''
          if (blockDepth <= 0) {
            inHoverBlock = false
          }
          return
        }

        violations.push(...collectHoverMotionViolations(line, i + 1))

        blockDepth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
        if (blockDepth <= 0) {
          inHoverBlock = false
          blockDepth = 0
        }
      })

      return violations
    },
  },
  {
    id: 'da-no-hex-in-tsx',
    severity: 'warn',
    description:
      'Hex color literals in TS/TSX should be replaced with token references unless the value is genuinely user-controlled or dynamic (e.g. annotation color picker initial value).',
    applies(file) {
      return isTsxTarget(file)
    },
    check({ lines }) {
      const violations = []
      lines.forEach((line, i) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
        if (STRING_HEX.test(line)) {
          violations.push({
            line: i + 1,
            message: `hex literal in TSX — review whether this should be a token reference`,
          })
        }
      })
      return violations
    },
  },
  {
    id: 'da-no-static-inline-style',
    severity: 'warn',
    description:
      'JSX inline styles are reserved for genuinely dynamic values. Static styling belongs in src/styles.css. The only documented inline-style use is `--da-grid-cols`.',
    applies(file) {
      return isTsxTarget(file)
    },
    check({ lines }) {
      const violations = []
      let inStyleBlock = false
      let blockStartLine = 0
      let blockBuffer = ''

      const flushIfClosed = i => {
        // Look for `}}` in the accumulated buffer past the opening `{{`.
        // This handles single-line `style={{ x: 1 }}` and multi-line forms.
        const openIdx = blockBuffer.indexOf('{{')
        if (openIdx === -1) return false
        const closeIdx = blockBuffer.indexOf('}}', openIdx + 2)
        if (closeIdx === -1) return false

        const isDynamic = INLINE_STYLE_DYNAMIC_HINTS.some(hint => blockBuffer.includes(hint))
        if (!isDynamic) {
          violations.push({
            line: blockStartLine,
            message: `inline style without --da-grid-cols or runtime values — move to a class in src/styles.css`,
          })
        }
        inStyleBlock = false
        blockBuffer = ''
        return true
      }

      lines.forEach((line, i) => {
        if (!inStyleBlock) {
          const match = line.match(STYLE_PROP_OPEN)
          if (!match) return
          inStyleBlock = true
          blockStartLine = i + 1
          blockBuffer = line.slice(match.index)
          // Same-line close: check immediately.
          flushIfClosed(i)
          return
        }
        blockBuffer += '\n' + line
        flushIfClosed(i)
      })
      return violations
    },
  },
]

/**
 * Return the rules that apply to a given file. Used by both the staged
 * runner (one file at a time) and the full-repo runner.
 */
export function rulesForFile(file) {
  return rules.filter(rule => rule.applies(file))
}
