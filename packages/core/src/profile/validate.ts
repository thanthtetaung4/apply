import { IssueCollector } from './issues'
import { PROFILE_FILES, type ProfileKind } from './load'
import { parseAnswers } from './parse-answers'
import { parseProjects } from './parse-projects'
import { parseResume } from './parse-resume'
import { parseTitles } from './parse-titles'
import {
  ContactSchema,
  EducationSchema,
  ExperienceSchema,
  SkillGroupSchema,
  TitlePrefsSchema,
} from './types'
import { z } from 'zod'

export interface FileValidation {
  ok: boolean
  /** Readable problems, one per line. Empty when ok. */
  issues: string[]
  /** What was understood, e.g. "3 jobs, 14 bullets". Shown so the user can spot misreads. */
  summary: string[]
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Check one profile file on its own, for the editor. The full profile is checked before runs. */
export function validateProfileFile(kind: ProfileKind, text: string): FileValidation {
  const issues = new IssueCollector()
  const summary: string[] = []
  const file = PROFILE_FILES[kind]

  if (!text.trim()) {
    if (kind === 'answers') return { ok: true, issues: [], summary: ['No saved answers yet.'] }
    return { ok: false, issues: ['The file is empty.'], summary: [] }
  }

  switch (kind) {
    case 'resume': {
      const r = parseResume(text, issues)
      if (!issues.hasIssues) {
        schemaCheck(issues, file, ContactSchema, r.contact, 'contact')
        schemaCheck(issues, file, z.array(ExperienceSchema).min(1), r.experience, 'experience')
        schemaCheck(issues, file, z.array(EducationSchema), r.education, 'education')
        schemaCheck(issues, file, z.array(SkillGroupSchema).min(1), r.skills, 'skills')
      }
      if (r.contact.name) summary.push(`Name: ${r.contact.name}`)
      const bullets = r.experience.reduce((n, e) => n + e.bullets.length, 0)
      summary.push(
        `${plural(r.experience.length, 'job')}, ${plural(bullets, 'bullet')}`,
        `${r.education.length} education ${r.education.length === 1 ? 'entry' : 'entries'}`,
        plural(
          r.skills.reduce((n, g) => n + g.skills.length, 0),
          'skill',
        ),
      )
      if (r.certifications.length) summary.push(plural(r.certifications.length, 'certification'))
      break
    }
    case 'titles': {
      const t = parseTitles(text, issues)
      if (!issues.hasIssues)
        schemaCheck(
          issues,
          file,
          TitlePrefsSchema,
          { keywords: [], locations: [], exclude: [], ...t },
          'titles',
        )
      summary.push(
        plural(t.titles?.length ?? 0, 'title'),
        plural(t.keywords?.length ?? 0, 'keyword'),
        plural(t.locations?.length ?? 0, 'location'),
        plural(t.exclude?.length ?? 0, 'excluded title'),
      )
      break
    }
    case 'projects': {
      const p = parseProjects(text, issues)
      summary.push(plural(p.length, 'project'))
      break
    }
    case 'answers': {
      const a = parseAnswers(text, issues)
      summary.push(plural(a.length, 'saved answer'))
      break
    }
  }

  return {
    ok: !issues.hasIssues,
    issues: issues.issues.map((i) => (i.file === file ? i.message : `${i.file}: ${i.message}`)),
    summary,
  }
}

function schemaCheck(
  issues: IssueCollector,
  file: string,
  schema: z.ZodType,
  value: unknown,
  label: string,
): void {
  const r = schema.safeParse(value)
  if (r.success) return
  for (const i of r.error.issues) issues.add(file, `${[label, ...i.path].join('.')}: ${i.message}`)
}

/**
 * Add an answer to answers.md. The question becomes a `##` heading (one pattern) and the answer
 * goes below it. If a heading already lists the same question, its answer is replaced instead,
 * so answering twice never creates a duplicate pattern.
 */
export function appendAnswer(content: string, question: string, answer: string): string {
  // "|" separates patterns and "#" would start a heading, so neither may appear in the question.
  const q = question
    .replace(/[\r\n]+/g, ' ')
    .replace(/\|/g, '/')
    .replace(/^#+\s*/, '')
    .trim()
  const a = answer.replace(/\r\n/g, '\n').trim()
  if (!q) throw new Error('The question is empty.')
  if (!a) throw new Error('The answer is empty.')
  // A line starting with "#" inside the answer would be read as a new heading.
  const body = a
    .split('\n')
    .map((l) => (/^\s*#/.test(l) ? l.replace(/^(\s*)#/, '$1\\#') : l))
    .join('\n')

  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
  const start = lines.findIndex(
    (l) =>
      /^##\s+/.test(l) &&
      !/^###/.test(l) &&
      l
        .replace(/^##\s+/, '')
        .split('|')
        .some((p) => norm(p) === norm(q)),
  )
  if (start >= 0) {
    let end = start + 1
    while (end < lines.length && !/^#{1,2}\s/.test(lines[end]!)) end++
    const next = [...lines.slice(0, start + 1), body, '', ...lines.slice(end)]
    return next
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\n*$/, '\n')
  }

  const base = content.replace(/\r\n/g, '\n').replace(/\s*$/, '')
  const head = base ? `${base}\n\n` : '# Answers\n\n'
  return `${head}## ${q}\n${body}\n`
}
