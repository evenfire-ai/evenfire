#!/usr/bin/env node

/**
 * Build Control API, then run `report --base-url URL --session-file FILE`.
 * Copy the emitted mappingTemplate to a reviewed JSON file, fill each exact
 * target list, then run `apply` with the same options plus
 * `--mapping FILE --confirm-reviewed`. The session file must be mode 0600; its
 * value is used only for the request cookie and is never emitted.
 */

import { readFile, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  applyReviewedLegacyGrantMigration,
  buildLegacyGrantMigrationReport,
} from '../control-api/dist/gfs/legacyStandaloneGrantMigration.js'

const MAX_MAPPING_FILE_BYTES = 1024 * 1024

function option(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

async function readPrivateValue(path) {
  const metadata = await stat(path)
  if ((metadata.mode & 0o077) !== 0) throw new Error('session_file_permissions_too_open')
  const value = (await readFile(path, 'utf8')).trim()
  if (!value || value.length > 4096) throw new Error('session_file_invalid')
  return value
}

export async function readBoundedMapping(path) {
  const metadata = await stat(path)
  if (!metadata.isFile() || metadata.size > MAX_MAPPING_FILE_BYTES) {
    throw new Error('mapping_file_invalid_or_too_large')
  }
  const contents = await readFile(path)
  if (contents.byteLength > MAX_MAPPING_FILE_BYTES) {
    throw new Error('mapping_file_invalid_or_too_large')
  }
  return JSON.parse(contents.toString('utf8'))
}

export class LegacyGrantControlApiClient {
  constructor(baseUrl, sessionValue, fetchImpl = fetch) {
    const parsed = new URL(baseUrl)
    const loopbackHost = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    const safeTransport = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopbackHost)
    if (!safeTransport || parsed.username || parsed.password) {
      throw new Error('base_url_invalid')
    }
    this.baseUrl = parsed.toString().replace(/\/$/, '')
    this.sessionValue = sessionValue
    this.fetchImpl = fetchImpl
  }

  async request(path, options = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...options,
      redirect: 'error',
      headers: {
        Cookie: `control_ui_admin_session=${this.sessionValue}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })
    const body = await response.json().catch(() => ({}))
    return { response, body }
  }

  async getLegacyGrants() {
    const result = await this.request('/api/v1/gfs/grants/legacy-standalone')
    if (!result.response.ok) throw new Error(`legacy_grant_report_failed:${result.response.status}`)
    return result.body
  }

  async getTrustedHostDirectory() {
    const result = await this.request('/api/v1/admin/hosts-overview')
    if (!result.response.ok) throw new Error(`trusted_host_directory_failed:${result.response.status}`)
    return result.body
  }

  async putGrant(body) {
    try {
      const result = await this.request('/api/v1/gfs/grants', {
        method: 'PUT',
        body: JSON.stringify(body),
      })
      return {
        ok: result.response.ok,
        status: result.response.status,
        error:
          typeof result.body?.error === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(result.body.error)
            ? result.body.error
            : result.response.ok
              ? undefined
              : 'request_rejected',
      }
    } catch {
      return { ok: false, error: 'request_failed' }
    }
  }
}

export async function main(args = process.argv.slice(2)) {
  const mode = args[0]
  const baseUrl = option(args, '--base-url')
  const sessionFile = option(args, '--session-file')
  if (!['report', 'apply'].includes(mode) || !baseUrl || !sessionFile) {
    throw new Error('usage: report|apply --base-url URL --session-file MODE_0600_FILE')
  }
  const api = new LegacyGrantControlApiClient(baseUrl, await readPrivateValue(sessionFile))
  if (mode === 'report') return buildLegacyGrantMigrationReport(api)
  if (!args.includes('--confirm-reviewed')) throw new Error('apply_requires_confirm_reviewed')
  const mappingPath = option(args, '--mapping')
  if (!mappingPath) throw new Error('apply_requires_mapping')
  return applyReviewedLegacyGrantMigration(api, await readBoundedMapping(mappingPath))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
    .then(result => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      if (result.mode === 'apply' && !result.allApprovedIndividualGrantsSucceeded) process.exitCode = 1
    })
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : 'migration_failed'}\n`)
      process.exitCode = 1
    })
}
