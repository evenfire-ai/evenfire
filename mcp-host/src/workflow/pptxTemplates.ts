/**
 * The preset decks of clerum__generate_pptx, built from a template's `data`.
 *
 * Each template reads a fixed set of fields, declared in the tool schema and
 * checked here, so a field name the model guessed wrong is reported by name.
 */
import {
  PptxInputError,
  type PptxKpi,
  type PptxSlide,
  type ReadContext,
  STATUSES,
  TEXT_LIMITS,
  isRecord,
  readChart,
  readEnum,
  readKpis,
  readStringList,
  readTable,
  readText,
} from './pptxInput'

export const PPTX_TEMPLATES = [
  'executive-brief',
  'quarterly-review',
  'incident-review',
  'pitch-deck',
] as const

export type PptxTemplate = (typeof PPTX_TEMPLATES)[number]

/** The fields each template reads; a required one missing fails the call. */
export const PPTX_TEMPLATE_FIELDS: Record<
  PptxTemplate,
  { required: string[]; optional: string[] }
> = {
  'executive-brief': {
    required: ['title'],
    optional: ['subtitle', 'status', 'kpis', 'charts', 'takeaways', 'nextSteps'],
  },
  'quarterly-review': {
    required: ['title', 'period'],
    optional: [
      'status',
      'highlights',
      'kpis',
      'revenueChart',
      'breakdownChart',
      'metricsTable',
      'outlook',
    ],
  },
  'incident-review': {
    required: ['title', 'severity', 'summary'],
    optional: ['date', 'timelineTable', 'impact', 'rootCause', 'remediation', 'lessons'],
  },
  'pitch-deck': {
    required: ['company', 'tagline', 'problem', 'solution'],
    optional: ['marketSize', 'tractionChart', 'team', 'ask'],
  },
}

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const

function fieldList(template: PptxTemplate): string {
  const { required, optional } = PPTX_TEMPLATE_FIELDS[template]
  return [...required.map(f => `${f} (required)`), ...optional].join(', ')
}

function camelCase(key: string): string {
  return key.replace(/[_\-\s]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase())
}

/** The name `key` of `data` is read under, when it is another field's spelling. */
function renamedField(key: string, data: Record<string, unknown>, known: Set<string>) {
  if (known.has(key)) return undefined
  const camel = camelCase(key)
  return known.has(camel) && !(camel in data) ? camel : undefined
}

/** `data` keyed by the template's field names, with the keys it cannot place. */
function placeFields(
  template: PptxTemplate,
  data: Record<string, unknown>,
  ctx: ReadContext
): { fields: Record<string, unknown>; unknown: string[] } {
  const { required, optional } = PPTX_TEMPLATE_FIELDS[template]
  const known = new Set([...required, ...optional])
  const fields: Record<string, unknown> = {}
  const unknown: string[] = []
  for (const [key, value] of Object.entries(data)) {
    if (known.has(key)) {
      fields[key] = value
      continue
    }
    const camel = renamedField(key, data, known)
    if (camel !== undefined) {
      fields[camel] = value
      ctx.warnings.push(`data.${key} was read as data.${camel}.`)
      continue
    }
    unknown.push(key)
  }
  return { fields, unknown }
}

function requiredText(
  fields: Record<string, unknown>,
  name: string,
  template: PptxTemplate,
  max: number,
  ctx: ReadContext
): string {
  const text = readText(fields[name], `data.${name}`, max, ctx)
  if (!text) {
    throw new PptxInputError(
      `template "${template}" needs data.${name}. Its fields are: ${fieldList(template)}.`
    )
  }
  return text
}

function kpiSlides(kpis: PptxKpi[], title: string): PptxSlide[] {
  return kpis.length > 0
    ? [{ layout: 'kpis', where: 'data', paths: { kpis: 'data.kpis' }, title, kpis }]
    : []
}

