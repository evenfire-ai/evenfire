import { afterEach, describe, expect, it, vi } from 'vitest'

const ARCHIVE_KEYS = ['APPROVAL_RETENTION_DAYS', 'APPROVAL_ARCHIVE_BATCH_SIZE'] as const

async function loadConfigWith(overrides: Partial<Record<(typeof ARCHIVE_KEYS)[number], string>>) {
  const originalValues = new Map<string, string | undefined>()
  for (const key of ARCHIVE_KEYS) {
    originalValues.set(key, process.env[key])
    delete process.env[key]
  }
  Object.assign(process.env, overrides)
  vi.resetModules()
  try {
    const mod = await import('../src/config.js')
    return mod.config
  } finally {
    for (const key of ARCHIVE_KEYS) {
      const value = originalValues.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('control-api approval archive config', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('loads approved archive defaults', async () => {
    const config = await loadConfigWith({})

    expect(config.approvalRetentionDays).toBe(180)
    expect(config.userApprovalRequestArchiveBatchSize).toBe(500)
  })

  it('accepts positive integer overrides', async () => {
    const config = await loadConfigWith({
      APPROVAL_RETENTION_DAYS: '90',
      APPROVAL_ARCHIVE_BATCH_SIZE: '250',
    })

    expect(config.approvalRetentionDays).toBe(90)
    expect(config.userApprovalRequestArchiveBatchSize).toBe(250)
  })

  it.each([
    ['APPROVAL_RETENTION_DAYS', '0'],
    ['APPROVAL_RETENTION_DAYS', '-1'],
    ['APPROVAL_RETENTION_DAYS', '1.5'],
    ['APPROVAL_RETENTION_DAYS', 'abc'],
    ['APPROVAL_ARCHIVE_BATCH_SIZE', '0'],
    ['APPROVAL_ARCHIVE_BATCH_SIZE', '-1'],
    ['APPROVAL_ARCHIVE_BATCH_SIZE', '1.5'],
    ['APPROVAL_ARCHIVE_BATCH_SIZE', 'abc'],
  ] as const)('rejects invalid %s=%s', async (key, value) => {
    await expect(loadConfigWith({ [key]: value })).rejects.toThrow(new RegExp(key))
  })
})
