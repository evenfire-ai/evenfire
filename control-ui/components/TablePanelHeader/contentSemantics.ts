import { Children, Fragment, isValidElement } from 'react'
import type { ReactNode } from 'react'

function flattenTitleNodes(title: ReactNode): ReactNode[] {
  return Children.toArray(title).flatMap(node =>
    isValidElement<{ children?: ReactNode }>(node) && node.type === Fragment
      ? flattenTitleNodes(node.props.children)
      : node
  )
}

export function splitTitleContent(title: ReactNode): {
  icon: ReactNode | null
  text: ReactNode[]
} {
  const nodes = flattenTitleNodes(title)
  const [first, ...remaining] = nodes
  const icon =
    remaining.length > 0 && isValidElement(first) && typeof first.type !== 'string' ? first : null

  return {
    icon,
    text: icon ? remaining : nodes,
  }
}

export function hasInteractiveDescendant(node: ReactNode): boolean {
  if (!isValidElement<{ children?: ReactNode }>(node)) return false
  if (node.type === Fragment) {
    return Children.toArray(node.props.children).some(hasInteractiveDescendant)
  }
  if (typeof node.type !== 'string') return true
  if (['a', 'button', 'input', 'select', 'textarea'].includes(node.type)) {
    return true
  }
  return Children.toArray(node.props.children).some(hasInteractiveDescendant)
}
