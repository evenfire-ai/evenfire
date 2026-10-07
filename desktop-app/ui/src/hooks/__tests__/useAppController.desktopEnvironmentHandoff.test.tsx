// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import type { DesktopRuntimeConfigState } from '../../../../src/types'
import {
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function runtimeConfigState(): DesktopRuntimeConfigState {
  const current = {
    appName: 'Current environment',
    externalRestApiBaseUrl: 'https://current-api.example.test/api/v1',
    rpcProxyBaseUrl: 'https://current-rpc.example.test',
  }
  const target = {
    appName: 'Target environment',
    externalRestApiBaseUrl: 'https://target-api.example.test/api/v1',
    rpcProxyBaseUrl: 'https://target-rpc.example.test',
  }
  return {
    configured: true,
    isLocalhost: false,
    selectorVisible: true,
    activeOptionId: 'current-profile',
    currentConfig: current,
    envKey: 'current-environment',
    storagePath: '/harness/runtime-configs',
    options: [
      {
        id: 'current-profile',
        label: 'Current environment',
        source: 'file',
        configPath: '/harness/current.json',
        ...current,
      },
      {
        id: 'target-profile',
        label: 'Target environment',
        source: 'file',
        configPath: '/harness/target.json',
        ...target,
      },
    ],
  }
}

describe('useAppController desktop environment handoff', () => {
  let unmount: (() => void) | null = null

  afterEach(() => {
    unmount?.()
    unmount = null
    vi.restoreAllMocks()
    uninstallMockClerum()
  })

  async function openSwitchConfirmation() {
    const { clerum, handle } = installAppControllerClerum({
      runtimeConfigState: runtimeConfigState(),
    })
    const app = renderAppController()
    unmount = app.unmount
    await waitFor(() => expect(app.result.current.booting).toBe(false))
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
    await waitFor(() => expect(handle.onDesktopEnvironmentSetup).toHaveBeenCalledOnce())

    let handoff!: Promise<void>
    await act(async () => {
      handoff = handle.emitDesktopEnvironmentSetup({
        appName: 'Target environment',
        externalRestApiBaseUrl: 'https://target-api.example.test/api/v1',
      })
    })
    await waitFor(() =>
      expect(app.result.current.pendingDesktopEnvironmentSwitchConfirmation).toMatchObject({
        targetEnvironmentName: 'Target environment',
        targetExternalRestApiBaseUrl: 'https://target-api.example.test/api/v1',
      })
    )
    return { app, handle, handoff }
  }

  it('keeps the signed-in session and skips selection when the user cancels', async () => {
    const { app, handle, handoff } = await openSwitchConfirmation()

    await act(async () => app.result.current.handleCancelDesktopEnvironmentSwitchConfirmation())
    await act(async () => handoff)

    expect(handle.logout).not.toHaveBeenCalled()
    expect(handle.selectRuntimeConfigForHandoff).not.toHaveBeenCalled()
    expect(app.result.current.isAuthenticated).toBe(true)
    expect(app.result.current.pendingDesktopEnvironmentSwitchConfirmation).toBeNull()
  })

  it('signs out before selecting the saved environment with the logout generation', async () => {
    const { app, handle, handoff } = await openSwitchConfirmation()

    await act(async () => app.result.current.handleConfirmDesktopEnvironmentSwitchConfirmation())
    await act(async () => handoff)

    expect(handle.logout).toHaveBeenCalledOnce()
    expect(handle.selectRuntimeConfigForHandoff).toHaveBeenCalledWith('target-profile', 1)
    expect(handle.logout.mock.invocationCallOrder[0]!).toBeLessThan(
      handle.selectRuntimeConfigForHandoff.mock.invocationCallOrder[0]!
    )
    expect(app.result.current.isAuthenticated).toBe(false)
    await expect(handle.getRuntimeConfigState()).resolves.toMatchObject({
      activeOptionId: 'target-profile',
    })
  })
})
