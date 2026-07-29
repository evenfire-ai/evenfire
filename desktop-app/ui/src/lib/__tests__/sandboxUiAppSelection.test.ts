import { describe, expect, it } from 'vitest'
import {
  canProcessSandboxUiDeepLinks,
  resolveSandboxUiDeepLinkApp,
  toActiveSandboxUiApps,
} from '@lib/sandboxUiAppSelection'

const apps = [
  {
    appRef: 'sandbox-recipes/ready-app',
    title: 'Ready app',
    defaultPath: '/',
    ready: true,
    phase: 'Ready',
    updatedAt: null,
  },
  {
    appRef: 'sandbox-recipes/provisioning-app',
    title: 'Provisioning app',
    defaultPath: '/',
    ready: false,
    phase: 'Installing',
    updatedAt: null,
  },
]

describe('sandbox UI app selection', () => {
  it('waits for startup hydration before processing a queued deep link', () => {
    expect(canProcessSandboxUiDeepLinks(true, true, 1)).toBe(false)
    expect(canProcessSandboxUiDeepLinks(false, true, 1)).toBe(true)
  })

  it('keeps provisioning apps out of the app picker', () => {
    expect(toActiveSandboxUiApps(apps)).toEqual([
      {
        appRef: 'sandbox-recipes/ready-app',
        label: 'Ready app',
        defaultPath: '/',
      },
    ])
  })

  it('distinguishes a provisioning deep-link target from an inaccessible app', () => {
    expect(resolveSandboxUiDeepLinkApp(apps, 'sandbox-recipes/provisioning-app')).toEqual({
      status: 'starting',
      label: 'Provisioning app',
      phase: 'Installing',
    })
    expect(resolveSandboxUiDeepLinkApp(apps, 'sandbox-recipes/missing-app')).toEqual({
      status: 'unavailable',
    })
  })

  it('returns a launchable app when the deep-link target is ready', () => {
    expect(resolveSandboxUiDeepLinkApp(apps, 'SANDBOX-RECIPES/READY-APP')).toEqual({
      status: 'ready',
      app: {
        appRef: 'sandbox-recipes/ready-app',
        label: 'Ready app',
        defaultPath: '/',
      },
    })
  })
})
