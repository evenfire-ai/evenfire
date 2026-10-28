import { useMemo } from 'react'
import { useAgentActivityContext } from '@contexts/AgentActivityContext'
import { Card, Col, Empty, Flex, Row, Statistic, Typography } from 'antd'

export function ActivityDashboard() {
  const { selectedAgentActivitySummary } = useAgentActivityContext()

  const activityChart = useMemo(() => {
    const points = selectedAgentActivitySummary.conversationsPerDay
    if (!points.length) {
      return {
        width: 680,
        height: 120,
        baselineY: 108,
        gridLineStartX: 32,
        linePath: '',
        areaPath: '',
        points: [] as Array<{ x: number; y: number; dayLabel: string; count: number }>,
        gridLines: [] as Array<{ y: number; label: string }>,
        yAxisLabelX: 26,
      }
    }
    const width = 680
    const height = 120
    const yAxisLabelX = 26
    const gridLineStartX = yAxisLabelX + 6
    const paddingX = gridLineStartX + 4
    const paddingY = 12
    const baselineY = height - paddingY
    const maxCount = Math.max(1, ...points.map(point => point.count))
    const niceStep = (() => {
      if (maxCount <= 5) return 1
      if (maxCount <= 10) return 2
      if (maxCount <= 25) return 5
      if (maxCount <= 50) return 10
      return Math.ceil(maxCount / 5 / 10) * 10
    })()
    const ceilMax = Math.ceil(maxCount / niceStep) * niceStep
    const gridLines: Array<{ y: number; label: string }> = []
    for (let v = niceStep; v <= ceilMax; v += niceStep) {
      const y = baselineY - (v / ceilMax) * (height - paddingY * 2)
      gridLines.push({ y, label: String(v) })
    }

    const chartPoints = points.map((point, index) => {
      const x =
        points.length === 1
          ? width / 2
          : paddingX + (index * (width - paddingX * 2)) / (points.length - 1)
      const y = baselineY - (point.count / ceilMax) * (height - paddingY * 2)
      return { x, y, dayLabel: point.dayLabel, count: point.count }
    })
    const linePath = chartPoints
      .map(
        (point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`
      )
      .join(' ')
    const firstPoint = chartPoints[0]!
    const lastPoint = chartPoints[chartPoints.length - 1]!
    const areaPath = `${linePath} L ${lastPoint.x.toFixed(2)} ${baselineY.toFixed(2)} L ${firstPoint.x.toFixed(2)} ${baselineY.toFixed(2)} Z`

    return {
      width,
      height,
      baselineY,
      gridLineStartX,
      linePath,
      areaPath,
      points: chartPoints,
      gridLines,
      yAxisLabelX,
    }
  }, [selectedAgentActivitySummary.conversationsPerDay])

  return (
    <Flex component="section" vertical gap="middle" aria-label="Agent activity">
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={6}>
          <Card size="small">
            <Statistic title="Conversations" value={selectedAgentActivitySummary.conversations} />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small">
            <Statistic title="Messages" value={selectedAgentActivitySummary.messages} />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small">
            <Statistic title="Tool calls" value={selectedAgentActivitySummary.toolCalls} />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small">
            <Statistic title="Errors" value={selectedAgentActivitySummary.errors} />
          </Card>
        </Col>
      </Row>

      <Card
        size="small"
        title="Activity over time"
        extra={<Typography.Text type="secondary">Conversations per day</Typography.Text>}
      >
        <Flex vertical gap="small">
          {activityChart.points.length > 0 ? (
            <>
              <svg
                viewBox={`0 0 ${activityChart.width} ${activityChart.height}`}
                role="img"
                aria-label="Conversations per day chart"
              >
                <defs>
                  <linearGradient id="agent-activity-gradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="rgba(var(--accent-rgb), 0.32)" />
                    <stop offset="100%" stopColor="rgba(var(--accent-rgb), 0.02)" />
                  </linearGradient>
                </defs>
                {activityChart.gridLines.map(gl => (
                  <g key={gl.label}>
                    <line
                      x1={activityChart.gridLineStartX}
                      y1={gl.y}
                      x2={activityChart.width}
                      y2={gl.y}
                      stroke="rgba(var(--edge-rgb), 0.18)"
                      strokeWidth="1"
                      strokeDasharray="3,3"
                    />
                    <text
                      x={activityChart.yAxisLabelX}
                      y={gl.y + 3.5}
                      textAnchor="end"
                      fill="rgba(var(--edge-rgb), 0.6)"
                      fontSize="9"
                      fontFamily="inherit"
                    >
                      {gl.label}
                    </text>
                  </g>
                ))}
                <line
                  x1={activityChart.gridLineStartX}
                  y1={activityChart.baselineY}
                  x2={activityChart.width}
                  y2={activityChart.baselineY}
                  stroke="rgba(var(--edge-rgb), 0.28)"
                  strokeWidth="1"
                />
                <text
                  x={activityChart.yAxisLabelX}
                  y={activityChart.baselineY + 3.5}
                  textAnchor="end"
                  fill="rgba(var(--edge-rgb), 0.6)"
                  fontSize="9"
                  fontFamily="inherit"
                >
                  0
                </text>
                <path d={activityChart.areaPath} fill="url(#agent-activity-gradient)" />
                <path
                  d={activityChart.linePath}
                  fill="none"
                  stroke="rgba(var(--accent-rgb), 0.9)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {activityChart.points.map(point => (
                  <circle
                    key={point.dayLabel}
                    cx={point.x}
                    cy={point.y}
                    r="2.8"
                    fill="rgba(var(--accent-rgb), 1)"
                  />
                ))}
              </svg>
              <div className="agent-activity-chart-x-axis">
                {activityChart.points.map(point => (
                  <span key={point.dayLabel} title={`${point.dayLabel}: ${point.count}`}>
                    {point.dayLabel}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <Empty description="No activity yet." />
          )}
        </Flex>
      </Card>
    </Flex>
  )
}