function listSlide(
  fields: Record<string, unknown>,
  name: string,
  title: string,
  ctx: ReadContext
): PptxSlide[] {
  const bullets = readStringList(fields[name], `data.${name}`, TEXT_LIMITS.bullet, ctx)
  return bullets?.length
    ? [
        {
          layout: 'title-bullets',
          where: 'data',
          paths: { bullets: `data.${name}` },
          title,
          bullets,
        },
      ]
    : []
}

function chartSlide(
  fields: Record<string, unknown>,
  name: string,
  fallbackTitle: string,
  ctx: ReadContext
): PptxSlide[] {
  if (fields[name] === undefined || fields[name] === null) return []
  const chart = readChart(fields[name], `data.${name}`, ctx)
  return [
    {
      layout: 'title-chart',
      where: 'data',
      paths: { chart: `data.${name}`, title: `data.${name}.title` },
      title: chart.title ?? fallbackTitle,
      chart,
    },
  ]
}

function executiveBrief(f: Record<string, unknown>, ctx: ReadContext): PptxSlide[] {
  const t: PptxTemplate = 'executive-brief'
  const slides: PptxSlide[] = [
    {
      layout: 'cover',
      where: 'data',
      title: requiredText(f, 'title', t, TEXT_LIMITS.title, ctx),
      subtitle: readText(f.subtitle, 'data.subtitle', TEXT_LIMITS.subtitle, ctx),
      status: readEnum(f.status, 'data.status', STATUSES),
    },
  ]
  if (f.kpis !== undefined)
    slides.push(...kpiSlides(readKpis(f.kpis, 'data.kpis', ctx), 'Key Metrics'))
  if (f.charts !== undefined && f.charts !== null) {
    if (!Array.isArray(f.charts)) {
      throw new PptxInputError('data.charts must be a list of charts.')
    }
    f.charts.forEach((raw, i) => {
      const chart = readChart(raw, `data.charts[${i}]`, ctx)
      slides.push({
        layout: 'title-chart',
        where: 'data',
        paths: { chart: `data.charts[${i}]`, title: `data.charts[${i}].title` },
        title: chart.title ?? 'Chart',
        chart,
      })
    })
  }
  slides.push(...listSlide(f, 'takeaways', 'Key Takeaways', ctx))
  slides.push(...listSlide(f, 'nextSteps', 'Next Steps', ctx))
  return slides
}

function quarterlyReview(f: Record<string, unknown>, ctx: ReadContext): PptxSlide[] {
  const t: PptxTemplate = 'quarterly-review'
  const title = requiredText(f, 'title', t, TEXT_LIMITS.title, ctx)
  const period = requiredText(f, 'period', t, TEXT_LIMITS.eyebrow, ctx)
  const slides: PptxSlide[] = [
    {
      layout: 'cover',
      where: 'data',
      paths: { subtitle: 'data.period' },
      title,
      subtitle: period,
      status: readEnum(f.status, 'data.status', STATUSES),
    },
  ]
  slides.push(...listSlide(f, 'highlights', `${period} Highlights`, ctx))
  if (f.kpis !== undefined)
    slides.push(...kpiSlides(readKpis(f.kpis, 'data.kpis', ctx), 'Quarterly KPIs'))
  slides.push(...chartSlide(f, 'revenueChart', 'Revenue Trend', ctx))
  slides.push(...chartSlide(f, 'breakdownChart', 'Revenue Breakdown', ctx))
  if (f.metricsTable !== undefined && f.metricsTable !== null) {
    slides.push({
      layout: 'title-table',
      where: 'data',
      paths: { table: 'data.metricsTable' },
      title: 'Metrics Snapshot',
      table: readTable(f.metricsTable, 'data.metricsTable', ctx),
    })
  }
  const outlook = listSlide(f, 'outlook', 'Next Quarter Priorities', ctx)
  if (outlook.length > 0) {
    slides.push({
      layout: 'section',
      where: 'data',
      eyebrow: 'Looking ahead',
      title: 'Outlook',
    })
    slides.push(...outlook)
  }
  return slides
}

