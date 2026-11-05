import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { careersUrlProblem, parseCareersUrl } from '../src/intake/careers-url'
import { runIntake } from '../src/intake'
import type { FetchLike } from '../src/intake/watchlist'
import { loadProfileFromDir as loadProfile } from '../src/profile/fs'
import { parseSettings, type UserSettings } from '../src/settings'
import type { Job } from '../src/shared/job'
import type { JobStore } from '../src/store'

// Demo profile: titles AI Engineer, Software Engineer, Backend Developer, Software Developer;
// location Singapore; excludes Senior Manager, Director, Intern.
const profile = loadProfile(resolve(__dirname, '../../../demo/profile'))

describe('parseCareersUrl', () => {
  it.each([
    ['https://job-boards.greenhouse.io/stripe', { kind: 'greenhouse', slug: 'stripe' }],
    ['https://boards.greenhouse.io/stripe/jobs/123', { kind: 'greenhouse', slug: 'stripe' }],
    ['https://boards-api.greenhouse.io/v1/boards/okx/jobs', { kind: 'greenhouse', slug: 'okx' }],
    ['https://jobs.lever.co/palantir', { kind: 'lever', slug: 'palantir', eu: false }],
    ['https://jobs.eu.lever.co/acme/abc', { kind: 'lever', slug: 'acme', eu: true }],
    ['https://jobs.ashbyhq.com/openai', { kind: 'ashby', slug: 'openai' }],
    [
      'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/x',
      {
        kind: 'workday',
        origin: 'https://nvidia.wd5.myworkdayjobs.com',
        tenant: 'nvidia',
        site: 'NVIDIAExternalCareerSite',
      },
    ],
  ])('%s', (url, expected) => {
    expect(parseCareersUrl(url)).toEqual(expected)
  })

  it.each([
    'https://careers.example.com/jobs',
    'https://job-boards.greenhouse.io/',
    'https://nvidia.wd5.myworkdayjobs.com/en-US',
    'ftp://jobs.lever.co/x',
    'not a url',
  ])('rejects %s', (url) => {
    expect(parseCareersUrl(url)).toBeNull()
    expect(careersUrlProblem(url)).toContain('is not a Greenhouse, Lever, Ashby or Workday')
  })

  it('settings reject unsupported careers pages with a readable issue', () => {
    const r = parseSettings({ watchlist: { companies: ['https://careers.example.com'] } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues[0]).toMatch(/^watchlist\.companies: .*careers\.example\.com/)
    expect(parseSettings({}).ok && parseSettings({})).toMatchObject({
      settings: { watchlist: { enabled: true, companies: [], maxPerCompany: 10 } },
    })
  })
})

/** The job APIs, answering from canned data. Records every request. */
function fakeApis() {
  const calls: string[] = []
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetch: FetchLike = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    const u = new URL(url)
    if (u.host === 'boards-api.greenhouse.io') {
      if (u.pathname === '/v1/boards/acme') return json({ name: 'Acme Corp' })
      if (u.pathname === '/v1/boards/acme/jobs')
        return json({
          jobs: [
            {
              id: 1,
              title: 'AI Engineer',
              location: { name: 'Singapore' },
              content: '&lt;p&gt;Build &lt;b&gt;LLM&lt;/b&gt; agents in Python&lt;/p&gt;',
              updated_at: '2026-10-01T00:00:00Z',
            },
            { id: 2, title: 'AI Engineer', location: { name: 'London' }, content: '' },
            { id: 3, title: 'Account Executive', location: { name: 'Singapore' }, content: '' },
            { id: 4, title: 'Software Engineer Intern', location: { name: 'Singapore' } },
          ],
        })
      return json({}, 404)
    }
    if (u.host === 'api.lever.co' && u.pathname === '/v0/postings/beta-labs')
      return json([
        {
          id: 'l1',
          text: 'Backend Developer',
          categories: { location: 'Singapore', allLocations: ['Singapore'] },
          hostedUrl: 'https://jobs.lever.co/beta-labs/l1',
          applyUrl: 'https://jobs.lever.co/beta-labs/l1/apply',
          descriptionPlain: 'Node.js and PostgreSQL',
          createdAt: Date.UTC(2026, 9, 2),
        },
      ])
    if (u.host === 'api.ashbyhq.com' && u.pathname === '/posting-api/job-board/gamma')
      return json({
        jobs: [
          {
            title: 'Software Engineer',
            location: 'Tokyo',
            secondaryLocations: [{ location: 'Singapore' }],
            isListed: true,
            jobUrl: 'https://jobs.ashbyhq.com/gamma/a1',
            applyUrl: 'https://jobs.ashbyhq.com/gamma/a1/application',
            descriptionPlain: 'TypeScript',
          },
          {
            // Flagged remote, but the place is San Francisco: not a Singapore job.
            title: 'Backend Developer',
            location: 'San Francisco',
            isRemote: true,
            jobUrl: 'https://jobs.ashbyhq.com/gamma/a3',
          },
          {
            title: 'Software Developer',
            location: 'Singapore',
            isListed: false,
            jobUrl: 'https://jobs.ashbyhq.com/gamma/a2',
          },
        ],
      })
    if (u.host === 'delta.wd3.myworkdayjobs.com') {
      if (u.pathname === '/wday/cxs/delta/Careers/jobs')
        return json({
          jobPostings: [
            {
              title: 'AI Engineer',
              externalPath: '/job/SG/AI-Engineer_R1',
              locationsText: '2 Locations',
            },
            {
              title: 'Payroll Specialist',
              externalPath: '/job/SG/Payroll_R2',
              locationsText: 'Singapore',
            },
          ],
        })
      if (u.pathname === '/wday/cxs/delta/Careers/job/SG/AI-Engineer_R1')
        return json({
          jobPostingInfo: {
            jobDescription: '<p>RAG and LangChain</p>',
            location: 'Singapore, One North',
            country: { descriptor: 'Singapore' },
          },
        })
    }
    return json({}, 404)
  }
  return { fetch, calls }
}

