import type { ReactNode } from 'react'
import type { GfsBrowserChild, GfsCrumb } from '@hooks/domain/useGfsBrowserController'
import type { GfsResourceActionId } from '@lib/gfsResourceActions'
import type { Tone } from '@/uiTypes'

/** The actions the host runs on an explicit resource, in place. */
export type GfsHostActionId = Extract<
  GfsResourceActionId,
  | 'share'
  | 'rename'
  | 'move'
  | 'new-folder'
  | 'upload-file'
  | 'delete'
  | 'download'
  | 'copy-link'
  | 'copy-route'
>

/**
 * The resource an action is about. For `new-folder` and `upload-file` it is
 * the folder the new entry goes into.
 */
export interface GfsHostActionTarget extends GfsBrowserChild {
  /** Root-first path to the target, where the Move dialog opens. */
  ancestorCrumbs?: readonly GfsCrumb[]
}

export type GfsHostActionPhase = 'checking' | 'picking' | 'dialog' | 'running'

/** The resource an action works on and the session it started under. */
export interface GfsHostActionOrigin {
  target: GfsHostActionTarget
  originScope: string
  originGen: number
}

/** The one action the host owns. A new token is minted for every opening. */
export interface GfsHostActiveAction extends GfsHostActionOrigin {
  token: number
  actionId: GfsHostActionId
  phase: GfsHostActionPhase
}

/** The folder a picker opening is for, consumed once by the file it returns. */
export interface GfsHostPendingUpload {
  token: number
  folder: GfsHostActionTarget
  originScope: string
  originGen: number
}

export interface GfsActionHostContextValue {
  /**
   * Starts an action on `target`. Call it from the gesture that chose the
   * action: Upload opens the file picker synchronously.
   */
  openGfsAction: (target: GfsHostActionTarget, actionId: GfsHostActionId) => void
  /** The resource a host Move is committing, so a drag of it can be refused. */
  hostMovingResourceId: string | null
  /**
   * A host dialog is shown (also while its action runs): it owns Escape, so
   * surfaces under it must not consume the key. False while an action is
   * still checking its permissions or waiting on the file picker.
   */
  actionOpen: boolean
}

export interface GfsActionHostProps {
  children?: ReactNode
  pushToast: (message: string, tone: Tone) => void
  /** Re-reads the Files location on screen after a successful mutation. */
  refreshFilesLocation: () => void
  /**
   * Reported synchronously with every change of the active action, so the
   * owner's overlay gate moves in the same batch as the gesture.
   */
  onActionOpenChange: (open: boolean) => void
}

export interface GfsActionOverlay {
  /** True while a sidebar resource menu or a host action is open. */
  overlayOpen: boolean
  /** The resource menu's open-state report. */
  onGfsMenuOpenChange: (open: boolean) => void
  /** The host's active-action report. */
  onActionOpenChange: (open: boolean) => void
}
