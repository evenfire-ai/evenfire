// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TitlebarActionsPortal, WindowTitleBar } from '@components/WindowTitleBar'

afterEach(() => cleanup())

describe('chat drawer titlebar portal', () => {
  it('mounts actions in the titlebar instead of the content panel', async () => {
    function Harness() {
      const [actionsRoot, setActionsRoot] = React.useState<HTMLDivElement | null>(null)

      return (
        <div className="app-frame">
          <WindowTitleBar actionsRef={setActionsRoot} />
          <div className="app-root">
            <section className="content-panel">
              <TitlebarActionsPortal container={actionsRoot}>
                <button type="button">Search</button>
              </TitlebarActionsPortal>
            </section>
          </div>
        </div>
      )
    }

    render(<Harness />)

    const search = await screen.findByRole('button', { name: 'Search' })
    expect(search.closest('.window-titlebar')).toBeTruthy()
    expect(search.closest('.content-panel')).toBeNull()
  })
})