/** Just enough of a job store for intake. */
function memoryStore() {
  const jobs = new Map<string, { job: Job; status: string }>()
  const store = {
    async addJob(job: Job, status = 'queued') {
      if (jobs.has(job.id)) return false
      jobs.set(job.id, { job, status })
      return true
    },
    async getJob(id: string) {
      return jobs.get(id) as never
    },
    async findDuplicate(j: Pick<Job, 'applyUrl'>) {
      return [...jobs.values()].find((r) => r.job.applyUrl === j.applyUrl)?.job.id
    },
  } as unknown as JobStore
  return { store, jobs }
}

const settingsWith = (watchlist: Partial<UserSettings['watchlist']>): UserSettings => {
  const r = parseSettings({ watchlist })
  if (!r.ok) throw new Error(r.issues.join('; '))
  return r.settings
}

const COMPANIES = [
  'https://job-boards.greenhouse.io/acme',
  'https://jobs.lever.co/beta-labs',
  'https://jobs.ashbyhq.com/gamma',
  'https://delta.wd3.myworkdayjobs.com/en-US/Careers',
]

const intake = (settings: UserSettings, api: ReturnType<typeof fakeApis>, store: JobStore) =>
  runIntake({
    settings,
    profile,
    store,
    registry: {} as never, // no board is searched, so no browser is launched
    sessions: {} as never,
    sources: ['company'],
    fetch: api.fetch,
  })

describe('company watchlist intake', () => {
  it('reads each hiring system, filters like a board search and queues the matches', async () => {
    const api = fakeApis()
    const { store, jobs } = memoryStore()
    const s = await intake(settingsWith({ companies: COMPANIES }), api, store)

    expect(s.errors).toEqual([])
    expect(s.perSource.company).toEqual({ found: 9, queued: 4 })
    expect(s.skipped).toMatchObject({ title_mismatch: 2, excluded_title: 1, location_mismatch: 2 })

    const byCompany = Object.fromEntries([...jobs.values()].map((r) => [r.job.company, r.job]))
    expect(byCompany['Acme Corp']).toMatchObject({
      source: 'company',
      title: 'AI Engineer',
      location: 'Singapore',
      description: 'Build LLM agents in Python',
      applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/1',
      applyTarget: 'greenhouse',
    })
    expect(byCompany['Beta Labs']).toMatchObject({
      applyUrl: 'https://jobs.lever.co/beta-labs/l1/apply',
      applyTarget: 'company_site',
      postedAt: '2026-10-02T00:00:00.000Z',
    })
    // Every listed place counts. Unlisted jobs are ignored.
    expect(byCompany['Gamma']).toMatchObject({
      location: 'Tokyo; Singapore',
      applyTarget: 'company_site',
    })
    // Workday: searched per title, details loaded only for the title match.
    expect(byCompany['Delta']).toMatchObject({
      location: 'Singapore, One North; Singapore',
      description: 'RAG and LangChain',
      applyTarget: 'workday',
    })
    expect(api.calls.filter((c) => c.includes('/job/SG/'))).toEqual([
      'GET https://delta.wd3.myworkdayjobs.com/wday/cxs/delta/Careers/job/SG/AI-Engineer_R1',
    ])
    expect(api.calls.filter((c) => c.startsWith('POST'))).toHaveLength(profile.titles.titles.length)
    // Only queued jobs are saved: a company lists hundreds that do not match.
    expect([...jobs.values()].every((r) => r.status === 'queued')).toBe(true)
  })

  it('finds nothing new the second time and saves nothing on a dry run', async () => {
    const { store, jobs } = memoryStore()
    const settings = settingsWith({ companies: COMPANIES })
    await intake(settings, fakeApis(), store)
    const again = await intake(settings, fakeApis(), store)
    expect(again.queued).toBe(0)
    expect(again.skipped.already_seen).toBe(4)
    expect(jobs.size).toBe(4)

    const dry = memoryStore()
    const r = await runIntake({
      settings,
      profile,
      store: dry.store,
      registry: {} as never,
      sessions: {} as never,
      sources: ['company'],
      fetch: fakeApis().fetch,
      dryRun: true,
    })
    expect(r.queued).toBe(4)
    expect(dry.jobs.size).toBe(0)
  })

  it('caps new jobs per company and reports a missing board without stopping the others', async () => {
    const { store } = memoryStore()
    const s = await intake(
      settingsWith({
        companies: ['https://job-boards.greenhouse.io/nobody', 'https://jobs.lever.co/beta-labs'],
        maxPerCompany: 1,
      }),
      fakeApis(),
      store,
    )
    expect(s.errors).toEqual([
      'company: Greenhouse https://job-boards.greenhouse.io/nobody: Greenhouse has no job board "nobody". Check the link.',
    ])
    expect(s.queued).toBe(1)
  })

  it('is skipped when turned off, and a board-only search leaves it out', async () => {
    const api = fakeApis()
    const { store } = memoryStore()
    await intake(settingsWith({ companies: COMPANIES, enabled: false }), api, store)
    await runIntake({
      settings: settingsWith({ companies: COMPANIES }),
      profile,
      store,
      registry: {} as never,
      sessions: {} as never,
      sources: [],
      fetch: api.fetch,
    })
    expect(api.calls).toEqual([])
  })
})
