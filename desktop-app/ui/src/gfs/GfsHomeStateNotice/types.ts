import type { GfsHomeNotice } from '../callerHome.types'

export type GfsHomeStateNoticeProps = {
  notice: GfsHomeNotice
  /** The sidebar tree uses compact chrome; the Files page uses a full banner. */
  variant: 'sidebar' | 'page'
}
