import { describe, expect, it } from 'vitest'
import { DESKTOP_ROUTES } from '@constants/navigation'
import type { SettingsSection, WorkspaceTab } from '../workspaceTabs.types'
import { mapKindToRoute, settingsSectionForRoute } from '../workspaceTabsRoute'

const tab = (partial: Partial<WorkspaceTab> & Pick<WorkspaceTab, 'kind'>): WorkspaceTab => ({
  id: 't1',
  title: 'tab',
  ...partial,
})

const SETTINGS_SECTIONS: SettingsSection[] = ['connectors', 'agents', 'plugins', 'settings']

describe('workspaceTabsRoute', () => {
  describe('mapKindToRoute', () => {
    it('maps each non-settings kind to its route', () => {
      expect(mapKindToRoute(tab({ kind: 'chat' }))).toBe(DESKTOP_ROUTES.chat)
      expect(mapKindToRoute(tab({ kind: 'app' }))).toBe(DESKTOP_ROUTES.apps)
      expect(mapKindToRoute(tab({ kind: 'files' }))).toBe(DESKTOP_ROUTES.files)
      expect(mapKindToRoute(tab({ kind: 'preview' }))).toBe(DESKTOP_ROUTES.preview)
    })

    it('maps each settings section to its route', () => {
      expect(mapKindToRoute(tab({ kind: 'settings', settings: { section: 'connectors' } }))).toBe(
        DESKTOP_ROUTES.connectors
      )
      expect(mapKindToRoute(tab({ kind: 'settings', settings: { section: 'agents' } }))).toBe(
        DESKTOP_ROUTES.agents
      )
      expect(mapKindToRoute(tab({ kind: 'settings', settings: { section: 'plugins' } }))).toBe(
        DESKTOP_ROUTES.plugins
      )
      expect(mapKindToRoute(tab({ kind: 'settings', settings: { section: 'settings' } }))).toBe(
        DESKTOP_ROUTES.settings
      )
    })

    it('falls back to the settings route for a settings tab with no section payload', () => {
      expect(mapKindToRoute(tab({ kind: 'settings' }))).toBe(DESKTOP_ROUTES.settings)
    })

    it('maps an empty workspace (undefined active tab) to chat', () => {
      expect(mapKindToRoute(undefined)).toBe(DESKTOP_ROUTES.chat)
    })
  })

  describe('settingsSectionForRoute', () => {
    it('round-trips every settings section (section -> route -> section)', () => {
      for (const section of SETTINGS_SECTIONS) {
        const route = mapKindToRoute(tab({ kind: 'settings', settings: { section } }))
        expect(settingsSectionForRoute(route)).toBe(section)
      }
    })

    it('returns null for non-settings routes', () => {
      expect(settingsSectionForRoute(DESKTOP_ROUTES.chat)).toBeNull()
      expect(settingsSectionForRoute(DESKTOP_ROUTES.apps)).toBeNull()
      expect(settingsSectionForRoute(DESKTOP_ROUTES.files)).toBeNull()
      expect(settingsSectionForRoute(DESKTOP_ROUTES.preview)).toBeNull()
    })
  })
})
