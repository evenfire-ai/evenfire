/** The four fixed templates, the custom template's blocks, and the data fields a template does not read. */
import {
  type DashRender,
  dashList,
  dashPart,
  dashRecord,
  dashText,
  describeDashValue,
  isDashRecord,
  renderChartCards,
  renderHero,
  renderIncidentsTimeline,
  renderKpis,
  renderSectionHtml,
  renderServiceHealthGrid,
  renderTableHtml,
} from './dashboardComponents'
import { oneOf } from './dashboardHtml'
import { BLOCK_TYPES, type DashboardTemplateName } from './dashboardVocabulary'
import { own } from './ownEntry'

// ─── Templates ──────────────────────────────────────────────────────

export type DashData = Record<string, unknown>

// The fields are named rather than spread: a spread reads every key, which
// would hide the ones nothing draws from the "Ignored arguments" note.
function heroOf(data: DashData, eyebrowFallback?: unknown): string {
  return renderHero({
    title: data.title,
    headline: data.headline,
    status: data.status,
    statusLabel: data.statusLabel,
    eyebrow: data.eyebrow ?? eyebrowFallback,
  })
}

function tablesOf(data: DashData, ctx: DashRender): string {
  return dashPart(ctx, 'data.tables', false, () =>
    dashList(data.tables, 'data.tables', 'table objects {headers, rows}')
      .map((t, i) => {
        const where = `data.tables[${i}]`
        return dashPart(ctx, where, true, () => renderTableHtml(t, where, ctx))
      })
      .join('\n')
  )
}

function sectionsOf(data: DashData, ctx: DashRender): string {
  return dashPart(ctx, 'data.sections', false, () =>
    dashList(data.sections, 'data.sections', 'section objects {type, content}')
      .map((s, i) => {
        const where = `data.sections[${i}]`
        return dashPart(ctx, where, true, () => renderSectionHtml(s, where))
      })
      .join('\n')
  )
}

function kpisOf(data: DashData, ctx: DashRender): string {
  return dashPart(ctx, 'data.kpis', false, () => renderKpis(data.kpis, 'data.kpis', ctx))
}

function chartsOf(data: DashData, ctx: DashRender, title: string | undefined): string {
  return dashPart(ctx, 'data.charts', false, () =>
    renderChartCards(data.charts, 'data.charts', ctx, title)
  )
}

export const DASHBOARD_TEMPLATES: Record<
  DashboardTemplateName,
  (data: DashData, ctx: DashRender) => string[]
> = {
  'executive-brief': (data, ctx) => [
    heroOf(data),
    kpisOf(data, ctx),
    chartsOf(data, ctx, 'Visual Trends'),
    tablesOf(data, ctx),
    sectionsOf(data, ctx),
  ],
  'operations-pulse': (data, ctx) => [
    heroOf(data),
    dashPart(ctx, 'data.services', false, () =>
      renderServiceHealthGrid(data.services, 'data.services', ctx, 'Service Health')
    ),
    kpisOf(data, ctx),
    dashPart(ctx, 'data.incidents', false, () =>
      renderIncidentsTimeline(data.incidents, 'data.incidents', ctx, 'Incident Timeline')
    ),
    chartsOf(data, ctx, 'Performance Trends'),
    tablesOf(data, ctx),
    sectionsOf(data, ctx),
  ],
  'financial-review': (data, ctx) => {
    const hasHero = data.heroChart !== undefined && data.heroChart !== null
    return [
      heroOf(data, data.period),
      kpisOf(data, ctx),
      hasHero
        ? dashPart(
            ctx,
            'data.heroChart',
            false,
            () =>
              `<section class="chart-stack">${ctx.charts.card(data.heroChart, 'data.heroChart', { tall: true })}</section>`
          )
        : '',
      chartsOf(data, ctx, hasHero ? 'Breakdowns' : 'Visual Trends'),
      tablesOf(data, ctx),
      sectionsOf(data, ctx),
    ]
  },
  'technical-report': (data, ctx) => [
    heroOf(data),
    kpisOf(data, ctx),
    sectionsOf(data, ctx),
    tablesOf(data, ctx),
    chartsOf(data, ctx, 'Charts'),
  ],
  custom: (data, ctx) => {
    const blocks = dashList(data.blocks, 'data.blocks', 'block objects')
    if (blocks.length === 0) {
      throw new Error(
        "template 'custom' needs data.blocks: a non-empty array of blocks such as " +
          '{"type": "kpis", "items": [{"label": "Revenue", "value": "$1.2M"}]}.'
      )
    }
    return blocks.map((b, idx) => renderBlock(b, `data.blocks[${idx}]`, ctx))
  },
}

// ─── Custom template (composable blocks) ────────────────────────────

/** Blocks that are content of their own; charts and card groups count their entries. */
const COUNTED_BLOCKS = new Set(['table', 'narrative', 'bullets', 'code', 'callout'])

function isEmptyList(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0)
}

