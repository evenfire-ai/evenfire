import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { GfsResourceMenu } from '@components/GfsResourceMenu'
import { sidebarRowActionOptions } from '@lib/gfsResourceActionSurfaces'
import { buildGfsResourceActions, getGfsMenuActions } from '@lib/gfsResourceActions'
import type { GfsResourceMenuPermissionGateStatus } from '@lib/gfsResourceMenuPermissionGate'
import { gfsRowActionAvailability } from '@lib/gfsRowActionAvailability'
import '../styles.css'
import '../styles/tokens.css'

/**
 * Mounts the real sidebar row menu, built from the real surface options and
 * action model, so a Chromium test can move a focused item between states
 * the way a permission read or an in-flight change does in the app.
 */
type MenuState = {
  writable: boolean
  permissionStatus: GfsResourceMenuPermissionGateStatus
  mutating: boolean
}

type FocusHarness = {
  /** Resolves once React has committed `state`. */
  setState: (state: MenuState) => Promise<void>
  calls: string[]
}

declare global {
  interface Window {
    __gfsMenuFocus?: FocusHarness
  }
}

const URI = 'gfs://main/0123456789abcdef0123456789abcdef'
const calls: string[] = []
const record = (id: string) => () => {
  calls.push(id)
}
const handlers = {
  'copy-link': record('copy-link'),
  'open-route': record('open-route'),
  'open-folder': record('open-folder'),
  'new-folder': record('new-folder'),
  'upload-file': record('upload-file'),
  rename: record('rename'),
  move: record('move'),
  share: record('share'),
  delete: record('delete'),
  preview: record('preview'),
  download: record('download'),
}

function actionsFor({ writable, mutating }: MenuState) {
  const held = writable ? ['read', 'write'] : ['read']
  return getGfsMenuActions(
    buildGfsResourceActions(
      sidebarRowActionOptions({
        kind: 'file',
        uri: URI,
        readable: true,
        previewable: true,
        parentResourceId: 'parent-1',
        availability: gfsRowActionAvailability({
          resource: { parentResourceId: 'parent-1', permissions: held },
          listing: 'folder',
          rowAffordances: { held },
          parentAffordances: { held },
        }),
        hostAvailable: true,
        mutating,
        handlers,
      })
    )
  )
}

const initial = new URLSearchParams(window.location.search)
const initialState: MenuState = {
  writable: initial.get('writable') === 'true',
  permissionStatus: (initial.get('status') ?? 'ok') as GfsResourceMenuPermissionGateStatus,
  mutating: initial.get('mutating') === 'true',
}

function Harness() {
  const [state, setState] = useState(initialState)
  const committed = useRef<(() => void) | null>(null)
  useEffect(() => {
    committed.current?.()
    committed.current = null
  }, [state])
  window.__gfsMenuFocus = {
    setState: next =>
      new Promise<void>(resolve => {
        committed.current = resolve
        setState(next)
      }),
    calls,
  }
  return (
    <GfsResourceMenu
      actions={actionsFor(state)}
      anchor={{ x: 40, y: 40 }}
      permissionStatus={state.permissionStatus}
      resourceName="notes.md"
    />
  )
}

createRoot(document.getElementById('root')!).render(<Harness />)
