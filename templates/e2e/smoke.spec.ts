import { test, expect } from '@playwright/test'

test.describe('smoke', () => {
  test('homepage loads without fatal errors', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))

    const response = await page.goto('/')
    expect(response?.status()).toBeLessThan(400)

    await expect(page.locator('body')).toBeVisible()
    const title = await page.title()
    expect(title.trim().length).toBeGreaterThan(0)

    expect(errors, `page errors: ${errors.join('; ')}`).toEqual([])
  })
})
