import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ToastProvider } from '@components/Toast'
import EditMcpServerPage from '../../app/mcp-servers/[name]/edit/page'
import { createMcpSecret, getMcpServer, getMcpServers, updateMcpSecret } from '../../lib/api'
import type { McpServerCondition, McpServerResource } from '../../lib/api'

// ─── R1-H2: drive the REAL page, not the component in isolation ────────────
//
// The component tests inject `surface`/`recipeOwned` directly and the resolver
// tests call the resolver directly, so NEITHER covers the wiring in between.
// The reviewer reproduced that gap twice: deleting the page's `surface` prop
// left both changed suites 36/36 green, and resolving only the first condition
// left the resolver suite 8/8 green. These tests close it by rendering the edit
// page against a producer-shaped getMcpServer() response and asserting the UI
// an operator would actually see.
//
// Nothing here passes `surface` or `recipeOwned` by hand — the page must derive
// both from the McpServer it loaded.

const SERVER_NAME = 'linear-connector'
const SECRET_NAME = 'linear-credentials'

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
    getMcpServer: vi.fn(),
    getMcpServers: vi.fn(),
    updateMcpServer: vi.fn(),
    updateMcpSecret: vi.fn(),
    createMcpSecret: vi.fn(),
  }
})

const mockGetMcpServer = vi.mocked(getMcpServer)
const mockGetMcpServers = vi.mocked(getMcpServers)
const mockUpdateMcpSecret = vi.mocked(updateMcpSecret)
const mockCreateMcpSecret = vi.mocked(createMcpSecret)

/** A SecretResolved condition in the shape HCC writes it. */
function secretResolved(
  overrides: Partial<McpServerCondition> & { lastTransitionTime: string }
): McpServerCondition {
  return {
    type: 'SecretResolved',
    status: 'False',
    reason: 'SecretNotFound',
    message: `Secret "${SECRET_NAME}" not found in namespace "mcp-server"`,
    ...overrides,
  }
}

/**
 * The producer: an McpServer as `GET /admin/mcp-servers/:name` returns it,
 * including the `spec.envSecret` the page has to narrow and the
 * `status.conditions` array the resolver has to reduce.
 */
function mcpServer(options: {
  managed?: boolean
  conditions?: McpServerCondition[]
}): McpServerResource {
  return {
    metadata: { name: SERVER_NAME, namespace: 'mcp-server' },
    spec: {
      image: 'ghcr.io/acme/linear-mcp:1.4.0',
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
    status: { conditions: options.conditions ?? [] },
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
  // Anchor on the loaded connector's own image: it renders only after
  // getMcpServer() resolves, and it is surface-independent (the credential
  // panel's own title changes between set/rotate/recipe-owned).
  await screen.findByText('ghcr.io/acme/linear-mcp:1.4.0')
}

beforeEach(() => {
  mockGetMcpServers.mockResolvedValue({ items: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('EditMcpServerPage — credential surface wiring', () => {
  it('renders the CREATE form when a managed connector reports SecretNotFound', async () => {
    await renderPage(
      mcpServer({
        managed: true,
        conditions: [secretResolved({ lastTransitionTime: '2026-08-06T04:00:00.000Z' })],
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
        conditions: [
          secretResolved({
            reason: 'SecretMissingKey',
            message: `Secret "${SECRET_NAME}" is missing key "workspace-id"`,
            lastTransitionTime: '2026-08-06T04:00:00.000Z',
          }),
        ],
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
        conditions: [secretResolved({ lastTransitionTime: '2026-08-06T04:00:00.000Z' })],
      })
    )

    expect(screen.getByText(/managed by its WorkflowRecipe/i)).toBeInTheDocument()
    expect(screen.queryByLabelText('api-key')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Set credentials' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rotate credentials' })).not.toBeInTheDocument()
  })

  // A real status array carries several condition types and no ordering
  // guarantee. Only the newest SecretResolved entry may decide the surface.
  it('ignores unrelated conditions and honors the NEWEST SecretResolved entry', async () => {
    await renderPage(
      mcpServer({
        managed: true,
        conditions: [
          {
            type: 'DeploymentReady',
            status: 'False',
            reason: 'SecretNotFound',
            message: 'unrelated condition reusing the reason',
            lastTransitionTime: '2026-08-06T09:00:00.000Z',
          },
          secretResolved({ lastTransitionTime: '2026-08-06T04:00:00.000Z' }),
          secretResolved({
            status: 'True',
            reason: 'SecretResolved',
            message: `Secret "${SECRET_NAME}" resolved`,
            lastTransitionTime: '2026-08-06T05:00:00.000Z',
          }),
        ],
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
        conditions: [
          secretResolved({
            status: 'True',
            reason: 'SecretResolved',
            message: `Secret "${SECRET_NAME}" resolved`,
            lastTransitionTime: '2026-08-06T04:00:00.000Z',
          }),
          secretResolved({ lastTransitionTime: '2026-08-06T05:00:00.000Z' }),
        ],
      })
    )

    expect(screen.getByRole('button', { name: 'Set credentials' })).toBeInTheDocument()
  })
})

// ─── R1-H1, end to end through the page ────────────────────────────────────
describe('EditMcpServerPage — late 404 on an unmanaged connector', () => {
  it('never exposes the create form when the rotation PUT 404s and status was absent', async () => {
    // The realistic race: the connector was just created, HCC has not written
    // status yet, so NOTHING observable says the Secret is missing and the
    // resolver can only answer 'rotate'. Ownership must come from the spec.
    await renderPage(mcpServer({ managed: false, conditions: [] }))

    // It starts as a normal rotate form — that part is unchanged.
    const rotate = screen.getByRole('button', { name: 'Rotate credentials' })
    mockUpdateMcpSecret.mockRejectedValue(
      Object.assign(new Error(`404 - Secret "${SECRET_NAME}" not found in mcp-server`), {
        status: 404,
      })
    )

    fireEvent.change(screen.getByLabelText('api-key'), { target: { value: 'partial-value' } })
    fireEvent.click(rotate)
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rotate & restart' }))

    await waitFor(() => {
      expect(screen.getByText(/managed by its WorkflowRecipe/i)).toBeInTheDocument()
    })
    // Explanation-only: no create form, no partial POST, and no copy telling the
    // operator to re-enter every key on a screen that cannot create anything.
    expect(screen.queryByRole('button', { name: 'Set credentials' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('api-key')).not.toBeInTheDocument()
    expect(screen.queryByText(/Enter every key to recreate it/)).not.toBeInTheDocument()
    expect(mockCreateMcpSecret).not.toHaveBeenCalled()
  })

  // The managed control for the same race: the recovery this screen exists to
  // provide must survive the ownership guard.
  it('does open the create form on the same 404 when the connector is managed', async () => {
    await renderPage(mcpServer({ managed: true, conditions: [] }))

    mockUpdateMcpSecret.mockRejectedValue(
      Object.assign(new Error(`404 - Secret "${SECRET_NAME}" not found in mcp-server`), {
        status: 404,
      })
    )

    fireEvent.change(screen.getByLabelText('api-key'), { target: { value: 'partial-value' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rotate credentials' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rotate & restart' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Set credentials' })).toBeInTheDocument()
    })
    expect(screen.getByText(/This Secret no longer exists\./)).toBeInTheDocument()
    expect(screen.queryByText(/managed by its WorkflowRecipe/i)).not.toBeInTheDocument()
    expect(mockCreateMcpSecret).not.toHaveBeenCalled()
  })
})
