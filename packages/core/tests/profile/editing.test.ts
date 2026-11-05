import { describe, expect, it } from 'vitest'
import {
  appendAnswer,
  parseProfile,
  PROFILE_TEMPLATES,
  validateProfileFile,
} from '../../src/profile'

describe('profile templates', () => {
  it('parse into a valid profile as shipped', () => {
    const p = parseProfile(PROFILE_TEMPLATES)
    expect(p.contact.name).toBe('Your Name')
    expect(p.answers.length).toBeGreaterThan(3)
  })
})

describe('validateProfileFile', () => {
  it('summarises a good file and flags problems in a bad one', () => {
    const ok = validateProfileFile('resume', PROFILE_TEMPLATES.resume)
    expect(ok.ok).toBe(true)
    expect(ok.summary[0]).toBe('1 roles, 2 bullets')

    const bad = validateProfileFile(
      'resume',
      '# Profile\nName: X\n# Experience\n## Broken header\n- a\n',
    )
    expect(bad.ok).toBe(false)
    expect(bad.issues.join(' ')).toMatch(/Email/)
    expect(bad.issues.join(' ')).toMatch(/Company \| Role \| Start - End/)
  })

  it('treats an empty answers file as fine and an empty resume as an error', () => {
    expect(validateProfileFile('answers', '').ok).toBe(true)
    expect(validateProfileFile('resume', ' ').ok).toBe(false)
  })

  it('validates titles, projects and answers on their own', () => {
    expect(validateProfileFile('titles', '# Keywords\n- a\n').issues[0]).toMatch(/Titles/)
    expect(validateProfileFile('projects', '## P\nSome text\n').issues.join()).toMatch(/Stack/)
    expect(validateProfileFile('answers', '## Q\n').issues.join()).toMatch(/no answer/)
  })
})

describe('appendAnswer', () => {
  it('adds a new heading and the profile still parses', () => {
    const next = appendAnswer(
      PROFILE_TEMPLATES.answers,
      'Describe a time you led a team',
      'I led a project.',
    )
    expect(next).toContain('## Describe a time you led a team\nI led a project.')
    const p = parseProfile({ ...PROFILE_TEMPLATES, answers: next })
    expect(p.answerBank.match('Describe a time you led a team')?.answer).toBe('I led a project.')
  })

  it('starts a new file and refuses empty or heading-like input', () => {
    expect(appendAnswer('', 'Q?', 'A')).toBe('# Answers\n\n## Q?\nA\n')
    expect(() => appendAnswer('', ' ', 'A')).toThrow(/question/)
    expect(() => appendAnswer('', 'Q', '')).toThrow(/answer/)
    expect(() => appendAnswer('', 'Q', '# hack')).toThrow(/headings/)
  })

  it('cleans a question that looks like a heading', () => {
    expect(appendAnswer('', '## Q?  \n', 'A')).toContain('\n## Q?\nA')
  })
})
