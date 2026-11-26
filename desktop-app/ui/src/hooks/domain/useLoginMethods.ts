import { useCallback, useRef, useState } from 'react'
import { errorClass } from '@lib/errorClass'
import { ipcErrorCode } from '@lib/ipcErrorCode'
import type { LoginMethodsAnswer } from '../../../../src/types'
import type { LoginScreenModel, UseLoginMethodsParams, UseLoginMethodsResult } from './types'

const LOADING: LoginScreenModel = Object.freeze({ kind: 'loading' })
const UNREACHABLE: LoginScreenModel = Object.freeze({ kind: 'unreachable' })
/** Below every generation main reports, so the first answer of an epoch always applies. */
const NOTHING_APPLIED = -1
/** Below every read's send number. */
const NO_SEND = 0

/**
 * The login screen's model, read from main (E12; design §10.1), and the one helper every
 * binding-changing call goes through (D15).
 *
 * Main stamps each answer with the generation it captured when it dispatched the read, but a
 * binding change returns no generation, so the renderer keeps its own request epoch. The helper
 * moves the epoch before each binding-changing call: an answer to a read sent under an older
 * epoch is dropped (L6), and within an epoch answers apply in non-decreasing generation order
 * (S5). A failed read carries no generation, so it is ordered by when it was sent: it shows the
 * unreachable state only if no read sent after it in the epoch has applied an answer. The helper
 * reads the model again when the call settles, success or failure, so the screen never stays on
 * `loading` (L7). The login screen sends its own reads; nothing reads on mount.
 */
export function useLoginMethods({
  refreshRuntimeConfigState,
}: UseLoginMethodsParams): UseLoginMethodsResult {
  const [model, setModel] = useState<LoginScreenModel>(LOADING)
  const epochRef = useRef(0)
  const appliedGenerationRef = useRef(NOTHING_APPLIED)
  /** Numbers each read in the order it is sent; it only grows. */
  const sendCountRef = useRef(NO_SEND)
  /**
   * The send number of the latest-sent read whose answer applied. A read of the current epoch was
   * sent after every read of an earlier one, so only this epoch's answers can exceed its number,
   * and a binding change needs no reset.
   */
  const appliedSendRef = useRef(NO_SEND)

  const refresh = useCallback(() => {
    const epoch = epochRef.current
    sendCountRef.current += 1
    const send = sendCountRef.current
    // A throw (a preload older than the renderer) becomes a rejection: `refresh` runs in the
    // helper's `finally`, where a throw would replace the call's own outcome.
    new Promise<LoginMethodsAnswer>(resolve => resolve(window.clerum.auth.getLoginMethods())).then(
      answer => {
        if (epochRef.current !== epoch) return
        if (answer.generation < appliedGenerationRef.current) return
        appliedGenerationRef.current = answer.generation
        appliedSendRef.current = Math.max(appliedSendRef.current, send)
        setModel(answer.model)
      },
      (error: unknown) => {
        // A read sent before the last binding change: its failure says nothing about the new
        // binding, which the change reads again when it settles.
        if (epochRef.current !== epoch) return
        // No environment is configured: onboarding shows instead of this screen, so the model
        // is left as it is (E12, N1). Nothing failed, so nothing is logged.
        if (ipcErrorCode(error, ['desktop_setup_required']) !== null) return
        // A read sent after this one has already applied its answer, which is newer than this
        // failure, so the failure is dropped (Task 13 review M1).
        if (send < appliedSendRef.current) return
        console.warn('[useLoginMethods] The login methods could not be read', errorClass(error))
        setModel(UNREACHABLE)
      }
    )
  }, [])

  const runBindingChange = useCallback(
    async <T>(call: () => Promise<T>): Promise<T> => {
      // Before the call, in this turn: a read already sent answers for the binding being left.
      epochRef.current += 1
      appliedGenerationRef.current = NOTHING_APPLIED
      setModel(LOADING)
      try {
        return await call()
      } catch (error) {
        // A failed change may still have moved the binding (A3-65); the caller reports `error`.
        new Promise(resolve => resolve(refreshRuntimeConfigState())).catch(
          (refreshError: unknown) => {
            console.warn(
              '[useLoginMethods] The runtime config state could not be read after a failed change',
              errorClass(refreshError)
            )
          }
        )
        throw error
      } finally {
        refresh()
      }
    },
    [refresh, refreshRuntimeConfigState]
  )

  return { model, refresh, runBindingChange }
}
