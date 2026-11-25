import type { Root, RootContent } from 'hast'
import { fromHtmlIsomorphic } from 'hast-util-from-html-isomorphic'
import katex from 'katex'
import {
  CHAT_MATH_CACHE_MAX_SOURCE_CHARS,
  CHAT_MATH_MAX_DEPTH,
  CHAT_MATH_MAX_EXPAND,
  CHAT_MATH_MAX_HTML_CHARS,
  CHAT_MATH_MAX_HTML_PER_MESSAGE,
  CHAT_MATH_MAX_SIZE_EM,
  CHAT_MATH_MAX_SOURCE_CHARS,
} from '@constants/chatRendering'
import { isDisplayMathCode, isMathCode } from './chatMarkdownTransforms'
import { elementText } from './chatMessageSemantics'

/** `size`: length of the generated HTML. */
export type ChatMathResult = Readonly<
  { ok: true; tree: Root; size: number } | { ok: false; reason: string }
>

// `maxExpand` counts expansions, not their output, so user macros could still grow without bound.
const REFUSED_COMMAND =
  /\\(?:def|gdef|edef|xdef|let|futurelet|global|newcommand|renewcommand|providecommand|message|errmessage|show)(?![A-Za-z])/

/** `%` starts a comment in LaTeX; in replies it is a percent sign. */
function withoutComments(source: string): string {
  return source.replace(/\\[\s\S]|%/g, match => (match === '%' ? '\\%' : match))
}

function depthOf(root: Root): number {
  let deepest = 0
  const pending: Array<[Root | RootContent, number]> = [[root, 0]]
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [node, depth] = next
    deepest = Math.max(deepest, depth)
    if ('children' in node) for (const child of node.children) pending.push([child, depth + 1])
  }
  return deepest
}

const drawn = new Map<string, ChatMathResult>()
let cachedSourceChars = 0

function draw(source: string, display: boolean): ChatMathResult {
  if (source.length > CHAT_MATH_MAX_SOURCE_CHARS) {
    return { ok: false, reason: 'the formula is too long to draw' }
  }
  if (REFUSED_COMMAND.test(source)) {
    return { ok: false, reason: 'the chat does not draw formulas that define macros' }
  }
  try {
    // `trust: false` rejects \href, \url, \includegraphics and \html*.
    const html = katex.renderToString(withoutComments(source), {
      displayMode: display,
      output: 'htmlAndMathml',
      throwOnError: true,
      trust: false,
      strict: 'ignore',
      maxExpand: CHAT_MATH_MAX_EXPAND,
      maxSize: CHAT_MATH_MAX_SIZE_EM,
    })
    if (html.length > CHAT_MATH_MAX_HTML_CHARS) {
      return { ok: false, reason: 'the formula is too large to draw' }
    }
    const tree = fromHtmlIsomorphic(html, { fragment: true })
    // Deeply nested boxes can overflow the layout stack.
    if (depthOf(tree) > CHAT_MATH_MAX_DEPTH) {
      return { ok: false, reason: 'the formula is nested too deeply to draw' }
    }
    return { ok: true, tree, size: html.length }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof katex.ParseError ? error.rawMessage : 'KaTeX could not draw it',
    }
  }
}

/** LRU cache bounded by source length: a short formula can expand into a large tree. */
export function renderChatMath(source: string, display: boolean): ChatMathResult {
  const key = formulaKey(source, display)
  const cached = drawn.get(key)
  if (cached) {
    drawn.delete(key)
    drawn.set(key, cached)
    return cached
  }
  const result = draw(source, display)
  drawn.set(key, result)
  cachedSourceChars += source.length
  for (const [oldest] of drawn) {
    if (cachedSourceChars <= CHAT_MATH_CACHE_MAX_SOURCE_CHARS || drawn.size <= 1) break
    drawn.delete(oldest)
    cachedSourceChars -= oldest.length - oldest.indexOf('\u0000') - 1
  }
  return result
}

export function formulaKey(source: string, display: boolean): string {
  return `${display ? 'display' : 'inline'}\u0000${source}`
}

/** Keys of the formulas that exceed the drawing budget of their message. */
export function formulasPastBudget(tree: Root): ReadonlySet<string> {
  const past = new Set<string>()
  const kept = new Set<string>()
  let size = 0
  const visit = (node: Root | RootContent, inBlock: boolean) => {
    if (node.type === 'element' && isMathCode(node)) {
      const source = elementText(node).trim()
      const display = inBlock || isDisplayMathCode(node)
      const key = formulaKey(source, display)
      // Repeats of an already drawn formula get twice the budget.
      const limit = CHAT_MATH_MAX_HTML_PER_MESSAGE * (kept.has(key) ? 2 : 1)
      const result = size > limit ? null : renderChatMath(source, display)
      if (result?.ok) size += result.size
      if (size > limit) past.add(key)
      else kept.add(key)
      return
    }
    if (!('children' in node)) return
    const block = node.type === 'element' && node.tagName === 'pre'
    node.children.forEach(child => visit(child, block))
  }
  visit(tree, false)
  return past
}
