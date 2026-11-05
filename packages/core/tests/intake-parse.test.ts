import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyApplyTarget } from '../src/intake/classify'
import { matchScore, skipReasonFor, titleScore } from '../src/intake/filter'
import { parseJobPage, parseSearchLinks } from '../src/intake/parse'
import { MOCK_TARGET_RULES } from '../src/demo/mock-server'
import { loadProfileFromDir as loadProfile } from '../src/profile/fs'

const profile = loadProfile(resolve(__dirname, '../../../demo/profile'))

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
    expect(skipReasonFor({ title: 'AI Engineer', location: 'Singapore' }, profile)).toBeNull()
    expect(
      skipReasonFor({ title: 'AI Engineer', location: 'Singapore; US-Remote' }, profile),
    ).toBeNull()
  })

  it('counts remote jobs only when Remote is one of your locations', () => {
    // The demo profile lists Singapore only.
    for (const location of ['Remote, EU', 'US-Remote', 'Remote in Canada', 'Remote'])
      expect(skipReasonFor({ title: 'AI Engineer', location }, profile)).toBe('location_mismatch')
    const remoteToo = {
      ...profile,
      titles: { ...profile.titles, locations: ['Singapore', 'Remote'] },
    }
    expect(skipReasonFor({ title: 'AI Engineer', location: 'Remote, EU' }, remoteToo)).toBeNull()
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
