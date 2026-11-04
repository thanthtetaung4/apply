import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appendAnswer,
  parseProfile,
  PROFILE_KINDS,
  PROFILE_TEMPLATES,
  ProfileError,
  validateProfileFile,
} from '../src/profile'
import { readProfileTexts } from '../src/profile/fs'

const DEMO = resolve(__dirname, '../../../demo/profile')

describe('parseProfile', () => {
  it('parses the starter templates and the demo profile', () => {
    expect(parseProfile(PROFILE_TEMPLATES).contact.name).toBe('Your Name')
    const demo = parseProfile(readProfileTexts(DEMO))
    expect(demo.contact.name).toBe('Alex Tan')
    expect(demo.answerBank.size).toBeGreaterThan(0)
  })

  it('lists every empty required file', () => {
    try {
      parseProfile({ answers: '' })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(ProfileError)
      expect((err as ProfileError).issues.map((i) => i.file)).toEqual([
        'resume.md',
        'titles.md',
        'projects.md',
      ])
    }
  })
})

describe('validateProfileFile', () => {
  it('accepts every starter template with a summary', () => {
    for (const kind of PROFILE_KINDS) {
      const v = validateProfileFile(kind, PROFILE_TEMPLATES[kind])
      expect(v, kind).toMatchObject({ ok: true, issues: [] })
      expect(v.summary.length, kind).toBeGreaterThan(0)
    }
  })

  it('reports problems in a single file', () => {
    expect(validateProfileFile('projects', '## Broken\n').issues.join()).toMatch(/Stack/)
    expect(validateProfileFile('resume', '').ok).toBe(false)
    expect(validateProfileFile('answers', '').ok).toBe(true)
    const bad = validateProfileFile(
      'resume',
      PROFILE_TEMPLATES.resume.replace('you@example.com', 'nope'),
    )
    expect(bad.ok).toBe(false)
  })
})

describe('appendAnswer', () => {
  it('appends a new question that the answer bank then matches', () => {
    const next = appendAnswer(PROFILE_TEMPLATES.answers, 'Years of React experience?', '3')
    expect(validateProfileFile('answers', next).ok).toBe(true)
    const p = parseProfile({ ...PROFILE_TEMPLATES, answers: next })
    expect(p.answerBank.match('Years of React experience?')?.answer).toBe('3')
  })

  it('replaces the answer when the question is already there', () => {
    const once = appendAnswer('', 'Expected salary', 'Negotiable')
    const twice = appendAnswer(once, 'expected  salary', 'SGD 6000')
    expect(twice.match(/## /g)).toHaveLength(1)
    expect(twice).toContain('SGD 6000')
    expect(twice).not.toContain('Negotiable')
    expect(validateProfileFile('answers', twice).ok).toBe(true)
  })

  it('keeps pipes, headings and blanks from breaking the file', () => {
    const next = appendAnswer('', 'A | B', '# not a heading')
    expect(next).toContain('## A / B\n')
    expect(validateProfileFile('answers', next).ok).toBe(true)
    expect(() => appendAnswer('', 'Q', '  ')).toThrow(/empty/)
  })
})
