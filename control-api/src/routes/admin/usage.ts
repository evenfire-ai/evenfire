import { Request, Response, Router } from 'express'
import {
  type UsageFilters,
  type UsageGroupBy,
  type UsageInterval,
  checkIntervalCoversRange,
  isAllowedGroupBy,
  isUsageInterval,
  queryUsageSeries,
  queryUsageTotals,
} from '../../services/usageReader.js'

type ParsedQuery = {
  from: Date
  to: Date
  interval: UsageInterval
  groupBy: UsageGroupBy
  filters: UsageFilters
  limit?: number
}

type ParseError = { error: string; detail?: string }

function parseDate(raw: unknown, field: string): Date | ParseError {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { error: 'invalid_query', detail: `${field} is required` }
  }
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) {
    return { error: 'invalid_query', detail: `${field} is not a valid ISO date` }
  }
  return d
}

function parseFilters(raw: unknown): UsageFilters | ParseError {
  if (raw === undefined || raw === null) return {}
  let obj: unknown
  if (typeof raw === 'string') {
    if (raw.trim().length === 0) return {}
    try {
      obj = JSON.parse(raw)
    } catch {
      return { error: 'invalid_query', detail: 'filters is not valid JSON' }
    }
  } else if (typeof raw === 'object') {
    obj = raw
  } else {
    return { error: 'invalid_query', detail: 'filters must be a JSON object' }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { error: 'invalid_query', detail: 'filters must be a JSON object' }
  }
  const out: UsageFilters = {}
  for (const [key, value] of Object.entries(obj)) {
    if (!isAllowedGroupBy(key)) {
      return { error: 'invalid_query', detail: `unknown filter dimension: ${key}` }
    }
    if (!Array.isArray(value)) {
      return { error: 'invalid_query', detail: `filter ${key} must be an array of strings` }
    }
    const values: string[] = []
    for (const v of value) {
      if (typeof v !== 'string') {
        return { error: 'invalid_query', detail: `filter ${key} contains a non-string value` }
      }
      values.push(v)
    }
    if (values.length > 0) out[key] = values
  }
  return out
}

function parseQuery(req: Request, withLimit: boolean): ParsedQuery | ParseError {
  const fromRes = parseDate(req.query.from, 'from')
  if (fromRes instanceof Date === false) return fromRes as ParseError
  const toRes = parseDate(req.query.to, 'to')
  if (toRes instanceof Date === false) return toRes as ParseError
  const from = fromRes as Date
  const to = toRes as Date
  if (!(from.getTime() < to.getTime())) {
    return { error: 'invalid_query', detail: 'from must be earlier than to' }
  }

  const interval = req.query.interval
  if (!isUsageInterval(interval)) {
    return { error: 'invalid_query', detail: 'interval must be one of: 5min, hour, day' }
  }

  const groupBy = req.query.groupBy
  if (!isAllowedGroupBy(groupBy)) {
    return { error: 'invalid_query', detail: 'groupBy is required and must be a known dimension' }
  }

  const rangeErr = checkIntervalCoversRange(interval, from)
  if (rangeErr) {
    return {
      error: rangeErr.error,
      detail: `interval=${interval} only covers the last ${rangeErr.retentionDays} days`,
    }
  }

  const filtersRes = parseFilters(req.query.filters)
  if ('error' in filtersRes) return filtersRes

  let limit: number | undefined
  if (withLimit && req.query.limit !== undefined) {
    const raw = Number(req.query.limit)
    if (!Number.isFinite(raw) || raw < 1) {
      return { error: 'invalid_query', detail: 'limit must be a positive integer' }
    }
    limit = raw
  }

  return { from, to, interval, groupBy, filters: filtersRes, limit }
}

export function createAdminUsageRouter(): Router {
  const router = Router()

  router.get('/admin/usage/llm', async (req: Request, res: Response, next) => {
    try {
      const parsed = parseQuery(req, false)
      if ('error' in parsed) {
        res.status(400).json(parsed)
        return
      }
      const rows = await queryUsageSeries({
        from: parsed.from,
        to: parsed.to,
        interval: parsed.interval,
        groupBy: parsed.groupBy,
        filters: parsed.filters,
      })
      res.status(200).json({
        from: parsed.from.toISOString(),
        to: parsed.to.toISOString(),
        interval: parsed.interval,
        groupBy: parsed.groupBy,
        rows,
      })
    } catch (error) {
      next(error)
    }
  })

  router.get('/admin/usage/llm/totals', async (req: Request, res: Response, next) => {
    try {
      const parsed = parseQuery(req, true)
      if ('error' in parsed) {
        res.status(400).json(parsed)
        return
      }
      const rows = await queryUsageTotals({
        from: parsed.from,
        to: parsed.to,
        interval: parsed.interval,
        groupBy: parsed.groupBy,
        filters: parsed.filters,
        limit: parsed.limit,
      })
      res.status(200).json({
        from: parsed.from.toISOString(),
        to: parsed.to.toISOString(),
        interval: parsed.interval,
        groupBy: parsed.groupBy,
        rows,
      })
    } catch (error) {
      next(error)
    }
  })

  return router
}
