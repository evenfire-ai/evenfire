// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShellOverlayContext } from '@contexts/ShellOverlayContext'
import { cleanup, render, screen } from '@testing-library/react'
import { useReportShellOverlay } from '../useReportShellOverlay'

function Overlay({ source, open }: { source: string; open: boolean }) {
  useReportShellOverlay(source, open)
  return <span>{source}</span>
}

const reported = (collector: ReturnType<typeof vi.fn>) =>
  collector.mock.calls.map(([source, open]) => `${source}:${open}`)

describe('useReportShellOverlay', () => {
  afterEach(cleanup)

  it('reports an overlay while it is open, and reports it closed after', () => {
    const setShellOverlay = vi.fn()
    const view = render(
      <ShellOverlayContext.Provider value={{ setShellOverlay }}>
        <Overlay open={false} source="delete-confirmation" />
      </ShellOverlayContext.Provider>
    )
    expect(reported(setShellOverlay)).toStrictEqual([])

    view.rerender(
      <ShellOverlayContext.Provider value={{ setShellOverlay }}>
        <Overlay open source="delete-confirmation" />
      </ShellOverlayContext.Provider>
    )
    expect(reported(setShellOverlay)).toStrictEqual(['delete-confirmation:true'])

    view.rerender(
      <ShellOverlayContext.Provider value={{ setShellOverlay }}>
        <Overlay open={false} source="delete-confirmation" />
      </ShellOverlayContext.Provider>
    )
    expect(reported(setShellOverlay)).toStrictEqual([
      'delete-confirmation:true',
      'delete-confirmation:false',
    ])
  })

  it('reports the overlay closed when its component unmounts while it is open', () => {
    const setShellOverlay = vi.fn()
    const view = render(
      <ShellOverlayContext.Provider value={{ setShellOverlay }}>
        <Overlay open source="delete-confirmation" />
      </ShellOverlayContext.Provider>
    )

    view.unmount()

    expect(reported(setShellOverlay)).toStrictEqual([
      'delete-confirmation:true',
      'delete-confirmation:false',
    ])
  })

  it('keeps each source apart', () => {
    const setShellOverlay = vi.fn()
    const view = render(
      <ShellOverlayContext.Provider value={{ setShellOverlay }}>
        <Overlay open source="sidebar" />
        <Overlay open source="header" />
      </ShellOverlayContext.Provider>
    )
    view.rerender(
      <ShellOverlayContext.Provider value={{ setShellOverlay }}>
        <Overlay open={false} source="sidebar" />
        <Overlay open source="header" />
      </ShellOverlayContext.Provider>
    )

    expect(reported(setShellOverlay)).toStrictEqual([
      'sidebar:true',
      'header:true',
      'sidebar:false',
    ])
  })

  it('does nothing outside the app shell', () => {
    render(<Overlay open source="delete-confirmation" />)

    expect(screen.getByText('delete-confirmation')).toBeTruthy()
  })
})
