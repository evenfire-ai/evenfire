import { describe, expect, it } from 'vitest'
import { formatToolApprovalLabel } from '../toolLabels'

describe('formatToolApprovalLabel', () => {
  it('uses the display name when toolName is empty', () => {
    expect(formatToolApprovalLabel({ displayName: 'CoinGecko', toolName: '' })).toBe('CoinGecko')
  })

  it('falls back when displayName and toolName are empty', () => {
    expect(formatToolApprovalLabel({ displayName: '', toolName: '', fallback: 'Connector' })).toBe(
      'Connector'
    )
  })

  it('returns the raw tool name for double-underscore-only names without a display name', () => {
    expect(formatToolApprovalLabel({ toolName: '__search' })).toBe('__search')
  })

  it('combines display name and function when display name matches provider', () => {
    expect(
      formatToolApprovalLabel({
        displayName: 'CoinGecko',
        toolName: 'coingecko__get_price',
      })
    ).toBe('CoinGecko get_price')
  })

  it('uses provider name when display name is absent', () => {
    expect(formatToolApprovalLabel({ toolName: 'mcp-coingecko__get_price' })).toBe(
      'mcp coingecko get_price'
    )
  })

  it('keeps a distinct display name instead of exposing provider/function details', () => {
    expect(
      formatToolApprovalLabel({
        displayName: 'Market data',
        toolName: 'coingecko__get_price',
      })
    ).toBe('Market data')
  })
})
