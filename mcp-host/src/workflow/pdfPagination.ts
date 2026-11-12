/** Page breaks: headings kept with what follows, running lines and page orientation. */
import { type Content, type Node } from 'pdfmake/interfaces'
import { TABLE_HEADER_ID } from './pdfBody'

/**
 * Style of the running header and footer. pdfmake lists their nodes among a
 * page's content when deciding page breaks, and this is how they are told apart.
 */
export const RUNNING_STYLE = 'running'

/** Top page margin; the running header is drawn inside it. */
export const PDF_TOP_MARGIN = 60

/**
 * pdfmake 0.2 calls this with the nodes that follow on the same page as its
 * second argument (the bundled typings describe 0.3's query object instead).
 * A heading with nothing after it on its page but more content on the next
 * page is moved there, so it is never left alone at the foot of a page.
 */
function keepHeadingWithNext(node: Node, followingOnPage: Node[]): boolean {
  if (
    node.headlineLevel !== 1 ||
    node.pageNumbers.length !== 1 ||
    node.pageNumbers[0] >= node.pages ||
    // Already at the top of its page: moving it would only leave a blank page.
    node.startPosition.top <= PDF_TOP_MARGIN + 20
  ) {
    return false
  }
  const following = followingOnPage.filter(next => next.style !== RUNNING_STYLE)
  const content = following.find(next => next.headlineLevel !== 1)
  if (!content) return true
  // A table whose header row did not fit is carried to the next page whole,
  // yet its cells are still listed on this one; only the header id says so.
  const headerId = tableHeaderId(content)
  if (headerId === undefined) return false
  const header = following.find(next => next.id === headerId)
  return header?.startPosition.pageNumber !== node.pageNumbers[0]
}

/**
 * pdfmake hands a pageBreakBefore callback the nodes after each node on its
 * page, which it collects by scanning the rest of the document for every node,
 * and each break the callback asks for lays the whole document out again. Past
 * these sizes the check costs more than a heading left at the foot of a page.
 */
const KEEP_WITH_NEXT_MAX_NODES = 1500
const KEEP_WITH_NEXT_MAX_MOVES = 10

/** How many nodes pdfmake lays out for `content`, counted up to `limit`. */
function countNodes(content: unknown, limit: number): number {
  let count = 0
  const visit = (node: unknown): void => {
    if (count > limit || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    count++
    const n = node as Record<string, unknown>
    for (const key of ['stack', 'ul', 'ol', 'columns']) visit(n[key])
    const table = n.table as { body?: unknown } | undefined
    if (table) visit(table.body)
  }
  visit(content)
  return count
}

/** keepHeadingWithNext for `content`, or undefined when the document is too large for it. */
export function headingKeeper(
  content: Content[]
): ((node: Node, following: Node[]) => boolean) | undefined {
  if (countNodes(content, KEEP_WITH_NEXT_MAX_NODES) > KEEP_WITH_NEXT_MAX_NODES) return undefined
  let moves = 0
  return (node: Node, following: Node[]) => {
    if (moves >= KEEP_WITH_NEXT_MAX_MOVES || !keepHeadingWithNext(node, following)) return false
    moves++
    return true
  }
}

/** The id buildTableNode gave a table's header; a right-to-left table has it last. */
function tableHeaderId(node: Node): string | undefined {
  const header = (node as { table?: { body?: Array<Array<{ id?: unknown }>> } }).table?.body?.[0]
  const id = Array.isArray(header)
    ? header.find(cell => typeof cell?.id === 'string')?.id
    : undefined
  return typeof id === 'string' && id.startsWith(TABLE_HEADER_ID) ? id : undefined
}

/** The spacer bodyToContent leaves for a blank line. */
export function isBlankLine(node: Content): boolean {
  return typeof node === 'object' && node !== null && 'text' in node && node.text === ''
}

/**
 * Put each landscape table on landscape pages and return to portrait after
 * it. A heading directly above such a table moves with it. Returns the
 * orientation the document starts in.
 */
export function applyPageOrientation(
  content: Content[],
  landscape: Set<Content>
): 'portrait' | 'landscape' {
  const previous = (i: number) => {
    let k = i - 1
    while (k >= 0 && isBlankLine(content[k])) k--
    return k
  }
  let initial: 'portrait' | 'landscape' = 'portrait'
  let current: 'portrait' | 'landscape' = 'portrait'
  for (let i = 0; i < content.length; i++) {
    if (isBlankLine(content[i])) continue
    const wanted = landscape.has(content[i]) ? 'landscape' : 'portrait'
    if (wanted === current) continue
    current = wanted
    let target = i
    const above = content[previous(i)] as { headlineLevel?: number } | undefined
    if (wanted === 'landscape' && above?.headlineLevel === 1) target = previous(i)
    // A break before the first node, or after the one that already ends the
    // cover page, would leave a blank page; those carry the orientation instead.
    const before = previous(target)
    if (before < 0) {
      initial = wanted
    } else if ((content[before] as { pageBreak?: string }).pageBreak === 'after') {
      Object.assign(content[before] as object, { pageOrientation: wanted })
    } else {
      Object.assign(content[target] as object, { pageBreak: 'before', pageOrientation: wanted })
    }
  }
  return initial
}
