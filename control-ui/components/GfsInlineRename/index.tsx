'use client'

import { IconCheck, IconX } from '@components/icons'
import { Button, TextInput } from '@components/ui'
import { cn } from '@lib/cn'
import type { GfsInlineRenameProps } from './types'

export function GfsInlineRename({
  busy = false,
  className,
  onCancel,
  onChange,
  onSubmit,
  value,
}: GfsInlineRenameProps) {
  return (
    <form
      aria-label="Rename resource"
      className={cn('cu-gfs-inline-rename', className)}
      onClick={event => event.stopPropagation()}
      onSubmit={event => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <TextInput
        aria-label="New name"
        autoFocus
        className="cu-gfs-inline-rename__input"
        compact
        value={value}
        onChange={event => onChange(event.currentTarget.value)}
        onFocus={event => event.currentTarget.select()}
      />
      <span className="cu-gfs-inline-rename__actions">
        <Button
          aria-label="Save name"
          className="cu-gfs-inline-rename__confirm"
          disabled={!value.trim()}
          icon
          loading={busy}
          size="sm"
          title="Save name"
          type="submit"
          variant="ghost"
        >
          <IconCheck />
        </Button>
        <Button
          aria-label="Cancel rename"
          className="cu-gfs-inline-rename__cancel"
          disabled={busy}
          icon
          size="sm"
          title="Cancel rename"
          type="button"
          variant="ghost"
          onClick={onCancel}
        >
          <IconX />
        </Button>
      </span>
    </form>
  )
}

export type { GfsInlineRenameProps } from './types'
