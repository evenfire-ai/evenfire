'use client'

import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { DialogShell } from './DialogShell'
import type { MultiSelectActionDialogProps } from './types'

export function MultiSelectActionDialog({
  open,
  onDismiss,
  title,
  description,
  items,
  selectedIds,
  onSelectedIdsChange,
  onAction,
  actionLabel,
  cancelLabel = 'Cancel',
  searchLabel = 'Search items',
  searchPlaceholder = 'Search',
  emptyMessage = 'No items available.',
  noMatchesMessage = 'No matching items.',
  loading = false,
  pending = false,
  error,
  size = 'large',
}: MultiSelectActionDialogProps) {
  const searchId = useId()
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleItems = useMemo(
    () =>
      items.filter(item => {
        const labelText =
          typeof item.label === 'string' || typeof item.label === 'number'
            ? String(item.label)
            : item.id
        const searchableText = (item.searchText ?? labelText).toLocaleLowerCase()
        return !normalizedQuery || searchableText.includes(normalizedQuery)
      }),
    [items, normalizedQuery]
  )
  const selected = new Set(selectedIds)
  const actionableSelectedIds = selectedIds.filter(id =>
    items.some(item => item.id === id && !item.disabled)
  )
  const footer: ReactNode = (
    <>
      <button
        className="eft-dialog__button eft-dialog__button--secondary"
        disabled={pending}
        onClick={() => onDismiss('cancel')}
        type="button"
      >
        {cancelLabel}
      </button>
      <button
        className="eft-dialog__button eft-dialog__button--primary"
        disabled={loading || pending || actionableSelectedIds.length === 0}
        onClick={() => onAction(actionableSelectedIds)}
        type="button"
      >
        {pending ? 'Working…' : actionLabel}
      </button>
    </>
  )

  return (
    <DialogShell
      busy={pending}
      description={description}
      error={error}
      footer={footer}
      onDismiss={onDismiss}
      open={open}
      size={size}
      title={title}
      status={loading ? 'Loading items…' : undefined}
    >
      <div className="eft-multi-select">
        <label className="eft-multi-select__search-label" htmlFor={searchId}>
          {searchLabel}
        </label>
        <input
          className="eft-multi-select__search"
          id={searchId}
          onChange={event => setQuery(event.currentTarget.value)}
          placeholder={searchPlaceholder}
          type="search"
          value={query}
        />
        {loading ? null : items.length === 0 ? (
          <p className="eft-multi-select__message">{emptyMessage}</p>
        ) : visibleItems.length === 0 ? (
          <p className="eft-multi-select__message">{noMatchesMessage}</p>
        ) : (
          <ul className="eft-multi-select__list">
            {visibleItems.map(item => (
              <li className="eft-multi-select__item" key={item.id}>
                <label className="eft-multi-select__option">
                  <input
                    checked={selected.has(item.id)}
                    disabled={pending || item.disabled}
                    onChange={event => {
                      const next = new Set(selectedIds)
                      if (event.currentTarget.checked) next.add(item.id)
                      else next.delete(item.id)
                      onSelectedIdsChange([...next])
                    }}
                    type="checkbox"
                  />
                  <span>
                    <span className="eft-multi-select__option-label">{item.label}</span>
                    {item.description ? (
                      <span className="eft-multi-select__option-description">
                        {item.description}
                      </span>
                    ) : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </DialogShell>
  )
}
