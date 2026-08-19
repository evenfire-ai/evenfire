import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  type PluginWorkloadSdkGrant,
  getAdminUsers,
  getPluginWorkloadSdkLegacyInventory,
  getRecipes,
  listLlmHostSecrets,
  listPluginWorkloadSdkGrants,
  listWorkflowGrants,
  searchPluginWorkloadSdkInvocations,
} from '@lib/api'
import PluginWorkloadSdkPage from '../../app/plugin-workload-sdk/page'

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  showToast: vi.fn(),
  routerPush: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.routerPush }),
  usePathname: () => '/plugins/sdk',
}))

vi.mock('@components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@components/ConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm, confirmDialog: null }),
}))

vi.mock('@components/Toast', () => ({
  useToast: () => ({ showToast: mocks.showToast, dismissToast: vi.fn() }),
}))

vi.mock('@lib/hooks/useLlmAllowedModels', () => ({
  useLlmAllowedModels: () => ({ models: [], loading: false, error: '', reload: vi.fn() }),
}))

vi.mock('@lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@lib/api')>()
  return {
    ...actual,
    getAdminUsers: vi.fn(),
    getPluginWorkloadSdkLegacyInventory: vi.fn(),
    getRecipes: vi.fn(),
    listLlmHostSecrets: vi.fn(),
    listPluginWorkloadSdkGrants: vi.fn(),
    listWorkflowGrants: vi.fn(),
    searchPluginWorkloadSdkInvocations: vi.fn(),
  }
})

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

const manualUser = {
  id: 'manual-user',
  email: 'manual@example.com',
  name: 'Manual user',
  displayName: null,
  picture: null,
  activeTeamCount: 0,
}

const prefilledUser = {
  id: 'prefilled-user',
  email: 'prefilled@example.com',
  name: 'Prefilled user',
  displayName: null,
}

function makeGrant(overrides: Partial<PluginWorkloadSdkGrant>): PluginWorkloadSdkGrant {
  return {
    id: 'grant-1',
    recipeNamespace: 'sandbox-recipes',
    recipeName: 'notify-recipe',
    capabilityFamily: 'clientNotifications',
    provider: null,
    allowedModels: [],
    allowedEventTypes: ['scan.complete'],
    allowedTargetRefs: [],
    allowedUserRefs: [],
    allowedCallers: ['scanner'],
    quotaLimits: {},
    modelPolicies: {},
    promptTargets: [],
    defaultTargetRef: null,
    policyState: 'active',
    revocationId: null,
    policyRevision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(getAdminUsers).mockResolvedValue({ items: [manualUser] })
  vi.mocked(getPluginWorkloadSdkLegacyInventory).mockResolvedValue({
    totalPromptBridgeGrants: 0,
    legacyPromptBridgeGrants: 0,
    activationReady: true,
    items: [],
  })
  vi.mocked(getRecipes).mockResolvedValue({
    items: [
      {
        metadata: { namespace: 'sandbox-recipes', name: 'notify-recipe' },
        spec: {
          pluginWorkloadSdk: {
            allowedCallers: ['scanner'],
            clientNotifications: { allowedEventTypes: ['scan.complete'] },
          },
        },
      },
    ],
  } as never)
  vi.mocked(listLlmHostSecrets).mockResolvedValue({ items: [] })
  vi.mocked(listPluginWorkloadSdkGrants).mockResolvedValue({ items: [] })
  vi.mocked(searchPluginWorkloadSdkInvocations).mockResolvedValue({ items: [] })
  mocks.confirm.mockResolvedValue(false)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Plugin Workload SDK operator page', () => {
  it('does not let a late recipe-grant response overwrite an explicit recipient selection', async () => {
    const prefill = createDeferred<{ items: (typeof prefilledUser)[] }>()
    vi.mocked(listWorkflowGrants).mockReturnValue(prefill.promise)

    render(<PluginWorkloadSdkPage />)
    const newGrant = await screen.findByRole('button', { name: 'New grant' })
    await waitFor(() => expect(newGrant).toBeEnabled())
    fireEvent.click(newGrant)

    const recipePicker = await screen.findByLabelText('Recipe (declares the SDK)')
    fireEvent.change(recipePicker, { target: { value: 'sandbox-recipes/notify-recipe' } })

    const usersPicker = await screen.findByLabelText('Allowed users')
    fireEvent.click(usersPicker)
    fireEvent.click(await screen.findByRole('option', { name: 'Manual user' }))

    await act(async () => {
      prefill.resolve({ items: [prefilledUser] })
      await prefill.promise
    })

    const selected = screen.getByLabelText('Selected users')
    expect(within(selected).getByText('Manual user')).toBeInTheDocument()
    expect(within(selected).queryByText('Prefilled user')).not.toBeInTheDocument()
  })

  it('renders the quota cell as N/min for a per-minute override and "platform defaults" without one', async () => {
    // Issue #348: the grants table shows API-set per-minute overrides when
    // present, else 'platform defaults'. Covers the PR's only observable UI
    // change (per-run caps removed; per-minute override surfaced).
    vi.mocked(listPluginWorkloadSdkGrants).mockResolvedValue({
      items: [
        makeGrant({
          id: 'grant-override',
          recipeName: 'override-recipe',
          capabilityFamily: 'promptBridge',
          provider: 'openai',
          quotaLimits: { maxInvocationsPerMinute: 4 },
        }),
        makeGrant({ id: 'grant-default', recipeName: 'default-recipe', quotaLimits: {} }),
      ],
    })

    render(<PluginWorkloadSdkPage />)

    expect(await screen.findByText('4/min')).toBeInTheDocument()
    expect(screen.getByText('platform defaults')).toBeInTheDocument()
  })
})
