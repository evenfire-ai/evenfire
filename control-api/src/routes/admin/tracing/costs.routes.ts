import type { Request } from 'express'
import { Router } from 'express'
import { asyncHandler } from '../../../http/asyncHandler.js'
import type {
  InfrastructureCostBasis,
  InfrastructureCostDimensions,
  InfrastructureCostPeriod,
  InfrastructureCostReadQuery,
  InfrastructureCostReadService,
} from '../../../services/tracing/costRead/infrastructureCostReadService.js'

type CostReadError = { error: 'invalid_query'; detail: string }
export type InfrastructureCostReader = Pick<InfrastructureCostReadService, 'listScopes' | 'read'>

const DIMENSION_KEYS = [
  'cloudProvider',
  'cloudProjectId',
  'clusterLocation',
  'clusterName',
  'environment',
  'namespace',
  'workloadKind',
  'workloadRef',
  'currency',
] as const
const ALLOWED_KEYS = new Set(['period', 'anchorDate', 'valuation', 'basis', ...DIMENSION_KEYS])
const PERIODS = new Set(['day', 'week', 'month'])
const VALUATIONS = new Set(['estimated', 'billed', 'variance'])
const BASES = new Set(['requested_capacity', 'gcp_request_allocation'])
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const CURRENCY_PATTERN = /^[A-Z]{3}$/
const DIMENSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/

function invalid(detail: string): CostReadError {
  return { error: 'invalid_query', detail }
}

function singleQueryValue(req: Request, key: string): string | undefined | CostReadError {
  const value = req.query[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') return invalid(`${key} must be a single string`)
  return value
}

function addUtcDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime())
  copy.setUTCDate(copy.getUTCDate() + days)
  return copy
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function parseAnchorDate(raw: string | undefined): Date | CostReadError {
  if (raw === undefined) return invalid('anchorDate is required')
  if (!DATE_PATTERN.test(raw)) return invalid('anchorDate must be a UTC date in YYYY-MM-DD format')
  const date = new Date(`${raw}T00:00:00.000Z`)
  if (utcDay(date) !== raw) return invalid('anchorDate must be a valid UTC calendar date')
  return date
}

function periodBounds(
  period: InfrastructureCostPeriod,
  anchorDate: Date
): Pick<InfrastructureCostReadQuery, 'periodStartUtc' | 'periodEndUtc'> {
  if (period === 'day') {
    return { periodStartUtc: utcDay(anchorDate), periodEndUtc: utcDay(addUtcDays(anchorDate, 1)) }
  }
  if (period === 'week') {
    const day = anchorDate.getUTCDay()
    const isoOffset = day === 0 ? -6 : 1 - day
    const start = addUtcDays(anchorDate, isoOffset)
    return { periodStartUtc: utcDay(start), periodEndUtc: utcDay(addUtcDays(start, 7)) }
  }
  const start = new Date(Date.UTC(anchorDate.getUTCFullYear(), anchorDate.getUTCMonth(), 1))
  const end = new Date(Date.UTC(anchorDate.getUTCFullYear(), anchorDate.getUTCMonth() + 1, 1))
  return { periodStartUtc: utcDay(start), periodEndUtc: utcDay(end) }
}

function parseDimension(
  req: Request,
  key: (typeof DIMENSION_KEYS)[number]
): string | CostReadError {
  const value = singleQueryValue(req, key)
  if (typeof value !== 'string') return value ?? invalid(`${key} is required`)
  if (key === 'currency') {
    return CURRENCY_PATTERN.test(value)
      ? value
      : invalid('currency must be a three-letter ISO code')
  }
  if (!DIMENSION_PATTERN.test(value)) {
    return invalid(`${key} must be 1-512 bounded reference characters`)
  }
  return value
}

function parseInfrastructureCostQuery(req: Request): InfrastructureCostReadQuery | CostReadError {
  const unexpectedKey = Object.keys(req.query).find(key => !ALLOWED_KEYS.has(key))
  if (unexpectedKey) return invalid(`unsupported query parameter: ${unexpectedKey}`)

  const rawPeriod = singleQueryValue(req, 'period')
  if (typeof rawPeriod !== 'string') return rawPeriod ?? invalid('period is required')
  if (!PERIODS.has(rawPeriod)) return invalid('period must be one of: day, week, month')
  const period = rawPeriod as InfrastructureCostPeriod

  const rawValuation = singleQueryValue(req, 'valuation')
  if (typeof rawValuation !== 'string') return rawValuation ?? invalid('valuation is required')
  if (!VALUATIONS.has(rawValuation)) {
    return invalid('valuation must be one of: estimated, billed, variance')
  }
  const rawBasis = singleQueryValue(req, 'basis')
  if (typeof rawBasis !== 'string') return rawBasis ?? invalid('basis is required')
  if (!BASES.has(rawBasis)) {
    return invalid('basis must be one of: requested_capacity, gcp_request_allocation')
  }
  const basis = rawBasis as InfrastructureCostBasis
  if (rawValuation === 'estimated' && basis !== 'requested_capacity') {
    return invalid('estimated valuation requires requested_capacity basis')
  }
  if (rawValuation === 'billed' && basis !== 'gcp_request_allocation') {
    return invalid('billed valuation requires gcp_request_allocation basis')
  }
  if (rawValuation === 'variance' && basis !== 'requested_capacity') {
    return invalid('variance valuation requires requested_capacity estimate basis')
  }

  const rawAnchorDate = singleQueryValue(req, 'anchorDate')
  if (typeof rawAnchorDate !== 'string') return rawAnchorDate ?? invalid('anchorDate is required')
  const anchorDate = parseAnchorDate(rawAnchorDate)
  if ('error' in anchorDate) return anchorDate

  const parsedDimensions: Partial<Record<(typeof DIMENSION_KEYS)[number], string>> = {}
  for (const key of DIMENSION_KEYS) {
    const value = parseDimension(req, key)
    if (typeof value !== 'string') return value
    parsedDimensions[key] = value
  }
  const dimensions = parsedDimensions as InfrastructureCostDimensions
  if (dimensions.cloudProvider !== 'gcp') return invalid('cloudProvider must be gcp')

  return {
    period,
    valuation: rawValuation as InfrastructureCostReadQuery['valuation'],
    basis,
    ...periodBounds(period, anchorDate),
    dimensions,
  }
}

export function createAdminTracingCostsRouter(reader: InfrastructureCostReader): Router {
  const router = Router()

  router.get(
    '/admin/tracing/costs/infrastructure/scopes',
    asyncHandler(async (req, res) => {
      const unexpectedKey = Object.keys(req.query)[0]
      if (unexpectedKey) {
        res.status(400).json(invalid(`unsupported query parameter: ${unexpectedKey}`))
        return
      }
      res.status(200).json(await reader.listScopes())
    })
  )

  router.get(
    '/admin/tracing/costs/infrastructure',
    asyncHandler(async (req, res) => {
      const parsed = parseInfrastructureCostQuery(req)
      if ('error' in parsed) {
        res.status(400).json(parsed)
        return
      }
      res.status(200).json(await reader.read(parsed))
    })
  )

  return router
}
