import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { DesktopEnvironmentResponse } from '@/app/types/api'
import type { Me } from '@/app/types/profile'
import desktopEnvironmentFixture from '@/test/fixtures/desktop-environment-response.json'
import { PASSWORD_CREDENTIAL_CHANGED_PUBLIC_RESPONSE } from '../../../../external-rest-api/src/routes/mePasswordErrors.js'
import { SettingsContent } from '../../settings/SettingsContent'

const mocks = vi.hoisted(() => ({
  buildDesktopEnvironmentLink: vi.fn(),
  checkAuth: vi.fn(),
  confirm: vi.fn(),
  disconnectWorkflowApprovalMedium: vi.fn(),
  getConfiguredExternalRestApiBaseUrl: vi.fn(),
  getDesktopEnvironment: vi.fn(),
  getMe: vi.fn(),
  isSilentApiError: vi.fn(),
  listWorkflowApprovalMediums: vi.fn(),
  logout: vi.fn(),
  navigateToDesktopApp: vi.fn(),
  refreshApprovalTargets: vi.fn(),
  refreshReleaseIdentity: vi.fn(),
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
  showToast: vi.fn(),
  updatePassword: vi.fn(),
  updateProfile: vi.fn(),
}))

const desktopEnvironment: DesktopEnvironmentResponse = desktopEnvironmentFixture
const currentUser: Me = {
  id: 'user-1',
  email: 'josue@example.com',
  name: 'Josue',
  role: 'member',
  teamId: null,
  teamName: null,
  profile: {
    displayName: 'Josue',
    channels: {
      emails: [],
      telegramHandles: [],
      slackUserNames: [],
      telegramIds: [],
      discordUserNames: [],
      whatsappNumbers: [],
    },
  },
}

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.routerPush, replace: mocks.routerReplace }),
  useSearchParams: () => ({ get: () => null }),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

vi.mock('@components/AuthContext', () => ({
  useAuth: () => ({ checkAuth: mocks.checkAuth, logout: mocks.logout }),
}))

vi.mock('@components/ConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm, confirmDialog: null }),
}))

vi.mock('@components/ProfileAccessContext', () => ({
  useProfileAccess: () => ({
    approvalTargets: [],
    refreshApprovalTargets: mocks.refreshApprovalTargets,
  }),
}))

vi.mock('@components/ProfileBodySkeleton', () => ({
  ProfileBodySkeleton: () => null,
}))

vi.mock('@components/ProfileShell', () => ({
  ProfileShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('@components/ReleaseLabel', () => ({
  ReleaseLabel: () => null,
}))

vi.mock('@components/Toast', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}))

vi.mock('@lib/api', () => ({
  getConfiguredExternalRestApiBaseUrl: mocks.getConfiguredExternalRestApiBaseUrl,
  getDesktopEnvironment: mocks.getDesktopEnvironment,
  getMe: mocks.getMe,
  isSilentApiError: mocks.isSilentApiError,
  updatePassword: mocks.updatePassword,
  updateProfile: mocks.updateProfile,
}))

vi.mock('@lib/approvalChannels', () => ({
  disconnectWorkflowApprovalMedium: mocks.disconnectWorkflowApprovalMedium,
  listWorkflowApprovalMediums: mocks.listWorkflowApprovalMediums,
}))

vi.mock('@lib/desktopAppLinks', () => ({
  buildDesktopEnvironmentLink: mocks.buildDesktopEnvironmentLink,
  navigateToDesktopApp: mocks.navigateToDesktopApp,
}))

vi.mock('@lib/releaseIdentity', () => ({
  refreshReleaseIdentity: mocks.refreshReleaseIdentity,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.buildDesktopEnvironmentLink.mockReturnValue(null)
  mocks.getConfiguredExternalRestApiBaseUrl.mockReturnValue('https://api.example.com')
  mocks.getDesktopEnvironment.mockResolvedValue(desktopEnvironment)
  mocks.getMe.mockResolvedValue(currentUser)
  mocks.isSilentApiError.mockReturnValue(false)
  mocks.listWorkflowApprovalMediums.mockResolvedValue([])
  mocks.refreshApprovalTargets.mockResolvedValue([])
})

afterEach(cleanup)

describe('Settings desktop setup handoff', () => {
  it('uses the shared desktop environment link builder', async () => {
    const desktopHref =
      'evenfire://desktop-environment?externalRestApiBaseUrl=https%3A%2F%2Fapi.example.com&tenantName=Example+Tenant'
    mocks.buildDesktopEnvironmentLink.mockReturnValue(desktopHref)

    render(<SettingsContent activeSettingsTab="profile" activeSocialTab="telegram" />)

    const setupButton = await screen.findByRole('button', { name: 'Setup desktop app' })
    await waitFor(() => expect(setupButton).toBeEnabled())
    fireEvent.click(setupButton)

    const dialog = await screen.findByRole('dialog', { name: 'Setup desktop app' })
    const openButton = within(dialog).getByRole('button', {
      name: 'Open desktop app and setup',
    })
    await waitFor(() => expect(openButton).toBeEnabled())
    fireEvent.click(openButton)

    expect(mocks.buildDesktopEnvironmentLink).toHaveBeenCalledWith(desktopEnvironment)
    expect(mocks.navigateToDesktopApp).toHaveBeenCalledWith(desktopHref)
  })
})

describe('Settings password update recovery messaging', () => {
  it('shows actionable guidance from the External REST credential-change response', async () => {
    const publicResponse = PASSWORD_CREDENTIAL_CHANGED_PUBLIC_RESPONSE
    const publicMessage = publicResponse.body.error
    const actualApi = await vi.importActual<typeof import('@lib/api')>('@lib/api')
    mocks.updatePassword.mockImplementation(actualApi.updatePassword)
    const upstreamFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(publicResponse.body), {
        status: publicResponse.status,
        statusText: 'Conflict',
        headers: { 'content-type': 'application/json' },
      })
    )

    try {
      render(<SettingsContent activeSettingsTab="profile" activeSocialTab="telegram" />)
      const openButton = await screen.findByRole('button', { name: 'Update password' })
      fireEvent.click(openButton)

      const dialog = await screen.findByRole('dialog', { name: 'Update password' })
      fireEvent.change(within(dialog).getByLabelText('Current password'), {
        target: { value: 'Synthetic-current-password' },
      })
      fireEvent.change(within(dialog).getByLabelText('New password'), {
        target: { value: 'Synthetic-next-password' },
      })
      fireEvent.change(within(dialog).getByLabelText('Confirm new password'), {
        target: { value: 'Synthetic-next-password' },
      })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Update password' }))

      expect(await within(dialog).findByText(`409 Conflict - ${publicMessage}`)).toBeInTheDocument()
      expect(mocks.logout).not.toHaveBeenCalled()
      expect(mocks.routerReplace).not.toHaveBeenCalled()
      expect(mocks.showToast).not.toHaveBeenCalled()
    } finally {
      upstreamFetch.mockRestore()
    }
  })
})
