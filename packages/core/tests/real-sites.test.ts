import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { mapField, pickOption } from '../src/apply/fields'
import { isBlockedPage } from '../src/apply/recipes'
import type { FormField } from '../src/browser/types'
import { loadProfileFromDir } from '../src/profile/fs'
import { classifyApplyTarget } from '../src/intake/classify'
import { parseJobPage } from '../src/intake/parse'

// Shapes seen on the live sites on 2026-11-04 (search only, signed out, from Singapore).

describe('pages from the real boards', () => {
  it('recognises bot protection pages and leaves normal pages alone', () => {
    expect(
      isBlockedPage({
        title: 'Blocked - Indeed.com',
        text: 'Find jobs Request Blocked You have been blocked. If you believe this in error...',
      }),
    ).toBe(true)
    expect(
      isBlockedPage({
        title: 'Just a moment...',
        text: 'Humans only Glassdoor has been built on the contributions of real employees',
      }),
    ).toBe(true)
    expect(
      isBlockedPage({
        title: 'AI Engineer Jobs in Singapore (3,000+ Open Roles) | LinkedIn',
        text: 'Skip to main content LinkedIn Jobs Sign in Join now 3,000+ AI Engineer Jobs',
      }),
    ).toBe(false)
    expect(isBlockedPage({ title: 'Blockchain Engineer at Acme', text: 'Apply now' })).toBe(false)
  })

  it('reads the company from a LinkedIn page title when there is no JSON-LD', () => {
    const html = `<html><head><title>AI Engineer--Conversational AI at Arros AI — Singapore | LinkedIn Jobs</title></head>
      <body><h1>AI Engineer--Conversational AI</h1><main>Arros AI Singapore Apply</main></body></html>`
    expect(parseJobPage(html, 'https://sg.linkedin.com/jobs/view/1')).toMatchObject({
      title: 'AI Engineer--Conversational AI',
      company: 'Arros AI',
    })
  })

  it('treats country subdomains of the board as the board itself', () => {
    expect(classifyApplyTarget('https://sg.linkedin.com/jobs/view/1', 'www.linkedin.com')).toBe(
      'board_native',
    )
    expect(classifyApplyTarget('https://www.linkedin.com/jobs/view/1', 'www.linkedin.com')).toBe(
      'board_native',
    )
    expect(classifyApplyTarget('https://notlinkedin.com/jobs/1', 'www.linkedin.com')).toBe(
      'company_site',
    )
    expect(classifyApplyTarget('https://careers.acme.com/1', 'www.linkedin.com')).toBe(
      'company_site',
    )
  })
})

describe('mapping real form labels (GitLab and Databricks Greenhouse, Palantir Lever)', () => {
  const profile = loadProfileFromDir(resolve(__dirname, '../../../demo/profile'))
  const map = (label: string, type: FormField['type'] = 'text') =>
    mapField({ id: 'x', label, type, required: true }, { profile, resumePath: 'r.pdf' })

  it('does not answer questions that merely contain "location" or "current employer"', () => {
    const sponsorship = map(
      'Will you now or in the future require sponsorship for a visa to remain in your current location?',
    )
    expect(sponsorship).not.toMatchObject({ kind: 'fill', value: 'Singapore' })
    expect(
      map(
        'Are you subject to any employment agreements and/or post-employment restrictions with your current employer or a past employer?',
      ),
    ).toEqual({ kind: 'unresolved' })
  })

  it('still fills plain field names', () => {
    expect(map('Location (City)')).toMatchObject({ kind: 'fill', value: 'Singapore' })
    expect(map('Current company')).toMatchObject({ kind: 'fill', value: 'Acme Analytics' })
    expect(map('Where are you based?')).toMatchObject({ kind: 'fill', value: 'Singapore' })
    expect(map('Website')).toMatchObject({ kind: 'fill' })
    expect(map('First Name')).toMatchObject({ kind: 'fill', value: 'Alex' })
    expect(map('LinkedIn Profile')).toMatchObject({ kind: 'fill' })
  })
})

describe('choosing among real dropdown options', () => {
  it('never guesses between several options that start with the answer', () => {
    const sponsorship = [
      'No',
      'Yes, Netherlands Highly Skilled Migrant Visa',
      'Yes, Ireland Highly Skilled Worker Visa',
      'Yes, EU Blue Card',
      'Yes, but not one of the visas listed here',
    ]
    expect(pickOption(sponsorship, 'Yes')).toBeNull()
    expect(pickOption(sponsorship, 'No')).toBe('No')
    expect(pickOption(sponsorship, 'Yes, EU Blue Card')).toBe('Yes, EU Blue Card')
    const worked = ['No', 'Yes - I currently work at Databricks', 'Yes - Previous Intern']
    expect(pickOption(worked, 'Yes')).toBeNull()
    expect(pickOption(['Yes', 'No'], 'yes')).toBe('Yes')
    expect(pickOption(['Singapore', 'Slovakia'], 'Sing')).toBe('Singapore')
  })
})

describe('file fields on real forms', () => {
  const profile = loadProfileFromDir(resolve(__dirname, '../../../demo/profile'))
  const file = (label: string, required = false) =>
    mapField({ id: 'f', label, type: 'file', required }, { profile, resumePath: 'r.pdf' })

  it('uploads the resume to resume fields but never to an autofill box', () => {
    expect(file('Resume/CV', true)).toEqual({ kind: 'fill', value: 'r.pdf', source: 'rule' })
    expect(file('Resume', true)).toMatchObject({ kind: 'fill' })
    expect(file('Autofill from resume')).toMatchObject({ kind: 'skip' })
    expect(file('Cover Letter')).toMatchObject({ kind: 'skip' })
  })
})
