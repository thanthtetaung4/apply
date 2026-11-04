import { stableId } from '../shared/hash'
import { bullets, keyValues, paragraph, splitByHeading, toLines } from './markdown'
import type { IssueCollector } from './issues'
import type { Project } from './types'

const FILE = 'projects.md'
const KEYS = ['stack', 'link', 'role', 'period'] as const

/**
 * Expected layout:
 *   ## Project Name
 *   Stack: TypeScript, Node, Postgres
 *   Link: https://...        (optional)
 *   Role: Solo developer     (optional)
 *   Period: 2025             (optional)
 *   One or two lines describing the project.
 *   - Outcome or highlight
 */
export function parseProjects(md: string, issues: IssueCollector): Project[] {
  const { sections } = splitByHeading(toLines(md), 2)
  if (sections.length === 0) {
    issues.add(FILE, 'no projects found. Add "## Project Name" entries')
    return []
  }

  const projects: Project[] = []
  const seen = new Set<string>()
  for (const s of sections) {
    if (!s.title) continue
    const id = stableId('prj', s.title)
    if (seen.has(id)) {
      issues.add(FILE, `duplicate project "${s.title}"`)
      continue
    }
    seen.add(id)

    const kv = keyValues(s.lines, KEYS)
    const stack = (kv.stack ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
    if (stack.length === 0) issues.add(FILE, `"${s.title}": missing "Stack:" line`)

    const seenHighlights = new Set<string>()
    const highlights = []
    for (const text of bullets(s.lines)) {
      const hid = stableId('b', id, text)
      if (seenHighlights.has(hid)) {
        issues.add(FILE, `"${s.title}": duplicate bullet "${text.slice(0, 50)}"`)
        continue
      }
      seenHighlights.add(hid)
      highlights.push({ id: hid, text })
    }

    const description = paragraph(s.lines, KEYS)
    if (!description && highlights.length === 0) {
      issues.add(FILE, `"${s.title}": add a short description or bullets`)
    }

    projects.push({
      id,
      name: s.title,
      stack: [...new Set(stack)],
      link: kv.link,
      role: kv.role,
      period: kv.period,
      description,
      highlights,
    })
  }
  return projects
}
