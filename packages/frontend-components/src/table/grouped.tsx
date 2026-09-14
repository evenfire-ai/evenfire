'use client'

import { Fragment } from 'react'
import type { GroupedTableBodyProps } from './types'
import { classNames } from './utils'

export function GroupedTableBody({
  childBodyClassName,
  children,
  className,
  colSpan,
  disclosureClassName,
  disclosureLabel,
  expanded,
  groupId,
  onExpandedChange,
  summary,
}: GroupedTableBodyProps) {
  const childRowsId = `eft-table-group-${groupId}-rows`

  return (
    <Fragment>
      <tbody className={classNames('eft-table-group', className)}>
        <tr className="eft-table-group__summary-row">
          <td colSpan={colSpan}>
            <button
              aria-controls={childRowsId}
              aria-expanded={expanded}
              aria-label={disclosureLabel(expanded)}
              className={classNames('eft-table-group__disclosure', disclosureClassName)}
              onClick={event => {
                event.stopPropagation()
                onExpandedChange(!expanded)
              }}
              type="button"
            >
              <span aria-hidden="true" className="eft-table-group__indicator">
                ›
              </span>
              <span className="eft-table-group__summary">{summary}</span>
            </button>
          </td>
        </tr>
      </tbody>
      <tbody
        className={classNames('eft-table-group__children', childBodyClassName)}
        id={childRowsId}
      >
        {expanded ? children : null}
      </tbody>
    </Fragment>
  )
}
