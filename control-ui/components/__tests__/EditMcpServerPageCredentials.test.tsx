import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ToastProvider } from '@components/Toast'
import EditMcpServerPage from '../../app/mcp-servers/[name]/edit/page'
import {
  createMcpSecret,
  getContexts,
  getMcpServer,
  getMcpServers,
  updateMcpSecret,
} from '../../lib/api'
import type { McpServerCondition, McpServerResource } from '../../lib/api'
import {
  secretFound,
  secretMissingKey,
  secretNotFound,
  syntheticCondition,
} from './fixtures/secretResolvedConditions'

// ─── R1-H2: drive the REAL page, not the component in isolation ────────────
//
// The component tests inject `surface`/`recipeOwned` directly and the resolver
// tests call the resolver directly, so NEITHER covers the wiring in between.
// The reviewer reproduced that gap three times: deleting the page's `surface`
// prop left both changed suites green, resolving only the first condition left
// the resolver suite green, and — round 2 — coupling the page's `recipeOwned`
// to `status.conditions.length === 0` left all 69 changed tests green.
//
// These tests close it by rendering the edit page against producer-shaped
// getMcpServer() responses and asserting the UI an operator would actually see.
// Nothing here passes `surface` or `recipeOwned` by hand — the page must derive
// both from the McpServer it loaded — and every condition comes from the shared
// producer builder (./fixtures/secretResolvedConditions), so a drift in the HCC
// is a one-place fix rather than a hunt through hand-written literals.

const SERVER_NAME = 'linear-connector'
const SECRET_NAME = 'linear-credentials'
const NAMESPACE = 'mcp-server'

const navigation = vi.hoisted(() => ({
  params: { name: 'linear-connector' },
  push: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useParams: () => navigation.params,
  useRouter: () => ({ push: navigation.push }),
}))

vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return {
    ...actual,
    getContexts: vi.fn(),
    getMcpServer: vi.fn(),
    getMcpServers: vi.fn(),
    updateMcpServer: vi.fn(),
    updateMcpSecret: vi.fn(),
    createMcpSecret: vi.fn(),
  }
})

const mockGetMcpServer = vi.mocked(getMcpServer)
const mockGetMcpServers = vi.mocked(getMcpServers)
const mockGetContexts = vi.mocked(getContexts)
const mockUpdateMcpSecret = vi.mocked(updateMcpSecret)
const mockCreateMcpSecret = vi.mocked(createMcpSecret)

const CONNECTOR_IMAGE = 'ghcr.io/acme/linear-mcp:1.4.0'

/**
 * An McpServer as `GET /admin/mcp-servers/:name` returns it, including the
 * `spec.envSecret` the page has to narrow and the `status` the resolver has to
 * reduce.
 *
 * `status` is passed through EXACTLY as given, including `undefined`: the
 * connector-just-created race leaves the subresource absent altogether, which
 * is a different shape from `{ conditions: [] }` and has to be testable as one.
 */
function mcpServer(options: {
  managed?: boolean
  status?: { conditions?: McpServerCondition[] }
}): McpServerResource {
  return {
    metadata: { name: SERVER_NAME, namespace: NAMESPACE },
    spec: {
      image: CONNECTOR_IMAGE,
      contextRef: 'default',
      ...(options.managed === undefined ? {} : { managed: options.managed }),
      envSecret: {
        name: SECRET_NAME,
        keys: [
          { secretKey: 'api-key', envVar: 'LINEAR_API_KEY' },
          { secretKey: 'workspace-id', envVar: 'LINEAR_WORKSPACE' },
        ],
      },
    },
    ...(options.status === undefined ? {} : { status: options.status }),
  }
}

/** Renders the page and waits for its initial getMcpServer() to settle. */
async function renderPage(server: McpServerResource) {
  mockGetMcpServer.mockResolvedValue(server)
  render(
    <ToastProvider>
      <EditMcpServerPage />
    </ToastProvider>
  )
  // The credentials tab owns this heading and renders only after
  // getMcpServer() resolves. The current edit-page layout no longer repeats
  // the image in this tab, so use the credential section itself as the loaded
  // anchor rather than a detail rendered by the egress tab.
  await screen.findByRole('heading', { name: /^(Update|Set) credentials$/ })
}

