import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ProfileError } from './issues'
import {
  parseProfile,
  PROFILE_FILES,
  PROFILE_KINDS,
  type ParseProfileOptions,
  type Profile,
  type ProfileKind,
} from './load'

/**
 * Read resume.md, titles.md, projects.md and answers.md from a directory. Missing files are left
 * out. Kept apart from `./index` so code that never touches the disk does not pull in node:fs.
 */
export function readProfileTexts(dir: string): Partial<Record<ProfileKind, string>> {
  const texts: Partial<Record<ProfileKind, string>> = {}
  for (const kind of PROFILE_KINDS) {
    const path = join(dir, PROFILE_FILES[kind])
    if (existsSync(path)) texts[kind] = readFileSync(path, 'utf8')
  }
  return texts
}

/** Load and parse a profile directory. Throws ProfileError listing every problem. */
export function loadProfileFromDir(dir: string, options: ParseProfileOptions = {}): Profile {
  const texts = readProfileTexts(dir)
  const missing = PROFILE_KINDS.filter(
    (k) => texts[k] === undefined && (k !== 'answers' || options.requireAnswers),
  )
  if (missing.length > 0) {
    throw new ProfileError(
      missing.map((k) => ({
        file: PROFILE_FILES[k],
        message: `file not found at ${join(dir, PROFILE_FILES[k])}`,
      })),
    )
  }
  return parseProfile(texts, options)
}
