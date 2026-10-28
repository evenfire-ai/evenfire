type MigrationFixtureResult = { rows: Array<Record<string, unknown>>; rowCount: number }

/** Supply fence-query responses for migration-runner unit fixtures. */
export function passwordAdmissionMigrationFixtureResult(
  sql: string
): MigrationFixtureResult | undefined {
  if (sql.includes('password-admission-required-receipts')) {
    const versions = [
      '0126_bug192_password_admission',
      '0127_password_evaluation_retention',
      '0128_password_work_ownership',
    ]
    return { rows: versions.map(version => ({ version })), rowCount: versions.length }
  }
  if (sql.includes("to_regclass('public.password_identifier_state')")) {
    return {
      rows: [
        {
          identifier_state: 'password_identifier_state',
          work_owner: 'password_verification_work',
          users: 'users',
        },
      ],
      rowCount: 1,
    }
  }
  if (sql.includes('SELECT phase FROM password_admission_rollout_state')) {
    return { rows: [{ phase: 'draining' }], rowCount: 1 }
  }
  if (sql.includes('SELECT count(*)::integer AS active_count FROM password_verification_work')) {
    return { rows: [{ active_count: 0 }], rowCount: 1 }
  }
  if (sql.includes('password_admission_rollout_is_ready()')) {
    return { rows: [{ ready: true }], rowCount: 1 }
  }
  return undefined
}
