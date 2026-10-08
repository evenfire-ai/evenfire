import { describe, expect, it } from 'vitest'
import { register } from 'prom-client'
import {
  enterGfsDownloadTransfer,
  exitGfsDownloadTransfer,
  recordGfsDownloadAdmission,
  recordGfsDownloadExpiry,
  recordGfsDownloadQuota,
  recordGfsDownloadTransfer,
  recordGfsShellOutputLimit,
} from './gfsDownloadMetrics'

/** Sum of the samples of `name` whose labels include every `labels` pair. */
async function counterValue(name: string, labels: Record<string, string> = {}): Promise<number> {
  const metric = register.getSingleMetric(name)
  if (metric === undefined) throw new Error(`metric ${name} is not registered`)
  const { values } = await metric.get()
  return values
    .filter(sample => Object.entries(labels).every(([key, value]) => sample.labels[key] === value))
    .reduce((sum, sample) => sum + sample.value, 0)
}

async function expiryValue(outcome: string): Promise<number> {
  return counterValue('clerum_gfs_download_expiry_total', { outcome })
}

describe('GFS download metrics', () => {
  it('registers fixed-cardinality instruments on the global metrics endpoint', async () => {
    const scraped = await register.metrics()
    expect(scraped).toContain('clerum_gfs_download_admissions_total')
    expect(scraped).toContain('clerum_gfs_download_transfers_total')
    expect(scraped).toContain('clerum_gfs_download_duration_seconds')
    expect(scraped).toContain('clerum_gfs_download_active')
    expect(scraped).toContain('clerum_gfs_shell_output_limits_total')
    expect(scraped).toContain('clerum_gfs_download_quota_total')
    expect(scraped).toContain('clerum_gfs_download_expiry_total')
  })

  it('records admission, transfer, active count, and shell-limit outcomes', async () => {
    const series = [
      ['clerum_gfs_download_admissions_total', { outcome: 'workspace_attempt' }],
      ['clerum_gfs_download_transfers_total', { outcome: 'success' }],
      ['clerum_gfs_shell_output_limits_total', { outcome: 'output_limit_exceeded' }],
      ['clerum_gfs_download_quota_total', { scope: 'caller', reason: 'storage_bytes' }],
      ['clerum_gfs_download_expiry_total', { outcome: 'remove_failed' }],
    ] as const
    const before = await Promise.all(series.map(([name, labels]) => counterValue(name, labels)))
    const active = await counterValue('clerum_gfs_download_active')

    recordGfsDownloadAdmission('workspace_attempt')
    enterGfsDownloadTransfer()
    expect(await counterValue('clerum_gfs_download_active')).toBe(active + 1)
    recordGfsDownloadTransfer('success', 0.25)
    exitGfsDownloadTransfer()
    recordGfsShellOutputLimit('output_limit_exceeded')
    recordGfsDownloadQuota('caller', 'storage_bytes')
    recordGfsDownloadExpiry('remove_failed')

    // Each call moved its own series by exactly one.
    for (const [index, [name, labels]] of series.entries())
      expect(await counterValue(name, labels)).toBe(before[index]! + 1)
    expect(await counterValue('clerum_gfs_download_active')).toBe(active)

    const scraped = await register.metrics()
    expect(scraped).toContain('clerum_gfs_download_admissions_total{outcome="workspace_attempt"}')
    expect(scraped).toContain('clerum_gfs_download_transfers_total{outcome="success"}')
    expect(scraped).toContain('clerum_gfs_download_active 0')
    expect(scraped).toContain(
      'clerum_gfs_shell_output_limits_total{outcome="output_limit_exceeded"}'
    )
    expect(scraped).toContain(
      'clerum_gfs_download_quota_total{scope="caller",reason="storage_bytes"}'
    )
    expect(scraped).toContain('clerum_gfs_download_expiry_total{outcome="remove_failed"}')
  })

  it('U10: counts every expiry outcome and no longer registers the ledger-era instruments', async () => {
    const outcomes = [
      'expired_removed',
      'incomplete_removed',
      'remove_failed',
      'retired_legacy_store',
      'sweep_failed',
    ] as const
    const before = new Map<string, number>()
    for (const outcome of outcomes) before.set(outcome, await expiryValue(outcome))
    for (const outcome of outcomes) recordGfsDownloadExpiry(outcome)
    for (const outcome of outcomes)
      expect(await expiryValue(outcome)).toBe(before.get(outcome)! + 1)

    const scraped = await register.metrics()
    // Witness: the scrape carries the instruments this module still registers.
    expect(scraped).toContain('# TYPE clerum_gfs_download_expiry_total counter')
    expect(scraped).toContain('# TYPE clerum_gfs_download_quota_total counter')
    expect(scraped).not.toContain('clerum_gfs_legacy_processing_leases_discarded_total')
    expect(scraped).not.toContain('clerum_gfs_download_store_quarantined_records')
    expect(register.getSingleMetric('clerum_gfs_legacy_processing_leases_discarded_total')).toBe(
      undefined
    )
    expect(register.getSingleMetric('clerum_gfs_download_store_quarantined_records')).toBe(
      undefined
    )
  })
})
