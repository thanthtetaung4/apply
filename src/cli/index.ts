import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { join, resolve } from 'node:path'
import { createApp, createRegistry, type App } from './../app'
import { sessionKeyFor } from '../apply/recipes'
import { ConfigError, loadConfig } from '../config/load'
import { listTables, openDb } from '../db'
import { runIntake } from '../intake'
import { buildReport, renderReportHtml, renderReportText } from '../metrics/report'
import { decidePolicy, siteStats } from '../metrics/gate'
import { loadProfile, ProfileError } from '../profile'
import { JOB_SOURCES, SITE_TYPES, type JobSource, type SiteType } from '../shared/status'

const HELP = `Auto Apply

Setup and checks
  config:check               Validate config/default.yaml and show resolved values
  profile:check [dir]        Parse the profile markdown files and summarise them
  profile:match "<text>"     Look up an answer in answers.md for a form question
  db:init                    Create or migrate data/apply.db

Pipeline
  intake [--dry-run] [--source indeed|linkedin|glassdoor]
                             Find jobs on the boards and queue the good ones
  tailor                     Make a tailored resume for every queued job
  run [--limit N]            Tailor, then apply with the worker pool (honours submit policy)
  status                     Counts by status and site type
  park                       Jobs waiting for a human, with the reason
  retry <jobId>              Put a job back in the queue
  login <site> [url]         Open a browser to sign in once and save the session
  board:flush                Retry board updates that failed earlier

Reports
  report [--html file]       Metrics by site type, model usage, shadow runs
  gate                       Which site types have earned auto submit

Demo
  pnpm demo                  Full pipeline against local mock sites with a dummy resume
`

