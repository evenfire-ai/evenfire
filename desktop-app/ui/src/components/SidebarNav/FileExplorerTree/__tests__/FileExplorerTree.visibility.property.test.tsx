// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import fc, { type AsyncCommand } from 'fast-check'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
  accessibleResource,
  childView,
  gfsRouteFailureMessage,
  listAccessiblePage,
  listChildrenPage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { FileExplorerTree } from '..'

const mockAuthContext = vi.hoisted(() => ({
  isAuthenticated: true,
  me: { id: 'user-1', teamId: 'team-1' },
  runtimeConfigState: { envKey: 'test' },
  sessionGeneration: 7,
}))
vi.mock('@contexts/AuthContext', () => ({ useAuthContext: () => mockAuthContext }))

// Nested grants: a ⊃ b ⊃ c, plus an unrelated d. Any of them can also be a
// root, so b and c may render as several copies at once.
const RIDS = ['a', 'b', 'c', 'd'] as const
type Rid = (typeof RIDS)[number]
const CHILDREN: Record<Rid, Rid[]> = { a: ['b'], b: ['c'], c: [], d: [] }
const PARENT: Record<Rid, Rid | null> = { a: null, b: 'a', c: 'b', d: null }
const NAME_POOL = ['Kilo', 'Lima', 'Mike', 'November'] as const
const uri = (rid: Rid) => `gfs://main/${rid}`

interface Model {
  roots: Set<Rid>
  names: Record<Rid, string>
  expanded: Set<Rid>
  failing: boolean
}

interface Real {
  server: Model
  published: string[][]
  remount: () => void
}

function pathOf(rid: Rid, names: Record<Rid, string>): string {
  const segments: string[] = []
  for (let at: Rid | null = rid; at; at = PARENT[at]) segments.unshift(names[at])
  return `/${segments.join('/')}`
}

const byName = (names: Record<Rid, string>) => (left: Rid, right: Rid) =>
  names[left].localeCompare(names[right])

/** Pre-order walk of what the tree should show: every rendered, expanded folder. */
function renderedInstances(model: Model): { rid: Rid; expanded: boolean }[] {
  if (model.failing) return []
  const out: { rid: Rid; expanded: boolean }[] = []
  const visit = (rid: Rid) => {
    const expanded = model.expanded.has(rid)
    out.push({ rid, expanded })
    if (expanded) for (const child of [...CHILDREN[rid]].sort(byName(model.names))) visit(child)
  }
  for (const root of [...model.roots].sort(byName(model.names))) visit(root)
  return out
}

function expectedPublished(model: Model): string[] {
  const out: string[] = []
  for (const instance of renderedInstances(model)) {
    const folder = uri(instance.rid)
    if (instance.expanded && !out.includes(folder)) out.push(folder)
  }
  return out
}

function isRendered(model: Model, rid: Rid): boolean {
  return renderedInstances(model).some(instance => instance.rid === rid)
}

function refocusWindow() {
  act(() => {
    focusManager.setFocused(false)
    focusManager.setFocused(true)
  })
}

class ExpandCommand implements AsyncCommand<Model, Real> {
  constructor(readonly rid: Rid) {}
  check = (m: Readonly<Model>) => isRendered(m, this.rid) && !m.expanded.has(this.rid)
  async run(m: Model, r: Real) {
    m.expanded.add(this.rid)
    fireEvent.click(screen.getAllByRole('button', { name: `Expand ${m.names[this.rid]}` })[0]!)
    await settleAndCheck(m, r)
  }
  toString = () => `Expand(${this.rid})`
}

class CollapseCommand implements AsyncCommand<Model, Real> {
  constructor(readonly rid: Rid) {}
  check = (m: Readonly<Model>) => isRendered(m, this.rid) && m.expanded.has(this.rid)
  async run(m: Model, r: Real) {
    m.expanded.delete(this.rid)
    const copies = screen.getAllByRole('button', { name: `Collapse ${m.names[this.rid]}` })
    fireEvent.click(copies.at(-1)!)
    await settleAndCheck(m, r)
  }
  toString = () => `Collapse(${this.rid})`
}

class AddRootCommand implements AsyncCommand<Model, Real> {
  constructor(readonly rid: Rid) {}
  check = (m: Readonly<Model>) => !m.roots.has(this.rid)
  async run(m: Model, r: Real) {
    m.roots.add(this.rid)
    r.server.roots.add(this.rid)
    refocusWindow()
    await settleAndCheck(m, r)
  }
  toString = () => `AddRoot(${this.rid})`
}

class RemoveRootCommand implements AsyncCommand<Model, Real> {
  constructor(readonly rid: Rid) {}
  check = (m: Readonly<Model>) => m.roots.has(this.rid)
  async run(m: Model, r: Real) {
    m.roots.delete(this.rid)
    r.server.roots.delete(this.rid)
    refocusWindow()
    await settleAndCheck(m, r)
  }
  toString = () => `RemoveRoot(${this.rid})`
}

/** Renames the folders into another permutation: the sorted positions move, the gfsUris do not. */
class ReorderRootsCommand implements AsyncCommand<Model, Real> {
  constructor(readonly permutation: number[]) {}
  check = () => true
  async run(m: Model, r: Real) {
    const names = Object.fromEntries(
      RIDS.map((rid, index) => [rid, NAME_POOL[this.permutation[index]!]!])
    ) as Record<Rid, string>
    m.names = names
    r.server.names = { ...names }
    refocusWindow()
    await settleAndCheck(m, r)
  }
  toString = () => `ReorderRoots(${this.permutation.join(',')})`
}

