import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { classifyApplyTarget } from '../src/intake/classify'
import { matchScore, skipReasonFor, titleScore } from '../src/intake/filter'
import { runIntake } from '../src/intake'
import { parseJobPage, parseSearchLinks } from '../src/intake/parse'
import { MOCK_TARGET_RULES } from '../src/demo/mock-server'
import { loadProfile } from '../src/profile'
import { makeEnv, type TestEnv } from './helpers/env'

const profile = loadProfile(resolve(__dirname, '../demo/profile'))

describe('classifyApplyTarget', () => {
  it.each([
    ['https://boards.greenhouse.io/acme/jobs/1', 'greenhouse'],
    ['https://job-boards.greenhouse.io/acme/jobs/1', 'greenhouse'],
    ['https://meridian.wd3.myworkdayjobs.com/en-US/careers/job/x', 'workday'],
    ['https://careers.example.com/jobs/12', 'company_site'],
    ['https://www.linkedin.com/jobs/view/123', 'board_native'],
    ['not a url', 'company_site'],
  ] as const)('%s is %s', (url, expected) => {
    expect(classifyApplyTarget(url, 'www.linkedin.com')).toBe(expected)
  })

  it('applies extra rules first', () => {
    expect(
      classifyApplyTarget('http://127.0.0.1:1/gh/x/jobs/1', '127.0.0.1', MOCK_TARGET_RULES),
    ).toBe('greenhouse')
  })
})

describe('parseJobPage', () => {
  it('reads schema.org JobPosting data, including @graph and html descriptions', () => {
    const html = `<html><body><h1>ignored</h1><script type="application/ld+json">${JSON.stringify({
      '@graph': [
        { '@type': 'WebPage' },
        {
          '@type': 'JobPosting',
          title: 'AI Engineer',
          description: '<p>Build <b>LLM</b> apps</p>',
          hiringOrganization: { name: 'Acme' },
          jobLocation: [{ address: { addressLocality: 'Singapore' } }],
          datePosted: '2026-10-01',
        },
      ],
    })}</script><a href="https://careers.acme.test/apply/1">Apply on company site</a></body></html>`
    const j = parseJobPage(html, 'https://board.test/jobs/1')
    expect(j).toMatchObject({
      title: 'AI Engineer',
      company: 'Acme',
      location: 'Singapore',
      description: 'Build LLM apps',
      postedAt: '2026-10-01',
      externalApplyUrl: 'https://careers.acme.test/apply/1',
      hasEasyApplyButton: false,
    })
  })

  it('falls back to page markup and detects Easy Apply and board apply links', () => {
    const html = `<main><h1>Backend Dev</h1><span class="company">Beta</span><p>Node.js role</p>
      <button type="button">Easy Apply</button><a href="/apply/9">Apply now</a><a href="https://board.test/jobs/2">Apply on company site</a></main>`
    const j = parseJobPage(html, 'https://board.test/jobs/1')
    expect(j.title).toBe('Backend Dev')
    expect(j.company).toBe('Beta')
    expect(j.hasEasyApplyButton).toBe(true)
    expect(j.boardApplyUrl).toBe('https://board.test/apply/9')
    expect(j.externalApplyUrl).toBeUndefined() // same host, so not an employer redirect
  })

  it('survives broken JSON-LD', () => {
    const j = parseJobPage(
      '<h1>T</h1><script type="application/ld+json">{oops</script><span class="company">C</span>',
      'https://b.test/',
    )
    expect(j).toMatchObject({ title: 'T', company: 'C' })
  })

  it('extracts, resolves and dedupes search links', () => {
    const html =
      '<a href="/jobs/view/1">a</a><a href="/jobs/view/1">dup</a><a href="/jobs/view/2">b</a><a href="/other">x</a>'
    expect(parseSearchLinks(html, 'https://b.test/search', 'a[href*="/jobs/view/"]', 10)).toEqual([
      'https://b.test/jobs/view/1',
      'https://b.test/jobs/view/2',
    ])
    expect(
      parseSearchLinks(html, 'https://b.test/search', 'a[href*="/jobs/view/"]', 1),
    ).toHaveLength(1)
  })
})

