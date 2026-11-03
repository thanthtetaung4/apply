import type { LoadedProfile } from '../profile'
import type { Selection } from './select'

export interface GroundingViolation {
  where: string
  problem: string
}

const numbers = (s: string) => s.match(/\d[\d,.]*%?/g) ?? []
const specialTokens = (s: string) =>
  (
    s.match(/\b(?:[A-Z][A-Za-z0-9+#]*(?:\.[A-Za-z]+)?|[a-z]+[A-Z][A-Za-z0-9]*|[A-Za-z]+\.js)\b/g) ??
    []
  ).filter((w) => w.length > 2)

/**
 * Check that a reworded bullet adds nothing that its source bullet and the profile do not already
 * contain: no new numbers, and no new names, tools or capitalised terms.
 */
export function checkRewrite(source: string, rewritten: string, knownTerms: Set<string>): string[] {
  const problems: string[] = []
  const src = source.toLowerCase()
  for (const n of numbers(rewritten)) {
    if (!src.includes(n.toLowerCase())) problems.push(`new number "${n}"`)
  }
  const sentenceStart = new Set<string>()
  for (const m of rewritten.matchAll(/(?:^|[.!?]\s+)([A-Z][a-z]+)/g)) sentenceStart.add(m[1]!)
  for (const t of specialTokens(rewritten)) {
    if (sentenceStart.has(t) && !/[A-Z].*[A-Z]|\d|\./.test(t)) continue
    if (!src.includes(t.toLowerCase()) && !knownTerms.has(t.toLowerCase()))
      problems.push(`new term "${t}"`)
  }
  return problems
}

/** Everything in the final resume must come from the profile. Fails closed. */
export function checkGrounding(
  profile: LoadedProfile,
  selection: Selection,
  rendered: {
    bullets: Map<string, string>
    summary?: string
    skills: { category: string; skills: string[] }[]
  },
): GroundingViolation[] {
  const violations: GroundingViolation[] = []
  const sourceBullets = new Map<string, string>()
  for (const e of profile.experience) for (const b of e.bullets) sourceBullets.set(b.id, b.text)
  for (const p of profile.projects) for (const h of p.highlights) sourceBullets.set(h.id, h.text)

  const known = new Set<string>()
  for (const g of profile.skills) for (const s of g.skills) known.add(s.toLowerCase())
  for (const p of profile.projects) for (const s of p.stack) known.add(s.toLowerCase())
  for (const t of [...profile.titles.titles, ...profile.titles.keywords]) known.add(t.toLowerCase())

  for (const [id, text] of rendered.bullets) {
    const source = sourceBullets.get(id)
    if (source === undefined) {
      violations.push({ where: `bullet ${id}`, problem: 'no such bullet in the profile' })
      continue
    }
    if (text !== source) {
      for (const p of checkRewrite(source, text, known))
        violations.push({ where: `bullet ${id}`, problem: p })
    }
  }

  const profileSkills = new Map(
    profile.skills.map((g) => [
      g.category.toLowerCase(),
      new Set(g.skills.map((s) => s.toLowerCase())),
    ]),
  )
  for (const g of rendered.skills) {
    const allowed = profileSkills.get(g.category.toLowerCase())
    if (!allowed) {
      violations.push({ where: `skills ${g.category}`, problem: 'category not in the profile' })
      continue
    }
    for (const s of g.skills) {
      if (!allowed.has(s.toLowerCase()))
        violations.push({ where: `skills ${g.category}`, problem: `"${s}" is not in the profile` })
    }
  }

  const selectedProjects = new Set(profile.projects.map((p) => p.id))
  for (const sp of selection.projects) {
    if (!selectedProjects.has(sp.project.id))
      violations.push({ where: 'projects', problem: `unknown project ${sp.project.id}` })
  }

  if (rendered.summary !== undefined && rendered.summary !== (profile.contact.summary ?? '')) {
    for (const p of checkRewrite(profile.contact.summary ?? '', rendered.summary, known)) {
      violations.push({ where: 'summary', problem: p })
    }
  }
  return violations
}
