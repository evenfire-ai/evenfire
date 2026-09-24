import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const lib = resolve(dirname(fileURLToPath(import.meta.url)), '../e2e/_lib')

for (const vendor of ['LibreSSL 3.3.6', 'unrecognized implementation']) {
  test(`rejects ${vendor} before attempting generation or creating an artifact`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'hcc-openssl-preflight-'))
    try {
      writeFileSync(join(directory, 'openssl'),
        `#!/bin/sh\nif [ "$1" = version ]; then printf '%s\\n' '${vendor}'; exit 0; fi\nprintf unexpected > "$0.called"\nexit 99\n`,
        { mode: 0o700 })
      const result = spawnSync(process.execPath, [join(lib, 'hcc-watch-tls-manifest.mjs'),
        'vendor-fixture', 'test-fixture', 'run-fixture', join(lib, 'hcc-watch-api-proxy.mjs')], {
        cwd: directory, env: { PATH: directory }, encoding: 'utf8', timeout: 10000,
      })
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /fixture_openssl_required/)
      assert.deepEqual(readdirSync(directory), ['openssl'], 'no generation attempt or key artifact')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
}