describe('filters', () => {
  it('scores titles and skips excluded, off topic and out of area jobs', () => {
    expect(titleScore('Software Engineer (AI Platform)', ['Software Engineer'])).toBe(1)
    expect(titleScore('Sales Representative', profile.titles.titles)).toBe(0)
    expect(
      skipReasonFor({ title: 'Senior Manager, Engineering', location: 'Singapore' }, profile),
    ).toBe('excluded_title')
    expect(skipReasonFor({ title: 'Sales Representative' }, profile)).toBe('title_mismatch')
    expect(skipReasonFor({ title: 'AI Engineer', location: 'Berlin' }, profile)).toBe(
      'location_mismatch',
    )
    expect(skipReasonFor({ title: 'AI Engineer', location: 'Remote, EU' }, profile)).toBeNull()
    expect(skipReasonFor({ title: 'AI Engineer', location: 'Singapore' }, profile)).toBeNull()
  })

  it('gives a higher match score when the job asks for what you have', () => {
    const good = matchScore(
      { title: 'AI Engineer', description: 'Python, TypeScript, LLM and PostgreSQL' },
      profile,
    )
    const bad = matchScore(
      { title: 'AI Engineer', description: 'Kubernetes, Terraform, Java and Kafka' },
      profile,
    )
    expect(good).toBeGreaterThan(bad)
    expect(good).toBeLessThanOrEqual(100)
  })
})

describe('runIntake against the mock boards', () => {
  let env: TestEnv
  beforeAll(async () => {
    env = await makeEnv()
  }, 60_000)
  afterAll(async () => env.close())

  const deps = () => ({
    config: env.config,
    registry: env.app.registry,
    profile: env.app.profile,
    repo: env.app.repo,
    targetRules: MOCK_TARGET_RULES,
  })

  it('queues good jobs, classifies targets and records why others were skipped', async () => {
    const s = await runIntake(deps())
    expect(s.errors).toEqual([])
    expect(s.found).toBe(12)
    expect(s.queued).toBe(9)
    expect(s.skipped).toMatchObject({ excluded_title: 1, title_mismatch: 1, duplicate: 1 })

    const byCompany = (c: string) =>
      env.app.db
        .prepare(
          'SELECT apply_target, apply_url FROM jobs j JOIN applications a ON a.job_id = j.id WHERE company = ? AND a.status = ?',
        )
        .get(c, 'queued') as { apply_target: string; apply_url: string }
    expect(byCompany('Lumen AI').apply_target).toBe('greenhouse')
    expect(byCompany('Meridian Bank').apply_target).toBe('workday')
    expect(byCompany('Northstar Logistics').apply_target).toBe('company_site')
    expect(byCompany('Atlas Retail').apply_target).toBe('board_native') // Easy Apply stays on the board
    expect(byCompany('Atlas Retail').apply_url).toContain('/linkedin/jobs/view/')
    expect(byCompany('BrightPath Learning').apply_url).toContain('/indeed/apply/')
  })

  it('does nothing the second time', async () => {
    const s = await runIntake(deps())
    expect(s.queued).toBe(0)
    expect(s.skipped.already_seen).toBe(12)
  })

  it('dry run saves nothing', async () => {
    const e2 = await makeEnv()
    try {
      const s = await runIntake({
        ...deps(),
        config: e2.config,
        registry: e2.app.registry,
        profile: e2.app.profile,
        repo: e2.app.repo,
        dryRun: true,
      })
      expect(s.queued).toBe(9)
      expect(e2.app.repo.counts()).toEqual([])
    } finally {
      await e2.close()
    }
  }, 60_000)

  it('isolates a failing source', async () => {
    const e2 = await makeEnv((c) => ({
      ...c,
      sources: { ...c.sources, indeed: { ...c.sources.indeed, baseUrl: 'http://127.0.0.1:1' } },
    }))
    try {
      const s = await runIntake({
        config: e2.config,
        registry: e2.app.registry,
        profile: e2.app.profile,
        repo: e2.app.repo,
        targetRules: MOCK_TARGET_RULES,
      })
      expect(s.errors.join()).toMatch(/indeed/)
      expect(s.perSource.linkedin!.queued + s.perSource.glassdoor!.queued).toBeGreaterThan(0)
    } finally {
      await e2.close()
    }
  }, 60_000)
})
