import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FallbackBoardLogger, McpBoardLogger } from '../src/board/mcp-logger'
import { createMockBoard, type MockBoard } from '../src/demo/mock-board'
import { MOCK_TARGET_RULES } from '../src/demo/mock-server'
import { runIntake } from '../src/intake'
import { createApp } from '../src/app'
import { buildReport } from '../src/metrics/report'
import { makeEnv, type TestEnv } from './helpers/env'

const statusOf = (env: TestEnv, company: string) =>
  env.app.db
    .prepare(
      'SELECT a.status, a.error FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.company = ? AND a.status != ?',
    )
    .get(company, 'skipped') as { status: string; error: string | null }

const intake = (env: TestEnv, sources?: ('indeed' | 'linkedin' | 'glassdoor')[]) =>
  runIntake({
    config: env.config,
    registry: env.app.registry,
    profile: env.app.profile,
    repo: env.app.repo,
    targetRules: MOCK_TARGET_RULES,
    sources,
  })

describe('full pipeline on the mock sites', () => {
  let env: TestEnv
  let board: MockBoard

  afterAll(async () => {
    await env?.close()
    await board?.close()
  })

  it('applies across site types and parks what needs a human', async () => {
    board = await createMockBoard()
    env = await makeEnv(
      (c) => ({
        ...c,
        backends: { shadow: { enabled: true, name: 'playwright-lean', sample: 1 } },
      }),
      {
        boardFactory: (repo, file) =>
          new FallbackBoardLogger(new McpBoardLogger(board.client, repo), file, repo),
      },
    )
    await intake(env)
    const summary = await env.app.orchestrator.run()
    expect(summary.tailored).toBe(9)
    expect(summary.processed).toBe(9)

    expect(statusOf(env, 'Lumen AI').status).toBe('submitted') // greenhouse, auto
    expect(statusOf(env, 'Harbor Pay').status).toBe('submitted') // cookie banner and self identification
    expect(statusOf(env, 'Northstar Logistics').status).toBe('submitted') // company site, apply modal
    expect(statusOf(env, 'Quanta Cloud').status).toBe('submitted') // two step company wizard
    expect(statusOf(env, 'BrightPath Learning').status).toBe('ready_to_submit') // indeed, review
    expect(statusOf(env, 'Atlas Retail').status).toBe('ready_to_submit') // linkedin easy apply, review
    expect(statusOf(env, 'NovaTech')).toMatchObject({
      status: 'needs_human',
      error: expect.stringContaining('led a team through conflict'),
    })
    expect(statusOf(env, 'Meridian Bank')).toMatchObject({
      status: 'needs_human',
      error: expect.stringContaining('sign in'),
    })
    expect(statusOf(env, 'ShadyCorp')).toMatchObject({
      status: 'needs_human',
      error: expect.stringContaining('verify you are human'),
    })

    // What the employer sites really received.
    const got = env.server.submissions
    expect(got.map((s) => s.company).sort()).toEqual([
      'Harbor Pay',
      'Lumen AI',
      'Northstar Logistics',
      'Quanta Cloud',
    ])
    for (const s of got) expect(Object.values(s.files)[0]?.filename).toBe('Alex_Tan_Resume.pdf')
    const harbor = got.find((s) => s.company === 'Harbor Pay')!
    expect(harbor.fields).toMatchObject({
      first_name: 'Alex',
      email: 'alex.tan@example.com',
      gender: 'decline to self-identify',
      ethnicity: 'decline to self-identify',
      work_auth: 'yes',
      sponsorship: 'no',
      location: 'Singapore',
    })

    // Artifacts on disk.
    const job = env.app.db
      .prepare(
        "SELECT id FROM jobs WHERE company = 'Lumen AI' AND id IN (SELECT job_id FROM applications WHERE status = 'submitted')",
      )
      .get() as { id: string }
    expect(existsSync(join(env.config.outputDir, 'resumes', job.id, 'Alex_Tan_Resume.pdf'))).toBe(
      true,
    )
    const record = JSON.parse(
      readFileSync(join(env.config.outputDir, 'applications', job.id, 'record.json'), 'utf8'),
    )
    expect(record.outcome.verify).toBe('pass')
    expect(record.outcome.fields.length).toBeGreaterThan(8)
    expect(JSON.stringify(record)).not.toMatch(/OPENROUTER|Bearer/)

    // The board, over MCP.
    const stage = (company: string) => board.apps.find((a) => a.company === company)?.stage
    expect(stage('Lumen AI')).toBe('Applied')
    expect(stage('Atlas Retail')).toBe('Wishlist')
    expect(board.apps.find((a) => a.company === 'ShadyCorp')?.nextAction).toMatch(/Finish by hand/)

    // Shadow runs found no field differences on the jobs that completed.
    const rep = buildReport(env.app.db, env.config)
    const shadow = rep.shadow.find((s) => s.backend === 'playwright-lean')!
    expect(shadow.runs).toBe(9)
    expect(shadow.compared).toBeGreaterThan(30)
    expect(rep.unanswered).toEqual(['Describe a time you led a team through conflict'])
  }, 180_000)

  it('does not apply twice when run again', async () => {
    const before = env.server.submissions.length
    const s = await env.app.orchestrator.run()
    expect(s.processed).toBe(0)
    expect(env.server.submissions.length).toBe(before)
  }, 60_000)

  it('recovers parked jobs after a sign in and a new saved answer', async () => {
    // Sign in to Workday once and save the session, as `pnpm cli login workday` would.
    const wd = await env.app.registry.launch('playwright-chromium', { headless: true })
    await wd.open(`${env.server.url}/wd/meridian/job/301`)
    const wall = await wd.formSchema()
    await wd.fill(wall.fields.find((f) => f.type === 'email')!.id, 'a@b.test')
    await wd.fill(wall.fields.find((f) => f.type === 'password')!.id, 'pw')
    await wd.click(wall.actions.find((a) => a.label === 'Sign In')!.id)
    await wd.saveState(join(env.config.sessionsDir, 'workday-meridian.json'))
    await wd.close()
    appendFileSync(
      join(env.config.profileDir, 'answers.md'),
      '\n## Describe a time you led a team through conflict\nI mediated a scope disagreement between a client and a designer and agreed clear deliverables.\n',
    )

    const app2 = await createApp(env.config, {
      boardFactory: (repo, file) =>
        new FallbackBoardLogger(new McpBoardLogger(board.client, repo), file, repo),
    })
    try {
      for (const company of ['Meridian Bank', 'NovaTech']) {
        const row = app2.db.prepare('SELECT id FROM jobs WHERE company = ?').get(company) as {
          id: string
        }
        app2.orchestrator.retry(row.id)
      }
      await app2.orchestrator.run()
      const st = (c: string) =>
        (
          app2.db
            .prepare(
              'SELECT a.status FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.company = ?',
            )
            .get(c) as { status: string }
        ).status
      expect(st('Meridian Bank')).toBe('ready_to_submit') // workday is review
      expect(st('NovaTech')).toBe('submitted')
      const nova = env.server.submissions.find((s) => s.company === 'NovaTech')!
      expect(nova.fields.conflict).toContain('mediated a scope disagreement')

      // Workday's resume parser overwrote name and phone after upload. The final values are the intended ones.
      const mer = app2.db.prepare("SELECT id FROM jobs WHERE company = 'Meridian Bank'").get() as {
        id: string
      }
      const rec = JSON.parse(
        readFileSync(join(env.config.outputDir, 'applications', mer.id, 'record.json'), 'utf8'),
      )
      const first = rec.outcome.fields.find((f: { label: string }) => f.label === 'First Name')
      expect(first).toMatchObject({ actual: 'Alex', status: 'ok' })
      expect(rec.outcome.steps).toBe(4)
    } finally {
      await app2.close()
    }
  }, 120_000)
})

