import { useLayoutEffect, useRef } from 'react'
import { Button, Flex, Input, Typography } from 'antd'
import type { InputRef } from 'antd'
import type { SandboxCurrentContentSearchProps } from './types'

export default function SandboxCurrentContentSearch({
  focusRequestId,
  onClose,
  onMove,
  onQueryChange,
  query,
  state,
}: SandboxCurrentContentSearchProps) {
  const inputRef = useRef<InputRef>(null)

  useLayoutEffect(() => {
    inputRef.current?.focus()
  }, [focusRequestId])

  const matchStatus =
    state.status === 'pending'
      ? 'Searching…'
      : state.status === 'results'
        ? `${state.current}/${state.total}`
        : state.status === 'empty'
          ? '0/0'
          : state.status === 'unavailable'
            ? state.reason
            : state.status === 'error'
              ? 'Search failed'
              : '—'

  return (
    <Flex align="center" gap="small" role="search" aria-label="Search current app">
      <Input
        ref={inputRef}
        aria-label="Find in current app"
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
      <Typography.Text role="status" aria-live="polite">
        {matchStatus}
      </Typography.Text>
      <Button
        aria-label="Previous app match"
        disabled={state.status !== 'results'}
        onClick={() => onMove('previous')}
      >
        ↑
      </Button>
      <Button
        aria-label="Next app match"
        disabled={state.status !== 'results'}
        onClick={() => onMove('next')}
      >
        ↓
      </Button>
      <Button aria-label="Close current app search" onClick={onClose}>
        ×
      </Button>
    </Flex>
  )
}
