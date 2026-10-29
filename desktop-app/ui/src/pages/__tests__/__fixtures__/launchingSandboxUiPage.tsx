import { type ComponentProps, useCallback, useEffect, useRef, useState } from 'react'
import type { Launch } from '@lib/embedOwnership.types'
import { createEmbedOwnershipMachine } from '@lib/embedOwnershipMachine'
import type { EmbedOwnershipMachine } from '@lib/embedOwnershipMachine.types'
import type { ActiveSandboxUiApp } from '@/uiTypes'
import { SandboxUiPage } from '../../SandboxUiPage'

/** The real ownership machine, talking to whatever `window.clerum.sandboxUi` the test installed. */
export function createPageEmbed(): EmbedOwnershipMachine {
  return createEmbedOwnershipMachine({
    bridge: {
      open: request => window.clerum.sandboxUi.open(request),
      close: request => window.clerum.sandboxUi.close(request),
    },
    updateTabs: () => {},
  })
}

type LaunchingSandboxUiPageProps = Omit<
  ComponentProps<typeof SandboxUiPage>,
  'onLaunchApp' | 'embed'
> & {
  embed?: EmbedOwnershipMachine
  onLaunchApp?: (app: ActiveSandboxUiApp) => void
  /** Launched once on mount, the way a deep link to `routePath` is. */
  initialLaunch?: ActiveSandboxUiApp
}

function launchOf(app: ActiveSandboxUiApp, tabId: string): Launch {
  return {
    launchId: crypto.randomUUID(),
    tabId,
    appRef: app.appRef,
    route:
      app.routePath !== undefined
        ? { kind: 'explicit', routePath: app.routePath }
        : { kind: 'tab' },
    app: { label: app.label, defaultPath: app.defaultPath },
  }
}

// The picker grid never opens an app itself: it hands it to the owner, and App
// opens a new app tab for it and launches into it once that tab is committed.
// Page-level tests that need a mounted app reproduce that here against the real
// machine: project the new tab, then dispatch its launch. The App-level suites
// cover App's own seam. The title-bar container is document.body so the
// portaled mounted-app actions stay queryable via `screen`.
export function LaunchingSandboxUiPage({
  embed: providedEmbed,
  onLaunchApp,
  initialLaunch,
  ...props
}: LaunchingSandboxUiPageProps) {
  const [embed] = useState(() => providedEmbed ?? createPageEmbed())
  const tabSequenceRef = useRef(0)
  const launch = useCallback(
    (app: ActiveSandboxUiApp) => {
      const tabId = `ws-tab-${++tabSequenceRef.current}`
      embed.dispatch({ type: 'projected', activeAppTabId: tabId })
      const next = launchOf(app, tabId)
      embed.registerWhenSettled(next.launchId)
      embed.dispatch({ type: 'intent', launch: next })
    },
    [embed]
  )
  const handleLaunchApp = useCallback(
    (app: ActiveSandboxUiApp) => {
      onLaunchApp?.(app)
      launch(app)
    },
    [launch, onLaunchApp]
  )
  const initialLaunchRef = useRef(initialLaunch)
  useEffect(() => {
    const app = initialLaunchRef.current
    initialLaunchRef.current = undefined
    if (app) launch(app)
  }, [launch])
  return (
    <SandboxUiPage
      titlebarLeadingContainer={document.body}
      {...props}
      embed={embed}
      onLaunchApp={handleLaunchApp}
    />
  )
}
