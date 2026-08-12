import { describe, expect, it, vi } from 'vitest'
import { secretKeyNames } from '../src/services/secretKeyNames.js'

function gatewayReturning(secret: unknown) {
  return { getSecret: vi.fn(async () => secret) } as never
}

describe('secretKeyNames', () => {
  it('returns the key names, sorted, and never a value', async () => {
    const gateway = gatewayReturning({
      data: { 'slack-signing-secret': 'aHVudGVyMg==', 'slack-bot-token': 'eG94Yi0x' },
    })
    const keys = await secretKeyNames(gateway, 'cc-x-credentials', 'channels')
    expect(keys).toEqual(['slack-bot-token', 'slack-signing-secret'])
    expect(JSON.stringify(keys)).not.toContain('aHVudGVyMg==')
    expect(JSON.stringify(keys)).not.toContain('hunter2')
  })

  it('returns an empty array when the Secret exists but has no data', async () => {
    expect(await secretKeyNames(gatewayReturning({}), 'cc-x-credentials', 'channels')).toEqual([])
  })

  it('returns an empty array when the Secret does not exist', async () => {
    const gateway = {
      getSecret: vi.fn(async () => {
        throw Object.assign(new Error('not found'), { statusCode: 404 })
      }),
    } as never
    expect(await secretKeyNames(gateway, 'missing', 'channels')).toEqual([])
  })

  it('rethrows a non-404 read failure so callers can fail closed', async () => {
    const gateway = {
      getSecret: vi.fn(async () => {
        throw Object.assign(new Error('forbidden'), { statusCode: 403 })
      }),
    } as never
    await expect(secretKeyNames(gateway, 'cc-x-credentials', 'channels')).rejects.toThrow()
  })
})
