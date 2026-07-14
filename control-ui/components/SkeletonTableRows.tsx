'use client'

import React from 'react'

export function SkeletonTableRows({ columns, rows = 4 }: { columns: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIdx) => (
        <tr key={rowIdx}>
          {Array.from({ length: columns }).map((_, colIdx) => (
            <td key={colIdx}>
              <div
                className="cu-skeleton cu-skeleton--cell"
                style={{
                  width:
                    colIdx === columns - 1 ? '2.5rem' : `${55 + (((rowIdx + colIdx) * 17) % 35)}%`,
                }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}