function incidentReview(f: Record<string, unknown>, ctx: ReadContext): PptxSlide[] {
  const t: PptxTemplate = 'incident-review'
  const title = requiredText(f, 'title', t, TEXT_LIMITS.title, ctx)
  const severity = readEnum(f.severity, 'data.severity', SEVERITIES)
  if (!severity) {
    throw new PptxInputError(
      `template "${t}" needs data.severity, one of ${SEVERITIES.join(', ')}. ` +
        `Its fields are: ${fieldList(t)}.`
    )
  }
  const summary = requiredText(f, 'summary', t, TEXT_LIMITS.bullet, ctx)
  const date = readText(f.date, 'data.date', TEXT_LIMITS.eyebrow, ctx)
  const slides: PptxSlide[] = [
    {
      layout: 'cover',
      where: 'data',
      paths: { subtitle: 'data.date' },
      title,
      subtitle: [severity.toUpperCase(), date].filter(Boolean).join(' · '),
      status:
        severity === 'critical' || severity === 'high'
          ? 'red'
          : severity === 'medium'
            ? 'yellow'
            : 'green',
    },
    {
      layout: 'title-bullets',
      where: 'data',
      paths: { bullets: 'data.summary' },
      title: 'Summary',
      bullets: [summary],
    },
  ]
  if (f.timelineTable !== undefined && f.timelineTable !== null) {
    slides.push({
      layout: 'title-table',
      where: 'data',
      paths: { table: 'data.timelineTable' },
      title: 'Timeline',
      table: readTable(f.timelineTable, 'data.timelineTable', ctx),
    })
  }
  slides.push(...listSlide(f, 'impact', 'Impact', ctx))
  const rootCause = readText(f.rootCause, 'data.rootCause', TEXT_LIMITS.bullet, ctx)
  if (rootCause) {
    slides.push({
      layout: 'title-bullets',
      where: 'data',
      paths: { bullets: 'data.rootCause' },
      title: 'Root Cause',
      bullets: [rootCause],
    })
  }
  slides.push(...listSlide(f, 'remediation', 'Remediation', ctx))
  slides.push(...listSlide(f, 'lessons', 'Lessons Learned', ctx))
  return slides
}

/** A money amount: text as written, or a number grouped in thousands ("12,000,000,000"). */
function readAmount(value: unknown, where: string, ctx: ReadContext): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toLocaleString('en-US', { maximumFractionDigits: 2 })
  }
  return readText(value, where, TEXT_LIMITS.value, ctx)
}

