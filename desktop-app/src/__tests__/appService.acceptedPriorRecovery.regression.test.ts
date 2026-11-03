import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appServicePriorRecoveryFixture as boundary,
  createAppServicePriorRecoveryHarness,
  disposeAppServicePriorRecoveryFixture,
  freshMe,
  freshToken,
  homeMe,
  homeToken,
  keyOf,
  resetAppServicePriorRecoveryFixture,
} from '../../testSupport/appServicePriorRecoveryFixture.js'

vi.mock('keytar', async () => {
  const { createAppServicePriorRecoveryKeytarFixture } =
    await import('../../testSupport/appServicePriorRecoveryFixture.js')
  return createAppServicePriorRecoveryKeytarFixture()
})
vi.mock('electron', async () => {
  const { createAppServicePriorRecoveryElectronFixture } =
    await import('../../testSupport/appServicePriorRecoveryFixture.js')
  return createAppServicePriorRecoveryElectronFixture()
})
vi.mock('../chatStoreBinding.js', async () => {
  const { createChatStoreBindingMock } = await import('../../testSupport/chatStoreBindingMock.js')
  return createChatStoreBindingMock()
})
vi.mock('../pluginSdkRuntime.js', () => ({
  tryGetPluginSdkRuntime: () => ({
    notifySessionChanged: boundary.notifySessionChanged,
    unpinAllSandboxUiSurfaces: vi.fn(),
  }),
}))
vi.mock('../windowsSessionAuthorityAcl.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../windowsSessionAuthorityAcl.js')>()
  const { createWindowsSessionAuthorityAclUnitFixture } =
    await import('../../testSupport/windowsSessionAuthorityAclUnitFixture.js')
  return createWindowsSessionAuthorityAclUnitFixture(actual)
})
vi.mock('../windowsSessionAuthorityFileOps.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../windowsSessionAuthorityFileOps.js')>()
  const { createWindowsSessionAuthorityFileOpsUnitFixture } =
    await import('../../testSupport/windowsSessionAuthorityFileOpsUnitFixture.js')
  return createWindowsSessionAuthorityFileOpsUnitFixture(actual)
})

beforeEach(async () => {
  await resetAppServicePriorRecoveryFixture()
})
afterEach(disposeAppServicePriorRecoveryFixture)

describe('R21-M6/R21-M15 accepted prior recovery retains exact authority', () => {
  it.each([
    { mode: 'environment-resolved', persistRuntimeConfig: false },
    { mode: 'persisted-runtime-config', persistRuntimeConfig: true },
  ])(
    'preserves the prior source after a public replacement setter rejects ($mode)',
    async ({ persistRuntimeConfig }) => {
      const h = await createAppServicePriorRecoveryHarness({ persistRuntimeConfig })
      await h.service.passwordLogin(homeMe.email, 'fixture-password')

      const acceptedBefore = await h.acceptance.readSessionAuthoritySourceSelection({
        tokenStore: h.tokenStore,
        envKey: h.envKey,
      })
      expect(acceptedBefore.status).toBe('accepted')
      if (acceptedBefore.status !== 'accepted')
        throw new Error('The public password producer did not select Home')
      expect(acceptedBefore.session.token).toBe(homeToken)
      expect(acceptedBefore.session.accepted.record.frame.source).toMatchObject({
        kind: 'keytar',
        format: 'v1',
        accountId: homeMe.id,
      })
      const source = acceptedBefore.session.accepted.record.frame.source
      if (!source || source.kind !== 'keytar' || source.format !== 'v1')
        throw new Error('Expected the prior accepted Keytar source')
      const priorKeytarAccount = `session-v1:${source.sourceRef}`
      const priorStoredValue = boundary.keychain.get(keyOf('Evenfire', priorKeytarAccount))
      expect(priorStoredValue).toBeDefined()
      const { safeStorage } = await import('electron')
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false)
      const notifyBefore = boundary.notifySessionChanged.mock.calls.length

      boundary.setPassword.mockImplementationOnce(async (service, account, token) => {
        boundary.keychain.set(keyOf(service, account), token)
        throw new Error('fixture-candidate setter rejected after publication')
      })
      vi.spyOn(h.state.authClient, 'passwordLogin').mockResolvedValueOnce({
        token: freshToken,
        me: freshMe,
      })
      await expect(h.service.passwordLogin(freshMe.email, 'fixture-password')).rejects.toThrow(
        'fixture-candidate setter rejected after publication'
      )
      expect(h.state.sessionToken).toBe(homeToken)
      expect(h.state.me).toEqual(homeMe)
      expect(boundary.keychain.get(keyOf('Evenfire', priorKeytarAccount))).toBe(priorStoredValue)

      const acceptedAfter = await h.acceptance.readSessionAuthoritySourceSelection({
        tokenStore: h.tokenStore,
        envKey: h.envKey,
      })
      expect(acceptedAfter.status).toBe('accepted')
      if (acceptedAfter.status !== 'accepted')
        throw new Error('Rejected replacement removed the prior accepted source')
      expect(acceptedAfter.session.token).toBe(homeToken)
      expect(acceptedAfter.session.accepted.record.frame.source?.sourceRef).toBe(
        acceptedBefore.session.accepted.record.frame.source?.sourceRef
      )

      const notifications = boundary.notifySessionChanged.mock.calls.slice(notifyBefore)
      expect(notifications).not.toContainEqual([false])
      const restarted = await createAppServicePriorRecoveryHarness({ persistRuntimeConfig })
      await expect(restarted.service.initialize()).resolves.toEqual({
        authenticated: true,
        me: homeMe,
      })
      expect(restarted.state.authClient.getMe).toHaveBeenCalledTimes(1)
      expect(restarted.state.authClient.getMe).toHaveBeenCalledWith(homeToken)
      expect(restarted.state.authClient.getMe).not.toHaveBeenCalledWith(freshToken)
      expect(h.state.sessionToken).toBe(homeToken)
      expect(h.state.me).toEqual(homeMe)
    }
  )
})
