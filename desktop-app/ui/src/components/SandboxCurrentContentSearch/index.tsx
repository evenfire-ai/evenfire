import { useLayoutEffect, useRef } from 'react'
import { Button, TextInput } from '@components/Common'
import type { SandboxCurrentContentSearchProps } from './types'

export default function SandboxCurrentContentSearch({
  focusRequestId,
  onClose,
  onMove,
  onQueryChange,
  query,
  state,
}: SandboxCurrentContentSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    inputRef.current?.focus()
  }, [focusRequestId])

  return (
    <div className="current-content-search" role="search" aria-label="Search current app">
      <TextInput
        ref={inputRef}
        aria-label="Find in current app"
        className="current-content-search__input"
        onChange={event => onQueryChange(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          } else if (event.key === 'Enter') {
            event.preventDefault()
            onMove(event.shiftKey ? 'previous' : 'next')
          }
        }}
        placeholder="Find in current app"
        value={query}
      />
      <span className="current-content-search__count" role="status" aria-live="polite">
        {state.status === 'pending'
          ? 'Searching…'
          : state.status === 'results'
            ? `${state.current}/${state.total}`
            : state.status === 'empty'
              ? '0/0'
              : state.status === 'unavailable'
                ? state.reason
                : state.status === 'error'
                  ? 'Search failed'
                  : '—'}
      </span>
      <Button
        aria-label="Previous app match"
        color="neutral"
        disabled={state.status !== 'results'}
        onClick={() => onMove('previous')}
        size="xs"
        variant="ghost"
      >
        ↑
      </Button>
      <Button
        aria-label="Next app match"
        color="neutral"
        disabled={state.status !== 'results'}
        onClick={() => onMove('next')}
        size="xs"
        variant="ghost"
      >
        ↓
      </Button>
      <Button
        aria-label="Close current app search"
        color="neutral"
        onClick={onClose}
        size="xs"
        variant="ghost"
      >
        ×
      </Button>
    </div>
  )
}