class FocusRefetchErrorCommand implements AsyncCommand<Model, Real> {
  check = (m: Readonly<Model>) => !m.failing
  async run(m: Model, r: Real) {
    m.failing = true
    r.server.failing = true
    refocusWindow()
    await settleAndCheck(m, r)
  }
  toString = () => 'FocusRefetchError'
}

class RecoverCommand implements AsyncCommand<Model, Real> {
  check = (m: Readonly<Model>) => m.failing
  async run(m: Model, r: Real) {
    m.failing = false
    r.server.failing = false
    refocusWindow()
    await settleAndCheck(m, r)
  }
  toString = () => 'Recover'
}

/** Navigating away and back: the query cache survives, the tree's expansion does not. */
class RemountCommand implements AsyncCommand<Model, Real> {
  check = () => true
  async run(m: Model, r: Real) {
    m.expanded.clear()
    r.remount()
    await settleAndCheck(m, r)
  }
  toString = () => 'Remount'
}

let activeClient: QueryClient | null = null

async function settleAndCheck(model: Model, real: Real) {
  await waitFor(() => {
    expect(activeClient!.isFetching()).toBe(0)
    // The forest is on screen exactly when discovery succeeded.
    if (model.failing) expect(screen.queryByRole('tree', { name: 'Shared files' })).toBeNull()
    else if (model.roots.size > 0) screen.getByRole('tree', { name: 'Shared files' })
  })
  await act(async () => {})
  const published = real.published.at(-1) ?? []
  const expected = expectedPublished(model)
  // V1 + S1: exactly the folders backed by a rendered, expanded copy.
  expect(new Set(published)).toEqual(new Set(expected))
  // S2: one entry per folder however many copies are expanded.
  expect(published.length).toBe(new Set(published).size)
  // O1: first on-screen appearance sets the order (the watch-key truncation priority).
  expect(published).toEqual(expected)
}

function installServer(server: Model) {
  const failure = gfsRouteFailureMessage(
    client => client.listAccessible('session', { drive: 'main' }),
    500,
    { code: 'internal', message: 'discovery unavailable' }
  )
  const shape = (rid: Rid) => ({
    parentResourceId: PARENT[rid],
    path: pathOf(rid, server.names),
  })
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      auth: { getSessionGeneration: vi.fn(async () => 7) },
      gfs: {
        listAccessible: vi.fn(async () => {
          if (server.failing) throw new Error(await failure)
          return listAccessiblePage(
            [...server.roots].map(rid =>
              accessibleResource(rid, server.names[rid], 'directory', shape(rid))
            )
          )
        }),
        listChildren: vi.fn(async (resourceId: string) =>
          listChildrenPage(
            (CHILDREN[resourceId as Rid] ?? []).map(rid =>
              childView(rid, server.names[rid], 'directory', shape(rid))
            )
          )
        ),
        download: vi.fn(),
      },
    },
  })
}

const initialNames = () =>
  Object.fromEntries(RIDS.map((rid, index) => [rid, NAME_POOL[index]!])) as Record<Rid, string>

afterEach(() => {
  cleanup()
  focusManager.setFocused(undefined)
  vi.restoreAllMocks()
})

const ridArb = fc.constantFrom(...RIDS)
const commandArbs = [
  ridArb.map(rid => new ExpandCommand(rid)),
  ridArb.map(rid => new ExpandCommand(rid)),
  ridArb.map(rid => new CollapseCommand(rid)),
  ridArb.map(rid => new AddRootCommand(rid)),
  ridArb.map(rid => new RemoveRootCommand(rid)),
  fc
    .shuffledSubarray([0, 1, 2, 3], { minLength: 4, maxLength: 4 })
    .map(permutation => new ReorderRootsCommand(permutation)),
  fc.constant(new FocusRefetchErrorCommand()),
  fc.constant(new RecoverCommand()),
  fc.constant(new RemountCommand()),
]

describe('FileExplorerTree — published expanded folders match the rendered forest', () => {
  it('holds V1, S1, S2 and O1 at rest after any sequence of tree and server events', async () => {
    await fc.assert(
      fc.asyncProperty(fc.commands(commandArbs, { maxCommands: 18 }), async commands => {
        cleanup()
        const model: Model = {
          roots: new Set(RIDS),
          names: initialNames(),
          expanded: new Set(),
          failing: false,
        }
        const server: Model = {
          roots: new Set(RIDS),
          names: initialNames(),
          expanded: new Set(),
          failing: false,
        }
        installServer(server)
        const published: string[][] = []
        const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
        activeClient = queryClient
        let generation = 0
        const view = (key: number) => (
          <QueryClientProvider client={queryClient}>
            <FileExplorerTree
              key={key}
              onOpenFolder={vi.fn()}
              onOpenPreview={vi.fn()}
              pushToast={vi.fn()}
              onVisibleExpandedFoldersChange={uris => published.push(uris)}
            />
          </QueryClientProvider>
        )
        const { rerender } = render(view(generation))
        const real: Real = {
          server,
          published,
          remount: () => {
            generation += 1
            rerender(view(generation))
          },
        }
        await settleAndCheck(model, real)
        await fc.asyncModelRun(() => ({ model, real }), commands)
        queryClient.clear()
      }),
      { numRuns: 100 }
    )
  }, 120_000)
})
