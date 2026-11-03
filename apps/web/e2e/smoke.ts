/**
 * Browser smoke test against a running stack: web app, worker, Postgres, and `pnpm demo` for the
 * fictional job sites. Usage (from apps/web):  BASE_URL=http://localhost:3100 pnpm e2e
 * Screenshots go to ./e2e-output.
 */
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright-core'
import { resolveChromium } from '@apply/core/browser'

const BASE = process.env.BASE_URL ?? 'http://localhost:3100'
const OUT = process.env.E2E_OUT ?? 'e2e-output'
mkdirSync(OUT, { recursive: true })

let failures = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) failures++
}
const shot = (p: Page, name: string) => p.screenshot({ path: `${OUT}/${name}.png`, fullPage: true })

async function waitFor(fn: () => Promise<boolean>, what: string, ms = 120_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 700))
  }
  check(false, `timed out: ${what}`)
  return false
}

async function main() {
  const browser = await chromium.launch({ executablePath: resolveChromium(), headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()
  const text = async () => (await page.locator('body').innerText()).replace(/\s+/g, ' ')

  // --- unauthenticated -------------------------------------------------------------------
  const anon = await fetch(`${BASE}/api/artifacts/00000000-0000-0000-0000-000000000000`)
  check(anon.status === 401, 'artifact API refuses a visitor who is not signed in')
  check((await fetch(`${BASE}/api/tasks/x`)).status === 401, 'task API refuses a visitor')
  const noTok = await fetch(`${BASE}/api/agent/sessions/linkedin`, { method: 'PUT', body: '{}' })
  check(noTok.status === 401, 'session upload refuses a missing token')
  await page.goto(`${BASE}/jobs`)
  check(page.url().endsWith('/login'), 'a protected page redirects to the login page')
  await shot(page, '01-login')

  // --- login failure then success --------------------------------------------------------
  await page.fill('#email', 'demo@example.com')
  await page.fill('#password', 'wrong-password')
  await page.click('button[type=submit]')
  await page.waitForSelector('text=Wrong email or password')
  check(true, 'wrong password shows a clear error')
  check(
    (await page.inputValue('#email')) === 'demo@example.com',
    'the email you typed is kept after a failed sign in',
  )
  await page.fill('#password', 'demo-password-123')
  await page.click('button[type=submit]')
  await page.waitForURL(`${BASE}/`)
  check((await text()).includes('Dashboard'), 'signing in lands on the dashboard')
  await shot(page, '02-dashboard-empty')

  // --- find jobs through the worker ------------------------------------------------------
  await page.getByRole('button', { name: 'Find jobs' }).click()
  await page.waitForSelector('text=Search queued')
  await waitFor(
    async () => (await text()).includes('Finished') && (await text()).includes('Applying'),
    'find jobs and apply finished',
  )
  await waitFor(async () => {
    await page.reload()
    const n = await page.evaluate(() => {
      const tile = [...document.querySelectorAll('.tile')].find((t) =>
        t.textContent?.includes('Submitted'),
      )
      return Number(tile?.querySelector('.n')?.textContent ?? 0)
    })
    return n >= 1
  }, 'submitted count shows on the dashboard')
  await shot(page, '03-dashboard-after')
  const dash = await text()
  check(/Need you/.test(dash), 'dashboard shows the Need you tile')

  // --- jobs list and detail --------------------------------------------------------------
  await page.goto(`${BASE}/jobs`)
  const jt = await text()
  check(
    jt.includes('Lumen AI') && jt.includes('Harbor Pay') && jt.includes('Meridian Bank'),
    'jobs list shows the found jobs',
  )
  check(
    jt.includes('Submitted') && jt.includes('Needs you') && jt.includes('Review'),
    'jobs list shows statuses',
  )
  await shot(page, '04-jobs')
  await page.goto(`${BASE}/jobs?status=submitted`)
  await page.getByRole('link', { name: 'Harbor Pay' }).first().click()
  await page.waitForSelector('text=What was filled in')
  const detail = await text()
  check(
    detail.includes('Alex') && detail.includes('Decline to self-identify'),
    'job detail shows the values that were filled',
  )
  check((await page.locator('.shots img').count()) >= 1, 'job detail shows screenshots')
  const imgOk = await page.evaluate(async () => {
    const img = document.querySelector<HTMLImageElement>('.shots img')
    return !!img && (await fetch(img.src)).headers.get('content-type') === 'image/png'
  })
  check(imgOk, 'screenshots are served from the database as images')
  const pdf = await page.evaluate(async () => {
    const a = [...document.querySelectorAll('a')].find((x) => x.textContent?.endsWith('.pdf'))
    if (!a) return null
    const r = await fetch((a as HTMLAnchorElement).href)
    return {
      type: r.headers.get('content-type'),
      head: new TextDecoder().decode((await r.arrayBuffer()).slice(0, 4)),
    }
  })
  check(
    pdf?.type === 'application/pdf' && pdf.head === '%PDF',
    'the tailored resume downloads as a real PDF',
  )
  await shot(page, '05-job-detail')

  // --- needs you: answer the question ----------------------------------------------------
  await page.goto(`${BASE}/needs-you`)
  const ny = await text()
  check(
    ny.includes('Describe a time you led a team through conflict'),
    'needs-you lists the unanswered question',
  )
  check(
    ny.includes('verify you are human') ||
      ny.includes('proof') ||
      ny.includes('prove you are human'),
    'needs-you explains the captcha job',
  )
  check(
    ny.includes('Connect your account') || ny.includes('Connect account'),
    'needs-you points the Workday job to Connections',
  )
  await shot(page, '06-needs-you')
  await page.fill(
    'textarea[name=answer]',
    'I mediated a scope disagreement between a client and a designer and agreed clear deliverables.',
  )
  await page.getByRole('button', { name: 'Save answer and retry' }).click()
  await page.waitForSelector('text=queued again')
  check(true, 'saving an answer queues the waiting job again')
  await waitFor(async () => {
    await page.goto(`${BASE}/jobs?status=submitted`)
    return (await text()).includes('NovaTech')
  }, 'NovaTech submitted after the answer')
  await page.goto(`${BASE}/profile`)
  await page.getByRole('tab', { name: /answers\.md/ }).click()
  const ans = await page.locator('textarea.editor').inputValue()
  check(
    ans.includes('## Describe a time you led a team through conflict'),
    'the answer was added to answers.md',
  )

  // --- review then approve ---------------------------------------------------------------
  await page.goto(`${BASE}/jobs?status=ready_to_submit`)
  await page.getByRole('link', { name: 'Atlas Retail' }).click()
  await page.waitForSelector('text=Nothing was submitted')
  await shot(page, '07-review-job')
  await page.getByRole('button', { name: 'Approve and submit' }).click()
  await page.waitForSelector('text=Approved')
  await waitFor(async () => {
    await page.reload()
    return (await text()).includes('Submitted')
  }, 'approved job becomes submitted')
  check(true, 'approving a reviewed job submits it')

  // --- profile editor --------------------------------------------------------------------
  await page.goto(`${BASE}/profile`)
  await page.getByRole('tab', { name: /titles\.md/ }).click()
  await page.fill('textarea.editor', '# Keywords\n- a\n')
  await page.waitForSelector('text=Needs fixing')
  check((await text()).includes('Titles'), 'the editor shows a problem while typing')
  await shot(page, '08-profile-error')
  await page.fill(
    'textarea.editor',
    '# Titles\n- AI Engineer\n- Software Engineer\n# Locations\n- Singapore\n',
  )
  await page.waitForSelector('text=Looks good')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForSelector('text=Saved.')
  check(true, 'a valid file saves')
  // A stale save from another tab is refused.
  const ctx2 = await browser.newContext()
  const p2 = await ctx2.newPage()
  await p2.goto(`${BASE}/login`)
  await p2.fill('#email', 'demo@example.com')
  await p2.fill('#password', 'demo-password-123')
  await p2.click('button[type=submit]')
  await p2.waitForURL(`${BASE}/`)
  await p2.goto(`${BASE}/profile`)
  await p2.getByRole('tab', { name: /titles\.md/ }).click()
  await page.fill('textarea.editor', '# Titles\n- AI Engineer\n# Locations\n- Singapore\n')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForSelector('text=Saved.')
  await p2.fill('textarea.editor', '# Titles\n- Something else\n')
  await p2.getByRole('button', { name: 'Save', exact: true }).click()
  await p2.waitForSelector('text=changed somewhere else')
  check(true, 'a stale save from a second tab is refused, not overwritten')
  await ctx2.close()

  // --- settings --------------------------------------------------------------------------
  await page.goto(`${BASE}/settings`)
  await page.selectOption('select[name="sites.workday.submit"]', 'manual')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await page.waitForSelector('text=Settings saved')
  await page.reload()
  check(
    (await page.inputValue('select[name="sites.workday.submit"]')) === 'manual',
    'settings persist',
  )
  await page.fill('input[name="gate.minAccuracy"]', '150')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await page.waitForSelector('text=Some settings are not valid')
  check(
    (await text()).includes('gate.minAccuracy'),
    'invalid settings are rejected with the field name',
  )
  await page.selectOption('select[name="sites.workday.submit"]', 'review')
  await page.fill('input[name="gate.minAccuracy"]', '90')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await page.waitForSelector('text=Settings saved')
  await shot(page, '09-settings')

  // --- connections: token, session upload, secrets ---------------------------------------
  await page.goto(`${BASE}/connections`)
  await page.fill('input[name=name]', 'e2e laptop')
  await page.getByRole('button', { name: 'Create token' }).click()
  await page.waitForSelector('pre[aria-label="New token"]')
  const token = (await page.locator('pre[aria-label="New token"]').innerText()).trim()
  check(token.startsWith('aat_'), 'an access token is created and shown once')
  const up = await fetch(`${BASE}/api/agent/sessions/linkedin`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      cookies: [{ name: 'li_at', value: 'secret-cookie', domain: '.linkedin.com' }],
      origins: [],
    }),
  })
  check(up.status === 200, 'a session uploads with the token')
  check(
    (
      await fetch(`${BASE}/api/agent/sessions/facebook`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}` },
        body: '{}',
      })
    ).status === 400,
    'an unknown site name is refused',
  )
  check(
    (
      await fetch(`${BASE}/api/agent/sessions/linkedin`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ cookies: [], origins: [] }),
      })
    ).status === 400,
    'an empty session is refused',
  )
  await page.reload()
  check((await text()).includes('LinkedIn connected'), 'the connection shows as connected')
  check(
    !(await page.content()).includes('secret-cookie'),
    'cookies are never rendered back to the page',
  )
  await page.fill('#apiKey', 'sk-or-v1-1234567890abcdef')
  await page.getByRole('button', { name: 'Save key' }).click()
  await page.waitForSelector('text=Model key saved')
  await page.reload()
  check(
    !(await page.content()).includes('sk-or-v1-1234567890abcdef'),
    'the model key is never shown again',
  )
  check((await text()).includes('saved'), 'the page says the model key is saved')
  await shot(page, '10-connections')

  // --- report ----------------------------------------------------------------------------
  await page.goto(`${BASE}/report`)
  const rep = await text()
  check(
    rep.includes('Greenhouse') && rep.includes('Model usage'),
    'the report shows site stats and model usage',
  )
  await shot(page, '11-report')

  // --- logout ----------------------------------------------------------------------------
  await page.getByRole('button', { name: 'Sign out' }).click()
  await page.waitForURL(`${BASE}/login`)
  await page.goto(`${BASE}/jobs`)
  check(page.url().endsWith('/login'), 'after signing out, protected pages redirect again')

  await browser.close()
  console.log(failures === 0 ? '\nAll browser checks passed.' : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
