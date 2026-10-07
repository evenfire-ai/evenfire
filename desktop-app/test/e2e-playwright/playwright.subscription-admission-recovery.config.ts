// E2E_GUARDIAN_IPC_FLOW: collection gates precede all setup; this suite has its own named report.
import { remainingJourneyConfig } from './subscriptionRemainingJourneyConfig.js'

export default remainingJourneyConfig(
  'admission-recovery',
  'subscription-admission-recovery.spec.ts'
)
