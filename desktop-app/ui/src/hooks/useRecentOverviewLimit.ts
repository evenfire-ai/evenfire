import { type RefObject, useLayoutEffect, useState } from 'react'
import { GFS_RECENT_FILES_VISIBLE_LIMIT } from '@constants/gfsBrowser'

/** Keep both overview destinations in view before showing more recent files. */
export function useRecentOverviewLimit(
  layoutRef: RefObject<HTMLDivElement | null>,
  active: boolean,
  fileCount: number,
  contentKey: string
): number {
  const [limit, setLimit] = useState(GFS_RECENT_FILES_VISIBLE_LIMIT)
  const [sizeRevision, setSizeRevision] = useState(0)

  useLayoutEffect(() => {
    const layout = layoutRef.current
    if (!active || !layout) return

    let { width, height } = layout.getBoundingClientRect()
    const onResize = () => {
      const next = layout.getBoundingClientRect()
      if (next.width === width && next.height === height) return
      width = next.width
      height = next.height
      setSizeRevision(revision => revision + 1)
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize)
    observer?.observe(layout)
    window.addEventListener('resize', onResize)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [active, layoutRef])

  useLayoutEffect(() => {
    setLimit(
      active && fileCount > GFS_RECENT_FILES_VISIBLE_LIMIT ? 10 : GFS_RECENT_FILES_VISIBLE_LIMIT
    )
  }, [active, contentKey, fileCount, sizeRevision])

  useLayoutEffect(() => {
    if (!active || limit !== 10) return
    const layout = layoutRef.current
    const home = layout?.querySelector('[data-gfs-overview-destination="home"]')
    const shared = layout?.querySelector('[data-gfs-overview-destination="shared"]')
    if (!layout || !home || !shared || layout.clientHeight === 0) {
      setLimit(GFS_RECENT_FILES_VISIBLE_LIMIT)
      return
    }

    const viewportBottom =
      layout.getBoundingClientRect().top + layout.clientTop + layout.clientHeight
    const destinationsFit = [home, shared].every(destination => {
      const bounds = destination.getBoundingClientRect()
      return bounds.height > 0 && bounds.bottom + layout.scrollTop <= viewportBottom
    })
    if (!destinationsFit) setLimit(GFS_RECENT_FILES_VISIBLE_LIMIT)
  }, [active, contentKey, layoutRef, limit, sizeRevision])

  return limit
}
