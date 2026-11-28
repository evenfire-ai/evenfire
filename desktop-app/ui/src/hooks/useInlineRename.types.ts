import type { RefObject } from 'react'

export type UseInlineRenameOptions = {
  /**
   * Performs the rename of the record `start` was called with. A rejection
   * means the rename did not happen: the editor reopens with the typed title.
   */
  onRename: (key: string, nextTitle: string) => void | Promise<unknown>
  /** Called after a rejected rename; the caller says why. */
  onRejected: () => void
  /**
   * Element that takes focus back when the editor closes while it held focus
   * (Enter, Escape). A blur-driven close leaves focus where the user put it.
   */
  returnFocusToRef?: RefObject<HTMLElement | null>
}

export type InlineRenameController = {
  /** Key of the record being edited, or null when no editor is open. */
  editingKey: string | null
  value: string
  inputRef: RefObject<HTMLInputElement | null>
  /** Opens the editor on `key`, showing `currentValue` selected. */
  start: (key: string, currentValue: string) => void
  /** Closes the editor without saving. */
  cancel: () => void
  /** Saves the edited title; an unchanged or blank one saves nothing. */
  commit: () => void
  onChange: (event: { target: { value: string } }) => void
  onKeyDown: (event: {
    key: string
    nativeEvent: { isComposing?: boolean }
    preventDefault: () => void
    stopPropagation: () => void
  }) => void
  onBlur: () => void
}
