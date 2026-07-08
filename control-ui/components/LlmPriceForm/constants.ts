import type { PriceFieldKey } from './types'

// The four per-1M-token price inputs. Order matches the table columns.
export const PRICE_FIELDS: Array<{ key: PriceFieldKey; label: string; description: string }> = [
  {
    key: 'input_token_price',
    label: 'Input price',
    description: 'Cost per 1,000,000 input tokens.',
  },
  {
    key: 'output_token_price',
    label: 'Output price',
    description: 'Cost per 1,000,000 output tokens.',
  },
  {
    key: 'cache_read_token_price',
    label: 'Cache read price',
    description: 'Cost per 1,000,000 cache-read tokens (≈0.1× input on Anthropic).',
  },
  {
    key: 'cache_write_token_price',
    label: 'Cache write price',
    description: 'Cost per 1,000,000 cache-write tokens (≈1.25× input on Anthropic).',
  },
]

export const DEFAULT_CURRENCY = 'USD'
