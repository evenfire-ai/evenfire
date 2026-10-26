/**
 * The fixed text the document tools print themselves: template headings, the
 * DOCX page label, chart and dashboard labels, and the badges drawn from enum
 * values. Text the model writes is never translated.
 */
export const LABEL_KEYS = [
  'page',
  'report',
  'chart',
  'total',
  'value',
  'remainder',
  'step',
  'stage',
  'sheet',
  'max',
  'noData',
  'trendNotDrawn',
  'visualTrends',
  'serviceHealth',
  'incidentTimeline',
  'performanceTrends',
  'breakdowns',
  'charts',
  'statusGreen',
  'statusYellow',
  'statusRed',
  'statusNeutral',
  'resolved',
  'open',
  'severityCritical',
  'severityHigh',
  'severityMedium',
  'severityLow',
  'severityInfo',
  'serviceHealthy',
  'serviceDegraded',
  'serviceDown',
  'serviceMaintenance',
  'serviceUnknown',
  'keyMetrics',
  'keyTakeaways',
  'nextSteps',
  'periodHighlights',
  'quarterlyKpis',
  'revenueTrend',
  'revenueBreakdown',
  'metricsSnapshot',
  'nextQuarterPriorities',
  'lookingAhead',
  'outlook',
  'summary',
  'timeline',
  'impact',
  'rootCause',
  'remediation',
  'lessonsLearned',
  'thePain',
  'problem',
  'ourApproach',
  'solution',
  'marketSize',
  'traction',
  'team',
  'theAsk',
] as const

export type LabelKey = (typeof LABEL_KEYS)[number]

/**
 * One language's text for every key. Status and severity words are printed in
 * capitals; `{period}` is replaced with the period the deck covers. In page,
 * step and stage, `{n}` marks where the number goes; without it the number
 * follows the word after a space.
 */
export type Labels = Record<LabelKey, string>
