import { contentVersion } from '../shared/hash'
import { AnswerBank } from './answer-bank'
import { IssueCollector, ProfileError } from './issues'
import { parseAnswers } from './parse-answers'
import { parseProjects } from './parse-projects'
import { parseResume } from './parse-resume'
import { parseTitles } from './parse-titles'
import { LoadedProfileSchema, type LoadedProfile } from './types'

/** The four profile files, in the order they are hashed and shown. */
export const PROFILE_KINDS = ['resume', 'titles', 'projects', 'answers'] as const
export type ProfileKind = (typeof PROFILE_KINDS)[number]

export const PROFILE_FILES: Record<ProfileKind, string> = {
  resume: 'resume.md',
  titles: 'titles.md',
  projects: 'projects.md',
  answers: 'answers.md',
}

export interface Profile extends LoadedProfile {
  answerBank: AnswerBank
}

export interface ParseProfileOptions {
  /** answers.md is optional by default. Set true to require it. */
  requireAnswers?: boolean
}

/**
 * Parse the four markdown texts into a profile. Pure: no file system, so it runs anywhere
 * (web server actions, worker, tests). Throws ProfileError listing every problem.
 */
export function parseProfile(
  texts: Partial<Record<ProfileKind, string>>,
  options: ParseProfileOptions = {},
): Profile {
  const issues = new IssueCollector()
  const t: Record<ProfileKind, string> = {
    resume: texts.resume ?? '',
    titles: texts.titles ?? '',
    projects: texts.projects ?? '',
    answers: texts.answers ?? '',
  }

  for (const kind of PROFILE_KINDS) {
    if (t[kind].trim()) continue
    if (kind === 'answers' && !options.requireAnswers) continue
    issues.add(PROFILE_FILES[kind], 'file is empty')
  }

  const resume = t.resume.trim() ? parseResume(t.resume, issues) : null
  const titles = t.titles.trim() ? parseTitles(t.titles, issues) : null
  const projects = t.projects.trim() ? parseProjects(t.projects, issues) : []
  const answers = t.answers.trim() ? parseAnswers(t.answers, issues) : []

  // Fail on parser problems first so users see readable messages, not schema noise.
  if (issues.hasIssues) throw new ProfileError(issues.issues)

  const candidate = {
    version: contentVersion([t.resume, t.titles, t.projects, t.answers]),
    contact: resume?.contact,
    experience: resume?.experience,
    education: resume?.education,
    skills: resume?.skills,
    certifications: resume?.certifications,
    projects,
    titles,
    answers,
  }

  // Safety net: the final shape must satisfy the schema.
  const result = LoadedProfileSchema.safeParse(candidate)
  if (!result.success) {
    throw new ProfileError(
      result.error.issues.map((i) => ({
        file: 'profile',
        message: `${i.path.join('.')}: ${i.message}`,
      })),
    )
  }
  return { ...result.data, answerBank: new AnswerBank(result.data.answers) }
}
