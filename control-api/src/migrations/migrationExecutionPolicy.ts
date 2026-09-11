import policyJson from './migrationExecutionPolicy.json'

export type MigrationExecutionPolicy = Readonly<{
  lockTimeoutMs: number
  ordinaryStatementTimeoutMs: number
  onlineIndexStatementTimeoutMs: number
  idleInTransactionTimeoutMs: number
  jobActiveDeadlineSeconds: number
  clientWaitSeconds: number
  terminationProofSeconds: number
  backoffLimit: number
  ttlSecondsAfterFinished: number
}>

const EXPECTED_POLICY: MigrationExecutionPolicy = Object.freeze({
  lockTimeoutMs: 10_000,
  ordinaryStatementTimeoutMs: 15_000,
  onlineIndexStatementTimeoutMs: 120_000,
  idleInTransactionTimeoutMs: 15_000,
  jobActiveDeadlineSeconds: 300,
  clientWaitSeconds: 360,
  terminationProofSeconds: 60,
  backoffLimit: 2,
  ttlSecondsAfterFinished: 600,
})

function validatePolicy(candidate: unknown): MigrationExecutionPolicy {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Invalid migration execution policy')
  }
  for (const [key, expected] of Object.entries(EXPECTED_POLICY)) {
    if ((candidate as Record<string, unknown>)[key] !== expected) {
      throw new Error(`Invalid migration execution policy value: ${key}`)
    }
  }
  if (Object.keys(candidate).length !== Object.keys(EXPECTED_POLICY).length) {
    throw new Error('Invalid migration execution policy keys')
  }
  if (
    EXPECTED_POLICY.lockTimeoutMs >= EXPECTED_POLICY.ordinaryStatementTimeoutMs ||
    EXPECTED_POLICY.clientWaitSeconds <
      EXPECTED_POLICY.jobActiveDeadlineSeconds + EXPECTED_POLICY.terminationProofSeconds
  ) {
    throw new Error('Invalid migration execution policy relationship')
  }
  return EXPECTED_POLICY
}

export const MIGRATION_EXECUTION_POLICY = validatePolicy(policyJson)

export const migrationSessionBoundsSql = (local: boolean): string[] => {
  const scope = local ? 'SET LOCAL' : 'SET'
  return [
    `${scope} lock_timeout = '${MIGRATION_EXECUTION_POLICY.lockTimeoutMs}ms'`,
    `${scope} statement_timeout = '${MIGRATION_EXECUTION_POLICY.ordinaryStatementTimeoutMs}ms'`,
    `${scope} idle_in_transaction_session_timeout = '${MIGRATION_EXECUTION_POLICY.idleInTransactionTimeoutMs}ms'`,
  ]
}
