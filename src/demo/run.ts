/**
 * End to end demo on local mock job sites with a dummy resume. Nothing real is contacted:
 * the job boards, employer sites and the Job Search Board are all local stand-ins.
 *
 *   pnpm demo
 */
import { appendFileSync, cpSync, mkdirSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createApp, type App } from '../app'
import { FallbackBoardLogger, McpBoardLogger } from '../board/mcp-logger'
import { PlaywrightBackend } from '../browser/playwright-backend'
import { loadConfig } from '../config/load'
import type { AppConfig } from '../config/schema'
import { runIntake } from '../intake'
import { buildReport, renderReportHtml, renderReportText } from '../metrics/report'
import { demoConfig } from './config'
import { createMockBoard } from './mock-board'
import { MOCK_TARGET_RULES, startMockServer } from './mock-server'

const say = (line = '') => process.stdout.write(line + '\n')
const heading = (t: string) => say(`\n=== ${t} ===`)

async function main() {
  const root = resolve(process.cwd())
  const outRoot = join(root, 'demo-output')
  rmSync(outRoot, { recursive: true, force: true })
  mkdirSync(outRoot, { recursive: true })
  cpSync(join(root, 'demo', 'profile'), join(outRoot, 'profile'), { recursive: true })

  const server = await startMockServer()
  const board = await createMockBoard()
  const base = loadConfig({ root, env: {} })
  const config: AppConfig = {
    ...demoConfig(base, server.url, outRoot),
    backends: { shadow: { enabled: true, name: 'playwright-lean', sample: 1 } },
  }

  const boardFactory = (
    repo: App['repo'],
    file: Parameters<NonNullable<Parameters<typeof createApp>[1]>['boardFactory'] & {}>[1],
  ) => new FallbackBoardLogger(new McpBoardLogger(board.client, repo), file, repo)

  // ---- Run 1 -------------------------------------------------------------------------
  let app = await createApp(config, { log: say, boardFactory })
  heading('1. Intake: search the three boards, read each job, queue the good ones')
  const intake = await runIntake({
    config,
    registry: app.registry,
    profile: app.profile,
    repo: app.repo,
    log: say,
    targetRules: MOCK_TARGET_RULES,
  })
  say(
    `found ${intake.found} job pages, queued ${intake.queued}, skipped ${JSON.stringify(Object.fromEntries(Object.entries(intake.skipped).filter(([, n]) => n)))}`,
  )

  heading('2. Run: tailor a resume per job, then apply (2 workers, shadow browser on)')
  const s1 = await app.orchestrator.run()
  say(`\ntailored ${s1.tailored}, processed ${s1.processed}`)
  await app.close()

  // ---- Human steps -------------------------------------------------------------------
  heading('3. Human steps: sign in to Workday once, add the missing answer')
  const backend = new PlaywrightBackend()
  const s = await backend.launch({ headless: true })
  await s.open(`${server.url}/wd/meridian/job/301`)
  const wall = await s.formSchema()
  await s.fill(wall.fields.find((f) => f.type === 'email')!.id, 'alex.tan@example.com')
  await s.fill(wall.fields.find((f) => f.type === 'password')!.id, 'demo-password')
  await s.click(wall.actions.find((a) => a.label === 'Sign In')!.id)
  await s.saveState(join(config.sessionsDir, 'workday-meridian.json'))
  await s.close()
  await backend.dispose()
  say('saved Workday session for the meridian tenant')
  appendFileSync(
    join(outRoot, 'profile', 'answers.md'),
    '\n## Describe a time you led a team through conflict\nWhile freelancing I mediated a scope disagreement between a client and a designer by writing down both sets of needs, agreeing priorities with each, and splitting the work into clear deliverables.\n',
  )
  say('added an answer for "Describe a time you led a team through conflict" (dummy text)')

  // ---- Run 2 -------------------------------------------------------------------------
  heading(
    '4. Retry the parked jobs. Workday now routes to the (unimplemented) ai-browser first and falls back to Chromium',
  )
  const config2: AppConfig = {
    ...config,
    sites: {
      ...config.sites,
      workday: { ...config.sites.workday, backend: 'ai-browser', fallback: 'playwright-chromium' },
    },
    backends: { shadow: { enabled: true, name: 'ai-browser', sample: 1 } },
  }
  app = await createApp(config2, { log: say, boardFactory })
  for (const company of ['Meridian Bank', 'NovaTech']) {
    const row = app.db.prepare('SELECT id FROM jobs WHERE company = ?').get(company) as {
      id: string
    }
    app.orchestrator.retry(row.id)
  }
  const s2 = await app.orchestrator.run()
  say(`\nprocessed ${s2.processed}`)

  // ---- Results -----------------------------------------------------------------------
  heading('5. Report')
  const data = buildReport(app.db, app.config)
  say(renderReportText(data))
  const submissions = JSON.stringify(
    server.submissions.map((x) => ({
      company: x.company,
      kind: x.kind,
      name: `${x.fields.first_name ?? x.fields.full_name ?? x.fields.wd_first ?? ''}`,
      email: x.fields.email ?? x.fields.wd_email ?? '',
      resume: Object.values(x.files)[0]?.filename,
    })),
    null,
    2,
  )
  await writeFile(
    join(outRoot, 'report.html'),
    renderReportHtml(data, { title: 'Auto Apply demo run', submissions }),
  )

  heading('6. What the Job Search Board (mock, over MCP) now holds')
  for (const a of board.apps)
    say(`${a.stage.padEnd(9)} ${(a.company + ' | ' + a.role).padEnd(46)} ${a.nextAction ?? ''}`)

  heading('7. What the mock employer sites received')
  say(submissions)

  await app.close()
  await board.close()
  await server.close()
  say(`\nOutput written to ${outRoot}`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
