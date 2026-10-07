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
    recordGfsDownloadAdmission('workspace_attempt')
    enterGfsDownloadTransfer()
    recordGfsDownloadTransfer('success', 0.25)
    exitGfsDownloadTransfer()
    recordGfsShellOutputLimit('output_limit_exceeded')
    recordGfsDownloadQuota('caller', 'storage_bytes')
    recordGfsDownloadExpiry('cleanup_failed')

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
    expect(scraped).toContain('clerum_gfs_download_expiry_total{outcome="cleanup_failed"}')
  })
})
