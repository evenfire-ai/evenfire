import { useEffect, useMemo, useRef, useState } from 'react'
import { CloseOutlined, SearchOutlined } from '@ant-design/icons'
import { Button, Input } from 'antd'
import type { InputRef } from 'antd'
import { findLoadedChatMessageMatches, wrapMatchIndex } from '@lib/chatLocalSearch'
import type { ChatLocalSearchProps } from './types'

export function ChatLocalSearch({ models, onClose, onSearchStateChange }: ChatLocalSearchProps) {
  const [query, setQuery] = useState('')
  const [currentIndex, setCurrentIndex] = useState(0)
  const inputRef = useRef<InputRef | null>(null)
  const matches = useMemo(() => findLoadedChatMessageMatches(models, query), [models, query])
  const currentMatch = matches[currentIndex] ?? null

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setCurrentIndex(index => (matches.length ? Math.min(index, matches.length - 1) : 0))
  }, [matches.length])

  useEffect(() => {
    onSearchStateChange(query, currentMatch)
    if (!currentMatch) return
    requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>('[data-current-search-match="true"]')
      target?.scrollIntoView?.({ block: 'center' })
    })
  }, [currentMatch, onSearchStateChange, query])

  const move = (delta: 1 | -1) => {
    setCurrentIndex(index => wrapMatchIndex(index, matches.length, delta))
  }

  return (
    <div className="current-content-search" role="search" aria-label="Search loaded chat messages">
      <Input
        ref={inputRef}
        aria-label="Find in current chat"
        prefix={<SearchOutlined aria-hidden="true" />}
        size="small"
        onChange={event => {
          setQuery(event.currentTarget.value)
          setCurrentIndex(0)
        }}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          } else if (event.key === 'Enter') {
            event.preventDefault()
            move(event.shiftKey ? -1 : 1)
          }
        }}
        placeholder="Find in loaded messages"
        value={query}
      />
      <span className="current-content-search__count" role="status" aria-live="polite">
        {matches.length ? currentIndex + 1 : 0}/{matches.length}
      </span>
      <Button
        aria-label="Previous match"
        icon={<span aria-hidden="true">↑</span>}
        size="small"
        onClick={() => move(-1)}
        type="text"
      />
      <Button
        aria-label="Next match"
        icon={<span aria-hidden="true">↓</span>}
        size="small"
        onClick={() => move(1)}
        type="text"
      />
      <Button
        aria-label="Close current chat search"
        icon={<CloseOutlined aria-hidden="true" />}
        size="small"
        onClick={onClose}
        type="text"
      />
      <span className="visually-hidden">
        Only messages already loaded in this chat are searched.
      </span>
    </div>
  )
}