const out = (line = '') => process.stdout.write(line + '\n')
const flag = (args: string[], name: string) => args.includes(name)
const opt = (args: string[], name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

async function withApp<T>(fn: (app: App) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const app = await createApp(config, { log: out })
  try {
    return await fn(app)
  } finally {
    await app.close()
  }
}

async function main(argv: string[]): Promise<number> {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const [cmd, ...args] = argv

  switch (cmd) {
    case 'config:check': {
      const cfg = loadConfig()
      out(
        JSON.stringify(
          { ...cfg, board: { ...cfg.board, url: cfg.board.url ?? '(not set)' } },
          null,
          2,
        ),
      )
      return 0
    }
    case 'profile:check': {
      const profile = loadProfile(args[0] ?? loadConfig().profileDir)
      const bullets = profile.experience.reduce((n, e) => n + e.bullets.length, 0)
      out(`Profile OK (version ${profile.version})`)
      out(`  name:           ${profile.contact.name} <${profile.contact.email}>`)
      out(`  experience:     ${profile.experience.length} roles, ${bullets} bullets`)
      out(`  education:      ${profile.education.length}`)
      out(`  skill groups:   ${profile.skills.length}`)
      out(`  projects:       ${profile.projects.length}`)
      out(`  titles:         ${profile.titles.titles.join(', ')}`)
      out(`  answer entries: ${profile.answers.length}`)
      return 0
    }
    case 'profile:match': {
      const question = args.join(' ').trim()
      if (!question) return (out('Usage: profile:match "<question text>"'), 1)
      const hit = loadProfile(loadConfig().profileDir).answerBank.match(question)
      if (!hit)
        return (
          out('No match. This question would go to the model or be parked as needs_human.'),
          0
        )
      out(`Matched "${hit.pattern}" (score ${hit.score.toFixed(2)})`)
      out(hit.answer)
      return 0
    }
    case 'db:init': {
      const cfg = loadConfig()
      const path = join(cfg.dataDir, 'apply.db')
      const db = openDb(path)
      out(`Database ready at ${path}`)
      out(`Tables: ${listTables(db).join(', ')}`)
      db.close()
      return 0
    }
    case 'intake':
      return withApp(async (app) => {
        const sourceArg = opt(args, '--source') as JobSource | undefined
        if (sourceArg && !JOB_SOURCES.includes(sourceArg))
          throw new ConfigError(`Unknown source "${sourceArg}"`)
        const s = await runIntake({
          config: app.config,
          registry: app.registry,
          profile: app.profile,
          repo: app.repo,
          log: out,
          sources: sourceArg ? [sourceArg] : undefined,
          dryRun: flag(args, '--dry-run'),
        })
        out(
          `\nFound ${s.found}, queued ${s.queued}. Skipped: ${
            Object.entries(s.skipped)
              .filter(([, n]) => n)
              .map(([k, n]) => `${k} ${n}`)
              .join(', ') || 'none'
          }`,
        )
        for (const e of s.errors) out(`Error: ${e}`)
        return s.errors.length ? 1 : 0
      })
    case 'tailor':
      return withApp(
        async (app) => (out(`Tailored ${await app.orchestrator.tailorQueued()} resumes`), 0),
      )
    case 'run':
      return withApp(async (app) => {
        const sig = () => app.orchestrator.stop()
        process.once('SIGINT', sig)
        const s = await app.orchestrator.run({
          limit: opt(args, '--limit') ? Number(opt(args, '--limit')) : undefined,
        })
        await app.fallbackBoard?.flush()
        out(`\nTailored ${s.tailored}, processed ${s.processed}, deferred ${s.deferred}`)
        out(
          Object.entries(s.byStatus)
            .map(([k, v]) => `${k} ${v}`)
            .join(', '),
        )
        return 0
      })
    case 'status':
      return withApp(async (app) => {
        const rows = app.repo.counts()
        if (rows.length === 0) return (out('No jobs yet. Run: pnpm cli intake'), 0)
        for (const r of rows.sort((a, b) => a.status.localeCompare(b.status)))
          out(`${r.status.padEnd(22)} ${r.siteType.padEnd(14)} ${r.n}`)
        return 0
      })
    case 'park':
      return withApp(async (app) => {
        const jobs = app.repo.listByStatus('needs_human')
        if (jobs.length === 0) return (out('Nothing is waiting for you.'), 0)
        for (const j of jobs) {
          out(
            `${j.id}  ${j.company} | ${j.title}\n    ${app.repo.getApplication(j.id)?.error ?? ''}\n    ${j.applyUrl}`,
          )
        }
        const q = app.repo.unanswered()
        if (q.length)
          out(`\nAdd answers for these to profile/answers.md, then retry:\n  - ${q.join('\n  - ')}`)
        return 0
      })
    case 'retry':
      return withApp(async (app) => {
        if (!args[0]) return (out('Usage: retry <jobId>'), 1)
        app.orchestrator.retry(args[0])
        out('Queued again. Run: pnpm cli run')
        return 0
      })
    case 'login': {
      const site = args[0] as SiteType | undefined
      if (!site || !SITE_TYPES.includes(site))
        return (out(`Usage: login <${SITE_TYPES.join('|')}> [url]`), 1)
      const cfg = loadConfig()
      const url =
        args[1] ??
        (site === 'indeed' || site === 'linkedin' || site === 'glassdoor'
          ? cfg.sources[site].baseUrl
          : undefined)
      if (!url) return (out('Give the sign in or job URL: login workday <url>'), 1)
      const key = sessionKeyFor(site, url)
      if (!key) return (out(`${site} does not need a saved sign in.`), 0)
      const registry = createRegistry(cfg)
      const session = await registry.launch('playwright-chromium', {
        headless: false,
        storageStatePath: join(cfg.sessionsDir, `${key}.json`),
      })
      try {
        await session.open(url)
        const rl = createInterface({ input: process.stdin, output: process.stdout })
        await rl.question(
          'Sign in in the browser window, then press Enter here to save the session... ',
        )
        rl.close()
        const path = join(cfg.sessionsDir, `${key}.json`)
        await session.saveState(path)
        out(`Saved ${path}`)
      } finally {
        await session.close()
        await registry.disposeAll()
      }
      return 0
    }
    case 'board:flush':
      return withApp(async (app) => {
        if (!app.fallbackBoard) return (out('No board URL configured (set BOARD_MCP_URL).'), 0)
        out(`Sent ${await app.fallbackBoard.flush()} queued updates`)
        return 0
      })
    case 'report':
      return withApp(async (app) => {
        const data = buildReport(app.db, app.config)
        out(renderReportText(data))
        const html = opt(args, '--html')
        if (html) {
          await writeFile(resolve(html), renderReportHtml(data))
          out(`\nWrote ${resolve(html)}`)
        }
        return 0
      })
    case 'gate':
      return withApp(async (app) => {
        for (const t of SITE_TYPES) {
          const d = decidePolicy(app.db, app.config, t)
          const s = siteStats(app.db, t)
          out(
            `${t.padEnd(14)} runs ${String(s.runs).padStart(3)}  verified ${(s.accuracy * 100).toFixed(0).padStart(3)}%  policy ${d.configured} -> ${d.effective}  ${d.reason ?? ''}`,
          )
        }
        return 0
      })
    default:
      out(HELP)
      return cmd ? 1 : 0
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    if (err instanceof ConfigError || err instanceof ProfileError) {
      process.stderr.write(err.message + '\n')
      process.exitCode = 1
    } else {
      throw err
    }
  })
