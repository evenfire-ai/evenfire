import { useCallback, useEffect, useRef, useState } from 'react'
import type { InlineRenameController, UseInlineRenameOptions } from './useInlineRename.types'

/**
 * An inline title editor: Enter or losing focus saves, Escape closes, an
 * unchanged or blank title saves nothing. One editor per hook instance.
 *
 * The title is compared with the one the editor opened with, not the live one:
 * a title that changes underneath an untouched editor is not the user's edit
 * and must not be overwritten by it. A rejected rename gives the typed title
 * back, so nothing the user typed is lost.
 */
export function useInlineRename({
  onRename,
  onRejected,
  returnFocusToRef,
}: UseInlineRenameOptions): InlineRenameController {
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const baselineRef = useRef('')
  const attemptRef = useRef(0)
  useEffect(
    () => () => {
      attemptRef.current += 1
    },
    []
  )
  // A closed editor ignores a later blur, so Escape can never save.
  const closedRef = useRef(true)
  const focusOnOpenRef = useRef(true)
  const restoreFocusRef = useRef(false)

  useEffect(() => {
    if (!editingKey || !focusOnOpenRef.current) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editingKey])

  // Runs once the editor has closed and its trigger is back in the tree.
  useEffect(() => {
    if (editingKey !== null || !restoreFocusRef.current) return
    restoreFocusRef.current = false
    returnFocusToRef?.current?.focus()
  }, [editingKey, returnFocusToRef])

  // Closes the editor. When it still held focus (Enter, Escape), focus goes back
  // to the caller's element once that element is back in the tree; a
  // blur-driven close leaves focus where the user put it.
  const close = useCallback(() => {
    if (document.activeElement === inputRef.current) restoreFocusRef.current = true
    closedRef.current = true
    setEditingKey(null)
  }, [])

  const start = useCallback((key: string, currentValue: string) => {
    attemptRef.current += 1
    closedRef.current = false
    focusOnOpenRef.current = true
    baselineRef.current = currentValue
    setValue(currentValue)
    setEditingKey(key)
  }, [])

  const cancel = useCallback(() => {
    attemptRef.current += 1
    close()
  }, [close])

  const commit = useCallback(() => {
    if (closedRef.current) return
    const key = editingKey
    const nextTitle = value.trim()
    const attempt = attemptRef.current
    close()
    if (!key || !nextTitle || nextTitle === baselineRef.current) return
    Promise.resolve(onRename(key, nextTitle)).catch(() => {
      // The rename did not happen. Give the typed title back without pulling
      // focus from wherever the user has moved on to; `onRejected` says why.
      onRejected()
      if (attemptRef.current !== attempt) return
      closedRef.current = false
      focusOnOpenRef.current = false
      setValue(nextTitle)
      setEditingKey(key)
    })
  }, [close, editingKey, onRename, onRejected, value])

  const onChange: InlineRenameController['onChange'] = event => setValue(event.target.value)

  const onKeyDown: InlineRenameController['onKeyDown'] = event => {
    if (event.key === 'Enter') {
      // An Enter that confirms an input-method candidate is not a save.
      if (event.nativeEvent.isComposing) return
      event.preventDefault()
      commit()
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
  }

  return { editingKey, value, inputRef, start, cancel, commit, onChange, onKeyDown, onBlur: commit }
}
