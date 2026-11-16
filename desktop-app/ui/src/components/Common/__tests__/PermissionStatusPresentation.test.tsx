// @vitest-environment jsdom
import { useLayoutEffect, useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PermissionErrorDialog, PermissionStatusIndicator } from '@components/Common'

afterEach(cleanup)

describe('EvenDrive permission status presentation', () => {
  it('keeps the reserved status slot mounted and exposes operation details on focus', () => {
    const { rerender, container } = render(
      <div className="da-gfs-preview-title-row">
        <h2>diagram.png</h2>
        <PermissionStatusIndicator active={false} label="Checking file permissions" />
        <button>Options</button>
      </div>
    )
    const slot = container.querySelector('.da-permission-status-slot')
    expect(slot).toBeTruthy()
    expect(slot?.nextElementSibling?.textContent).toBe('Options')
    rerender(
      <div className="da-gfs-preview-title-row">
        <h2>diagram.png</h2>
        <PermissionStatusIndicator active label="Checking file and Move permissions" />
        <button>Options</button>
      </div>
    )
    const indicator = screen.getByRole('status', {
      name: 'Checking file and Move permissions',
    })
    fireEvent.focus(indicator)
    expect(screen.getByText('Checking file and Move permissions')).toBeTruthy()
    expect(container.querySelector('.da-permission-status-slot')).toBe(slot)
  })

  it('keeps keyboard focus on the status owner when checking completes', () => {
    const { rerender } = render(
      <PermissionStatusIndicator active label="Checking file permissions" />
    )
    const activeIndicator = screen.getByRole('status', { name: 'Checking file permissions' })
    activeIndicator.focus()

    rerender(<PermissionStatusIndicator active={false} label="Checking file permissions" />)

    const idleOwner = screen.getByRole('group', { name: 'Permission check complete' })
    expect(idleOwner).toBe(activeIndicator)
    expect(document.activeElement).toBe(idleOwner)
    expect(idleOwner.getAttribute('tabindex')).toBe('-1')
    expect(idleOwner.getAttribute('aria-live')).toBe('off')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('does not create an idle keyboard stop when the status was not focused', () => {
    const { container } = render(
      <PermissionStatusIndicator active={false} label="Checking file permissions" />
    )

    expect(container.querySelector('.da-permission-status-slot')).toBeTruthy()
    expect(container.querySelector('.da-permission-status-indicator')).toBeNull()
  })

  it('restores dismissal focus to an eligible input outside the portaled Files surface', () => {
    function FocusReturnFixture() {
      const inputRef = useRef<HTMLInputElement>(null)
      const [dialogOpen, setDialogOpen] = useState(true)
      useLayoutEffect(() => inputRef.current?.focus(), [])
      return (
        <>
          <input aria-label="Search outside Files" ref={inputRef} />
          <div className="da-gfs-page">
            <div className="da-gfs-current-file__title-row">
              <button className="da-gfs-resource-menu__trigger">Options</button>
            </div>
            {dialogOpen ? (
              <PermissionErrorDialog
                errors={[{ id: 'query-focus-return', message: 'Permission check failed.' }]}
                onDismiss={() => setDialogOpen(false)}
              />
            ) : null}
          </div>
        </>
      )
    }

    render(<FocusReturnFixture />)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'Search outside Files' })
    )
  })

  it('uses the visible Files menu trigger when the previously focused element disappears', () => {
    function FocusReturnFixture() {
      const inputRef = useRef<HTMLInputElement>(null)
      const [inputVisible, setInputVisible] = useState(true)
      const [dialogOpen, setDialogOpen] = useState(true)
      useLayoutEffect(() => inputRef.current?.focus(), [])
      return (
        <div className="da-gfs-page">
          {inputVisible ? <input aria-label="Temporary search" ref={inputRef} /> : null}
          <div className="da-gfs-current-file__title-row">
            <button className="da-gfs-resource-menu__trigger">Options</button>
          </div>
          {dialogOpen ? (
            <PermissionErrorDialog
              errors={[{ id: 'query-focus-fallback', message: 'Permission check failed.' }]}
              onDismiss={() => {
                setInputVisible(false)
                setDialogOpen(false)
              }}
            />
          ) : null}
        </div>
      )
    }

    render(<FocusReturnFixture />)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Options' }))
  })

  it('traps keyboard focus, dismisses on Escape, and retains the exact Retry callback', () => {
    const retry = vi.fn(() => ({ admitted: false }))
    const onDismiss = vi.fn()
    render(
      <PermissionErrorDialog
        errors={[{ id: 'query-1', message: 'Could not verify permissions for report.txt.', retry }]}
        onDismiss={onDismiss}
      />
    )
    const dialog = screen.getByRole('alertdialog', { name: 'Could not verify permissions' })
    const close = screen.getByRole('button', { name: 'Close' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Retry permission check' }))
    expect(retry).toHaveBeenCalledTimes(1)
    close.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Retry permission check' })
    )
    fireEvent.keyDown(close, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledWith(['query-1'])
  })

  it('contains Escape within the portaled permission dialog', () => {
    const onDismiss = vi.fn()
    const parentKeyDown = vi.fn()
    render(
      <div onKeyDown={parentKeyDown}>
        <PermissionErrorDialog
          errors={[{ id: 'query-escape', message: 'Permission check failed.' }]}
          onDismiss={onDismiss}
        />
      </div>
    )

    fireEvent.keyDown(screen.getByRole('button', { name: 'Close' }), { key: 'Escape' })

    expect(onDismiss).toHaveBeenCalledOnce()
    expect(parentKeyDown).not.toHaveBeenCalled()
  })

  it('aggregates duplicate observations of one permission query into one retry target', () => {
    const queryClient = new QueryClient()
    const queryKey = ['permission-aggregation', 'parent-folder'] as const
    queryClient.setQueryData(queryKey, { held: ['read'] })
    const queryIdentity = queryClient.getQueryCache().find({ queryKey, exact: true })
    if (!queryIdentity) throw new Error('QueryClient did not create the permission Query')
    const retry = vi.fn(() => ({ admitted: false }))
    render(
      <PermissionErrorDialog
        errors={[
          {
            id: 'row:parent-folder',
            queryIdentity,
            errorUpdateCount: 1,
            message: 'Could not verify permissions for Team.',
            retry,
          },
          {
            id: 'move:parent-folder',
            queryIdentity,
            errorUpdateCount: 1,
            message: 'Could not verify Move permissions for Team.',
            retry,
          },
        ]}
        onDismiss={vi.fn()}
      />
    )

    expect(screen.getAllByText(/Could not verify permissions for Team/)).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Retry permission check' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Retry permission check' }))
    expect(retry).toHaveBeenCalledOnce()
    queryClient.clear()
  })
})
