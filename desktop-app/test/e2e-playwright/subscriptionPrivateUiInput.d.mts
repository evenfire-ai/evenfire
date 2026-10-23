import type { Page } from '@playwright/test'

export function enterLoginPassword(page: Page, value: string): Promise<void>
