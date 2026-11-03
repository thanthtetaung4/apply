import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

/**
 * Find a Chromium or Chrome executable. Order: CHROMIUM_PATH, the one Playwright expects
 * (`pnpm exec playwright install chromium`), any Chromium under PLAYWRIGHT_BROWSERS_PATH,
 * then common system Chrome locations.
 */
export function resolveChromium(env: Record<string, string | undefined> = process.env): string {
  const candidates: string[] = []
  if (env.CHROMIUM_PATH) candidates.push(env.CHROMIUM_PATH)
  try {
    candidates.push(chromium.executablePath())
  } catch {
    // Playwright cannot tell on this platform. Keep looking.
  }

  const roots = [
    env.PLAYWRIGHT_BROWSERS_PATH,
    join(env.HOME ?? env.USERPROFILE ?? '', '.cache', 'ms-playwright'),
  ]
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    for (const dir of readdirSync(root)
      .filter((d) => d.startsWith('chromium'))
      .sort()
      .reverse()) {
      candidates.push(
        join(root, dir, 'chrome-linux64', 'chrome'),
        join(root, dir, 'chrome-linux', 'chrome'),
        join(root, dir, 'chrome-win64', 'chrome.exe'),
        join(root, dir, 'chrome-win', 'chrome.exe'),
      )
    }
  }
  candidates.push(
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  )

  const found = candidates.find((p) => p && existsSync(p))
  if (!found) {
    throw new Error(
      'No Chromium found. Run "pnpm exec playwright install chromium" or set CHROMIUM_PATH to a Chrome or Chromium executable.',
    )
  }
  return found
}
