import React from 'react'
import type { HostOverviewTabProps } from './types'

function SummaryCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="cu-card" aria-label={title}>
      <div className="cu-card__body">
        <h3 className="cu-section-title" style={{ marginBottom: 'var(--cu-space-2)' }}>
          {title}
        </h3>
        {children}
      </div>
    </section>
  )
}

export function HostOverviewTab({
  hostName,
  displayName,
  contextRef,
  contextMcpServers,
  modelName,
  fallbackLines,
  allowedModelLines,
  accessSummary,
}: HostOverviewTabProps) {
  const contextLabel = contextRef.trim() || '—'
  const hasContext = Boolean(contextRef.trim())
  const hasMcpServers = contextMcpServers.length > 0

  return (
    <div className="cu-form-stack cu-agent-form-stack">
      <SummaryCard title="Name">
        <div className="cu-field" style={{ marginBottom: 0 }}>
          <div
            style={{
              fontSize: '1.25rem',
              fontWeight: 600,
              lineHeight: 1.3,
            }}
          >
            {displayName.trim() || hostName}
          </div>
          <div className="cu-muted" style={{ fontSize: '0.8125rem', marginTop: '0.15rem' }}>
            {hostName}
          </div>
        </div>
      </SummaryCard>

      <SummaryCard title="Access">
        <div className="cu-field" style={{ marginBottom: 0 }}>
          <div
            style={{
              display: 'flex',
              gap: 'var(--cu-space-3)',
              flexWrap: 'wrap',
            }}
          >
            <span className="cu-chip">
              {accessSummary.memberCount === 1
                ? '1 member'
                : `${accessSummary.memberCount} members`}
            </span>
            <span className="cu-chip">
              {accessSummary.teamCount === 1 ? '1 team' : `${accessSummary.teamCount} teams`}
            </span>
          </div>
        </div>
      </SummaryCard>

      <SummaryCard title="Models">
        <div className="cu-field">
          <label>Primary</label>
          <div className="cu-field__readonly">{modelName.trim() || '—'}</div>
        </div>
        {fallbackLines.length > 0 ? (
          <div className="cu-field">
            <label>Fallbacks</label>
            <ol className="cu-llm-policy__summary" style={{ margin: 0 }}>
              {fallbackLines.map((line, index) => (
                <li key={index} className="cu-field__readonly">
                  {line}
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        {allowedModelLines.length > 0 ? (
          <div className="cu-field">
            <label>Per-host model allowlist</label>
            <ul className="cu-llm-policy__summary" style={{ margin: 0 }}>
              {allowedModelLines.map((line, index) => (
                <li key={index} className="cu-field__readonly">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </SummaryCard>

      <SummaryCard title="Context">
        <div className="cu-field" style={{ marginBottom: hasMcpServers ? undefined : 0 }}>
          <div className="cu-field__readonly">{contextLabel}</div>
        </div>
        {hasContext ? (
          <section className="cu-agent-context-mcp-summary" aria-label="Attached MCP servers">
            <div className="cu-agent-context-mcp-summary__head">
              <span>MCP servers</span>
              <span>{contextMcpServers.length}</span>
            </div>
            {hasMcpServers ? (
              <ul className="cu-agent-context-mcp-summary__list">
                {contextMcpServers.map(server => (
                  <li key={server} title={server}>
                    {server}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="cu-muted" style={{ margin: 0 }}>
                No MCP servers attached.
              </p>
            )}
          </section>
        ) : null}
      </SummaryCard>
    </div>
  )
}
