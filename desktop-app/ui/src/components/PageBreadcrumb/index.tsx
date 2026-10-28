import { Breadcrumb, Button, Typography } from 'antd'
import type { PageBreadcrumbProps } from './types'

export function PageBreadcrumb({ ariaLabel, items }: PageBreadcrumbProps) {
  if (items.length === 0) return null

  return (
    <Breadcrumb
      aria-label={ariaLabel}
      separator="/"
      items={items.map((item, index) => {
        const isCurrent = index === items.length - 1
        return {
          title: item.onClick ? (
            <Button
              aria-current={isCurrent ? 'page' : undefined}
              htmlType="button"
              onClick={item.onClick}
              size="small"
              type="link"
            >
              {item.label}
            </Button>
          ) : (
            <Typography.Text aria-current={isCurrent ? 'page' : undefined}>
              {item.label}
            </Typography.Text>
          ),
        }
      })}
    />
  )
}
