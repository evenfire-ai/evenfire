import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { IconButton, TextInput } from '@components/Common'
import { GfsResourceTitlebarActions } from '@components/GfsResourceTitlebarActions'
import { TitlebarActionsPortal, WindowTitleBar } from '@components/WindowTitleBar'

// Mounted by the native Electron app-region fixture. The title bar and the
// leading actions are the production components, so the fixture checks the
// element order they really render. The actions slot gets a search pill with
// the AppHeader titlebar class structure instead of the real AppHeader, which
// needs the authenticated data controllers; it only has to exercise the
// explicit `no-drag` carve-out that the title-bar search relies on.
function TitlebarAppRegionHarness() {
  const [actionsRoot, setActionsRoot] = useState<HTMLDivElement | null>(null)
  const [leadingRoot, setLeadingRoot] = useState<HTMLDivElement | null>(null)
  const noop = () => undefined

  return (
    <div className="app-frame">
      <WindowTitleBar actionsRef={setActionsRoot} leadingRef={setLeadingRoot} />
      <div className="app-root">
        <TitlebarActionsPortal container={leadingRoot}>
          <IconButton className="compact-navigation-toggle" label="Open navigation">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2 4h12M2 8h12M2 12h12" />
            </svg>
          </IconButton>
        </TitlebarActionsPortal>
        <GfsResourceTitlebarActions
          target={leadingRoot}
          onRefresh={noop}
          onCopyLink={noop}
          onOpenLink={noop}
        />
        <TitlebarActionsPortal container={actionsRoot}>
          <div className="top-bar top-bar--titlebar">
            <div className="header-left">
              <div className="global-search global-search--titlebar">
                <TextInput className="search-input search-input--titlebar" aria-label="Search" />
              </div>
            </div>
          </div>
        </TitlebarActionsPortal>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<TitlebarAppRegionHarness />)
