import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProfileError } from '../src/profile'
import { loadProfileFromDir as loadProfile } from '../src/profile/fs'

const FIXTURE = resolve(__dirname, 'fixtures/profile')

function copyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'apply-profile-'))
  cpSync(FIXTURE, dir, { recursive: true })
  return dir
}

function edit(dir: string, file: string, fn: (s: string) => string): void {
  const path = join(dir, file)
  writeFileSync(path, fn(readFileSync(path, 'utf8')))
}

function issuesOf(dir: string): string[] {
  try {
    loadProfile(dir)
  } catch (err) {
    if (err instanceof ProfileError) return err.issues.map((i) => `${i.file}: ${i.message}`)
    throw err
  }
  return []
}

describe('loadProfile (valid fixture)', () => {
  const profile = loadProfile(FIXTURE)

  it('parses contact, links and summary', () => {
    expect(profile.contact.name).toBe('Alex Tan')
    expect(profile.contact.email).toBe('alex.tan@example.com')
    expect(profile.contact.links).toHaveLength(2)
    expect(profile.contact.links[0]).toEqual({ label: 'GitHub', url: 'https://github.com/alextan' })
    expect(profile.contact.summary).toContain('backend systems')
  })

  it('parses experience with joined continuation lines', () => {
    expect(profile.experience).toHaveLength(2)
    const first = profile.experience[0]!
    expect(first).toMatchObject({ company: 'Acme Analytics', start: 'Jun 2024', end: 'Present' })
    expect(first.bullets).toHaveLength(3)
    expect(first.bullets[2]!.text).toBe(
      'Extended the evaluation framework into a 100+ scenario regression suite. Maintained by the whole team.',
    )
  })

  it('parses education, skills, certifications', () => {
    expect(profile.education[0]).toMatchObject({
      institution: 'Example University',
      start: '2020',
      end: '2023',
    })
    expect(profile.skills.map((s) => s.category)).toEqual(['Languages', 'Backend', 'AI'])
    expect(profile.skills[0]!.skills).toEqual(['TypeScript', 'Python', 'SQL'])
    expect(profile.certifications).toEqual(['AWS Certified Cloud Practitioner'])
  })

  it('parses projects', () => {
    expect(profile.projects).toHaveLength(2)
    const sage = profile.projects[0]!
    expect(sage).toMatchObject({ name: 'Sage', role: 'Solo developer', period: '2025' })
    expect(sage.stack).toEqual(['TypeScript', 'Node', 'PostgreSQL'])
    expect(sage.description).toBe('Multi-tenant AI assistant for retail stores.')
    expect(sage.highlights).toHaveLength(2)
    expect(profile.projects[1]!.link).toBeUndefined()
  })

  it('parses title preferences', () => {
    expect(profile.titles.titles).toEqual(['AI Engineer', 'Software Engineer', 'Backend Developer'])
    expect(profile.titles.exclude).toContain('Intern')
    expect(profile.titles.locations).toEqual(['Singapore', 'Remote'])
  })

  it('parses the answer bank with multiple patterns per entry', () => {
    expect(profile.answers).toHaveLength(5)
    expect(profile.answers[1]!.patterns).toHaveLength(3)
  })
})

describe('stable ids', () => {
  it('are identical across loads and line ending styles', () => {
    const a = loadProfile(FIXTURE)
    const dir = copyFixture()
    edit(dir, 'resume.md', (s) => s.replace(/\n/g, '\r\n'))
    const b = loadProfile(dir)
    expect(b.experience.map((e) => e.id)).toEqual(a.experience.map((e) => e.id))
    expect(b.experience[0]!.bullets.map((x) => x.id)).toEqual(
      a.experience[0]!.bullets.map((x) => x.id),
    )
    expect(b.projects.map((p) => p.id)).toEqual(a.projects.map((p) => p.id))
    rmSync(dir, { recursive: true })
  })

  it('ignore case and trailing punctuation, but change when the text changes', () => {
    const a = loadProfile(FIXTURE)
    const dir = copyFixture()
    edit(dir, 'resume.md', (s) =>
      s
        .replace(
          'Built two chart types that are still used in production.',
          'built two chart types that are still used in production',
        )
        .replace('Wrote integration tests', 'Wrote unit tests'),
    )
    const b = loadProfile(dir)
    expect(b.experience[0]!.bullets[1]!.id).toBe(a.experience[0]!.bullets[1]!.id)
    expect(b.experience[1]!.bullets[1]!.id).not.toBe(a.experience[1]!.bullets[1]!.id)
    expect(b.experience[1]!.id).toBe(a.experience[1]!.id)
    rmSync(dir, { recursive: true })
  })

  it('give every bullet a unique id and change the profile version on any edit', () => {
    const a = loadProfile(FIXTURE)
    const ids = a.experience.flatMap((e) => e.bullets.map((b) => b.id))
    expect(new Set(ids).size).toBe(ids.length)

    const dir = copyFixture()
    edit(dir, 'answers.md', (s) => s + '\n## Pronouns\nthey/them\n')
    expect(loadProfile(dir).version).not.toBe(a.version)
    rmSync(dir, { recursive: true })
  })
})

