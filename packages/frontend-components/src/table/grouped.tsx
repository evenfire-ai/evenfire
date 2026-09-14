'use client'

import { Fragment, useId } from 'react'
import type { ReactNode } from 'react'
import { DataTable } from './primitives'
import type { GroupedTableBodyProps } from './types'
import { classNames } from './utils'

export function GroupedTableBody({
  childBodyClassName,
  childHeader,
  childTableClassName,
  children,
  className,
  colSpan,
  disclosureClassName,
  disclosureLabel,
  expanded,
  groupId,
  nestedChildTable = false,
  onExpandedChange,
  summary,
  summaryCells,
}: GroupedTableBodyProps) {
  const instanceId = useId().replaceAll(':', '')
  const idBase = `eft-table-group-${instanceId}-${encodeURIComponent(groupId)}`
  const disclosureId = `${idBase}-disclosure`
  const childRowsId = `${idBase}-rows`
  const summarySpan = summaryCells?.reduce((total, cell) => total + (cell.colSpan ?? 1), 0)

  if (summaryCells && summarySpan !== colSpan) {
    throw new Error(
      `GroupedTableBody summary cell spans (${summarySpan}) must equal colSpan (${colSpan}).`
    )
  }

  const disclosure = (content: ReactNode) => (
    <button
      aria-controls={childRowsId}
      aria-expanded={expanded}
      aria-label={disclosureLabel(expanded)}
      className={classNames('eft-table-group__disclosure', disclosureClassName)}
      id={disclosureId}
      onClick={event => {
        event.stopPropagation()
        onExpandedChange(!expanded)
      }}
      type="button"
    >
      <span aria-hidden="true" className="eft-table-group__indicator">
        ›
      </span>
      <span className="eft-table-group__summary">{content}</span>
    </button>
  )

  return (
    <Fragment>
      <tbody className={classNames('eft-table-group', className)}>
        <tr
          className={classNames(
            'eft-table-group__summary-row',
            summaryCells && 'eft-table-group__summary-row--cells'
          )}
        >
          {summaryCells ? (
            summaryCells.map((cell, index) => (
              <td
                className={classNames(
                  'eft-table-group__summary-cell',
                  index === 0 && 'eft-table-group__summary-cell--disclosure',
                  cell.className
                )}
                colSpan={cell.colSpan}
                key={cell.key}
              >
                {index === 0 ? disclosure(cell.content) : cell.content}
              </td>
            ))
          ) : (
            <td colSpan={colSpan}>{disclosure(summary)}</td>
          )}
        </tr>
      </tbody>
      <tbody
        aria-labelledby={disclosureId}
        className={classNames('eft-table-group__children', !nestedChildTable && childBodyClassName)}
        id={childRowsId}
      >
        {expanded && nestedChildTable ? (
          <tr className="eft-table-group__child-row">
            <td className="eft-table-group__child-cell" colSpan={colSpan}>
              <DataTable
                aria-labelledby={disclosureId}
                className={classNames('eft-table-group__child-table', childTableClassName)}
              >
                {childHeader ? <thead>{childHeader}</thead> : null}
                <tbody className={childBodyClassName}>{children}</tbody>
              </DataTable>
            </td>
          </tr>
        ) : expanded ? (
          <>
            {childHeader}
            {children}
          </>
        ) : null}
      </tbody>
    </Fragment>
  )
}