/** The credential panel, scoped so "no submit control" means no control in
 *  THIS section rather than none on a page that also has Save egress/Cancel. */
function credentialPanel(): HTMLElement {
  const heading = screen.getByRole('heading', { name: /^(Update|Set) credentials$/ })
  const section = heading.closest('section')
  if (!section) throw new Error('credential FormSection not found')
  return section
}

/**
 * Drives the LATE-DISCOVERY journey: fill PARTIAL rotate data (one of the two
 * declared keys), submit, confirm, and have the real PUT answer a
 * status-bearing 404 — the only way a connector whose status never said
 * "missing" can learn its Secret is gone.
 */
async function submitPartialRotateAndGet404() {
  mockUpdateMcpSecret.mockRejectedValue(
    Object.assign(new Error(`404 - Secret "${SECRET_NAME}" not found in ${NAMESPACE}`), {
      status: 404,
    })
  )
  fireEvent.change(screen.getByLabelText('api-key'), { target: { value: 'partial-value' } })
  fireEvent.click(screen.getByRole('button', { name: 'Rotate credentials' }))
  const dialog = await screen.findByRole('alertdialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Rotate & restart' }))
}

/** Invariant O2 at the page level: explanation only. */
function expectExplanationOnly() {
  const panel = credentialPanel()
  expect(within(panel).getByText(/managed by its WorkflowRecipe/i)).toBeInTheDocument()
  // No credential form at all…
  expect(panel.querySelectorAll('form')).toHaveLength(0)
  // …no password inputs (the only kind this screen renders for credentials)…
  expect(panel.querySelectorAll('input[type="password"]')).toHaveLength(0)
  // Regex, not the bare key: set mode's label carries the required marker
  // ("api-key *"), so an exact-string query would pass even if the create form
  // HAD rendered.
  expect(screen.queryByLabelText(/^api-key/)).not.toBeInTheDocument()
  expect(screen.queryByLabelText(/^workspace-id/)).not.toBeInTheDocument()
  // …no submit control…
  expect(within(panel).queryAllByRole('button')).toHaveLength(0)
  expect(screen.queryByRole('button', { name: 'Set credentials' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Rotate credentials' })).not.toBeInTheDocument()
  // …and no copy telling the operator to re-enter every key on a screen that
  // cannot create anything.
  expect(screen.queryByText(/Enter every key to recreate it/)).not.toBeInTheDocument()
  // The load-bearing one: the POST is never reached.
  expect(mockCreateMcpSecret).not.toHaveBeenCalled()
}

/** The managed control: the recovery this screen exists to provide. */
function expectRecoveredIntoCreateForm() {
  expect(screen.getByRole('button', { name: 'Set credentials' })).toBeInTheDocument()
  expect(screen.getByText(/This Secret no longer exists\./)).toBeInTheDocument()
  // "api-key *" in set mode — every declared key is required there.
  expect(screen.getByLabelText('api-key *')).toBeInTheDocument()
  expect(screen.getByLabelText('workspace-id *')).toBeInTheDocument()
  expect(screen.queryByText(/managed by its WorkflowRecipe/i)).not.toBeInTheDocument()
  // Still no POST: recovering into the form is not submitting it.
  expect(mockCreateMcpSecret).not.toHaveBeenCalled()
}

beforeEach(() => {
  mockGetMcpServers.mockResolvedValue({ items: [] })
  mockGetContexts.mockResolvedValue({ items: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// ─── R1-H2 / mini-spec §1: ownership is a function of `spec` alone ─────────
//
// Invariant O1: `recipeOwned === (spec.managed === false)`, never a function of
// status. Every shape below resolves the SURFACE to 'rotate' — none of them
// carries the SecretNotFound condition that would let the resolver spot the
// missing Secret up front — so ownership is the ONLY thing standing between a
// managed:false connector and the create form once the PUT 404s.
//
// That is what makes the round-2 mutation
//
//     recipeOwned = (status?.conditions ?? []).length === 0 && managed === false
//
// so dangerous: for shapes 3-5 it silently returns false and the late 404
// re-opens POST on a Secret that belongs to a WorkflowRecipe. Shapes 1-2 are
// the other half of the pair — they keep the mutant honest about the states it
// does still get right, so a "fix" that simply hard-codes recipeOwned=false
// cannot pass either.
const STATUS_SHAPES: Array<{
  name: string
  status?: { conditions?: McpServerCondition[] }
}> = [
  // 1. The connector was just created and HCC has not written the status
  //    subresource at all. Nothing observable says anything.
  { name: 'status absent entirely', status: undefined },
  // 2. Status exists but is empty — the same information, a different shape.
  { name: 'empty conditions array', status: { conditions: [] } },
  // 3. SYNTHETIC ADVERSARY: HCC writes SecretResolved at 'True' or 'False'
  //    only, never 'Unknown'. Included because a partially-reconciled or
  //    hand-edited resource can still present it, and because it is the
  //    cheapest way to have a NON-EMPTY conditions array that proves nothing —
  //    exactly where the length-based mutant goes wrong.
  {
    name: 'SecretResolved / Unknown / Reconciling (synthetic)',
    status: {
      conditions: [
        syntheticCondition({
          status: 'Unknown',
          reason: 'Reconciling',
          message: 'Secret resolution in progress',
          lastTransitionTime: '2026-08-06T03:00:00.000Z',
        }),
      ],
    },
  },
  // 4. Producer output, but STALE: the Secret resolved cleanly an hour ago and
  //    has been deleted since. The UI cannot know that until the PUT 404s.
  {
    name: 'stale SecretResolved / True / SecretFound',
    status: { conditions: [secretFound({ at: '2026-08-06T03:00:00.000Z' })] },
  },
  // 5. Producer output: the Secret EXISTS but lacks a key — so this one says
  //    the opposite of "missing", and still resolves to rotate.
  {
    name: 'SecretResolved / False / SecretMissingKey',
    status: {
      conditions: [
        secretMissingKey({
          at: '2026-08-06T03:00:00.000Z',
          secretName: SECRET_NAME,
          secretKey: 'workspace-id',
          envVar: 'LINEAR_WORKSPACE',
        }),
      ],
    },
  },
]

describe('EditMcpServerPage — ownership survives a late 404 for every status shape', () => {
  for (const shape of STATUS_SHAPES) {
    it(`keeps a managed:false connector on explanation-only — ${shape.name}`, async () => {
      await renderPage(mcpServer({ managed: false, status: shape.status }))

      // It starts as an ordinary rotate form: nothing observable says the
      // Secret is missing, so the resolver can only answer 'rotate'.
      expect(screen.getByRole('button', { name: 'Rotate credentials' })).toBeInTheDocument()

      await submitPartialRotateAndGet404()

      await waitFor(() => {
        expect(screen.getByText(/managed by its WorkflowRecipe/i)).toBeInTheDocument()
      })
      expectExplanationOnly()
      // The partial draft really was submitted — one key of two — so this is
      // the journey that used to leak into a partial POST, not a no-op.
      expect(mockUpdateMcpSecret).toHaveBeenCalledWith(SECRET_NAME, { 'api-key': 'partial-value' })
    })

    it(`still recovers a managed:true connector into the create form — ${shape.name}`, async () => {
      await renderPage(mcpServer({ managed: true, status: shape.status }))

      expect(screen.getByRole('button', { name: 'Rotate credentials' })).toBeInTheDocument()

      await submitPartialRotateAndGet404()

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Set credentials' })).toBeInTheDocument()
      })
      expectRecoveredIntoCreateForm()
    })
  }

  // `managed` absent means managed:true (the CRD defaults it, so the API server
  // always persists it — but a fixture or an older resource may still omit it).
  // Absence must never be read as recipe-owned.
  it('treats an ABSENT spec.managed as managed, not as recipe-owned', async () => {
    await renderPage(mcpServer({ status: { conditions: [] } }))
    await submitPartialRotateAndGet404()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Set credentials' })).toBeInTheDocument()
    })
    expectRecoveredIntoCreateForm()
  })
})

describe('EditMcpServerPage — credential surface wiring', () => {
  it('renders the CREATE form when a managed connector reports SecretNotFound', async () => {
    await renderPage(
      mcpServer({
        managed: true,
        status: {
          conditions: [secretNotFound({ at: '2026-08-06T04:00:00.000Z', secretName: SECRET_NAME })],
        },
      })
    )

    expect(screen.getByText(/needs credentials before it can start/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Set credentials' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rotate credentials' })).not.toBeInTheDocument()
  })

  // SecretMissingKey means the Secret EXISTS but lacks a declared key, which the
  // PUT merge-patch already adds. Sending it to the create form would POST into
  // an AlreadyExists that control-api collapses to a bare 500.
  it('keeps the ROTATE form when the connector reports SecretMissingKey', async () => {
    await renderPage(
      mcpServer({
        managed: true,
        status: {
          conditions: [
            secretMissingKey({ at: '2026-08-06T04:00:00.000Z', secretName: SECRET_NAME }),
          ],
        },
      })
    )

    expect(screen.getByRole('button', { name: 'Rotate credentials' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Set credentials' })).not.toBeInTheDocument()
    expect(screen.getByText(/Rotate values stored in Secret/i)).toBeInTheDocument()
  })

  it('renders the recipe explanation, and no form, for an unmanaged connector with a missing Secret', async () => {
    await renderPage(
      mcpServer({
        managed: false,
        status: {
          conditions: [secretNotFound({ at: '2026-08-06T04:00:00.000Z', secretName: SECRET_NAME })],
        },
      })
    )

    expectExplanationOnly()
  })

  // A real status array carries several condition types and no ordering
  // guarantee. Only the newest SecretResolved entry may decide the surface.
  //
  // The DeploymentReady entry is a SYNTHETIC ADVERSARY: it reuses the
  // SecretNotFound reason on a type the HCC never writes it on, and carries the
  // newest timestamp in the array.
  it('ignores unrelated conditions and honors the NEWEST SecretResolved entry', async () => {
    await renderPage(
      mcpServer({
        managed: true,
        status: {
          conditions: [
            syntheticCondition({
              type: 'DeploymentReady',
              message: 'unrelated condition reusing the reason',
              lastTransitionTime: '2026-08-06T09:00:00.000Z',
            }),
            secretNotFound({ at: '2026-08-06T04:00:00.000Z', secretName: SECRET_NAME }),
            secretFound({ at: '2026-08-06T05:00:00.000Z' }),
          ],
        },
      })
    )

    // The stale SecretNotFound and the DeploymentReady noise must both lose.
    expect(screen.getByRole('button', { name: 'Rotate credentials' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Set credentials' })).not.toBeInTheDocument()
  })

  it('honors a NEWER SecretNotFound over a stale clean resolution', async () => {
    await renderPage(
      mcpServer({
        managed: true,
        status: {
          conditions: [
            secretFound({ at: '2026-08-06T04:00:00.000Z' }),
            secretNotFound({ at: '2026-08-06T05:00:00.000Z', secretName: SECRET_NAME }),
          ],
        },
      })
    )

    expect(screen.getByRole('button', { name: 'Set credentials' })).toBeInTheDocument()
  })

  // The R1-M2 defect, end to end through the page: a malformed calendar date
  // (February 30, which JavaScript silently normalizes into March 2) must NOT
  // outrank the valid — and genuinely newer — clean resolution.
  //
  // SYNTHETIC ADVERSARY: HCC always stamps a real instant.
  it('does not let a February-30 duplicate reopen the create form', async () => {
    await renderPage(
      mcpServer({
        managed: true,
        status: {
          conditions: [
            syntheticCondition({ lastTransitionTime: '2026-02-30T00:00:00.000Z' }),
            secretFound({ at: '2026-02-28T23:59:59.000Z' }),
          ],
        },
      })
    )

    expect(screen.getByRole('button', { name: 'Rotate credentials' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Set credentials' })).not.toBeInTheDocument()
  })
})