/** The list field of each list block, and the other name models give it. */
const BLOCK_LISTS: Record<string, { field: 'items' | 'services'; alias: string; noun: string }> = {
  kpis: { field: 'items', alias: 'kpis', noun: 'cards' },
  'charts-grid': { field: 'items', alias: 'charts', noun: 'charts' },
  incidents: { field: 'items', alias: 'incidents', noun: 'incidents' },
  'service-health': { field: 'services', alias: 'items', noun: 'services' },
}

/** Whether `block` gives its list under the other name only. */
function listUnderAlias(block: Record<string, unknown>): boolean {
  const list = own(BLOCK_LISTS, String(block.type))
  return !!list && isEmptyList(block[list.field]) && !isEmptyList(block[list.alias])
}

/**
 * The entries of a list block, from its field or from the other name models
 * give it. A block with no entries throws, so it is reported rather than left
 * off the page.
 */
function blockList(
  block: Record<string, unknown>,
  where: string,
  ctx: DashRender
): { value: unknown; at: string } {
  const { field, alias, noun } = own(BLOCK_LISTS, String(block.type))!
  if (listUnderAlias(block)) {
    ctx.warnings.push(`${where}: the list was read from ${alias}; name it ${field}.`)
    const at = `${where}.${alias}`
    ctx.aliased.push(at)
    return { value: block[alias], at }
  }
  if (isEmptyList(block[field])) {
    throw new Error(
      `${where}.${field} is missing or empty; a '${String(block.type)}' block lists its ${noun} in ${field}.`
    )
  }
  return { value: block[field], at: `${where}.${field}` }
}

function renderBlock(b: unknown, where: string, ctx: DashRender): string {
  const type = isDashRecord(b) ? b.type : undefined
  return dashPart(ctx, where, COUNTED_BLOCKS.has(String(type)), () => {
    const block = dashRecord(b, where, 'a block object with a type')
    const title = dashText(block.title) || undefined
    switch (block.type) {
      case 'hero':
        return renderHero(block)
      case 'kpis': {
        const list = blockList(block, where, ctx)
        return renderKpis(list.value, list.at, ctx, title)
      }
      case 'chart':
        if (!isDashRecord(block.spec)) {
          throw new Error(
            `${where} is a 'chart' block and needs spec: {type, labels, datasets}; ` +
              `received ${describeDashValue(block.spec)}.`
          )
        }
        return `<section class="chart-grid">${ctx.charts.card(block.spec, `${where}.spec`, { title })}</section>`
      case 'charts-grid': {
        const list = blockList(block, where, ctx)
        return renderChartCards(list.value, list.at, ctx, title)
      }
      case 'table':
        return renderTableHtml(block.spec, `${where}.spec`, ctx, title)
      case 'narrative':
      case 'code':
      case 'callout':
        return renderSectionHtml(
          {
            type: block.type,
            content: block.content,
            language: block.language,
            tone: block.tone,
            title,
          },
          where
        )
      case 'bullets':
        return renderSectionHtml(
          { type: 'bullets', title, content: block.items ?? block.content },
          block.items === undefined ? where : `${where}.items`
        )
      case 'incidents': {
        const list = blockList(block, where, ctx)
        return renderIncidentsTimeline(list.value, list.at, ctx, title)
      }
      case 'service-health': {
        const list = blockList(block, where, ctx)
        return renderServiceHealthGrid(list.value, list.at, ctx, title)
      }
      case 'divider':
        return '<hr class="dashboard-divider"/>'
      case 'spacer':
        return `<div class="dashboard-spacer dashboard-spacer--${oneOf(block.size, ['sm', 'md', 'lg'] as const, 'md')}"></div>`
      default:
        throw new Error(
          `${where}.type ${block.type === undefined ? 'is missing' : `"${dashText(block.type)}" is not a block type`}; ` +
            `use one of: ${BLOCK_TYPES.join(', ')}.`
        )
    }
  })
}

const TEMPLATE_ONLY_FIELDS: Record<string, DashboardTemplateName[]> = {
  services: ['operations-pulse'],
  incidents: ['operations-pulse'],
  heroChart: ['financial-review'],
  period: ['financial-review'],
  blocks: ['custom'],
}
const FIXED_TEMPLATE_FIELDS = [
  'eyebrow',
  'headline',
  'status',
  'statusLabel',
  'kpis',
  'charts',
  'tables',
  'sections',
]

/** Data the chosen template does not show, which the model would otherwise believe is on the page. */
export function ignoredDashboardFields(template: DashboardTemplateName, data: DashData): string[] {
  const ignored = Object.entries(TEMPLATE_ONLY_FIELDS)
    .filter(([field, templates]) => data[field] !== undefined && !templates.includes(template))
    .map(([field, templates]) => `data.${field} is only shown by template '${templates[0]}'`)
  if (template === 'custom') {
    for (const field of FIXED_TEMPLATE_FIELDS) {
      if (data[field] !== undefined) {
        ignored.push(`data.${field} is not read by template 'custom' (put it in a block)`)
      }
    }
  }
  return ignored.map(line => `${line}; it was left out.`)
}
