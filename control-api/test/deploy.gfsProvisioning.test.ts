import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

function read(relativeFromRepoRoot: string): string {
  return readFileSync(new URL(relativeFromRepoRoot, import.meta.url), 'utf-8')
}

describe('deploy/scripts/provision-gfs-db.sh', () => {
  const script = read('../../deploy/scripts/provision-gfs-db.sh')
  const verifier = read('../../scripts/minikube/verify-gfs.sh')
  const probe = read('../../deploy/scripts/lib/gfs-dsn-probe.sh')
  const transitions = read('../../deploy/scripts/lib/gfs-credential-secret.sh')
  const rollout = read('../../deploy/scripts/lib/gfs-credential-rollout.sh')
  const recovery = read('../../deploy/scripts/lib/gfs-credential-recovery.sh')
  const probePath = fileURLToPath(new URL('../../deploy/scripts/lib/gfs-dsn-probe.sh', import.meta.url))
  const role = 'gfs_controller'
  const host = 'control-postgres.control-plane.svc.cluster.local'
  const password = 'a'.repeat(48)
  const uri = (endpoint: string) => ['postgresql', '://', role, ':', password, endpoint].join('')

  it('requires an explicit mode and contains no broad rollout', () => {
    expect(script).toContain('stage-writer|stage-reader|rotate-reader|rotate-writer')
    expect(script).not.toContain('rollout restart deployment -l')
    expect(script).not.toContain('rollout status deployment -l')
    expect(script).not.toContain('base64 -d 2>/dev/null || true')
  })

  it('keeps reader and writer rotations independent', () => {
    const reader = script.slice(script.lastIndexOf('rotate-reader)'), script.lastIndexOf('rotate-writer)'))
    const writer = script.slice(script.lastIndexOf('rotate-writer)'))
    expect(reader).toContain('reconcile_credential gfs_controller_reader reader "$READER_SECRET" gfsc-reader true')
    expect(reader).not.toContain('gfsc-writer')
    expect(writer).toContain('reconcile_credential gfs_controller writer "$WRITER_SECRET" gfsc-writer true')
    expect(writer).not.toContain('gfsc-reader')
    const reconciliation = script.slice(script.indexOf('reconcile_credential()'), script.lastIndexOf('case "$MODE"'))
    expect(reconciliation.indexOf('ensure_pending_candidate')).toBeLessThan(reconciliation.indexOf('set_role_password'))
    expect(reconciliation.indexOf('claim_secret_candidate')).toBeLessThan(reconciliation.indexOf('set_role_password'))
    expect(reconciliation.indexOf('set_role_password')).toBeLessThan(reconciliation.indexOf('promote_candidate'))
    expect(reconciliation.indexOf('promote_candidate')).toBeLessThan(reconciliation.lastIndexOf('complete_rollout'))
  })

  it('adopts legacy writer state without rotating or restarting it', () => {
    const adoption = script.slice(script.indexOf('stage_writer()'), script.lastIndexOf('case "$MODE"'))
    expect(adoption).toContain('load_secret_snapshot "$WRITER_SECRET"')
    expect(adoption).toContain('dsn_has_role "$GFS_SNAPSHOT_ACTIVE" gfs_controller')
    expect(adoption).toContain('authenticate_or_restore_nologin gfs_controller writer "$GFS_SNAPSHOT_ACTIVE"')
    expect(adoption).toContain('verify_role_contract gfs_controller writer')
    expect(adoption).toContain('credential_adoption_timestamp gfsc-writer')
    expect(adoption).toContain('adopt_legacy_secret_state "$WRITER_SECRET" "$GFS_SNAPSHOT_RV" "$GFS_SNAPSHOT_ANNOTATIONS"')
    expect(adoption).toContain('[ "$(secret_dsn "$WRITER_SECRET")" = "$GFS_SNAPSHOT_ACTIVE" ]')
    expect(adoption).not.toContain('set_role_password')
    expect(adoption).not.toContain('complete_rollout')
    expect(transitions).toContain('{"op": "test", "path": "/metadata/resourceVersion", "value": rv}')
    expect(transitions).toContain('get secret "$secret" -o json')
    expect(transitions).toContain('GFS_SNAPSHOT_ROTATED_AT=')
    expect(rollout).toContain('input === process.env.GFS_PG_CONNECTION_STRING')
  })

  it('checks table, sequence, and membership boundaries explicitly', () => {
    expect(script).toContain("has_sequence_privilege(:'role_name', 'gfs_audit_sequence_no_seq', 'USAGE')")
    expect(script).toContain("has_sequence_privilege(:'role_name', 'gfs_audit_sequence_no_seq', 'SELECT')")
    expect(script).toContain("NOT has_sequence_privilege(:'role_name', 'gfs_audit_sequence_no_seq', 'UPDATE')")
    expect(script).toContain('NOT rolinherit')
    expect(script).toContain('pg_auth_members')
    expect(script).toContain("has_table_privilege(:'role_name', 'gfs_resources', 'INSERT')")
    expect(script).toContain("has_table_privilege(:'role_name', 'gfs_blob_manifests', 'DELETE')")
    expect(script).toContain(
      "has_column_privilege(:'role_name', 'control_admin_users', 'id', 'SELECT')"
    )
    expect(script).toContain(
      "has_column_privilege(:'role_name', 'team_members', 'status', 'SELECT')"
    )
    expect(script).toContain("column_name NOT IN ('id', 'status')")
    expect(script).toContain("column_name NOT IN ('team_id', 'user_id', 'status')")
    expect(script).toContain("'INSERT,UPDATE,REFERENCES'")
    expect(script).toContain("'DELETE,TRUNCATE,TRIGGER'")
  })

  it('fails API and decoding errors instead of treating them as absence', () => {
    expect(script).toContain('cannot read ${GFS_NS}/$secret')
    expect(script).toContain('contains an invalid $key encoding')
    expect(script).toContain('[ -n "$encoded" ] || return 0')
  })

  it('probes preserved reader authentication without exposing connection material', () => {
    const stage = script.slice(script.lastIndexOf('stage-reader)'), script.lastIndexOf('rotate-reader)'))
    expect(stage).toContain('reconcile_credential gfs_controller_reader reader "$READER_SECRET" gfsc-reader false')
    expect(script).toContain('gfs_dsn_authenticates_as "$1" "$2"')
    expect(probe).toContain('kc -n "$PG_NS" exec -i "$PG_PROBE_DEPLOY" -- node -e')
    expect(probe).toContain('await client.query("SELECT current_user")')
    expect(probe).toContain('[ "$actual" = "$expected_role" ]')
    expect(probe).toContain('error.code === "28P01" || error.code === "28000"')
    expect(probe).toContain('[ "$rc" -eq 41 ] && [ "$actual" = GFS_DSN_AUTH_REJECTED ]')
    const roleCheck = script.slice(script.indexOf('verify_role()'), script.indexOf('set_role_password()'))
    expect(roleCheck).toContain('persisted="$(secret_dsn "${!ref_name}")"')
    expect(roleCheck.indexOf('dsn_has_role "$persisted"')).toBeLessThan(roleCheck.indexOf('require_authenticated_dsn "$persisted"'))
    expect(roleCheck.indexOf('require_authenticated_dsn "$persisted"')).toBeLessThan(roleCheck.indexOf('verify_role_contract "$role" "$kind"'))
    expect(recovery).toContain('die "$3 authentication probe unavailable"')
    expect(recovery).toContain('authentication probe unavailable; refusing credential mutation')
    expect(recovery).toContain('disable_role_login "$role"')
    expect(script).not.toContain('DSN_TO_CHECK=')
    expect(script).not.toContain('-v role_secret="$password"')
    expect(script).not.toContain('PGPASSWORD=')
    expect(script).not.toContain('psql "$dsn"')
    expect(script).not.toContain('psql "$probe_dsn"')
    expect(script).not.toContain('-c "SELECT rolcanlogin')
    expect(script).toContain('-v role_name="$1" -f -')
    expect(probe).toContain('if not raw or "\\\\" in raw')
    expect(probe).toContain('ch.isspace() or unicodedata.category(ch).startswith("C")')
    expect(probe).toContain('parsed.hostname == expected_host')
    expect(probe).toContain('and not parsed.query')
    expect(probe).toContain('and not parsed.fragment')
    expect(probe).toContain('re.fullmatch(r"[0-9a-f]{48}", password)')
    expect(verifier).toContain('gfs_dsn_authenticates_as "$dsn" "$role"')
    expect(verifier).not.toContain('psql "$connection"')
    expect(verifier).toContain('clerum\\.io/gfs-dsn-rotated-at')
    expect(verifier).toContain('GlobalFileSystem/gfs is not adopted; no GFS instance to verify')
    expect(verifier).toContain('cannot determine whether GlobalFileSystem/gfs is adopted')
    expect(verifier).toContain('credential lifecycle is ${lifecycle:-unset}, not ready')
    expect(verifier).toContain('retains an unfinished credential candidate')
    expect(script).toContain('pending-connection-string')
    expect(script).toContain('Resuming persisted pending candidate')
    expect(script).toContain('Resuming incomplete ${deployment} rollout without rotating again')
    expect(script).toContain('rollback_uncommitted_candidate')
    expect(script).toContain('staged credential state was superseded; refusing a stale completion')
    expect(script).not.toContain('Adopting concurrently staged candidate')
    expect(script).toContain('GFS_RECOVER_ABANDONED_STATE')
    expect(recovery).toContain('role_can_login "$role"')
    expect(recovery).toContain('release_abandoned_candidate "$secret"')
    expect(transitions).toContain('{"op": "test", "path": state_path, "value": "pending"}')
    expect(transitions).toContain('{"op": "replace", "path": state_path, "value": "applying"}')
    expect(transitions).toContain('{"op": "test", "path": state_path, "value": "applying"}')
    expect(transitions).toContain('{"op": "replace", "path": state_path, "value": "rollout-pending"}')
    expect(transitions).toContain('{"op": "test", "path": pending_path, "value": candidate}')
    expect(rollout).toContain('rollout-running')
    expect(script).not.toContain('\\quit 1')
    expect(script.match(/SELECT 1\/0;/g)).toHaveLength(4)
  })

  it('accepts only the exact persisted endpoint and rejects URI overrides', () => {
    const run = (input: string) => spawnSync(
      'bash',
      ['-c', 'source "$1"; gfs_dsn_validate "$2" "$3" 5432 profiles', 'bash', probePath, role, host],
      { input, encoding: 'utf8' }
    )
    const accepted = run(uri(`@${host}:5432/profiles`))
    expect(accepted.status).toBe(0)
    expect(accepted.stdout).toBe('')
    for (const endpoint of [
      '@wrong.example:5432/profiles',
      '@[::1]:5432/profiles',
      `@${host}:5433/profiles`,
      `@${host}/profiles`,
      `@${host}:5432/wrong`,
      `@${host}:5432/profiles?host=example.invalid`,
      `@${host}:5432/profiles#override`,
      `@${host}:not-a-port/profiles`,
    ]) {
      expect(run(uri(endpoint)).status).not.toBe(0)
    }
    expect(run(`postgresql://other:${password}@${host}:5432/profiles`).status).not.toBe(0)
    expect(run(`postgresql://${role}:@${host}:5432/profiles`).status).not.toBe(0)
    expect(run(`postgresql://${role}:short@${host}:5432/profiles`).status).not.toBe(0)
    expect(run(`postgresql://${role}:${'A'.repeat(48)}@${host}:5432/profiles`).status).not.toBe(0)
    expect(run(`postgresql://${role}:${'%3B'.repeat(48)}@${host}:5432/profiles`).status).not.toBe(0)
    expect(run(`${uri(`@${host}:5432/profiles`)}\n`).status).not.toBe(0)
  })
})