describe('validation errors', () => {
  it('reports missing files for all four inputs at once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apply-empty-'))
    const issues = issuesOf(dir)
    expect(issues).toHaveLength(3) // answers.md is optional
    expect(issues.join('\n')).toMatch(/resume\.md.*not found/)
    expect(issues.join('\n')).toMatch(/titles\.md.*not found/)
    expect(issues.join('\n')).toMatch(/projects\.md.*not found/)
  })

  it('treats answers.md as optional', () => {
    const dir = copyFixture()
    rmSync(join(dir, 'answers.md'))
    const profile = loadProfile(dir)
    expect(profile.answers).toEqual([])
    expect(profile.answerBank.match('anything')).toBeNull()
    expect(() => loadProfile(dir, { requireAnswers: true })).toThrow(/answers\.md/)
    rmSync(dir, { recursive: true })
  })

  it('names missing sections and fields in resume.md', () => {
    const dir = copyFixture()
    edit(dir, 'resume.md', (s) =>
      s
        .replace('Email: alex.tan@example.com\n', '')
        .replace(/# Skills[\s\S]*?(?=# Certifications)/, ''),
    )
    const issues = issuesOf(dir)
    expect(issues.some((i) => i.includes('missing "Email:"'))).toBe(true)
    expect(issues.some((i) => i.includes('missing "# Skills" section'))).toBe(true)
    rmSync(dir, { recursive: true })
  })

  it('flags bad experience headers, empty roles and bad skills lines', () => {
    const dir = copyFixture()
    edit(dir, 'resume.md', (s) =>
      s
        .replace(
          '## Northwind Labs | Software Developer Intern | Jan 2023 - May 2023',
          '## Northwind Labs | Intern',
        )
        .replace('- Languages: TypeScript, Python, SQL', '- Languages TypeScript'),
    )
    const issues = issuesOf(dir)
    expect(issues.some((i) => i.includes('should look like "Company | Role | Start - End"'))).toBe(
      true,
    )
    expect(issues.some((i) => i.includes('expected "Category: a, b, c"'))).toBe(true)
    rmSync(dir, { recursive: true })
  })

  it('flags duplicate bullets', () => {
    const dir = copyFixture()
    edit(dir, 'resume.md', (s) =>
      s.replace(
        '- Built internal REST endpoints in TypeScript and Node.',
        '- Built internal REST endpoints in TypeScript and Node.\n- built internal REST endpoints in typescript and node',
      ),
    )
    expect(issuesOf(dir).some((i) => i.includes('duplicate bullet'))).toBe(true)
    rmSync(dir, { recursive: true })
  })

  it('requires at least one title', () => {
    const dir = copyFixture()
    edit(dir, 'titles.md', (s) => s.replace(/# Titles[\s\S]*?(?=# Keywords)/, '# Titles\n\n'))
    expect(issuesOf(dir).some((i) => i.includes('add at least one'))).toBe(true)
    rmSync(dir, { recursive: true })
  })

  it('flags projects without a stack and answers without text', () => {
    const dir = copyFixture()
    edit(dir, 'projects.md', (s) => s.replace('Stack: Flutter, Supabase\n', ''))
    edit(dir, 'answers.md', (s) => s.replace('Yes', ''))
    const issues = issuesOf(dir)
    expect(issues.some((i) => i.includes('"Flashcards": missing "Stack:" line'))).toBe(true)
    expect(issues.some((i) => i.includes('answers.md') && i.includes('no answer text'))).toBe(true)
    rmSync(dir, { recursive: true })
  })

  it('flags duplicate answer patterns', () => {
    const dir = copyFixture()
    edit(dir, 'answers.md', (s) => s + '\n## Notice Period\n1 month\n')
    expect(issuesOf(dir).some((i) => i.includes('appears twice'))).toBe(true)
    rmSync(dir, { recursive: true })
  })

  it('rejects an invalid email through the schema safety net', () => {
    const dir = copyFixture()
    edit(dir, 'resume.md', (s) => s.replace('alex.tan@example.com', 'not-an-email'))
    expect(() => loadProfile(dir)).toThrow(/contact\.email/)
    rmSync(dir, { recursive: true })
  })
})