describe('policy gate, caps and fallback', () => {
  it('does not auto submit while the gate is enforced', async () => {
    const env = await makeEnv((c) => ({ ...c, gate: { ...c.gate, enforce: true } }))
    try {
      await intake(env, ['indeed'])
      await env.app.orchestrator.run()
      expect(env.server.submissions).toHaveLength(0)
      expect(statusOf(env, 'Lumen AI').status).toBe('ready_to_submit')
      const evt = env.app.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'policy_downgraded'")
        .get() as { n: number }
      expect(evt.n).toBeGreaterThanOrEqual(2)
    } finally {
      await env.close()
    }
  }, 120_000)

  it('defers jobs past the daily cap and finishes them the next day', async () => {
    const env = await makeEnv((c) => ({
      ...c,
      workers: 1,
      sites: { ...c.sites, greenhouse: { ...c.sites.greenhouse, dailyCap: 1 } },
    }))
    try {
      await intake(env, ['indeed'])
      const s = await env.app.orchestrator.run()
      expect(s.deferred).toBe(1)
      expect(env.server.submissions).toHaveLength(1)
      expect(['Lumen AI', 'Harbor Pay'].map((c) => statusOf(env, c).status).sort()).toEqual([
        'ready',
        'submitted',
      ])
    } finally {
      await env.close()
    }
  }, 120_000)

  it('manual policy never opens the form', async () => {
    const env = await makeEnv((c) => ({
      ...c,
      sites: { ...c.sites, greenhouse: { ...c.sites.greenhouse, submit: 'manual' as const } },
    }))
    try {
      await intake(env, ['indeed'])
      await env.app.orchestrator.run()
      expect(statusOf(env, 'Lumen AI')).toMatchObject({
        status: 'needs_human',
        error: expect.stringContaining('manual'),
      })
      expect(env.server.submissions).toHaveLength(0)
    } finally {
      await env.close()
    }
  }, 120_000)

  it('falls back to Chromium when the primary backend cannot start', async () => {
    const env = await makeEnv((c) => ({
      ...c,
      sites: {
        ...c.sites,
        greenhouse: {
          ...c.sites.greenhouse,
          backend: 'ai-browser',
          fallback: 'playwright-chromium',
        },
      },
    }))
    try {
      await intake(env, ['indeed'])
      await env.app.orchestrator.run()
      expect(statusOf(env, 'Lumen AI').status).toBe('submitted')
      const m = env.app.db
        .prepare(
          "SELECT backend FROM metrics m JOIN jobs j ON j.id = m.job_id WHERE j.company = 'Lumen AI' AND m.outcome = 'submitted'",
        )
        .get() as { backend: string }
      expect(m.backend).toBe('playwright-chromium')
      const e = env.app.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'backend_error'")
        .get() as { n: number }
      expect(e.n).toBeGreaterThanOrEqual(1)
    } finally {
      await env.close()
    }
  }, 120_000)

  it('fails a job when no backend works and keeps going with the rest', async () => {
    const env = await makeEnv((c) => ({
      ...c,
      sites: {
        ...c.sites,
        greenhouse: { ...c.sites.greenhouse, backend: 'ai-browser', fallback: 'also-missing' },
      },
    }))
    try {
      await intake(env, ['indeed'])
      await env.app.orchestrator.run()
      expect(['failed', 'ready']).toContain(statusOf(env, 'Lumen AI').status)
      expect(statusOf(env, 'BrightPath Learning').status).toBe('ready_to_submit')
    } finally {
      await env.close()
    }
  }, 120_000)
})
