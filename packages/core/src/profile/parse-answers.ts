import { stableId } from '../shared/hash'
import { splitByHeading, toLines } from './markdown'
import type { IssueCollector } from './issues'
import type { AnswerEntry } from './types'

const FILE = 'answers.md'

/**
 * Expected layout. Each `##` heading is one or more question patterns separated by `|`.
 * The text below it is the answer to give.
 *
 *   ## Are you authorized to work in Singapore? | work authorization
 *   Yes
 */
export function parseAnswers(md: string, issues: IssueCollector): AnswerEntry[] {
  const { sections } = splitByHeading(toLines(md), 2)
  const entries: AnswerEntry[] = []
  const seenPatterns = new Map<string, string>()

  for (const s of sections) {
    const patterns = s.title
      .split('|')
      .map((p) => p.trim())
      .filter(Boolean)
    const answer = s.lines
      .map((l) => l.trimEnd())
      .join('\n')
      .trim()

    if (patterns.length === 0) {
      issues.add(FILE, 'found a "##" heading with no question text')
      continue
    }
    if (!answer) {
      issues.add(FILE, `"${s.title}": no answer text under the heading`)
      continue
    }
    let duplicate = false
    for (const p of patterns) {
      const key = p.toLowerCase()
      const prior = seenPatterns.get(key)
      if (prior) {
        issues.add(FILE, `pattern "${p}" appears twice (also in "${prior}")`)
        duplicate = true
      }
      seenPatterns.set(key, s.title)
    }
    if (duplicate) continue

    entries.push({ id: stableId('ans', ...patterns), patterns, answer })
  }
  return entries
}
