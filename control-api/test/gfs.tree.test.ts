import { describe, expect, it } from 'vitest'
import {
  ChildRow,
  ChildrenStore,
  GfsTreeError,
  MAX_LIMIT,
  clampLimit,
  decodeCursor,
  encodeCursor,
  listChildrenPaged,
  toChildView,
} from '../src/gfs/tree.js'

function rid(n: number): string {
  return n.toString(16).padStart(32, '0')
}

function child(name: string, n: number): ChildRow {
  return {
    resourceId: rid(n),
    name,
    kind: 'directory',
    pathCache: `/${name}`,
    bytes: 0,
    version: 0,
  }
}

class FakeChildrenStore implements ChildrenStore {
  constructor(private rows: ChildRow[]) {}
  async listChildren(
    _drive: string,
    _parent: string,
    opts: { limit: number; afterName?: string; afterId?: string }
  ): Promise<ChildRow[]> {
    const sorted = [...this.rows].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : a.resourceId < b.resourceId ? -1 : 1
    )
    const filtered =
      opts.afterName === undefined
        ? sorted
        : sorted.filter(
            r =>
              r.name > opts.afterName! ||
              (r.name === opts.afterName && r.resourceId > (opts.afterId ?? ''))
          )
    return filtered.slice(0, opts.limit)
  }
}

describe('clampLimit / cursor', () => {
  it('clamps the limit and round-trips a cursor', () => {
    expect(clampLimit(undefined)).toBe(100)
    expect(clampLimit('25')).toBe(25)
    expect(clampLimit(99999)).toBe(MAX_LIMIT)
    expect(decodeCursor(encodeCursor('a', rid(1)))).toEqual({ n: 'a', i: rid(1) })
    expect(() => decodeCursor('@@@garbage@@@')).toThrow(GfsTreeError)
  })
})

describe('listChildrenPaged', () => {
  it('walks every child exactly once across pages (no count(*), no drops/dupes)', async () => {
    const names = ['a', 'b', 'c', 'd', 'e']
    const store = new FakeChildrenStore(names.map((n, i) => child(n, 100 + i)))
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 10; guard++) {
      const page = await listChildrenPaged(store, 'main', rid(1), { limit: 2, cursor })
      seen.push(...page.items.map(i => i.name))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(seen).toEqual(names)
  })

  it('nextCursor is null on the final page', async () => {
    const store = new FakeChildrenStore([child('only', 1)])
    const page = await listChildrenPaged(store, 'main', rid(1), { limit: 10 })
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).toBeNull()
  })

  it('child view exposes a canonical gfs:// URI', () => {
    const view = toChildView('main', child('org', 5))
    expect(view.gfsUri).toBe(`gfs://main/${rid(5)}`)
    expect(view.path).toBe('/org')
  })
})
