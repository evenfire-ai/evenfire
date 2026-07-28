import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  LegacyGrantControlApiClient,
  readBoundedMapping,
} from '../gfs-legacy-standalone-grants.mjs'

describe('legacy standalone grant client transport boundary', () => {
  it('rejects plaintext HTTP for a non-loopback host', () => {
    assert.throws(
      () => new LegacyGrantControlApiClient('http://control-api.example.test', 'unit-test-session'),
      /base_url_invalid/
    )
  })

  it('allows exact loopback HTTP hosts and HTTPS', () => {
    for (const url of [
      'http://localhost:8090',
      'http://127.0.0.1:8090',
      'http://[::1]:8090',
      'https://control-api.example.test',
    ]) {
      assert.doesNotThrow(() => new LegacyGrantControlApiClient(url, 'unit-test-session'))
    }
  })

  it('forces redirect errors so a caller cannot forward the session to a redirect target', async () => {
    const calls = []
    const fetchImpl = async (url, options) => {
      calls.push({ url, options })
      if (options.redirect === 'error') throw new TypeError('redirect blocked')
      throw new Error('unsafe redirect policy')
    }
    const client = new LegacyGrantControlApiClient(
      'https://control-api.example.test',
      'unit-test-session',
      fetchImpl
    )

    await assert.rejects(
      client.request('/api/v1/gfs/grants/legacy-standalone', { redirect: 'follow' }),
      /redirect blocked/
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0].options.redirect, 'error')
    assert.match(calls[0].options.headers.Cookie, /^control_ui_admin_session=/)
  })
})

describe('reviewed mapping file bound', () => {
  it('accepts a small JSON mapping and rejects an oversized file before parsing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gfs-grant-mapping-test-'))
    const small = join(directory, 'small.json')
    const large = join(directory, 'large.json')
    try {
      await writeFile(small, '{"version":1}')
      await chmod(small, 0o600)
      await writeFile(large, Buffer.alloc(1024 * 1024 + 1, 0x20))
      await chmod(large, 0o600)

      await assert.doesNotReject(readBoundedMapping(small))
      await assert.rejects(readBoundedMapping(large), /mapping_file_invalid_or_too_large/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
