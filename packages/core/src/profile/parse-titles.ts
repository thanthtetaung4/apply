import { bullets, findSection, splitByHeading, toLines } from './markdown'
import type { IssueCollector } from './issues'
import type { TitlePrefs } from './types'

const FILE = 'titles.md'

function dedupe(items: string[]): string[] {
  const seen = new Set<string>()
  return items.filter((i) => {
    const k = i.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * Expected layout (one list per section):
 *   # Titles      required, at least one
 *   # Keywords    optional
 *   # Locations   optional
 *   # Exclude     optional, words or phrases that rule a job out
 */
export function parseTitles(md: string, issues: IssueCollector): Partial<TitlePrefs> {
  const { sections } = splitByHeading(toLines(md), 1)
  const list = (...names: string[]) => {
    const s = findSection(sections, ...names)
    return s ? dedupe(bullets(s.lines)) : []
  }

  const titles = list('titles', 'preferred titles', 'job titles')
  if (!findSection(sections, 'titles', 'preferred titles', 'job titles')) {
    issues.add(FILE, 'missing "# Titles" section')
  } else if (titles.length === 0) {
    issues.add(FILE, '# Titles: add at least one "- Job Title" line')
  }

  return {
    titles,
    keywords: list('keywords'),
    locations: list('locations', 'location'),
    exclude: list('exclude', 'exclusions'),
  }
}