function pitchDeck(f: Record<string, unknown>, ctx: ReadContext): PptxSlide[] {
  const t: PptxTemplate = 'pitch-deck'
  const slides: PptxSlide[] = [
    {
      layout: 'cover',
      where: 'data',
      paths: { title: 'data.company', subtitle: 'data.tagline' },
      title: requiredText(f, 'company', t, TEXT_LIMITS.title, ctx),
      subtitle: requiredText(f, 'tagline', t, TEXT_LIMITS.subtitle, ctx),
    },
    {
      layout: 'section',
      where: 'data',
      paths: { subtitle: 'data.problem' },
      eyebrow: 'The pain',
      title: 'Problem',
      subtitle: requiredText(f, 'problem', t, TEXT_LIMITS.subtitle, ctx),
    },
    {
      layout: 'section',
      where: 'data',
      paths: { subtitle: 'data.solution' },
      eyebrow: 'Our approach',
      title: 'Solution',
      subtitle: requiredText(f, 'solution', t, TEXT_LIMITS.subtitle, ctx),
    },
  ]
  if (f.marketSize !== undefined && f.marketSize !== null) {
    const m = f.marketSize
    const value = isRecord(m) ? readAmount(m.value, 'data.marketSize.value', ctx) : undefined
    if (!isRecord(m) || !value) {
      throw new PptxInputError(
        'data.marketSize must be an object with value (e.g. "$12B" or 12000000000) and an ' +
          'optional description.'
      )
    }
    slides.push({
      layout: 'kpis',
      where: 'data',
      title: 'Market Size',
      kpis: [
        {
          where: 'data.marketSize',
          notePath: 'data.marketSize.description',
          label: 'TAM',
          value,
          note: readText(m.description, 'data.marketSize.description', TEXT_LIMITS.note, ctx),
        },
      ],
    })
  }
  slides.push(...chartSlide(f, 'tractionChart', 'Traction', ctx))
  if (f.team !== undefined && f.team !== null) {
    if (!Array.isArray(f.team))
      throw new PptxInputError('data.team must be a list of {name, role}.')
    const people = f.team.map((p, i) => {
      const at = `data.team[${i}]`
      if (!isRecord(p)) throw new PptxInputError(`${at} must be an object with name and role.`)
      // Workflows written against the KPI-card shape send {label: name, value: role}.
      const name = readText(p.name ?? p.label, `${at}.name`, TEXT_LIMITS.value, ctx)
      if (!name) throw new PptxInputError(`${at}.name is missing.`)
      return {
        where: at,
        notePath: `${at}.role`,
        value: name,
        note: readText(p.role ?? p.value, `${at}.role`, TEXT_LIMITS.label, ctx),
      }
    })
    if (people.length > 0) {
      slides.push({
        layout: 'kpis',
        where: 'data',
        title: 'Team',
        kpis: people,
        kpiStyle: 'people',
      })
    }
  }
  if (f.ask !== undefined && f.ask !== null) {
    const a = f.ask
    const amount = isRecord(a) ? readAmount(a.amount, 'data.ask.amount', ctx) : undefined
    if (!isRecord(a) || !amount) {
      throw new PptxInputError(
        'data.ask must be an object with amount (e.g. "$5M" or 5000000) and useOfFunds.'
      )
    }
    const uses = readStringList(a.useOfFunds, 'data.ask.useOfFunds', TEXT_LIMITS.bullet, ctx)
    slides.push(
      uses?.length
        ? {
            layout: 'title-bullets',
            where: 'data',
            paths: { bullets: 'data.ask.useOfFunds', title: 'data.ask.amount' },
            title: `The Ask · ${amount}`,
            bullets: uses,
          }
        : {
            layout: 'section',
            where: 'data',
            paths: { title: 'data.ask.amount' },
            eyebrow: 'The Ask',
            title: amount,
          }
    )
  }
  return slides
}

const BUILDERS: Record<
  PptxTemplate,
  (f: Record<string, unknown>, ctx: ReadContext) => PptxSlide[]
> = {
  'executive-brief': executiveBrief,
  'quarterly-review': quarterlyReview,
  'incident-review': incidentReview,
  'pitch-deck': pitchDeck,
}

/** The slides a template builds from `data`. Throws PptxInputError naming the field to fix. */
export function buildTemplateSlides(
  template: PptxTemplate,
  data: unknown,
  ctx: ReadContext
): PptxSlide[] {
  if (!isRecord(data)) {
    throw new PptxInputError(
      `template "${template}" requires data, an object with these fields: ` +
        `${fieldList(template)}.`
    )
  }
  const { fields, unknown } = placeFields(template, data, ctx)
  const slides = BUILDERS[template](fields, ctx)
  if (unknown.length > 0) {
    const names = unknown.map(k => `data.${k}`).join(', ')
    const message =
      `${names} ${unknown.length > 1 ? 'are not fields' : 'is not a field'} of the ` +
      `"${template}" template. Its fields are: ${fieldList(template)}.`
    if (slides.length <= 1) {
      throw new PptxInputError(`${message} As sent, the deck would hold only its cover.`)
    }
    ctx.warnings.push(`${message} ${unknown.length > 1 ? 'They were' : 'It was'} left out.`)
  }
  return slides
}
