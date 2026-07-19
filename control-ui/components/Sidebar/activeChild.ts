import { isControlRouteSection } from '@constants/routes'
import type { SidebarChildItem } from './types'

export function activeSidebarChildHref(
  pathname: string,
  children: readonly SidebarChildItem[]
): string | undefined {
  return children
    .filter(child => isControlRouteSection(pathname, child.matchPath ?? child.href))
    .sort(
      (first, second) =>
        (second.matchPath ?? second.href).length - (first.matchPath ?? first.href).length
    )[0]?.href
}
