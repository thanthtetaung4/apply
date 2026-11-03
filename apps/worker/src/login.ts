/**
 * Sign in to a job site on THIS computer and upload the session to your Auto Apply account.
 * Your password never leaves this window. Only the resulting session cookies are sent, over HTTPS,
 * and they are stored encrypted.
 *
 *   APPLY_API_URL=https://your-app.vercel.app APPLY_API_TOKEN=aat_... pnpm login linkedin
 *   pnpm login workday https://acme.wd3.myworkdayjobs.com/en-US/careers
 *   pnpm login linkedin --file state.json     (upload a storage state you saved another way)
 */
import { existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { PlaywrightBackend } from '@apply/core/browser'

const SITES = ['indeed', 'linkedin', 'glassdoor', 'workday'] as const
const DEFAULT_URL: Record<string, string> = {
  indeed: 'https://sg.indeed.com/account/login',
  linkedin: 'https://www.linkedin.com/login',
  glassdoor: 'https://www.glassdoor.sg/profile/login_input.htm',
}

export function sessionKey(site: string, url?: string): string {
  if (site !== 'workday') return site
  const host = url ? new URL(url).hostname : ''
  const tenant = host.split('.')[0]
  if (!tenant || host.indexOf('.') < 0)
    throw new Error(
      'For Workday give the company job page URL, e.g. https://acme.wd3.myworkdayjobs.com/...',
    )
  return `workday-${tenant.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`
}

async function upload(apiUrl: string, token: string, key: string, state: unknown) {
  const res = await fetch(`${apiUrl.replace(/\/$/, '')}/api/agent/sessions/${key}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(state),
  })
  if (!res.ok) throw new Error(`Upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
}

async function main() {
  const [site, ...rest] = process.argv.slice(2)
  const fileIdx = rest.indexOf('--file')
  const file = fileIdx >= 0 ? rest[fileIdx + 1] : undefined
  const url = rest.find((a) => a.startsWith('http'))
  const apiUrl = process.env.APPLY_API_URL
  const token = process.env.APPLY_API_TOKEN
  if (!site || !SITES.includes(site as (typeof SITES)[number]) || !apiUrl || !token) {
    console.error(
      `Usage: APPLY_API_URL=... APPLY_API_TOKEN=aat_... pnpm login <${SITES.join('|')}> [job page url] [--file state.json]`,
    )
    process.exit(1)
  }
  const key = sessionKey(site, url)

  if (file) {
    if (!existsSync(file)) throw new Error(`File not found: ${file}`)
    await upload(apiUrl, token, key, JSON.parse(readFileSync(file, 'utf8')))
    console.log(`Uploaded ${file} as "${key}".`)
    return
  }

  const backend = new PlaywrightBackend()
  const session = await backend.launch({ headless: false })
  try {
    await session.open(url ?? DEFAULT_URL[site] ?? 'about:blank')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    await rl.question('Sign in in the browser window (finish any 2FA), then press Enter here... ')
    rl.close()
    await upload(apiUrl, token, key, await session.exportState())
    console.log(`Saved your ${site} sign in as "${key}". You can close the browser.`)
  } finally {
    await session.close()
    await backend.dispose()
  }
}

if (process.argv[1]?.endsWith('login.ts')) {
  main().catch((err) => {
    console.error((err as Error).message)
    process.exit(1)
  })
}
