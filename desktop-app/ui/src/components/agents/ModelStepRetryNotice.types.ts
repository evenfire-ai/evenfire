import type { ModelStepCheckpointView } from '../../../../src/types'
import type { ModelStepRetryState } from '../../uiTypes'

export interface ModelStepRetryNoticeProps {
  /** The active chat's checkpoint, as the Host last reported it. */
  checkpoint: ModelStepCheckpointView
  /** The in-flight / failed state of the last **Retry model step** request. */
  retry: ModelStepRetryState | null
  onRetry: () => void
}
