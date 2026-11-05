import { stableId } from '../shared/hash'
import {
  bullets,
  dateRange,
  findSection,
  keyValues,
  paragraph,
  pipeParts,
  splitByHeading,
  toLines,
} from './markdown'
import type { IssueCollector } from './issues'
import type { Contact, Education, Experience, SkillGroup } from './types'

const FILE = 'resume.md'

export interface ParsedResume {
  contact: Partial<Contact> & { links: Contact['links'] }
  experience: Experience[]
  education: Education[]
  skills: SkillGroup[]
  certifications: string[]
}

function uniqueBullets(texts: string[], scope: string, ctx: string, issues: IssueCollector) {
  const seen = new Set<string>()
  const out = []
  for (const text of texts) {
    const id = stableId('b', scope, text)
    if (seen.has(id)) {
      issues.add(FILE, `${ctx}: duplicate bullet "${text.slice(0, 50)}"`)
      continue
    }
    seen.add(id)
    out.push({ id, text })
  }
  return out
}

/**
 * Expected layout:
 *   # Profile        Name:, Email:, Phone:, Location:
 *   # Links          - Label: url
 *   # Summary        paragraph
 *   # Experience     ## Company | Role | Start - End   then bullets
 *   # Education      ## Institution | Degree | Start - End   (optional bullets)
 *   # Skills         - Category: a, b, c
 *   # Certifications - item
 */
export function parseResume(md: string, issues: IssueCollector): ParsedResume {
  const { sections } = splitByHeading(toLines(md), 1)

  // Profile
  const profile = findSection(sections, 'profile', 'contact')
  const contact: ParsedResume['contact'] = { links: [] }
  if (!profile) {
    issues.add(FILE, 'missing "# Profile" section (needs Name and Email)')
  } else {
    const kv = keyValues(profile.lines, ['name', 'email', 'phone', 'location'])
    if (!kv.name) issues.add(FILE, '# Profile: missing "Name:"')
    if (!kv.email) issues.add(FILE, '# Profile: missing "Email:"')
    contact.name = kv.name
    contact.email = kv.email
    contact.phone = kv.phone
    contact.location = kv.location
  }

  // Links
  const links = findSection(sections, 'links')
  if (links) {
    for (const item of bullets(links.lines)) {
      const m = /^([^:]+):\s*(\S.*)$/.exec(item)
      if (m) contact.links.push({ label: (m[1] ?? '').trim(), url: (m[2] ?? '').trim() })
      else issues.add(FILE, `# Links: expected "Label: url", got "${item}"`)
    }
  }

  // Summary
  const summary = findSection(sections, 'summary')
  if (summary) {
    const text = paragraph(summary.lines)
    if (text) contact.summary = text
  }

  // Experience
  const experience: Experience[] = []
  const expSection = findSection(sections, 'experience', 'work experience')
  if (!expSection) {
    issues.add(FILE, 'missing "# Experience" section')
  } else {
    const { sections: roles } = splitByHeading(expSection.lines, 2)
    if (roles.length === 0)
      issues.add(FILE, '# Experience: no "## Company | Role | Start - End" entries')
    const seenRoles = new Set<string>()
    for (const r of roles) {
      const parts = pipeParts(r.title)
      const [company, role, dates] = parts
      const range = dates ? dateRange(dates) : null
      if (parts.length < 3 || !company || !role || !range) {
        issues.add(
          FILE,
          `# Experience: header "${r.title}" should look like "Company | Role | Start - End"`,
        )
        continue
      }
      const id = stableId('exp', company, role, range[0])
      if (seenRoles.has(id)) {
        issues.add(FILE, `# Experience: duplicate entry "${r.title}"`)
        continue
      }
      seenRoles.add(id)
      const items = bullets(r.lines)
      if (items.length === 0) {
        issues.add(FILE, `# Experience: "${r.title}" has no bullets`)
        continue
      }
      experience.push({
        id,
        company,
        role,
        start: range[0],
        end: range[1],
        bullets: uniqueBullets(items, id, `# Experience "${r.title}"`, issues),
      })
    }
  }

  // Education
  const education: Education[] = []
  const eduSection = findSection(sections, 'education')
  if (eduSection) {
    const { sections: entries } = splitByHeading(eduSection.lines, 2)
    for (const e of entries) {
      const [institution, degree, dates] = pipeParts(e.title)
      if (!institution || !degree) {
        issues.add(
          FILE,
          `# Education: header "${e.title}" should look like "Institution | Degree | Start - End"`,
        )
        continue
      }
      // A single date ("2024", "June 2024") is the graduation date.
      const single = dates && !dateRange(dates) && /\b\d{4}$/.test(dates.trim())
      const range: [string | undefined, string] | null = dates
        ? single
          ? [undefined, dates.trim()]
          : dateRange(dates)
        : null
      if (dates && !range) {
        issues.add(FILE, `# Education: could not read dates "${dates}" in "${e.title}"`)
      }
      const id = stableId('edu', institution, degree)
      education.push({
        id,
        institution,
        degree,
        start: range?.[0],
        end: range?.[1],
        notes: uniqueBullets(bullets(e.lines), id, `# Education "${e.title}"`, issues),
      })
    }
  }

  // Skills
  const skills: SkillGroup[] = []
  const skillSection = findSection(sections, 'skills')
  if (!skillSection) {
    issues.add(FILE, 'missing "# Skills" section')
  } else {
    for (const item of bullets(skillSection.lines)) {
      const m = /^([^:]+):\s*(\S.*)$/.exec(item)
      if (!m) {
        issues.add(FILE, `# Skills: expected "Category: a, b, c", got "${item}"`)
        continue
      }
      const category = (m[1] ?? '').trim()
      const list = (m[2] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      if (list.length === 0) {
        issues.add(FILE, `# Skills: category "${category}" has no skills`)
        continue
      }
      skills.push({ id: stableId('skl', category), category, skills: [...new Set(list)] })
    }
    if (
      skills.length === 0 &&
      !issues.issues.some((i) => i.file === FILE && i.message.startsWith('# Skills'))
    ) {
      issues.add(FILE, '# Skills: no "- Category: a, b, c" lines found')
    }
  }

  // Certifications (optional)
  const certSection = findSection(sections, 'certifications', 'certificates')
  const certifications = certSection ? bullets(certSection.lines) : []

  return { contact, experience, education, skills, certifications }
}
