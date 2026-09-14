import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const helper = fileURLToPath(new URL('./desktop-login-seed.sh', import.meta.url))

test('shared seed preserves context allowlist and original copy-in-DB behavior without a cluster', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-seed-contract-'))
  const sqlFile = path.join(directory, 'captured.sql')
  const argsFile = path.join(directory, 'captured.args')
  const harness = path.join(directory, 'harness.sh')
  const fakeKubectl = path.join(directory, 'kubectl')
  try {
    fs.writeFileSync(
      fakeKubectl,
      '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$CAPTURE_ARGS"\ncat > "$CAPTURE_SQL"\nprintf "%s\\n" "$FIXTURE_USER_ID"\n',
      { mode: 0o700 }
    )
    fs.writeFileSync(
      harness,
      '#!/usr/bin/env bash\nset -euo pipefail\nsource "$1"\nCONTEXT="$2"\nis_password_seed_allowed_context || exit 88\nKC="kubectl --context=${CONTEXT}"\nCONTROL_API_NS=control-plane\nADMIN_USERNAME=fixture-admin\ndie() { exit 89; }\nseed_desktop_login_for_user fixture@members.test "$FIXTURE_USER_ID" fixture-password\n',
      { mode: 0o700 }
    )
    const env = {
      PATH: `${directory}:/usr/bin:/bin`,
      CAPTURE_ARGS: argsFile,
      CAPTURE_SQL: sqlFile,
      FIXTURE_USER_ID: '00000000-0000-4000-8000-000000000001',
    }
    for (const context of [
      'clerum-test',
      'clerum-codex-fixture',
      'clerum-fix-fixture-1234abcd',
      'gke_your-gcp-project_us-central1-a_example-dev',
    ]) {
      const result = spawnSync('bash', [harness, helper, context], {
        env,
        timeout: 5000,
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, '')
      const args = fs.readFileSync(argsFile, 'utf8').trim().split('\n')
      assert.deepEqual(args.slice(0, 8), [
        `--context=${context}`,
        '-n',
        'control-plane',
        'exec',
        '-i',
        'deploy/control-postgres',
        '--',
        'psql',
      ])
      assert.ok(args.includes('user_id=00000000-0000-4000-8000-000000000001'))
      assert.ok(args.includes('email=fixture@members.test'))
      const sql = fs.readFileSync(sqlFile, 'utf8')
      assert.ok(sql.includes('SET password_hash = a.password_hash'))
      assert.ok(sql.includes("WHERE u.id = :'user_id'"))
      assert.ok(sql.includes("AND u.email = :'email'"))
      assert.ok(sql.includes("AND a.username = :'admin_username'"))
      assert.equal(sql.includes('fixture-password'), false)
    }
    fs.unlinkSync(sqlFile)
    for (const context of ['gke_project_eu_clerum', 'production', 'clerum-dev', 'other']) {
      const result = spawnSync('bash', [harness, helper, context], { env, timeout: 5000 })
      assert.equal(result.status, 88)
      assert.equal(fs.existsSync(sqlFile), false)
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
